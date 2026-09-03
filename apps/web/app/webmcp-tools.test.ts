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
  expect(source).toContain("readOnlyHint: true");
  expect(source).toContain("additionalProperties: false");
  expect(source).toContain('fetch("/api/v1/webmcp"');
  expect(source).toContain('fetch("/api/v1/dashboard"');
});
