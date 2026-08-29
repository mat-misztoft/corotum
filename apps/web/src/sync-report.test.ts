import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { skillId } from "../../../packages/core/src/index";
import {
  CLI_VERSION_HEADER,
  DEVICE_TOKEN_HEADER,
  postDeviceSyncReport,
  SaaSProvider,
} from "../../../packages/saas-provider/src/index";
import { handleGetDeviceTargetStatus } from "./device-target-status-http";
import { approvePairing, createPairing } from "./pairings";
import { handleGetWorkspaceState, handlePutWorkspaceState } from "./state-http";
import { handlePostDeviceSyncReport } from "./sync-report-http";
import { issueDeviceToken, type TokenDatabase } from "./tokens";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const skill = skillId("sk_01JSyncReport");
const source = "https://github.com/example/skills.git";
const desired = {
  manifest: {
    version: 1 as const,
    skills: [
      {
        id: skill,
        source,
        skill: "review",
        ref: "main",
        targets: "all" as const,
        resolutionStatus: "RESOLVED" as const,
      },
    ],
  },
  lockfile: {
    version: 1 as const,
    skills: [
      {
        id: skill,
        source,
        skill: "review",
        ref: "main",
        repository: source,
        revision: "abc123",
        path: "skills/review",
        contentHash: "sha256:locked",
      },
    ],
  },
};
const transition = { type: "ADD" as const, skillId: skill, metadata: {} };

async function reportDb() {
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

async function pairDevice(
  db: TokenDatabase,
  sqlite: Database,
  name: string,
  now: number,
) {
  if (!sqlite.query("SELECT id FROM user WHERE id = ?").get("user_1")) {
    sqlite
      .query(
        "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
      )
      .run("user_1", "Ada", "ada@example.com", now, now);
  }
  const pairing = await createPairing(
    db,
    {
      name,
      platform: "darwin",
      architecture: "arm64",
      cliVersion: "0.1.0",
    },
    now,
  );
  await approvePairing(db, "user_1", pairing.id, pairing.userCode, now + 1);
  return issueDeviceToken(db, pairing.id, pairing.deviceCode, now + 2);
}

function reportRequest(
  deviceId: string,
  token: string,
  body: unknown,
  init?: ConstructorParameters<typeof Request>[1],
) {
  return new Request(
    `https://toolmirror.com/api/v1/devices/${deviceId}/sync-report`,
    {
      method: "POST",
      ...init,
      headers: {
        [CLI_VERSION_HEADER]: "0.1.0",
        [DEVICE_TOKEN_HEADER]: token,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
      body: JSON.stringify(body),
    },
  );
}

function membership(sqlite: Database, deviceId: string) {
  return sqlite
    .query(
      `SELECT device_id AS deviceId,
              applied_revision_sequence AS appliedRevisionSequence,
              sync_status AS syncStatus,
              last_error_code AS lastErrorCode,
              last_error_message AS lastErrorMessage
       FROM device_workspaces
       WHERE device_id = ?`,
    )
    .get(deviceId) as {
    deviceId: string;
    appliedRevisionSequence: number;
    syncStatus: string;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
  };
}

test("an authenticated device can report only its locally verified applied revision", async () => {
  const { sqlite, db } = await reportDb();
  const first = await pairDevice(db, sqlite, "studio", 1_000);
  const second = await pairDevice(db, sqlite, "laptop", 2_000);
  const workspaceId = first.workspaceId as string;

  const created = await handlePutWorkspaceState(
    new Request(
      `https://toolmirror.com/api/v1/workspaces/${workspaceId}/state`,
      {
        method: "PUT",
        headers: {
          [CLI_VERSION_HEADER]: "0.1.0",
          [DEVICE_TOKEN_HEADER]: first.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          state: desired,
          baseRevision: null,
          idempotencyKey: "key-1",
          transition,
        }),
      },
    ),
    db,
    workspaceId,
  );
  expect(created.status).toBe(200);
  const revision = (await created.json()) as {
    revisionId: string;
    revisionSequence: number;
  };

  const accepted = await handlePostDeviceSyncReport(
    reportRequest(first.deviceId, first.token, {
      appliedRevisionId: revision.revisionId,
      syncStatus: "PARTIALLY_SYNCED",
      lastErrorCode: "TARGET_ERROR",
      lastErrorMessage: "One agent target failed.",
    }),
    db,
    first.deviceId,
  );
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({
    deviceId: first.deviceId,
    workspaceId,
    appliedRevisionId: revision.revisionId,
    appliedRevisionSequence: 1,
    syncStatus: "PARTIALLY_SYNCED",
    lastErrorCode: "TARGET_ERROR",
    lastErrorMessage: "One agent target failed.",
  });

  expect(membership(sqlite, first.deviceId)).toEqual({
    deviceId: first.deviceId,
    appliedRevisionSequence: 1,
    syncStatus: "PARTIALLY_SYNCED",
    lastErrorCode: "TARGET_ERROR",
    lastErrorMessage: "One agent target failed.",
  });
  expect(membership(sqlite, second.deviceId)).toEqual({
    deviceId: second.deviceId,
    appliedRevisionSequence: 0,
    syncStatus: "NEVER_SYNCED",
    lastErrorCode: null,
    lastErrorMessage: null,
  });
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM workspace_revisions").get(),
  ).toEqual({ count: 1 });
});

