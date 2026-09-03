import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CliUpdateDeps,
  cliUpdate,
} from "../../../apps/cli/src/cli-update";
import { SanitizedLogger } from "../../../apps/cli/src/logs";
import { MutationLock } from "../../../apps/cli/src/mutation-lock";
import { skillId } from "../../../packages/core/src/index";
import { SaaSProvider } from "../../../packages/saas-provider/src/index";
import { assertSafeGitSource } from "../../../packages/skills-adapter/src/git-source";
import {
  createReleaseLayout,
  type LatestJson,
  RELEASE_TARGETS,
  type ReleaseTargetId,
  verifyReleaseLayout,
} from "../../../tooling/release";
import { type BillingEnvironment, hasHostedCloudAccess } from "../src/billing";
import { handleCreemWebhook } from "../src/billing-http";
import { CLI_VERSION_HEADER } from "../src/cli-compat";
import { approvePairing, createPairing } from "../src/pairings";
import {
  handleApprovePairing,
  handleCreatePairing,
} from "../src/pairings-http";
import { RATE_LIMITS } from "../src/rate-limit";
import {
  handleGetWorkspaceState,
  handlePostPendingResolution,
  handlePutWorkspaceState,
} from "../src/state-http";
import { handlePostTelemetry } from "../src/telemetry-http";
import { authenticateDeviceToken, issueDeviceToken } from "../src/tokens";
import { handleIssueDeviceToken, handleRevokeDevice } from "../src/tokens-http";
import { handleWebMcpTool } from "../src/webmcp-http";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
const evidencePath = fileURLToPath(
  new URL("./security-evidence.md", import.meta.url),
);
const webhookSecret = "whsec_test";
const launchEnd = Date.parse("2026-10-01T00:00:00.000Z");
const hostedEnv: BillingEnvironment = {
  COROTUM_HOSTED: "true",
  CREEM_API_KEY: "ck_test",
  CREEM_WEBHOOK_SECRET: webhookSecret,
  CREEM_PRODUCT_MONTHLY: "prod_month",
  CREEM_PRODUCT_ANNUAL: "prod_year",
};
const device = {
  name: "studio",
  platform: "darwin",
  architecture: "arm64",
  cliVersion: "0.1.0",
};

async function securityDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
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
  };
  return { sqlite, db };
}

