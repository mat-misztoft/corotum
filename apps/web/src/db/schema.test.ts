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