test("a report cannot change another device or claim an unreported device is synced", async () => {
  const { sqlite, db } = await reportDb();
  const first = await pairDevice(db, sqlite, "studio", 1_000);
  const second = await pairDevice(db, sqlite, "laptop", 2_000);
  const workspaceId = first.workspaceId as string;
  const created = await handlePutWorkspaceState(
    new Request(
      `https://toolmirror.com/api/v1/workspaces/${workspaceId}/state`,
      {
        method: "PUT",
        headers: {
          [CLI_VERSION_HEADER]: "0.1.0",
          [DEVICE_TOKEN_HEADER]: first.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          state: desired,
          baseRevision: null,
          idempotencyKey: "key-1",
          transition,
        }),
      },
    ),
    db,
    workspaceId,
  );
  const revision = (await created.json()) as { revisionId: string };

  const spoofed = await handlePostDeviceSyncReport(
    reportRequest(second.deviceId, first.token, {
      appliedRevisionId: revision.revisionId,
      syncStatus: "SYNCED",
      otherDeviceId: second.deviceId,
    }),
    db,
    second.deviceId,
  );
  expect(spoofed.status).toBe(401);

  const unknownRevision = await handlePostDeviceSyncReport(
    reportRequest(first.deviceId, first.token, {
      appliedRevisionId: "rev_unapplied",
      syncStatus: "SYNCED",
    }),
    db,
    first.deviceId,
  );
  expect(unknownRevision.status).toBe(400);

  const missingRevision = await handlePostDeviceSyncReport(
    reportRequest(first.deviceId, first.token, {
      appliedRevisionId: null,
      syncStatus: "SYNCED",
    }),
    db,
    first.deviceId,
  );
  expect(missingRevision.status).toBe(400);

  expect(membership(sqlite, first.deviceId)).toEqual({
    deviceId: first.deviceId,
    appliedRevisionSequence: 0,
    syncStatus: "NEVER_SYNCED",
    lastErrorCode: null,
    lastErrorMessage: null,
  });
  expect(membership(sqlite, second.deviceId)).toEqual({
    deviceId: second.deviceId,
    appliedRevisionSequence: 0,
    syncStatus: "NEVER_SYNCED",
    lastErrorCode: null,
    lastErrorMessage: null,
  });
});