function insertUser(sqlite: Database, userId: string) {
  sqlite
    .query(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
    .run(userId, userId, `${userId}@example.com`, Date.now(), Date.now());
}

function api(path: string, init?: ConstructorParameters<typeof Request>[1]) {
  return new Request(`https://corotum.com${path}`, init);
}

async function sign(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function layoutFiles(version: string): Map<string, Uint8Array> {
  const archives = Object.fromEntries(
    RELEASE_TARGETS.map((target) => [
      target.id,
      new TextEncoder().encode(`final-archive:${target.id}`),
    ]),
  ) as Record<ReleaseTargetId, Uint8Array>;
  return createReleaseLayout(
    version,
    archives,
    "0123456789abcdef0123456789abcdef01234567",
    sha256,
  );
}

test("security: pairing and token hashes never persist plaintext secrets", async () => {
  const { sqlite, db } = await securityDb();
  insertUser(sqlite, "user_1");
  const created = await handleCreatePairing(
    api("/api/v1/cli/pairings", {
      method: "POST",
      headers: { [CLI_VERSION_HEADER]: "0.1.0" },
      body: JSON.stringify(device),
    }),
    db as never,
  );
  expect(created.status).toBe(201);
  const pairing = (await created.json()) as {
    id: string;
    deviceCode: string;
    userCode: string;
  };
  const pairingRow = sqlite
    .query("SELECT * FROM cli_pairings WHERE id = ?")
    .get(pairing.id) as Record<string, unknown>;
  expect(pairingRow.device_code_hash).toBeString();
  expect(JSON.stringify(pairingRow)).not.toContain(pairing.deviceCode);
  expect(pairingRow).not.toHaveProperty("device_code");

  const guessed = await handleApprovePairing(
    api(`/api/v1/cli/pairings/${pairing.id}/approve`, {
      method: "POST",
      headers: { origin: "https://corotum.com" },
      body: JSON.stringify({ userCode: "XXXX-XXXX" }),
    }),
    db as never,
    pairing.id,
    "user_1",
  );
  expect(guessed.status).toBe(404);
  expect(sqlite.query("SELECT COUNT(*) AS count FROM devices").get()).toEqual({
    count: 0,
  });

  const approved = await handleApprovePairing(
    api(`/api/v1/cli/pairings/${pairing.id}/approve`, {
      method: "POST",
      headers: { origin: "https://corotum.com" },
      body: JSON.stringify({ userCode: pairing.userCode }),
    }),
    db as never,
    pairing.id,
    "user_1",
  );
  expect(approved.status).toBe(200);

  const issuedResponse = await handleIssueDeviceToken(
    api(`/api/v1/cli/pairings/${pairing.id}/token`, {
      method: "POST",
      headers: {
        [CLI_VERSION_HEADER]: "0.1.0",
        "x-toolmirror-device-code": pairing.deviceCode,
      },
    }),
    db as never,
    pairing.id,
  );
  expect(issuedResponse.status).toBe(201);
  const issued = (await issuedResponse.json()) as {
    token: string;
    deviceId: string;
  };
  const tokenRow = sqlite
    .query("SELECT * FROM device_tokens WHERE device_id = ?")
    .get(issued.deviceId) as Record<string, unknown>;
  expect(tokenRow.token_hash).toBeString();
  expect(tokenRow.token_hash).not.toBe(issued.token);
  expect(JSON.stringify(tokenRow)).not.toContain(issued.token);
  expect(tokenRow).not.toHaveProperty("token");

  const revoked = await handleRevokeDevice(
    api(`/api/v1/devices/${issued.deviceId}/revoke`, {
      method: "POST",
      headers: { origin: "https://corotum.com" },
    }),
    db as never,
    issued.deviceId,
    "user_1",
  );
  expect(revoked.status).toBe(200);
  await expect(
    authenticateDeviceToken(db as never, issued.token, Date.now()),
  ).rejects.toThrow();
  expect(
    sqlite
      .query("SELECT COUNT(*) AS count FROM devices WHERE id = ?")
      .get(issued.deviceId),
  ).toEqual({ count: 1 });
  expect(
    JSON.stringify(sqlite.query("SELECT * FROM device_tokens").all()),
  ).not.toContain(issued.token);
});

test("security: authorization rejects foreign devices, workspaces, and CSRF without mutation", async () => {
  const { sqlite, db } = await securityDb();
  insertUser(sqlite, "user_1");
  insertUser(sqlite, "user_2");
  const first = await createPairing(db as never, device, 1_000);
  await approvePairing(db as never, "user_1", first.id, first.userCode, 2_000);
  const firstToken = await issueDeviceToken(
    db as never,
    first.id,
    first.deviceCode,
    3_000,
  );
  const second = await createPairing(
    db as never,
    { ...device, name: "laptop" },
    1_000,
  );
  await approvePairing(
    db as never,
    "user_2",
    second.id,
    second.userCode,
    2_000,
  );
  const secondToken = await issueDeviceToken(
    db as never,
    second.id,
    second.deviceCode,
    3_000,
  );

  const foreign = await handleGetWorkspaceState(
    api(`/api/v1/workspaces/${secondToken.workspaceId}/state`, {
      headers: {
        [CLI_VERSION_HEADER]: "0.1.0",
        "x-toolmirror-device-token": firstToken.token,
      },
    }),
    db as never,
    secondToken.workspaceId,
  );
  expect(foreign.status).toBe(404);
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM workspace_revisions").get(),
  ).toEqual({ count: 0 });

  const csrf = await handleWebMcpTool(
    api("/api/v1/webmcp", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({
        tool: "add_skill",
        baseRevisionId: null,
        idempotencyKey: "csrf",
        arguments: {
          source: "https://example.com/skills.git",
          skill: "review",
        },
      }),
    }),
    db as never,
    "user_1",
    false,
  );
  expect(csrf.status).toBe(403);
});

