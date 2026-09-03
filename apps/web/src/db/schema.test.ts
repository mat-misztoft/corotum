import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const migration = await Bun.file(
  new URL("../../migrations/0004_thick_landau.sql", import.meta.url),
).text();

test("v1 workspace rows roll forward without rewriting their snapshots", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const directory = fileURLToPath(new URL("../../migrations/", import.meta.url));
  for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < "0011_yummy_annihilus.sql").sort()) {
    const sql = await Bun.file(join(directory, file)).text();
    for (const statement of sql.split("--> statement-breakpoint")) if (statement.trim()) db.exec(statement);
  }
  db.query("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('u1', 'Ada', 'ada@example.com', 1, 1, 1)").run();
  db.query("INSERT INTO workspaces (id, owner_user_id, name, current_revision_sequence, created_at, updated_at) VALUES ('w1', 'u1', 'Default', 1, 1, 1)").run();
  db.query("INSERT INTO workspace_revisions (id, workspace_id, revision_sequence, manifest_json, lockfile_json, created_at, created_by_type, created_by_id, operation_type, operation_metadata_json) VALUES ('r1', 'w1', 1, '{\"version\":1,\"skills\":[]}', '{\"version\":1,\"skills\":[]}', 1, 'user', 'u1', 'ADD', '{}')").run();
  db.query("INSERT INTO workspace_skills (workspace_id, skill_id, source, skill_name, ref, targets_json, resolution_status, updated_at) VALUES ('w1', 'sk_01JV1Skill', 'https://example.test/skills.git', 'Review', 'main', '\"all\"', 'RESOLVED', 1)").run();
  const upgrade = await Bun.file(join(directory, "0011_yummy_annihilus.sql")).text();
  for (const statement of upgrade.split("--> statement-breakpoint")) if (statement.trim()) db.exec(statement);
  expect(db.query("SELECT manifest_json AS manifest, disposition_ledger_json AS ledger FROM workspace_revisions").get()).toEqual({
    manifest: '{"version":1,"skills":[]}', ledger: '{"version":2,"activeDispositions":{}}',
  });
  expect(db.query("SELECT source, skill_name AS skillName, ref FROM workspace_skills").get()).toEqual({
    source: "https://example.test/skills.git", skillName: "Review", ref: "main",
  });
  expect(() => db.query("INSERT INTO workspace_skills (workspace_id, skill_id, source, skill_name, ref, targets_json, resolution_status, updated_at) VALUES ('w1', 'sk_01JDuplicate', NULL, 'review', NULL, '\"all\"', 'RESOLVED', 2)").run()).toThrow();
  expect(db.query("SELECT COUNT(*) AS count FROM workspace_artifacts").get()).toEqual({ count: 0 });
});

test("device memberships allow history but enforce one active workspace", () => {
  expect(migration).toContain("CREATE TABLE `device_workspaces`");
  expect(migration).toContain(
    "CREATE UNIQUE INDEX `device_workspaces_device_workspace_unique`",
  );
  expect(migration).toContain(
    "CREATE UNIQUE INDEX `device_workspaces_one_active_workspace_unique`",
  );
  expect(migration).toContain('WHERE "device_workspaces"."is_active" = 1');
});

test("device agent data is limited to approved identifiers and statuses", () => {
  expect(migration).toContain("CREATE TABLE `device_agents`");
  expect(migration).toContain("device_agents_agent_id_check");
  expect(migration).toContain(
    "'codex', 'claude-code', 'pi', 'gemini-cli', 'opencode', 'cursor', 'windsurf', 'cline', 'roo-code', 'github-copilot', 'kiro-cli'",
  );
  expect(migration).toContain("'DETECTED', 'ENABLED', 'DISABLED'");
});

test("devices retain only device metadata, never filesystem or target-state blobs", () => {
  const devices = migration.match(/CREATE TABLE `devices` \([\s\S]*?\);/)?.[0];
  expect(devices).toBeDefined();
  expect(devices).not.toContain("path");
  expect(devices).not.toContain("status_json");
});

test("device update checks retain only skill IDs, status, and check time", async () => {
  const updates = await Bun.file(
    new URL("../../migrations/0010_sharp_landau.sql", import.meta.url),
  ).text();
  expect(updates).toContain("CREATE TABLE `device_skill_updates`");
  expect(updates).toContain("device_skill_updates_unique");
  expect(updates).toContain(
    "'UP_TO_DATE', 'UPDATE_AVAILABLE', 'UNKNOWN', 'AUTH_REQUIRED', 'CHECK_FAILED'",
  );
  expect(updates).not.toContain("repository");
  expect(updates).not.toContain("path");
  expect(updates).not.toContain("credential");
});

test("device skill targets live in dedicated relational rows", async () => {
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const directory = fileURLToPath(
    new URL("../../migrations/", import.meta.url),
  );
  const sql = (
    await Promise.all(
      readdirSync(directory)
        .filter((file) => file.endsWith(".sql"))
        .map((file) => Bun.file(join(directory, file)).text()),
    )
  ).join("\n");
  expect(sql).toContain("CREATE TABLE `device_skill_targets`");
  expect(sql).toContain("`skill_id`");
  expect(sql).toContain("`agent_id`");
  expect(sql).toContain("`content_hash`");
  expect(sql).toContain("device_skill_targets_unique");
  expect(sql).toContain("'SYNCED', 'DRIFTED', 'AUTH_REQUIRED', 'ERROR'");
});

test("account rows store Better Auth issuer keys", async () => {
  const sql = await Bun.file(
    new URL("../../migrations/0012_faulty_nighthawk.sql", import.meta.url),
  ).text();
  expect(sql).toContain("ADD `issuer`");
  expect(sql).toContain("local:oauth:");
  expect(sql).toContain("account_issuer_account_id_unique");
});