test("hosted Cloud sync-report requires entitlement while self-host does not", async () => {
  const { sqlite, db } = await reportDb();
  const issued = await pairDevice(db, sqlite, "studio", 1_000);
  const denied = await handlePostDeviceSyncReport(
    reportRequest(issued.deviceId, issued.token, {
      appliedRevisionId: null,
      syncStatus: "ERROR",
      lastErrorCode: "DEVICE_ERROR",
    }),
    db,
    issued.deviceId,
    true,
  );
  expect(denied.status).toBe(402);

  const allowed = await handlePostDeviceSyncReport(
    reportRequest(issued.deviceId, issued.token, {
      appliedRevisionId: null,
      syncStatus: "ERROR",
      lastErrorCode: "DEVICE_ERROR",
    }),
    db,
    issued.deviceId,
    false,
  );
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toMatchObject({
    deviceId: issued.deviceId,
    syncStatus: "ERROR",
    appliedRevisionSequence: 0,
  });
});

const mixedTargets = [
  {
    skillId: skill,
    agentId: "codex",
    status: "SYNCED",
    errorCode: null,
    errorMessage: null,
    contentHash: "sha256:ok",
  },
  {
    skillId: skill,
    agentId: "pi",
    status: "DRIFTED",
    errorCode: null,
    errorMessage: null,
    contentHash: "sha256:drift",
  },
  {
    skillId: skill,
    agentId: "claude-code",
    status: "AUTH_REQUIRED",
    errorCode: "AUTH_REQUIRED",
    errorMessage: "Private repository access is required.",
    contentHash: null,
  },
  {
    skillId: skill,
    agentId: "cursor",
    status: "ERROR",
    errorCode: "TARGET_ERROR",
    errorMessage: "One agent target failed.",
    contentHash: null,
  },
] as const;

test("reported device/skill/agent outcomes persist in dedicated target rows", async () => {
  const { sqlite, db } = await reportDb();
  const issued = await pairDevice(db, sqlite, "studio", 1_000);
  const workspaceId = issued.workspaceId as string;
  const created = await handlePutWorkspaceState(
    new Request(
      `https://toolmirror.com/api/v1/workspaces/${workspaceId}/state`,
      {
        method: "PUT",
        headers: {
          [CLI_VERSION_HEADER]: "0.1.0",
          [DEVICE_TOKEN_HEADER]: issued.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          state: desired,
          baseRevision: null,
          idempotencyKey: "key-1",
          transition,
        }),
      },
    ),
    db,
    workspaceId,
  );
  const revision = (await created.json()) as { revisionId: string };

  const accepted = await handlePostDeviceSyncReport(
    reportRequest(issued.deviceId, issued.token, {
      appliedRevisionId: revision.revisionId,
      syncStatus: "SYNCED",
      targets: mixedTargets,
    }),
    db,
    issued.deviceId,
  );
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({
    deviceId: issued.deviceId,
    syncStatus: "PARTIALLY_SYNCED",
    lastErrorCode: "TARGET_ERROR",
    lastErrorMessage: "One agent target failed.",
  });

  const rows = sqlite
    .query(
      `SELECT device_id AS deviceId,
              workspace_id AS workspaceId,
              skill_id AS skillId,
              agent_id AS agentId,
              status,
              error_code AS errorCode,
              error_message AS errorMessage,
              content_hash AS contentHash,
              updated_at AS updatedAt
       FROM device_skill_targets
       ORDER BY agent_id`,
    )
    .all() as Record<string, unknown>[];
  expect(rows).toHaveLength(4);
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        deviceId: issued.deviceId,
        workspaceId,
        skillId: skill,
        agentId: "codex",
        status: "SYNCED",
        errorCode: null,
        errorMessage: null,
        contentHash: "sha256:ok",
      }),
      expect.objectContaining({
        agentId: "pi",
        status: "DRIFTED",
        contentHash: "sha256:drift",
      }),
      expect.objectContaining({
        agentId: "claude-code",
        status: "AUTH_REQUIRED",
        errorCode: "AUTH_REQUIRED",
      }),
      expect.objectContaining({
        agentId: "cursor",
        status: "ERROR",
        errorCode: "TARGET_ERROR",
        errorMessage: "One agent target failed.",
      }),
    ]),
  );
  expect(
    sqlite
      .query("SELECT sql FROM sqlite_master WHERE name = 'devices'")
      .get() as {
      sql: string;
    },
  ).toEqual(
    expect.objectContaining({
      sql: expect.not.stringContaining("json"),
    }),
  );

  const view = await handleGetDeviceTargetStatus(
    new Request(`https://toolmirror.com/api/v1/devices/${issued.deviceId}`, {
      headers: { origin: "https://toolmirror.com" },
    }),
    db,
    issued.deviceId,
    "user_1",
  );
  expect(view.status).toBe(200);
  const body = (await view.json()) as {
    syncStatus: string;
    targets: readonly { agentId: string; status: string }[];
  };
  expect(body.syncStatus).toBe("PARTIALLY_SYNCED");
  expect(body.targets.map((target) => target.status).sort()).toEqual([
    "AUTH_REQUIRED",
    "DRIFTED",
    "ERROR",
    "SYNCED",
  ]);

  const stranger = await handleGetDeviceTargetStatus(
    new Request(`https://toolmirror.com/api/v1/devices/${issued.deviceId}`, {
      headers: { origin: "https://toolmirror.com" },
    }),
    db,
    issued.deviceId,
    "user_other",
  );
  expect(stranger.status).toBe(404);
});