test("security: unsigned webhooks, rate limits, and old CLIs cannot mutate Cloud", async () => {
  const { sqlite, db } = await securityDb();
  insertUser(sqlite, "user_1");
  const payload = JSON.stringify({
    id: "evt_forged",
    eventType: "subscription.paid",
    object: {
      id: "sub_forged",
      customer: { id: "cus_ada" },
      metadata: { userId: "user_1", billingInterval: "month" },
    },
  });
  const forged = await handleCreemWebhook(
    new Request("https://corotum.com/api/v1/webhooks/creem", {
      method: "POST",
      headers: { "creem-signature": "00" },
      body: payload,
    }),
    db as never,
    hostedEnv,
  );
  expect(forged.status).toBe(401);
  expect(await hasHostedCloudAccess(db as never, "user_1", true, launchEnd)).toBe(false);

  const signed = await handleCreemWebhook(
    new Request("https://corotum.com/api/v1/webhooks/creem", {
      method: "POST",
      headers: { "creem-signature": await sign(payload, webhookSecret) },
      body: payload,
    }),
    db as never,
    hostedEnv,
  );
  expect(signed.status).toBe(200);
  expect(await hasHostedCloudAccess(db as never, "user_1", true)).toBe(true);

  sqlite.query("UPDATE subscriptions SET status = 'canceled'").run();
  const replay = await handleCreemWebhook(
    new Request("https://corotum.com/api/v1/webhooks/creem", {
      method: "POST",
      headers: { "creem-signature": await sign(payload, webhookSecret) },
      body: payload,
    }),
    db as never,
    hostedEnv,
  );
  expect(replay.status).toBe(200);
  expect(sqlite.query("SELECT status FROM subscriptions").get()).toEqual({
    status: "canceled",
  });

  const outdated = await handleCreatePairing(
    api("/api/v1/cli/pairings", {
      method: "POST",
      headers: { [CLI_VERSION_HEADER]: "0.0.1" },
      body: JSON.stringify(device),
    }),
    db as never,
  );
  expect(outdated.status).toBe(426);
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM cli_pairings").get(),
  ).toEqual({ count: 0 });

  let last = new Response();
  for (let index = 0; index < RATE_LIMITS.pairingAuth.limit + 1; index += 1) {
    last = await handleCreatePairing(
      api("/api/v1/cli/pairings", {
        method: "POST",
        headers: {
          [CLI_VERSION_HEADER]: "0.1.0",
          "cf-connecting-ip": "203.0.113.50",
        },
        body: JSON.stringify({ ...device, name: `n${index}` }),
      }),
      db as never,
    );
  }
  expect(last.status).toBe(429);
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM cli_pairings").get(),
  ).toEqual({ count: RATE_LIMITS.pairingAuth.limit });
});

test("security: credential URLs are rejected before Git, Cloud origin, or desired-state writes", async () => {
  expect(() =>
    assertSafeGitSource("https://token:secret@example.com/skills.git"),
  ).toThrow("credentials");
  expect(
    () =>
      new SaaSProvider({
        origin: "https://user:pass@corotum.com",
        workspaceId: "ws_1",
        deviceToken: "token",
      }),
  ).toThrow("credentials");

  const { sqlite, db } = await securityDb();
  insertUser(sqlite, "user_1");
  const pairing = await createPairing(db as never, device, 1_000);
  await approvePairing(
    db as never,
    "user_1",
    pairing.id,
    pairing.userCode,
    2_000,
  );
  const issued = await issueDeviceToken(
    db as never,
    pairing.id,
    pairing.deviceCode,
    3_000,
  );
  const id = skillId("sk_cred");
  const poisoned = await handlePutWorkspaceState(
    api(`/api/v1/workspaces/${issued.workspaceId}/state`, {
      method: "PUT",
      headers: {
        [CLI_VERSION_HEADER]: "0.1.0",
        "x-toolmirror-device-token": issued.token,
      },
      body: JSON.stringify({
        baseRevision: null,
        idempotencyKey: "cred-1",
        transition: { type: "ADD", skillId: id, metadata: {} },
        state: {
          manifest: {
            version: 1,
            skills: [
              {
                id,
                source: "https://ada:token@github.com/acme/skills.git",
                skill: "review",
                ref: "main",
                targets: "all",
                resolutionStatus: "PENDING_RESOLUTION",
              },
            ],
          },
          lockfile: { version: 1, skills: [] },
        },
      }),
    }),
    db as never,
    issued.workspaceId,
  );
  expect(poisoned.status).toBe(400);
  expect(await poisoned.json()).toEqual({
    error: "Repository must not include credentials",
  });
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM workspace_revisions").get(),
  ).toEqual({ count: 0 });

  const pending = await handlePostPendingResolution(
    api(`/api/v1/workspaces/${issued.workspaceId}/pending-resolution`, {
      method: "POST",
      headers: {
        [CLI_VERSION_HEADER]: "0.1.0",
        "x-toolmirror-device-token": issued.token,
      },
      body: JSON.stringify({
        skillId: id,
        baseRevision: "rev_x",
        idempotencyKey: "cred-2",
        repository: "https://ada:token@github.com/acme/skills.git",
        revision: "abc",
        path: "review",
        contentHash: "sha256:abc",
      }),
    }),
    db as never,
    issued.workspaceId,
  );
  expect(pending.status).toBe(400);
});

