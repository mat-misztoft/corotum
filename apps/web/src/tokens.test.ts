import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { approvePairing, createPairing } from "./pairings";
import {
  authenticateDeviceToken,
  DeviceNotFoundError,
  DeviceUnauthorizedError,
  issueDeviceToken,
  logoutDeviceToken,
  PairingNotApprovedError,
  revokeDevice,
  TokenAlreadyIssuedError,
  type TokenDatabase,
} from "./tokens";
import {
  handleIssueDeviceToken,
  handleLogoutDevice,
  handleRevokeDevice,
} from "./tokens-http";

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

async function tokenDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of migrationFiles) {
    const sql = await Bun.file(join(migrationsDirectory, file)).text();
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }

  const db: TokenDatabase = {
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

async function approvedPairing(
  db: TokenDatabase,
  sqlite: Database,
  userId = "user_1",
  name = device.name,
) {
  await insertUser(sqlite, userId);
  const pairing = await createPairing(db, { ...device, name }, 1_000);
  const approved = await approvePairing(
    db,
    userId,
    pairing.id,
    pairing.userCode,
    2_000,
  );
  return { pairing, approved };
}

function apiRequest(
  path: string,
  init?: ConstructorParameters<typeof Request>[1],
) {
  return new Request(`https://toolmirror.com${path}`, init);
}

test("device token migration stores token_hash and never a plaintext token column", async () => {
  const sql = (
    await Promise.all(
      migrationFiles.map((file) =>
        Bun.file(join(migrationsDirectory, file)).text(),
      ),
    )
  ).join("\n");
  expect(sql).toContain("CREATE TABLE `device_tokens`");
  expect(sql).toContain("`token_hash`");
  expect(sql).not.toMatch(/CREATE TABLE `device_tokens`[\s\S]*?`token`/);
});

test("issueDeviceToken returns the secret once and persists only its hash", async () => {
  const { sqlite, db } = await tokenDb();
  const { pairing, approved } = await approvedPairing(db, sqlite);
  const issued = await issueDeviceToken(
    db,
    pairing.id,
    pairing.deviceCode,
    3_000,
  );

  expect(issued.token).toHaveLength(64);
  expect(issued.deviceId).toBe(approved.deviceId);
  expect(issued.workspaceId).toBe(approved.workspaceId);

  const row = sqlite
    .query("SELECT * FROM device_tokens WHERE device_id = ?")
    .get(issued.deviceId) as Record<string, unknown>;
  expect(row.token_hash).toBeString();
  expect(row.token_hash).not.toBe(issued.token);
  expect(JSON.stringify(row)).not.toContain(issued.token);
  expect(row).not.toHaveProperty("token");
  expect(row.revoked_at).toBeNull();
  expect(
    sqlite
      .query("SELECT status FROM cli_pairings WHERE id = ?")
      .get(pairing.id),
  ).toEqual({ status: "CONSUMED" });

  await expect(
    issueDeviceToken(db, pairing.id, pairing.deviceCode, 4_000),
  ).rejects.toBeInstanceOf(TokenAlreadyIssuedError);
});

test("a valid token authenticates only its device", async () => {
  const { sqlite, db } = await tokenDb();
  const first = await approvedPairing(db, sqlite, "user_1", "studio");
  const secondPairing = await createPairing(
    db,
    { ...device, name: "laptop" },
    1_000,
  );
  const secondApproved = await approvePairing(
    db,
    "user_1",
    secondPairing.id,
    secondPairing.userCode,
    2_000,
  );
  const firstToken = await issueDeviceToken(
    db,
    first.pairing.id,
    first.pairing.deviceCode,
    3_000,
  );
  const secondToken = await issueDeviceToken(
    db,
    secondPairing.id,
    secondPairing.deviceCode,
    3_000,
  );

  expect(await authenticateDeviceToken(db, firstToken.token, 4_000)).toEqual({
    deviceId: first.approved.deviceId,
    userId: "user_1",
  });
  expect(await authenticateDeviceToken(db, secondToken.token, 4_000)).toEqual({
    deviceId: secondApproved.deviceId,
    userId: "user_1",
  });
  expect(first.approved.deviceId).not.toBe(secondApproved.deviceId);
  await expect(
    authenticateDeviceToken(db, "not-a-real-token", 4_000),
  ).rejects.toBeInstanceOf(DeviceUnauthorizedError);
});

test("logout revokes the token immediately and keeps remote device data", async () => {
  const { sqlite, db } = await tokenDb();
  const { pairing, approved } = await approvedPairing(db, sqlite);
  sqlite
    .query(
      "INSERT INTO device_agents (device_id, agent_id, status, updated_at) VALUES (?, 'codex', 'DETECTED', ?)",
    )
    .run(approved.deviceId, 2_000);
  const issued = await issueDeviceToken(
    db,
    pairing.id,
    pairing.deviceCode,
    3_000,
  );

  expect(await logoutDeviceToken(db, issued.token, 4_000)).toEqual({
    deviceId: approved.deviceId,
    userId: "user_1",
  });
  await expect(
    authenticateDeviceToken(db, issued.token, 5_000),
  ).rejects.toBeInstanceOf(DeviceUnauthorizedError);

  expect(
    sqlite
      .query("SELECT id, revoked_at AS revokedAt FROM devices WHERE id = ?")
      .get(approved.deviceId),
  ).toEqual({ id: approved.deviceId, revokedAt: null });
  expect(
    sqlite
      .query(
        "SELECT COUNT(*) AS count FROM device_workspaces WHERE device_id = ?",
      )
      .get(approved.deviceId),
  ).toEqual({ count: 1 });
  expect(
    sqlite
      .query("SELECT COUNT(*) AS count FROM device_agents WHERE device_id = ?")
      .get(approved.deviceId),
  ).toEqual({ count: 1 });
  expect(
    sqlite
      .query(
        "SELECT revoked_at AS revokedAt FROM device_tokens WHERE device_id = ?",
      )
      .get(approved.deviceId),
  ).toEqual({ revokedAt: 4_000 });
});

test("user revoke invalidates access without deleting remote machine data", async () => {
  const { sqlite, db } = await tokenDb();
  const { pairing, approved } = await approvedPairing(db, sqlite);
  sqlite
    .query(
      "INSERT INTO device_agents (device_id, agent_id, status, updated_at) VALUES (?, 'codex', 'DETECTED', ?)",
    )
    .run(approved.deviceId, 2_000);
  const issued = await issueDeviceToken(
    db,
    pairing.id,
    pairing.deviceCode,
    3_000,
  );

  expect(await revokeDevice(db, "user_1", approved.deviceId, 4_000)).toEqual({
    deviceId: approved.deviceId,
  });
  await expect(
    authenticateDeviceToken(db, issued.token, 5_000),
  ).rejects.toBeInstanceOf(DeviceUnauthorizedError);
  await expect(
    revokeDevice(db, "user_other", approved.deviceId, 6_000),
  ).rejects.toBeInstanceOf(DeviceNotFoundError);

  const deviceRow = sqlite
    .query("SELECT id, name, revoked_at AS revokedAt FROM devices WHERE id = ?")
    .get(approved.deviceId) as {
    id: string;
    name: string;
    revokedAt: number;
  };
  expect(deviceRow).toEqual({
    id: approved.deviceId,
    name: "studio",
    revokedAt: 4_000,
  });
  expect(
    sqlite
      .query(
        "SELECT COUNT(*) AS count FROM device_workspaces WHERE device_id = ?",
      )
      .get(approved.deviceId),
  ).toEqual({ count: 1 });
  expect(
    sqlite
      .query("SELECT COUNT(*) AS count FROM device_agents WHERE device_id = ?")
      .get(approved.deviceId),
  ).toEqual({ count: 1 });
});

test("a revoked device cannot exchange an approved pairing for a token", async () => {
  const { db, sqlite } = await tokenDb();
  const { pairing, approved } = await approvedPairing(db, sqlite);
  await revokeDevice(db, "user_1", approved.deviceId, 3_000);
  await expect(
    issueDeviceToken(db, pairing.id, pairing.deviceCode, 4_000),
  ).rejects.toBeInstanceOf(DeviceNotFoundError);
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM device_tokens").get(),
  ).toEqual({ count: 0 });
});

