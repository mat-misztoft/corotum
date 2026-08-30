import { expect, test } from "bun:test";

const surface = await Bun.file(
  `${import.meta.dir}/dashboard-surface.tsx`,
).text();

test("unauthenticated dashboard and settings redirect to /sign-in on 401", () => {
  expect(surface).toContain("response.status === 401");
  expect(surface).toContain('window.location.assign("/sign-in")');
  expect(surface).not.toContain("Authentication required");
});

test("overview keeps dashboard chrome and renders accessible state panels", () => {
  expect(surface).toContain("dashboard-shell");
  expect(surface).toContain(
    'aria-current={view === item.view ? "page" : undefined}',
  );
  expect(surface).toContain("Desired skills in this workspace");
  expect(surface).toContain('role="alert"');
  expect(surface).toContain("No remote sync is requested.");
  expect(surface).toContain("No target report.");
});
