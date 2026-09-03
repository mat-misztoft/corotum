import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { skillId } from "../../../packages/core/src/index";
import {
  CLI_VERSION_HEADER,
  DEVICE_TOKEN_HEADER,
  SaaSProvider,
  UNINITIALIZED_CLOUD_REVISION,
} from "../../../packages/saas-provider/src/index";
import { approvePairing, createPairing } from "./pairings";
import {
  handleGetWorkspaceState,
  handlePostPendingResolution,
  handlePutWorkspaceState,
} from "./state-http";
import { issueDeviceToken, type TokenDatabase } from "./tokens";

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
const skill = skillId("sk_01JSaasState");
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

async function stateDb() {
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

async function pairedDevice(db: TokenDatabase, sqlite: Database) {
  sqlite
    .query(
      "INSERT OR IGNORE INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
    .run("user_1", "Ada", "ada@example.com", Date.now(), Date.now());
  const pairing = await createPairing(db, device, 1_000);
  await approvePairing(db, "user_1", pairing.id, pairing.userCode, 2_000);
  const issued = await issueDeviceToken(
    db,
    pairing.id,
    pairing.deviceCode,
    3_000,
  );
  return { issued, workspaceId: issued.workspaceId as string };
}

function apiRequest(
  path: string,
  init?: ConstructorParameters<typeof Request>[1],
) {
  return new Request(`https://corotum.com${path}`, init);
}

function stateRequest(
  workspaceId: string,
  token: string,
  init?: ConstructorParameters<typeof Request>[1],
) {
  return apiRequest(`/api/v1/workspaces/${workspaceId}/state`, {
    ...init,
    headers: {
      [CLI_VERSION_HEADER]: "0.1.0",
      [DEVICE_TOKEN_HEADER]: token,
      ...(init?.headers ?? {}),
    },
  });
}

test("an authenticated device can pull empty Cloud state and push an idempotent update", async () => {
  const { sqlite, db } = await stateDb();
  const { issued, workspaceId } = await pairedDevice(db, sqlite);

  const empty = await handleGetWorkspaceState(
    stateRequest(workspaceId, issued.token),
    db,
    workspaceId,
  );
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({
    revisionId: null,
    revisionSequence: 0,
    state: {
      manifest: { version: 1, skills: [] },
      lockfile: { version: 1, skills: [] },
    },
    dispositionLedger: { version: 2, activeDispositions: {} },
  });

  const created = await handlePutWorkspaceState(
    stateRequest(workspaceId, issued.token, {
      method: "PUT",
      body: JSON.stringify({
        state: desired,
        baseRevision: null,
        idempotencyKey: "key-1",
        transition,
      }),
    }),
    db,
    workspaceId,
  );
  expect(created.status).toBe(200);
  const first = (await created.json()) as {
    revisionId: string;
    revisionSequence: number;
    state: unknown;
  };
  expect(first.revisionSequence).toBe(1);
  expect(first.state).toEqual(desired);
  expect(
    sqlite
      .query(
        "SELECT skill_id AS skillId, workspace_id AS workspaceId FROM workspace_skills",
      )
      .all(),
  ).toEqual([{ skillId: skill, workspaceId }]);

  const retry = await handlePutWorkspaceState(
    stateRequest(workspaceId, issued.token, {
      method: "PUT",
      body: JSON.stringify({
        state: desired,
        baseRevision: null,
        idempotencyKey: "key-1",
        transition,
      }),
    }),
    db,
    workspaceId,
  );
  expect(await retry.json()).toEqual(first);
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM workspace_revisions").get(),
  ).toEqual({ count: 1 });

  const stale = await handlePutWorkspaceState(
    stateRequest(workspaceId, issued.token, {
      method: "PUT",
      body: JSON.stringify({
        state: desired,
        baseRevision: "rev_stale",
        idempotencyKey: "key-2",
        transition,
      }),
    }),
    db,
    workspaceId,
  );
  expect(stale.status).toBe(409);
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM workspace_revisions").get(),
  ).toEqual({ count: 1 });
});

