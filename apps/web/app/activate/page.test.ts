import { expect, test } from "bun:test";

const page = await Bun.file(`${import.meta.dir}/page.tsx`).text();

test("CLI login opens /activate with the user code query", () => {
  expect(page).toContain('get("code")');
  expect(page).toContain('fetch("/api/v1/cli/pairings/approve"');
  expect(page).toContain("Approve this device");
  expect(page).toContain("Approve device");
  expect(page).toContain("response.status === 401");
  expect(page).toContain("/sign-in?next=");
});
