import { expect, test } from "bun:test";

const surface = await Bun.file(`${import.meta.dir}/dashboard-surface.tsx`).text();

test("unauthenticated dashboard and settings redirect to /sign-in on 401", () => {
  expect(surface).toContain("response.status === 401");
  expect(surface).toContain('window.location.assign("/sign-in")');
  expect(surface).not.toContain("Authentication required");
});