test("v2 artifact locks atomically materialize nullable source rows and immutable references", async () => {
  const { sqlite, db } = await stateDb();
  const { issued, workspaceId } = await pairedDevice(db, sqlite);
  const hash = `sha256:${"a".repeat(64)}`;
  const artifactState = {
    manifest: {
      version: 2 as const,
      skills: [
        {
          id: skill,
          name: "review",
          targets: "all" as const,
          resolutionStatus: "RESOLVED" as const,
        },
      ],
    },
    lockfile: {
      version: 2 as const,
      skills: [
        {
          id: skill,
          name: "review",
          materialization: {
            kind: "artifact" as const,
            artifact: {
              kind: "r2-tar-zst" as const,
              contentHash: hash,
              integrityHash: hash,
              locator: `workspaces/${workspaceId}/artifacts/${skill}/${hash}.tar.zst`,
              sizeBytes: 42,
            },
          },
        },
      ],
    },
  };
  const ledger = {
    version: 2,
    activeDispositions: {
      sk_01JRemoved: {
        skillId: "sk_01JRemoved",
        name: "removed",
        disposition: "UNMANAGE",
        effectiveSequence: 1,
      },
    },
  };
  const response = await handlePutWorkspaceState(
    stateRequest(workspaceId, issued.token, {
      method: "PUT",
      body: JSON.stringify({
        state: artifactState,
        baseRevision: null,
        idempotencyKey: "v2-artifact-1",
        transition,
        dispositionLedger: ledger,
      }),
    }),
    db,
    workspaceId,
  );
  expect(response.status).toBe(200);
  expect(
    sqlite
      .query(
        "SELECT source, ref, content_hash AS contentHash FROM workspace_skills",
      )
      .get(),
  ).toEqual({ source: null, ref: null, contentHash: hash });
  expect(
    sqlite
      .query("SELECT locator, size_bytes AS sizeBytes FROM workspace_artifacts")
      .get(),
  ).toEqual({
    locator: artifactState.lockfile.skills[0].materialization.artifact.locator,
    sizeBytes: 42,
  });
  expect(
    sqlite
      .query(
        "SELECT skill_id AS skillId, integrity_hash AS integrityHash FROM workspace_revision_artifacts",
      )
      .get(),
  ).toEqual({ skillId: skill, integrityHash: hash });
  expect(
    JSON.parse(
      (
        sqlite
          .query(
            "SELECT disposition_ledger_json AS ledger FROM workspace_revisions",
          )
          .get() as { ledger: string }
      ).ledger,
    ),
  ).toEqual(ledger);
  const stale = await handlePutWorkspaceState(
    stateRequest(workspaceId, issued.token, {
      method: "PUT",
      body: JSON.stringify({
        state: artifactState,
        baseRevision: "rev_stale",
        idempotencyKey: "v2-artifact-stale",
        transition,
      }),
    }),
    db,
    workspaceId,
  );
  expect(stale.status).toBe(409);
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM workspace_artifacts").get(),
  ).toEqual({ count: 1 });
  expect(
    sqlite
      .query("SELECT COUNT(*) AS count FROM workspace_revision_artifacts")
      .get(),
  ).toEqual({ count: 1 });
});

test("the first device resolution locks a pending skill once and a competing resolver conflicts", async () => {
  const { sqlite, db } = await stateDb();
  const firstDevice = await pairedDevice(db, sqlite);
  const secondDevice = await pairedDevice(db, sqlite);
  const pending = {
    manifest: {
      version: 1 as const,
      skills: [
        {
          ...desired.manifest.skills[0],
          resolutionStatus: "PENDING_RESOLUTION" as const,
        },
      ],
    },
    lockfile: { version: 1 as const, skills: [] },
  };
  const created = await handlePutWorkspaceState(
    stateRequest(firstDevice.workspaceId, firstDevice.issued.token, {
      method: "PUT",
      body: JSON.stringify({
        state: pending,
        baseRevision: null,
        idempotencyKey: "pending-1",
        transition,
      }),
    }),
    db,
    firstDevice.workspaceId,
  );
  const baseRevision = ((await created.json()) as { revisionId: string })
    .revisionId;
  const resolution = {
    skillId: skill,
    baseRevision,
    idempotencyKey: "resolve-1",
    repository: source,
    revision: "abc123",
    path: "skills/review",
    contentHash: "sha256:locked",
  };
  const winner = await handlePostPendingResolution(
    stateRequest(firstDevice.workspaceId, firstDevice.issued.token, {
      method: "POST",
      body: JSON.stringify(resolution),
    }),
    db,
    firstDevice.workspaceId,
  );
  expect(winner.status).toBe(200);
  expect(((await winner.json()) as { state: typeof desired }).state).toEqual(
    desired,
  );
  const loser = await handlePostPendingResolution(
    stateRequest(secondDevice.workspaceId, secondDevice.issued.token, {
      method: "POST",
      body: JSON.stringify({ ...resolution, idempotencyKey: "resolve-2" }),
    }),
    db,
    secondDevice.workspaceId,
  );
  expect(loser.status).toBe(409);
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM workspace_revisions").get(),
  ).toEqual({ count: 2 });
  expect(
    sqlite
      .query(
        "SELECT repository, locked_revision AS revision FROM workspace_skills",
      )
      .get(),
  ).toEqual({ repository: source, revision: "abc123" });
});