test("security: log and telemetry injection cannot retain secrets or private skill data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corotum-security-logs-"));
  try {
    const logger = new SanitizedLogger(join(directory, "logs"));
    await logger.write('sync.failed\n{"token":"line-inject"}', {
      token: "device-token-secret",
      deviceCode: "pairing-device-code",
      skillContent: "private SKILL.md body",
      message:
        "Bearer leaked-session https://ada:hunter2@git.example/skills.git token=inline-secret",
    });
    const output = await readFile(
      join(directory, "logs", "corotum.log"),
      "utf8",
    );
    for (const secret of [
      "device-token-secret",
      "pairing-device-code",
      "private SKILL.md body",
      "leaked-session",
      "ada:hunter2",
      "inline-secret",
      "line-inject",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("[REDACTED]");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const points: AnalyticsEngineDataPoint[] = [];
  const analytics = {
    writeDataPoint: (point?: AnalyticsEngineDataPoint) =>
      points.push(point ?? {}),
  };
  const { db } = await securityDb();
  const rejected = await handlePostTelemetry(
    new Request("https://corotum.com/api/v1/telemetry", {
      method: "POST",
      headers: { [CLI_VERSION_HEADER]: "0.1.0" },
      body: JSON.stringify({
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        version: "0.1.0",
        os: "darwin",
        architecture: "arm64",
        command: "sync",
        durationMs: 1,
        outcome: "SUCCESS",
        errorCode: null,
        activeAgentCount: 1,
        supportedAgentIds: ["pi"],
        skillName: "private-review",
        repositoryUrl: "https://github.com/acme/private",
        localPath: "/Users/ada/.pi/skills",
        token: "secret-token",
        deviceName: "Ada's Mac",
      }),
    }),
    db as never,
    analytics,
  );
  expect(rejected.status).toBe(400);
  expect(points).toEqual([]);
});

test("security: malicious release metadata cannot escape install/update paths or replace a verified executable", async () => {
  const version = "0.1.0";
  const good = layoutFiles(version);
  expect(verifyReleaseLayout(version, good, sha256)).toEqual([]);

  const escaped = layoutFiles(version);
  const latest = JSON.parse(
    new TextDecoder().decode(escaped.get("releases/latest.json")),
  ) as LatestJson;
  latest.artifacts["darwin-arm64"] = {
    ...latest.artifacts["darwin-arm64"],
    object: "releases/v0.1.0/binaries/../../secret.tar.gz",
  };
  escaped.set(
    "releases/latest.json",
    new TextEncoder().encode(`${JSON.stringify(latest)}\n`),
  );
  expect(verifyReleaseLayout(version, escaped, sha256).join("\n")).toContain(
    "object path mismatch",
  );

  const work = await mkdtemp(join(tmpdir(), "corotum-security-update-"));
  try {
    const executablePath = join(work, "corotum");
    await writeFile(executablePath, "old-cli", { encoding: "utf8" });
    const original = await readFile(executablePath);
    const lock = new MutationLock(join(work, "process.lock"));
    const requested: string[] = [];
    const files = layoutFiles("0.1.1");
    const poisoned = JSON.parse(
      new TextDecoder().decode(files.get("releases/latest.json")),
    ) as LatestJson;
    poisoned.version = "0.1.1/../../etc";
    files.set(
      "releases/latest.json",
      new TextEncoder().encode(`${JSON.stringify(poisoned)}\n`),
    );
    const deps: CliUpdateDeps = {
      currentVersion: "0.1.0",
      platform: "darwin",
      arch: "arm64",
      executablePath,
      pendingDir: join(work, "pending"),
      releaseBase: "https://releases.corotum.com",
      fetchBytes: async (url) => {
        const key = new URL(url).pathname.replace(/^\//, "");
        requested.push(key);
        const body = files.get(key);
        if (!body) throw new Error(`missing ${key}`);
        return body;
      },
      acquireLock: () => lock.acquire(),
    };
    await expect(cliUpdate(deps, { check: false })).rejects.toThrow(
      /malformed/,
    );
    expect(await readFile(executablePath)).toEqual(original);
    expect(requested.some((path) => path.includes(".."))).toBe(false);
    expect(requested.some((path) => path.endsWith(".tar.gz"))).toBe(false);
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  const r2Root = join(root, "dist/r2");
  await rm(r2Root, { recursive: true, force: true });
  for (const [key, bytes] of good) {
    const path = join(r2Root, key);
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, bytes);
  }
  const written = new Map<string, Uint8Array>();
  const glob = new Bun.Glob("**/*");
  for await (const path of glob.scan({ cwd: r2Root, onlyFiles: true })) {
    written.set(
      path,
      new Uint8Array(await Bun.file(join(r2Root, path)).arrayBuffer()),
    );
  }
  expect(verifyReleaseLayout(version, written, sha256)).toEqual([]);

  const evidence = await readFile(evidencePath, "utf8");
  expect(evidence).toContain("device_code_hash");
  expect(evidence).toContain("token_hash");
  expect(evidence).toContain("latest.json");
  expect(evidence).toContain("handlePutWorkspaceState");
  expect(evidence).toContain("invalid.event");
  expect(evidence).not.toMatch(/sk-proj-|whsec_|ghp_/);
});