test("postDeviceSyncReport talks to /sync-report without pulling or executing remote sync", async () => {
  const { sqlite, db } = await reportDb();
  const issued = await pairDevice(db, sqlite, "studio", 1_000);
  const workspaceId = issued.workspaceId as string;
  const created = await handlePutWorkspaceState(
    new Request(
      `https://toolmirror.com/api/v1/workspaces/${workspaceId}/state`,
      {
        method: "PUT",
        headers: {
          [CLI_VERSION_HEADER]: "0.1.0",
          [DEVICE_TOKEN_HEADER]: issued.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          state: desired,
          baseRevision: null,
          idempotencyKey: "key-1",
          transition,
        }),
      },
    ),
    db,
    workspaceId,
  );
  const revision = (await created.json()) as { revisionId: string };
  const paths: string[] = [];
  const result = await postDeviceSyncReport({
    origin: "https://toolmirror.com",
    deviceId: issued.deviceId,
    deviceToken: issued.token,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      paths.push(new URL(request.url).pathname);
      expect(request.method).toBe("POST");
      expect(request.url).not.toContain("sync_device");
      expect(request.url).not.toContain("sync_all_devices");
      return handlePostDeviceSyncReport(request, db, issued.deviceId);
    },
    report: {
      appliedRevisionId: revision.revisionId,
      syncStatus: "SYNCED",
    },
  });
  expect(paths).toEqual([`/api/v1/devices/${issued.deviceId}/sync-report`]);
  expect(result).toMatchObject({
    kind: "success",
    value: {
      deviceId: issued.deviceId,
      syncStatus: "SYNCED",
      appliedRevisionSequence: 1,
      lastErrorCode: null,
    },
  });

  const current = await handleGetWorkspaceState(
    new Request(
      `https://toolmirror.com/api/v1/workspaces/${workspaceId}/state`,
      {
        headers: {
          [CLI_VERSION_HEADER]: "0.1.0",
          [DEVICE_TOKEN_HEADER]: issued.token,
        },
      },
    ),
    db,
    workspaceId,
  );
  expect(current.status).toBe(200);
  expect(
    "report" in
      new SaaSProvider({
        origin: "https://toolmirror.com",
        workspaceId,
        deviceToken: issued.token,
      }),
  ).toBe(false);
});
