import { expect, test } from "bun:test";

const surface = await Bun.file(
  `${import.meta.dir}/dashboard-surface.tsx`,
).text();
const css = await Bun.file(`${import.meta.dir}/globals.css`).text();

test("unauthenticated dashboard and settings redirect to /sign-in on 401", () => {
  expect(surface).toContain("response.status === 401");
  expect(surface).toContain('window.location.assign("/sign-in")');
  expect(surface).not.toContain("Authentication required");
});

test("dashboard keeps chrome and renders accessible state panels", () => {
  expect(surface).toContain("dashboard-shell");
  expect(surface).toContain(
    'aria-current={view === item.view ? "page" : undefined}',
  );
  expect(surface).toContain("Desired skills in this workspace");
  expect(surface).toContain('role="alert"');
  expect(surface).toContain("No remote sync is requested.");
  expect(surface).toContain("No target report.");
});

test("billing and settings use the shared dashboard language without new controls", () => {
  expect(surface).toContain("dashboard-billing-panel");
  expect(surface).toContain("This Corotum Cloud instance is self-hosted.");
  expect(surface).toContain('className="dashboard-command"');
  expect(surface).toContain('if (view === "billing")');
  expect(surface).not.toContain("dashboard-legacy");
});

test("skills and devices use semantic status panels without new mutations", () => {
  expect(surface).toContain('if (view === "skills" || view === "devices")');
  expect(surface).toContain('className="dashboard-page-header"');
  expect(surface).toContain('className="dashboard-secondary-button"');
  expect(surface).not.toContain("<th>Lock</th>");
  expect(surface).toContain("Pair a device from the CLI with");
});

test("dashboard operate chrome uses frozen tokens and truthful status chips", () => {
  expect(surface).toContain('href: "/dashboard"');
  expect(surface).toContain('href: "/dashboard/skills"');
  expect(surface).toContain('href: "/dashboard/devices"');
  expect(surface).toContain('href: "/dashboard/billing"');
  expect(surface).toContain('href: "/settings"');
  expect(surface).toContain('className="dashboard-chrome"');
  expect(surface).not.toContain("/dashboard/history");
  expect(surface).not.toContain("dark-mode");
  expect(surface).toContain('StatusLabel status="402"');
  expect(surface).toContain("response.status === 402");
  expect(surface).toContain('? "✓"');
  expect(surface).toContain('? "≠"');
  expect(css).toContain("--paper: #f4eee4");
  expect(css).toContain("--ink: #171512");
  expect(css).toContain("--machine: #20201e");
  expect(css).toContain("--vermillion: #df492f");
  expect(css).toContain(".dashboard-brand-rule { background: var(--vermillion); height: 4px; }");
  expect(css).toContain("max-width: 1120px");
  expect(css).toContain("border-radius: 0");
  expect(css).toContain(
    'font-family: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif',
  );
  expect(css).toContain("transition: none !important");
  expect(css).not.toContain("Inter");
  expect(css).not.toContain("Geist");
  expect(css).toContain("border-top: 14px solid var(--vermillion)");
});
