import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approvePairing,
  createPairing,
  getPairingStatus,
  InvalidPairingInputError,
  PairingAlreadyApprovedError,
  type PairingDatabase,
  PairingExpiredError,
  PairingNotFoundError,
} from "./pairings";
import {
  handleApprovePairing,
  handleCreatePairing,
  handleGetPairing,
} from "./pairings-http";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const device = {
  name: "studio",
  platform: "darwin",
  architecture: "arm64",
  cliVersion: "0.1.0",
};

async function pairingDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of migrationFiles) {
    const sql = await Bun.file(join(migrationsDirectory, file)).text();
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }

  const db: PairingDatabase = {
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
    async batch(statements) {
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
  };

  return { sqlite, db };
}

async function insertUser(sqlite: Database, userId: string) {
  sqlite
    .query(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
    .run(userId, "Ada", `${userId}@example.com`, Date.now(), Date.now());
}

test("pairing migration stores a hashed device code and never a plaintext secret column", async () => {
  const sql = (
    await Promise.all(
      migrationFiles.map((file) =>
        Bun.file(join(migrationsDirectory, file)).text(),
      ),
    )
  ).join("\n");
  expect(sql).toContain("CREATE TABLE `cli_pairings`");
  expect(sql).toContain("`device_code_hash`");
  expect(sql).toContain("`user_code`");
  expect(sql).not.toMatch(/`device_code`/);
});

test("createPairing returns secrets once and persists only the device_code hash", async () => {
  const { sqlite, db } = await pairingDb();
  const pairing = await createPairing(db, device, 1_000);
  expect(pairing.deviceCode).toHaveLength(64);
  expect(pairing.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(pairing.expiresAt).toBe(1_000 + 10 * 60 * 1000);

  const row = sqlite
    .query("SELECT * FROM cli_pairings WHERE id = ?")
    .get(pairing.id) as Record<string, unknown>;
  expect(row.device_code_hash).toBeString();
  expect(row.device_code_hash).not.toBe(pairing.deviceCode);
  expect(JSON.stringify(row)).not.toContain(pairing.deviceCode);
  expect(row).not.toHaveProperty("device_code");
  expect(row.user_code).toBe(pairing.userCode);
  expect(row.status).toBe("PENDING");
});

test("approval associates the authenticated user, device, and default workspace once", async () => {
  const { sqlite, db } = await pairingDb();
  await insertUser(sqlite, "user_1");
  const pairing = await createPairing(db, device, 1_000);
  const approved = await approvePairing(
    db,
    "user_1",
    pairing.id,
    pairing.userCode,
    2_000,
  );

  expect(approved.deviceId).toStartWith("dev_");
  expect(approved.workspaceId).toStartWith("ws_");
  expect(
    await getPairingStatus(db, pairing.id, pairing.deviceCode, 2_000),
  ).toEqual({
    status: "APPROVED",
  });

  const deviceRow = sqlite
    .query("SELECT user_id AS userId, name FROM devices WHERE id = ?")
    .get(approved.deviceId) as { userId: string; name: string };
  expect(deviceRow).toEqual({ userId: "user_1", name: "studio" });
  const membership = sqlite
    .query(
      "SELECT workspace_id AS workspaceId, is_active AS isActive FROM device_workspaces WHERE device_id = ?",
    )
    .get(approved.deviceId) as { workspaceId: string; isActive: number };
  expect(membership).toEqual({
    workspaceId: approved.workspaceId,
    isActive: 1,
  });

  await expect(
    approvePairing(db, "user_1", pairing.id, pairing.userCode, 3_000),
  ).rejects.toBeInstanceOf(PairingAlreadyApprovedError);
});

test("a user code cannot approve a different pairing's secret device code", async () => {
  const { sqlite, db } = await pairingDb();
  await insertUser(sqlite, "user_1");
  const first = await createPairing(db, device, 1_000);
  const second = await createPairing(db, { ...device, name: "laptop" }, 1_000);

  await expect(
    approvePairing(db, "user_1", first.id, second.userCode, 2_000),
  ).rejects.toBeInstanceOf(PairingNotFoundError);
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM devices").get() as {
      count: number;
    },
  ).toEqual({ count: 0 });
  expect(await getPairingStatus(db, first.id, first.deviceCode, 2_000)).toEqual(
    {
      status: "PENDING",
    },
  );
});

test("expired pairings cannot be approved or reused, and polling marks them expired", async () => {
  const { sqlite, db } = await pairingDb();
  await insertUser(sqlite, "user_1");
  const pairing = await createPairing(db, device, 1_000);
  const expiredAt = 1_000 + 10 * 60 * 1000;

  await expect(
    approvePairing(db, "user_1", pairing.id, pairing.userCode, expiredAt),
  ).rejects.toBeInstanceOf(PairingExpiredError);
  expect(
    await getPairingStatus(db, pairing.id, pairing.deviceCode, expiredAt),
  ).toEqual({
    status: "EXPIRED",
  });
  expect(
    sqlite
      .query("SELECT status FROM cli_pairings WHERE id = ?")
      .get(pairing.id),
  ).toEqual({ status: "EXPIRED" });
  await expect(
    approvePairing(db, "user_1", pairing.id, pairing.userCode, expiredAt + 1),
  ).rejects.toBeInstanceOf(PairingExpiredError);
});

