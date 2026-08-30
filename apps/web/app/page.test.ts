import { expect, test } from "bun:test";

const page = await Bun.file(`${import.meta.dir}/page.tsx`).text();
const styles = await Bun.file(`${import.meta.dir}/globals.css`).text();

const sections = [
  "Keep your agent skills in sync.",
  "One state. Everywhere.",
  "From skill to synced state.",
  "One ToolMirror. Two ways to sync.",
  "See every device at a glance.",
  "One skill. Many agents.",
  "Set it once. Keep it in sync.",
] as const;

test("landing keeps the seven frozen sections in order", () => {
  let cursor = 0;
  for (const copy of sections) {
    const index = page.indexOf(copy, cursor);
    expect(index).toBeGreaterThan(-1);
    cursor = index + copy.length;
  }
});

test("final CTA copy, actions, and install command match planning", () => {
  expect(page).toContain('className="final-cta"');
  expect(page).toContain(
    "Start with ToolMirror Cloud, or use your own Git repository for free.",
  );
  expect(page).toContain("Start with ToolMirror Cloud");
  expect(page).toContain("View on GitHub");
  expect(page).toContain("curl -fsSL https://toolmirror.com/install.sh | sh");
  expect(page).not.toContain("sync_device");
  expect(page).not.toContain("sync_all_devices");
});

test("landing login and Cloud CTAs go to /sign-in", () => {
  expect(page).toContain('<a href="/sign-in">Sign in</a>');
  expect(page).toContain('href="/sign-in">');
  expect(page.match(/href="\/sign-in"/g)?.length).toBe(3);
  expect(page).not.toContain('href="/dashboard"');
});

test("landing keeps keyboard focus and overflow-safe diagrams", () => {
  expect(styles).toContain(".landing a:focus-visible");
  expect(styles).toContain("overflow-x: clip");
  expect(styles).toContain(".landing-header nav");
  expect(styles).toContain("min-width: 0");
  expect(styles).toContain("user-select: all");
  expect(page).toContain('aria-labelledby="dispatch-heading"');
  expect(page).toContain("<caption>TARGET STATUS / AFTER CLI SYNC</caption>");
  expect(page).toContain(
    "<caption>SKILL EXPOSURE / SUPPORTED AGENTS</caption>",
  );
});

test("landing motion stays semantic and readable without color or animation", async () => {
  const motion = await Bun.file(
    `${import.meta.dir}/landing-flow-story.tsx`,
  ).text();
  expect(page).toContain("data-line={lineKind(status)}");
  expect(page).toContain("statusMark");
  expect(page).toContain("ADD");
  expect(page).toContain("LOCK");
  expect(page).toContain("DIFF");
  expect(page).toContain("RECONCILE");
  expect(page).toContain("SYNCED");
  expect(page).toContain(
    "The complete sequence remains visible without animation.",
  );
  expect(motion).toContain("prefers-reduced-motion: reduce");
  expect(motion).toContain("IntersectionObserver");
  expect(styles).toContain("@keyframes reconcile-travel");
  expect(styles).toContain('[data-line="synced"]');
  expect(styles).toContain('[data-line="pending"]');
  expect(styles).toContain('[data-line="drifted"]');
  expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  expect(styles).toContain("animation: none");
  expect(styles).toContain(".status-mark");
});
