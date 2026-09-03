import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { skillId, validateV2DesiredState, type V2DesiredState } from "../../../packages/core/src/index";
import { HostedEntitlementRequiredError } from "./billing";
import {
  handleDashboardGet,
  handleDashboardMutation,
} from "./dashboard-http";
import { projectDashboardSkills, projectedDeviceSyncStatus, readDashboard } from "./dashboard";
import { acceptDeviceSyncReport } from "./sync-report";
import {
  ArtifactTransferError,
  cloudArtifactLocator,
  getWorkspaceArtifact,
} from "./artifacts";
import { mutateDesiredState } from "./revisions";
import { executeWebMcpMutationTool, executeWebMcpReadOnlyTool } from "./webmcp";
import { ensureDefaultWorkspace, type WorkspaceDatabase } from "./workspaces";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort();

const sourceId = skillId("sk_01JDashSource");
const provenId = skillId("sk_01JDashProven");
const orphanId = skillId("sk_01JDashOrphan");
const pendingId = skillId("sk_01JDashPending");
const foreignId = skillId("sk_01JDashForeign");
const repository = "https://github.com/example/skills.git";
const revision = "a".repeat(40);
const contentHash = `sha256:${"b".repeat(64)}` as const;
const integrityHash = `sha256:${"c".repeat(64)}` as const;
const sourceMeta = { repository, path: "skills/review", ref: "main" };

async function dashboardDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
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
  };
  return { sqlite, db: db as WorkspaceDatabase & { batch: typeof db.batch } };
}

