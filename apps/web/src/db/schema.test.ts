import { expect, test } from "bun:test";

const migration = await Bun.file(
  new URL("../../migrations/0004_thick_landau.sql", import.meta.url),
).text();

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