test("polling requires the secret device code and never accepts a guessed code", async () => {
  const { db } = await pairingDb();
  const pairing = await createPairing(db, device, 1_000);
  await expect(
    getPairingStatus(db, pairing.id, "guessed-device-code", 1_000),
  ).rejects.toBeInstanceOf(PairingNotFoundError);
  await expect(
    getPairingStatus(db, "pair_missing", pairing.deviceCode, 1_000),
  ).rejects.toBeInstanceOf(PairingNotFoundError);
});

test("invalid device details are rejected before a pairing is stored", async () => {
  const { sqlite, db } = await pairingDb();
  await expect(
    createPairing(db, { ...device, name: "  " }),
  ).rejects.toBeInstanceOf(InvalidPairingInputError);
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM cli_pairings").get(),
  ).toEqual({ count: 0 });
});

test("approval accepts a typed user code and rejects a consumed pairing", async () => {
  const { sqlite, db } = await pairingDb();
  await insertUser(sqlite, "user_1");
  const pairing = await createPairing(db, device, 1_000);
  const approved = await approvePairing(
    db,
    "user_1",
    pairing.id,
    ` ${pairing.userCode.toLowerCase()} `,
    2_000,
  );
  expect(approved.deviceId).toStartWith("dev_");

  sqlite
    .query("UPDATE cli_pairings SET status = 'CONSUMED' WHERE id = ?")
    .run(pairing.id);
  await expect(
    approvePairing(db, "user_1", pairing.id, pairing.userCode, 3_000),
  ).rejects.toBeInstanceOf(PairingAlreadyApprovedError);
});

test("an expired pairing with the wrong user code does not reveal that the pairing exists", async () => {
  const { sqlite, db } = await pairingDb();
  await insertUser(sqlite, "user_1");
  const pairing = await createPairing(db, device, 1_000);
  await expect(
    approvePairing(
      db,
      "user_1",
      pairing.id,
      "XXXX-XXXX",
      1_000 + 10 * 60 * 1000,
    ),
  ).rejects.toBeInstanceOf(PairingNotFoundError);
});

function pairingRequest(
  path: string,
  init?: ConstructorParameters<typeof Request>[1],
) {
  return new Request(`https://toolmirror.com${path}`, init);
}

test("pairing HTTP flow creates, polls, approves once, and refuses a second exchange", async () => {
  const { sqlite, db } = await pairingDb();
  await insertUser(sqlite, "user_1");
  const created = await handleCreatePairing(
    pairingRequest("/api/v1/cli/pairings", {
      method: "POST",
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
  expect(pairing.deviceCode).toHaveLength(64);

  const pending = await handleGetPairing(
    pairingRequest(`/api/v1/cli/pairings/${pairing.id}`, {
      headers: { "x-toolmirror-device-code": pairing.deviceCode },
    }),
    db,
    pairing.id,
  );
  expect(await pending.json()).toEqual({ status: "PENDING" });

  const unauthenticated = await handleApprovePairing(
    pairingRequest(`/api/v1/cli/pairings/${pairing.id}/approve`, {
      method: "POST",
      headers: { origin: "https://toolmirror.com" },
      body: JSON.stringify({ userCode: pairing.userCode }),
    }),
    db,
    pairing.id,
    null,
  );
  expect(unauthenticated.status).toBe(401);

  const crossOrigin = await handleApprovePairing(
    pairingRequest(`/api/v1/cli/pairings/${pairing.id}/approve`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ userCode: pairing.userCode }),
    }),
    db,
    pairing.id,
    "user_1",
  );
  expect(crossOrigin.status).toBe(403);

  const approved = await handleApprovePairing(
    pairingRequest(`/api/v1/cli/pairings/${pairing.id}/approve`, {
      method: "POST",
      headers: { origin: "https://toolmirror.com" },
      body: JSON.stringify({ userCode: pairing.userCode }),
    }),
    db,
    pairing.id,
    "user_1",
  );
  expect(approved.status).toBe(200);
  const body = (await approved.json()) as {
    pairingId: string;
    deviceId: string;
    workspaceId: string;
  };
  expect(body.pairingId).toBe(pairing.id);
  expect(body.deviceId).toStartWith("dev_");
  expect(body.workspaceId).toStartWith("ws_");

  const replay = await handleApprovePairing(
    pairingRequest(`/api/v1/cli/pairings/${pairing.id}/approve`, {
      method: "POST",
      headers: { origin: "https://toolmirror.com" },
      body: JSON.stringify({ userCode: pairing.userCode }),
    }),
    db,
    pairing.id,
    "user_1",
  );
  expect(replay.status).toBe(409);
  expect(
    JSON.stringify(
      sqlite.query("SELECT * FROM cli_pairings WHERE id = ?").get(pairing.id),
    ),
  ).not.toContain(pairing.deviceCode);
});

test("polling without the secret device code is unauthorized", async () => {
  const { db } = await pairingDb();
  const created = await createPairing(db, device, 1_000);
  const response = await handleGetPairing(
    pairingRequest(`/api/v1/cli/pairings/${created.id}`),
    db,
    created.id,
  );
  expect(response.status).toBe(401);
});
