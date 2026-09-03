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
  expect(surface).toContain('window.open(url, "_blank", "noopener,noreferrer")');
  expect(surface).toContain('settings.subscription.status === "paid"');
  expect(surface).toContain("`Connect ${label}`");
  expect(surface).toContain("`Disconnect ${label}`");
  expect(surface).toContain("authClient.unlinkAccount({ accountId })");
  expect(surface).toContain("unlinkProvider(provider, linked.accountId)");
  expect(surface).toContain("` · ${linked.label}`");
  expect(surface).toContain('view === "billing" || view === "settings"');
  expect(surface).toContain("authClient.linkSocial(");
  expect(surface).toContain("authClient.changeEmail(");
  expect(surface).toContain("Magic link email");
  expect(surface).not.toContain("dashboard-legacy");
});

test("skills and devices use semantic status panels and skill mutations", () => {
  expect(surface).toContain('if (view === "skills" || view === "devices")');
  expect(surface).toContain('className="dashboard-page-header"');
  expect(surface).toContain('className="dashboard-secondary-button"');
  expect(surface).not.toContain("<th>Lock</th>");
  expect(surface).toContain("Pair a device from the CLI with");
  expect(surface).toContain('fetch("/api/v1/dashboard"');
  expect(surface).toContain('type: "ADD"');
  expect(surface).toContain('type: "REMOVE"');
  expect(surface).toContain('type: "CLEAR"');
  expect(surface).toContain("Delete Cloud skills");
  expect(surface).toContain("Remove");
  expect(surface).toContain("No remote sync is requested");
});

test("dashboard operate chrome uses frozen tokens and truthful status chips", () => {
  expect(surface).toContain('href: "/dashboard"');
  expect(surface).toContain('href: "/dashboard/skills"');
  expect(surface).toContain('href: "/dashboard/devices"');
  expect(surface).toContain('href: "/dashboard/billing"');
  expect(surface).toContain('href: "/settings"');
  expect(surface).toContain('href="https://docs.corotum.com"');
  expect(surface).toContain("Sign out");
  expect(surface).toContain("authClient.signOut()");
  expect(surface).toContain('className="dashboard-chrome"');
  expect(surface).toContain("<SiteFooter />");
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