test("the first device resolution locks a v2 pending skill once and a competing resolver conflicts", async () => {
  const { sqlite, db } = await stateDb();
  const firstDevice = await pairedDevice(db, sqlite);
  const secondDevice = await pairedDevice(db, sqlite);
  const revision = "a".repeat(40);
  const contentHash = `sha256:${"b".repeat(64)}`;
  const pending = {
    manifest: {
      version: 2 as const,
      skills: [
        {
          id: skill,
          name: "review",
          targets: "all" as const,
          source: { repository: source, path: "skills/review", ref: "main" },
          resolutionStatus: "PENDING_RESOLUTION" as const,
        },
      ],
    },
    lockfile: { version: 2 as const, skills: [] },
  };
  const created = await handlePutWorkspaceState(
    stateRequest(firstDevice.workspaceId, firstDevice.issued.token, {
      method: "PUT",
      body: JSON.stringify({
        state: pending,
        baseRevision: null,
        idempotencyKey: "v2-pending-1",
        transition,
      }),
    }),
    db,
    firstDevice.workspaceId,
  );
  expect(created.status).toBe(200);
  const baseRevision = ((await created.json()) as { revisionId: string })
    .revisionId;
  const resolution = {
    skillId: skill,
    baseRevision,
    idempotencyKey: "v2-resolve-1",
    repository: source,
    revision,
    path: "skills/review",
    contentHash,
  };
  const winner = await handlePostPendingResolution(
    stateRequest(firstDevice.workspaceId, firstDevice.issued.token, {
      method: "POST",
      body: JSON.stringify(resolution),
    }),
    db,
    firstDevice.workspaceId,
  );
  expect(winner.status).toBe(200);
  const locked = (await winner.json()) as {
    state: {
      manifest: { skills: { resolutionStatus: string }[] };
      lockfile: { skills: { source?: { revision: string } }[] };
    };
  };
  expect(locked.state.manifest.skills[0]?.resolutionStatus).toBe("RESOLVED");
  expect(locked.state.lockfile.skills[0]?.source?.revision).toBe(revision);
  const loser = await handlePostPendingResolution(
    stateRequest(secondDevice.workspaceId, secondDevice.issued.token, {
      method: "POST",
      body: JSON.stringify({ ...resolution, idempotencyKey: "v2-resolve-2" }),
    }),
    db,
    secondDevice.workspaceId,
  );
  expect(loser.status).toBe(409);
  expect(
    sqlite.query("SELECT COUNT(*) AS count FROM workspace_revisions").get(),
  ).toEqual({ count: 2 });
});

test("device-token SaaSProvider pull/push talks to /api/v1 without login or reporting", async () => {
  const { sqlite, db } = await stateDb();
  const { issued, workspaceId } = await pairedDevice(db, sqlite);
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.pathname).toBe(`/api/v1/workspaces/${workspaceId}/state`);
    expect(url.pathname).not.toContain("login");
    expect(url.pathname).not.toContain("report");
    expect(url.pathname).not.toContain("pairings");
    if (request.method === "GET") {
      return handleGetWorkspaceState(request, db, workspaceId);
    }
    return handlePutWorkspaceState(request, db, workspaceId);
  };
  const provider = new SaaSProvider({
    origin: "https://corotum.com",
    workspaceId,
    deviceToken: issued.token,
    fetch: fetchImpl,
  });

  const pulled = await provider.pull();
  expect(pulled).toMatchObject({
    kind: "success",
    value: {
      revisionId: UNINITIALIZED_CLOUD_REVISION,
      revisionSequence: 0,
    },
  });

  if (pulled.kind !== "success") throw new Error("expected pull success");
  const pushed = await provider.push(
    {
      state: desired,
      baseRevision: pulled.value.revisionId,
      idempotencyKey: "provider-1",
    },
    transition,
  );
  expect(pushed).toMatchObject({
    kind: "success",
    value: { revisionSequence: 1, state: desired },
  });
  if (pushed.kind !== "success") throw new Error("expected push success");

  const conflict = await provider.push(
    { state: desired, baseRevision: null, idempotencyKey: "provider-2" },
    transition,
  );
  expect(conflict).toMatchObject({
    kind: "failure",
    error: { code: "CONFLICT" },
  });

  const replay = await provider.push(
    { state: desired, baseRevision: null, idempotencyKey: "provider-1" },
    transition,
  );
  expect(replay).toEqual(pushed);
});

test("workspace state requires a device token and a compatible CLI", async () => {
  const { sqlite, db } = await stateDb();
  const { workspaceId } = await pairedDevice(db, sqlite);
  const missingToken = await handleGetWorkspaceState(
    apiRequest(`/api/v1/workspaces/${workspaceId}/state`, {
      headers: { [CLI_VERSION_HEADER]: "0.1.0" },
    }),
    db,
    workspaceId,
  );
  expect(missingToken.status).toBe(401);

  const incompatible = await handleGetWorkspaceState(
    apiRequest(`/api/v1/workspaces/${workspaceId}/state`, {
      headers: { [CLI_VERSION_HEADER]: "0.0.1" },
    }),
    db,
    workspaceId,
  );
  expect(incompatible.status).toBe(426);
});
