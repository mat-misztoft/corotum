import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { protectCloudRequest } from "./cloud-protect";
import type { PairingDatabase } from "./pairings";
import {
  handleApprovePairing,
  handleCreatePairing,
  handleGetPairing,
} from "./pairings-http";
import { RATE_LIMITS } from "./rate-limit";
import type { TokenDatabase } from "./tokens";
import { handleRevokeDevice } from "./tokens-http";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
const cliSrc = fileURLToPath(new URL("../../cli/src", import.meta.url));
const device = {
  name: "studio",
  platform: "darwin",
  architecture: "arm64",
  cliVersion: "0.1.0",
};

async function protectDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrationFiles = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    const sql = await Bun.file(join(migrationsDirectory, file)).text();
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }

  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              return (sqlite.query(query).get(...values) as T) ?? null;
            },
            async run() {
              const result = sqlite.query(query).run(...values);
              return { meta: { changes: Number(result.changes) } };
            },
            async all<T>() {
              return { results: sqlite.query(query).all(...values) as T[] };
            },
          };
        },
      };
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as PairingDatabase & TokenDatabase;

  return { sqlite, db };
}

function apiRequest(
  path: string,
  init?: ConstructorParameters<typeof Request>[1],
) {
  return new Request(`https://toolmirror.com${path}`, init);
}

test("an incompatible CLI receives 426 before pairing state is created", async () => {
  const { sqlite, db } = await protectDb();
  const missing = await handleCreatePairing(
    apiRequest("/api/v1/cli/pairings", {
      method: "POST",
      body: JSON.stringify(device),
    }),
    db,
  );
  expect(missing.status).toBe(426);

  const outdated = await handleCreatePairing(
    apiRequest("/api/v1/cli/pairings", {
      method: "POST",
      headers: { "x-toolmirror-cli-version": "0.0.9" },
      body: JSON.stringify(device),
    }),
    db,
  );
  expect(outdated.status).toBe(426);
  expect(await outdated.json()).toEqual({
    error: "CLI upgrade required",
    minVersion: "0.1.0",
  });
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM cli_pairings").get(),
  ).toEqual({ count: 0 });
});

test("a compatible CLI can still pair, and browser approve is not gated on CLI version", async () => {
  const { sqlite, db } = await protectDb();
  sqlite
    .query(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)",
    )
    .run("user_1", "Ada", "ada@example.com");
  const created = await handleCreatePairing(
    apiRequest("/api/v1/cli/pairings", {
      method: "POST",
      headers: { "x-toolmirror-cli-version": "0.1.0" },
      body: JSON.stringify(device),
    }),
    db,
  );
  expect(created.status).toBe(201);
  const pairing = (await created.json()) as {
    id: string;
    deviceCode: string;
    userCode: string;
  };
  const pending = await handleGetPairing(
    apiRequest(`/api/v1/cli/pairings/${pairing.id}`, {
      headers: {
        "x-toolmirror-cli-version": "0.1.0",
        "x-toolmirror-device-code": pairing.deviceCode,
      },
    }),
    db,
    pairing.id,
  );
  expect(pending.status).toBe(200);
  const approved = await handleApprovePairing(
    apiRequest(`/api/v1/cli/pairings/${pairing.id}/approve`, {
      method: "POST",
      headers: { origin: "https://toolmirror.com" },
      body: JSON.stringify({ userCode: pairing.userCode }),
    }),
    db,
    pairing.id,
    "user_1",
  );
  expect(approved.status).toBe(200);
});

test("an over-limit incompatible CLI is throttled instead of reaching Cloud pairing", async () => {
  const { sqlite, db } = await protectDb();
  let last = new Response();
  for (let index = 0; index < RATE_LIMITS.pairingAuth.limit + 1; index += 1) {
    last = await handleCreatePairing(
      apiRequest("/api/v1/cli/pairings", {
        method: "POST",
        headers: {
          "x-toolmirror-cli-version": "0.0.1",
          "cf-connecting-ip": "203.0.113.9",
        },
        body: JSON.stringify(device),
      }),
      db,
    );
  }
  expect(last.status).toBe(429);
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM cli_pairings").get(),
  ).toEqual({ count: 0 });
});

test("pairing/auth requests over the per-IP limit are throttled", async () => {
  const { sqlite, db } = await protectDb();
  let last = new Response();
  for (let index = 0; index < RATE_LIMITS.pairingAuth.limit + 1; index += 1) {
    last = await handleCreatePairing(
      apiRequest("/api/v1/cli/pairings", {
        method: "POST",
        headers: {
          "x-toolmirror-cli-version": "0.1.0",
          "cf-connecting-ip": "203.0.113.8",
        },
        body: JSON.stringify({ ...device, name: `studio-${index}` }),
      }),
      db,
    );
  }
  expect(last.status).toBe(429);
  expect(last.headers.get("retry-after")).toBeTruthy();
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM cli_pairings").get(),
  ).toEqual({ count: RATE_LIMITS.pairingAuth.limit });
});

test("device mutations over the per-user limit are throttled", async () => {
  const { db } = await protectDb();
  let last = new Response();
  for (let index = 0; index < RATE_LIMITS.mutation.limit + 1; index += 1) {
    last = await handleRevokeDevice(
      apiRequest("/api/v1/devices/dev_missing/revoke", {
        method: "POST",
        headers: { origin: "https://toolmirror.com" },
      }),
      db,
      "dev_missing",
      "user_1",
    );
  }
  expect(last.status).toBe(429);
  expect(await last.json()).toEqual({ error: "Rate limit exceeded" });
});

test("normal authenticated Cloud API traffic is throttled independently", async () => {
  const { db } = await protectDb();
  const request = apiRequest("/api/v1/workspaces/ws_1/state", {
    headers: { "x-toolmirror-cli-version": "0.1.0" },
  });
  let last: Response | null = null;
  for (let index = 0; index < RATE_LIMITS.normal.limit + 1; index += 1) {
    last = await protectCloudRequest(request, db, {
      kind: "normal",
      requireCli: true,
      identity: "device:dev_1",
    });
  }
  expect(last?.status).toBe(429);
});

test("Git Sync CLI sources stay independent of Cloud compatibility checks", () => {
  const files = readdirSync(cliSrc).filter((file) => file.endsWith(".ts"));
  expect(files.some((file) => file.includes("sync"))).toBe(true);
  for (const file of files) {
    const source = readFileSync(join(cliSrc, file), "utf8");
    expect(source).not.toContain("protectCloudRequest");
    expect(source).not.toContain("CLI upgrade required");
    expect(source).not.toContain("x-toolmirror-cli-version");
  }
});