function insertUser(sqlite: Database, id: string, email: string) {
  sqlite
    .query(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
    .run(id, id, email, Date.now(), Date.now());
}

function artifact(workspaceId: string, skill: string) {
  const locator = cloudArtifactLocator(workspaceId, skill, integrityHash);
  return {
    kind: "r2-tar-zst" as const,
    contentHash,
    integrityHash,
    locator,
    sizeBytes: 42,
  };
}

function fourStateDesired(workspaceId: string): V2DesiredState {
  const art = artifact(workspaceId, provenId);
  const orphan = artifact(workspaceId, orphanId);
  return {
    manifest: {
      version: 2,
      skills: [
        { id: sourceId, name: "source", targets: "all", source: sourceMeta, resolutionStatus: "RESOLVED" },
        { id: provenId, name: "proven", targets: "all", source: sourceMeta, resolutionStatus: "RESOLVED" },
        { id: orphanId, name: "orphan", targets: "all", source: null, resolutionStatus: "RESOLVED" },
        { id: pendingId, name: "pending", targets: "all", source: sourceMeta, resolutionStatus: "PENDING_RESOLUTION" },
      ],
    },
    lockfile: {
      version: 2,
      skills: [
        {
          id: sourceId,
          name: "source",
          source: { ...sourceMeta, revision, contentHash },
          materialization: { kind: "source", contentHash },
        },
        { id: provenId, name: "proven", materialization: { kind: "artifact", artifact: art } },
        { id: orphanId, name: "orphan", materialization: { kind: "artifact", artifact: orphan } },
      ],
    },
  };
}

function forbiddenPayloadText(workspaceId: string) {
  return [
    cloudArtifactLocator(workspaceId, provenId, integrityHash),
    cloudArtifactLocator(workspaceId, orphanId, integrityHash),
    "workspaces/",
    ".tar.zst",
    sourceMeta.path,
    "/Users/",
    ".corotumignore",
    ".env",
    "id_rsa",
    "secret-token",
  ];
}

function assertSanitized(body: unknown, workspaceId: string) {
  const encoded = JSON.stringify(body);
  for (const leak of forbiddenPayloadText(workspaceId)) {
    expect(encoded.includes(leak)).toBe(false);
  }
  expect(encoded).not.toContain("locator");
  expect(encoded).not.toContain("integrityHash");
  expect(encoded).not.toContain("sizeBytes");
}

test("projectDashboardSkills maps the four v2 materialization states without lock internals", () => {
  const state = fourStateDesired("ws_example");
  expect(projectDashboardSkills(state)).toEqual([
    { id: sourceId, skill: "source", ref: "main", targets: "all", resolutionStatus: "RESOLVED", locked: true, materialization: "source-backed" },
    { id: provenId, skill: "proven", ref: "main", targets: "all", resolutionStatus: "RESOLVED", locked: true, materialization: "artifact-backed-with-provenance" },
    { id: orphanId, skill: "orphan", ref: "", targets: "all", resolutionStatus: "RESOLVED", locked: true, materialization: "artifact-backed-without-source" },
    { id: pendingId, skill: "pending", ref: "main", targets: "all", resolutionStatus: "PENDING_RESOLUTION", locked: false, materialization: "pending-resolution" },
  ]);
});

test("authorized dashboard and WebMCP responses expose only semantic materialization fields", async () => {
  const { sqlite, db } = await dashboardDb();
  insertUser(sqlite, "user_1", "ada@example.com");
  const workspace = await ensureDefaultWorkspace(db, "user_1");
  const state = fourStateDesired(workspace.id);
  await mutateDesiredState(db, {
    workspaceId: workspace.id,
    userId: "user_1",
    baseRevisionId: null,
    idempotencyKey: "dash-v2-1",
    actor: { type: "user", id: "user_1" },
    state,
    transition: { type: "ADD", skillId: sourceId, metadata: {} },
  });
  sqlite
    .query(
      "INSERT INTO devices (id, user_id, name, platform, architecture, cli_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("dev_1", "user_1", "Mac", "darwin", "arm64", "0.1.0", Date.now());
  sqlite
    .query(
      `INSERT INTO device_workspaces
        (device_id, workspace_id, is_active, applied_revision_sequence, sync_status, last_sync_at, last_error_code, last_error_message)
       VALUES (?, ?, 1, 0, 'BEHIND', ?, 'TARGET_ERROR', ?)`,
    )
    .run("dev_1", workspace.id, Date.now(), "Failed to write /Users/ada/.agents/skills/source");
  sqlite
    .query(
      `INSERT INTO device_skill_targets
        (device_id, workspace_id, skill_id, agent_id, status, error_code, error_message, content_hash, updated_at)
       VALUES (?, ?, ?, 'pi', 'DRIFTED', NULL, ?, ?, ?)`,
    )
    .run("dev_1", workspace.id, sourceId, "ignored .corotumignore result", contentHash, Date.now());

  const view = await readDashboard(db as never, "user_1");
  expect(view.skills).toEqual(projectDashboardSkills(validateV2DesiredState(state)));
  expect(view.devices[0]).toMatchObject({
    id: "dev_1",
    syncStatus: "BEHIND",
    appliedRevisionSequence: 0,
    lastErrorMessage: "A local target failed.",
    targets: [{ skillId: sourceId, agentId: "pi", status: "DRIFTED", errorMessage: "A local target failed." }],
  });
  assertSanitized(view, workspace.id);

  const response = await handleDashboardGet(db as never, "user_1");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.skills.map((skill: { materialization: string }) => skill.materialization)).toEqual([
    "artifact-backed-without-source",
    "pending-resolution",
    "artifact-backed-with-provenance",
    "source-backed",
  ]);
  assertSanitized(body, workspace.id);

  const listed = await executeWebMcpReadOnlyTool(db as never, {
    userId: "user_1",
    hosted: false,
    tool: "list_skills",
  });
  expect(listed).toMatchObject({ skills: view.skills, revision: view.revision });
  assertSanitized(listed, workspace.id);

  await expect(
    getWorkspaceArtifact(
      {
        async put() {},
        async get() { return null; },
        async list() { return { keys: [], truncated: false }; },
        async delete() {},
      },
      {
        workspaceId: workspace.id,
        transfer: { skillId: provenId, artifact: artifact(workspace.id, provenId) },
      },
    ),
  ).rejects.toBeInstanceOf(ArtifactTransferError);
  const afterR2Failure = await handleDashboardGet(db as never, "user_1");
  expect(afterR2Failure.status).toBe(200);
  assertSanitized(await afterR2Failure.json(), workspace.id);
});

test("a workspace cannot read another workspace's materialization or device status", async () => {
  const { sqlite, db } = await dashboardDb();
  insertUser(sqlite, "user_1", "ada@example.com");
  insertUser(sqlite, "user_2", "grace@example.com");
  const first = await ensureDefaultWorkspace(db, "user_1");
  const second = await ensureDefaultWorkspace(db, "user_2");
  await mutateDesiredState(db, {
    workspaceId: first.id,
    userId: "user_1",
    baseRevisionId: null,
    idempotencyKey: "owner-1",
    actor: { type: "user", id: "user_1" },
    state: fourStateDesired(first.id),
    transition: { type: "ADD", skillId: sourceId, metadata: {} },
  });
  await mutateDesiredState(db, {
    workspaceId: second.id,
    userId: "user_2",
    baseRevisionId: null,
    idempotencyKey: "owner-2",
    actor: { type: "user", id: "user_2" },
    state: {
      manifest: {
        version: 2,
        skills: [{ id: foreignId, name: "foreign", targets: "all", resolutionStatus: "RESOLVED" }],
      },
      lockfile: {
        version: 2,
        skills: [{
          id: foreignId,
          name: "foreign",
          materialization: { kind: "artifact", artifact: artifact(second.id, foreignId) },
        }],
      },
    },
    transition: { type: "ADD", skillId: foreignId, metadata: {} },
  });
  sqlite
    .query(
      "INSERT INTO devices (id, user_id, name, platform, architecture, cli_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("dev_2", "user_2", "Studio", "linux", "x64", "0.1.0", Date.now());
  sqlite
    .query(
      "INSERT INTO device_workspaces (device_id, workspace_id, is_active, applied_revision_sequence, sync_status) VALUES (?, ?, 1, 1, 'SYNCED')",
    )
    .run("dev_2", second.id);

  const ada = await readDashboard(db as never, "user_1");
  const grace = await readDashboard(db as never, "user_2");
  expect(ada.workspace.id).toBe(first.id);
  expect(grace.workspace.id).toBe(second.id);
  expect(ada.skills.map((skill) => skill.id)).toEqual([orphanId, pendingId, provenId, sourceId]);
  expect(grace.skills).toEqual([{
    id: foreignId,
    skill: "foreign",
    ref: "",
    targets: "all",
    resolutionStatus: "RESOLVED",
    locked: true,
    materialization: "artifact-backed-without-source",
  }]);
  expect(ada.devices).toEqual([]);
  expect(grace.devices.map((device) => device.id)).toEqual(["dev_2"]);
  assertSanitized(ada, first.id);
  assertSanitized(grace, second.id);
});

test("pending resolution, hosted entitlement and truthful target status keep existing behavior", async () => {
  const { sqlite, db } = await dashboardDb();
  insertUser(sqlite, "user_1", "ada@example.com");
  expect((await handleDashboardGet(db as never, null)).status).toBe(401);

  const created = await handleDashboardMutation(
    new Request("https://corotum.com/api/v1/dashboard", {
      method: "POST",
      headers: { origin: "https://corotum.com", "content-type": "application/json" },
      body: JSON.stringify({
        baseRevisionId: null,
        idempotencyKey: "pending-add",
        mutation: { type: "ADD", source: repository, skill: "review", ref: "main" },
      }),
    }),
    db as never,
    "user_1",
    false,
  );
  expect(created.status).toBe(200);
  const mutation = await created.json() as { pendingResolution: string[] };
  expect(mutation.pendingResolution).toHaveLength(1);

  const view = await readDashboard(db as never, "user_1");
  expect(view.skills).toEqual([{
    id: mutation.pendingResolution[0],
    skill: "review",
    ref: "main",
    targets: "all",
    resolutionStatus: "PENDING_RESOLUTION",
    locked: false,
    materialization: "pending-resolution",
  }]);

  await expect(executeWebMcpReadOnlyTool(db as never, {
    userId: "user_1",
    hosted: true,
    tool: "list_skills",
  })).rejects.toBeInstanceOf(HostedEntitlementRequiredError);

  await expect(handleDashboardMutation(
    new Request("https://corotum.com/api/v1/dashboard", {
      method: "POST",
      headers: { origin: "https://corotum.com", "content-type": "application/json" },
      body: JSON.stringify({
        baseRevisionId: view.revision.id,
        idempotencyKey: "hosted-denied",
        mutation: { type: "UPDATE", skillId: mutation.pendingResolution[0] },
      }),
    }),
    db as never,
    "user_1",
    true,
  ).then((response) => response.status)).resolves.toBe(402);
});

test("projected device status never claims SYNCED ahead of the applied revision", () => {
  expect(projectedDeviceSyncStatus("SYNCED", 1, 1)).toBe("SYNCED");
  expect(projectedDeviceSyncStatus("SYNCED", 1, 2)).toBe("BEHIND");
  expect(projectedDeviceSyncStatus("ERROR", 1, 2)).toBe("ERROR");
  expect(projectedDeviceSyncStatus("NEVER_SYNCED", 0, 1)).toBe("NEVER_SYNCED");
});

test("dashboard and WebMCP mutations write Cloud revisions and keep devices BEHIND until they report", async () => {
  const { sqlite, db } = await dashboardDb();
  insertUser(sqlite, "user_1", "ada@example.com");
  const created = await handleDashboardMutation(
    new Request("https://corotum.com/api/v1/dashboard", {
      method: "POST",
      headers: { origin: "https://corotum.com", "content-type": "application/json" },
      body: JSON.stringify({
        baseRevisionId: null,
        idempotencyKey: "truth-add",
        mutation: { type: "ADD", source: repository, skill: "review", ref: "main", path: "skills/review" },
      }),
    }),
    db as never,
    "user_1",
    false,
  );
  expect(created.status).toBe(200);
  const added = await created.json() as { revisionId: string; revisionSequence: number; pendingResolution: string[] };
  expect(added.revisionSequence).toBe(1);
  expect(added.pendingResolution).toHaveLength(1);
  const skillIdValue = added.pendingResolution[0]!;

  const workspace = await ensureDefaultWorkspace(db, "user_1");
  sqlite
    .query("INSERT INTO devices (id, user_id, name, platform, architecture, cli_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("dev_truth", "user_1", "Mac", "darwin", "arm64", "0.1.0", Date.now());
  sqlite
    .query("INSERT INTO device_workspaces (device_id, workspace_id, is_active, applied_revision_sequence, sync_status) VALUES (?, ?, 1, 0, 'SYNCED')")
    .run("dev_truth", workspace.id);

  const behind = await readDashboard(db as never, "user_1");
  expect(behind.skills[0]).toMatchObject({
    id: skillIdValue,
    skill: "review",
    ref: "main",
    resolutionStatus: "PENDING_RESOLUTION",
    locked: false,
    materialization: "pending-resolution",
  });
  expect(behind.devices[0]).toMatchObject({
    id: "dev_truth",
    appliedRevisionSequence: 0,
    syncStatus: "BEHIND",
  });

  const webStatus = await executeWebMcpReadOnlyTool(db as never, {
    userId: "user_1",
    hosted: false,
    tool: "get_sync_status",
  });
  expect(webStatus).toMatchObject({
    revision: { sequence: 1 },
    devices: [{ id: "dev_truth", syncStatus: "BEHIND" }],
  });

  const refreshed = await executeWebMcpMutationTool(db as never, {
    userId: "user_1",
    hosted: false,
    tool: "update_skill",
    baseRevisionId: added.revisionId,
    idempotencyKey: "truth-update",
    arguments: { skillId: skillIdValue },
  });
  expect(refreshed.revisionSequence).toBe(2);
  expect(refreshed.pendingResolution).toEqual([skillIdValue]);

  const updated = await executeWebMcpMutationTool(db as never, {
    userId: "user_1",
    hosted: false,
    tool: "set_skill_ref",
    baseRevisionId: refreshed.revisionId,
    idempotencyKey: "truth-set-ref",
    arguments: { skillId: skillIdValue, ref: "v2" },
  });
  expect(updated.revisionSequence).toBe(3);
  expect(updated.pendingResolution).toEqual([skillIdValue]);

  const stillBehind = await readDashboard(db as never, "user_1");
  expect(stillBehind.skills[0]).toMatchObject({ ref: "v2", resolutionStatus: "PENDING_RESOLUTION" });
  expect(stillBehind.devices[0]?.syncStatus).toBe("BEHIND");

  const removed = await handleDashboardMutation(
    new Request("https://corotum.com/api/v1/dashboard", {
      method: "POST",
      headers: { origin: "https://corotum.com", "content-type": "application/json" },
      body: JSON.stringify({
        baseRevisionId: updated.revisionId,
        idempotencyKey: "truth-remove",
        mutation: { type: "REMOVE", skillId: skillIdValue },
      }),
    }),
    db as never,
    "user_1",
    false,
  );
  expect(removed.status).toBe(200);
  const removedBody = await removed.json() as { revisionId: string; revisionSequence: number };
  expect(removedBody.revisionSequence).toBe(4);

  const reported = await acceptDeviceSyncReport(db as never, {
    deviceId: "dev_truth",
    appliedRevisionId: removedBody.revisionId,
    syncStatus: "SYNCED",
    lastErrorCode: null,
    lastErrorMessage: null,
    targets: [],
  });
  expect(reported.syncStatus).toBe("SYNCED");
  expect(reported.appliedRevisionSequence).toBe(4);
  expect((await readDashboard(db as never, "user_1")).devices[0]?.syncStatus).toBe("SYNCED");

  const hostedDenied = await handleDashboardMutation(
    new Request("https://corotum.com/api/v1/dashboard", {
      method: "POST",
      headers: { origin: "https://corotum.com", "content-type": "application/json" },
      body: JSON.stringify({
        baseRevisionId: removedBody.revisionId,
        idempotencyKey: "hosted-add-denied",
        mutation: { type: "ADD", source: repository, skill: "other", ref: "main" },
      }),
    }),
    db as never,
    "user_1",
    true,
  );
  expect(hostedDenied.status).toBe(402);
  await expect(executeWebMcpMutationTool(db as never, {
    userId: "user_1",
    hosted: true,
    tool: "add_skill",
    baseRevisionId: removedBody.revisionId,
    idempotencyKey: "hosted-webmcp-denied",
    arguments: { source: repository, skill: "other" },
  })).rejects.toBeInstanceOf(HostedEntitlementRequiredError);
});