test("a pending pairing cannot mint a device token", async () => {
  const { db } = await tokenDb();
  const pairing = await createPairing(db, device, 1_000);
  await expect(
    issueDeviceToken(db, pairing.id, pairing.deviceCode, 2_000),
  ).rejects.toBeInstanceOf(PairingNotApprovedError);
});

test("token HTTP issuance, logout, and revoke never leak the plaintext secret after issuance", async () => {
  const { sqlite, db } = await tokenDb();
  const { pairing, approved } = await approvedPairing(db, sqlite);

  const issuedResponse = await handleIssueDeviceToken(
    apiRequest(`/api/v1/cli/pairings/${pairing.id}/token`, {
      method: "POST",
      headers: { "x-toolmirror-device-code": pairing.deviceCode },
    }),
    db,
    pairing.id,
  );
  expect(issuedResponse.status).toBe(201);
  const issued = (await issuedResponse.json()) as {
    token: string;
    deviceId: string;
  };
  expect(issued.token).toHaveLength(64);
  expect(issued.deviceId).toBe(approved.deviceId);

  const replay = await handleIssueDeviceToken(
    apiRequest(`/api/v1/cli/pairings/${pairing.id}/token`, {
      method: "POST",
      headers: { "x-toolmirror-device-code": pairing.deviceCode },
    }),
    db,
    pairing.id,
  );
  expect(replay.status).toBe(409);
  expect(JSON.stringify(await replay.json())).not.toContain(issued.token);

  const loggedOut = await handleLogoutDevice(
    apiRequest("/api/v1/cli/logout", {
      method: "POST",
      headers: { "x-toolmirror-device-token": issued.token },
    }),
    db,
  );
  expect(loggedOut.status).toBe(200);
  const logoutBody = await loggedOut.json();
  expect(logoutBody).toEqual({ revoked: true, deviceId: approved.deviceId });
  expect(JSON.stringify(logoutBody)).not.toContain(issued.token);

  const second = await approvedPairing(db, sqlite, "user_2", "laptop");
  const secondIssued = await issueDeviceToken(
    db,
    second.pairing.id,
    second.pairing.deviceCode,
    4_000,
  );
  const unauthenticated = await handleRevokeDevice(
    apiRequest(`/api/v1/devices/${second.approved.deviceId}/revoke`, {
      method: "POST",
      headers: { origin: "https://toolmirror.com" },
    }),
    db,
    second.approved.deviceId,
    null,
  );
  expect(unauthenticated.status).toBe(401);

  const crossOrigin = await handleRevokeDevice(
    apiRequest(`/api/v1/devices/${second.approved.deviceId}/revoke`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    }),
    db,
    second.approved.deviceId,
    "user_2",
  );
  expect(crossOrigin.status).toBe(403);

  const revoked = await handleRevokeDevice(
    apiRequest(`/api/v1/devices/${second.approved.deviceId}/revoke`, {
      method: "POST",
      headers: { origin: "https://toolmirror.com" },
    }),
    db,
    second.approved.deviceId,
    "user_2",
  );
  expect(revoked.status).toBe(200);
  expect(JSON.stringify(await revoked.json())).not.toContain(
    secondIssued.token,
  );
  await expect(
    authenticateDeviceToken(db, secondIssued.token, 5_000),
  ).rejects.toBeInstanceOf(DeviceUnauthorizedError);

  expect(
    JSON.stringify(sqlite.query("SELECT * FROM device_tokens").all()),
  ).not.toContain(issued.token);
  expect(
    JSON.stringify(sqlite.query("SELECT * FROM device_tokens").all()),
  ).not.toContain(secondIssued.token);
});

test("token HTTP exchange without the secret device code is unauthorized", async () => {
  const { db } = await tokenDb();
  const pairing = await createPairing(db, device, 1_000);
  const response = await handleIssueDeviceToken(
    apiRequest(`/api/v1/cli/pairings/${pairing.id}/token`, { method: "POST" }),
    db,
    pairing.id,
  );
  expect(response.status).toBe(401);
});
