import { expect, test } from "bun:test";

const source = await Bun.file(`${import.meta.dir}/webmcp-tools.tsx`).text();

test("dashboard registers the planned WebMCP tools through document.modelContext", () => {
  for (const tool of [
    "list_skills",
    "list_devices",
    "get_sync_status",
    "check_skill_updates",
  ])
    expect(source).toContain(`"${tool}"`);
  for (const tool of [
    "add_skill",
    "remove_skill",
    "update_skill",
    "set_skill_ref",
  ])
    expect(source).toContain(`name: "${tool}"`);
  expect(source).toContain("modelContext.registerTool");
  expect(source).toContain('fetch("/api/v1/webmcp"');
  expect(source).toContain('fetch("/api/v1/dashboard"');
});

test("landing exposes only a dashboard navigation tool", () => {
  expect(source).toContain('name: "open_dashboard"');
  expect(source).toContain('window.location.assign("/dashboard")');
  expect(source).toContain("? [openDashboardTool]");
  expect(source).toContain(": dashboardTools.map");
});
