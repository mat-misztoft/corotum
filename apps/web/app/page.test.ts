import { expect, test } from "bun:test";

const page = await Bun.file(`${import.meta.dir}/page.tsx`).text();
const styles = await Bun.file(`${import.meta.dir}/globals.css`).text();

const sections = [
  "Keep your agent skills in sync.",
  "One state. Everywhere.",
  "From skill to synced state.",
  "One Corotum. Two ways to sync.",
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
    "Start with Corotum Cloud, or use your own Git repository for free.",
  );
  expect(page).toContain("Start with Corotum Cloud");
  expect(page).toContain("View on GitHub");
  expect(page).toContain("curl -fsSL https://corotum.com/install.sh | sh");
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
  expect(styles).toContain("user-select: all");
  expect(page).toContain("<caption>TARGET STATUS / AFTER CLI SYNC</caption>");
  expect(page).toContain(
    "<caption>SKILL EXPOSURE / SUPPORTED AGENTS</caption>",
  );
});

test("landing uses the supplied static artwork without changing the flow story", async () => {
  const motion = await Bun.file(
    `${import.meta.dir}/landing-flow-story.tsx`,
  ).text();
  for (const asset of [
    "01-one-desired-state.jpg",
    "02-reconciliation.jpg",
    "04-two-ways-to-sync.jpg",
  ]) {
    expect(page).toContain(asset);
  }
  expect(page).not.toContain("DesiredStateVisual");
  expect(page).not.toContain("ReconciliationVisual");
  expect(page).not.toContain("ProvidersVisual");
  expect(page).toContain("<FlowStory>");
  expect(motion).toContain("IntersectionObserver");
  expect(styles).toContain(".landing-visual");
  expect(styles).toContain("width: 100%");
  expect(styles).toContain("height: auto");
  expect(styles).toContain("max-width: 100%");
});
