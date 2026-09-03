import { expect, test } from "bun:test";
import { Glob } from "bun";

const webRoot = `${import.meta.dir}/..`;
const page = await Bun.file(`${webRoot}/app/page.tsx`).text();
const styles = await Bun.file(`${webRoot}/app/globals.css`).text();
const motion = await Bun.file(`${webRoot}/app/landing-flow-story.tsx`).text();
const qa = await Bun.file(`${import.meta.dir}/landing-visual-qa.md`).text();
const builtCss = [
  ...new Glob("dist/**/*.css").scanSync({ cwd: webRoot }),
].sort();

const slop = [
  "linear-gradient",
  "radial-gradient",
  "backdrop-filter",
  "particle",
  "blob",
  "glassmorphism",
  "testimonial",
  "sparkle",
];

test("landing e2e: static artwork fills the existing visual slots", () => {
  expect(page).toContain("From skill to synced state.");
  expect(page).toContain("<FlowStory>");
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
  expect(styles).toContain(".landing-visual");
  expect(styles).toContain("width: 100%");
  expect(styles).toContain("height: auto");
  expect(styles).toContain("max-width: 100%");
  expect(styles).not.toContain("aspect-ratio");
  expect(motion).toContain("aria-current");
  expect(motion).toContain("prefers-reduced-motion: reduce");
  expect(styles).not.toContain("particle");
  expect(styles).not.toContain("blob");
});

test("landing e2e: reduced-motion keeps the full sequence and stops animation", () => {
  expect(page).toContain(
    "The complete sequence remains visible without animation.",
  );
  expect(page).toContain("<strong>01</strong> ADD");
  expect(page).toContain("<strong>05</strong> SYNCED");
  expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  expect(styles).toContain("animation: none");
  expect(motion).toContain('root.dataset.motion = "reduced"');
});

test("landing e2e: status is labeled in text, not color alone", () => {
  expect(page).toContain("SYNCED");
  expect(page).toContain("DRIFTED");
  expect(page).toContain("AUTH_REQUIRED");
  expect(page).toContain("LOCKED");
});

test.skipIf(builtCss.length === 0)(
  "landing e2e: built CSS preserves reduced-motion kill switch",
  async () => {
    const css = await Bun.file(`${webRoot}/${builtCss[0]}`).text();
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toMatch(/animation:\s*none/);
    expect(css).toContain(".landing-header");
    expect(css).toContain("background:var(--paper)");
  },
);

test("landing e2e: visual QA evidence records desktop and mobile PASS", () => {
  expect(qa).toContain("## Static landing artwork QA");
  expect(qa).toContain("| 1440 | PASS");
  expect(qa).toContain("| 1920 | PASS");
  expect(qa).toContain("| 390 | PASS");
  expect(qa).not.toContain("FAIL");
});

test("landing e2e: login and Cloud CTAs go to /sign-in", () => {
  expect(page).toContain('href="/sign-in">');
  expect(page.match(/href="\/sign-in"/g)?.length).toBe(3);
  expect(page).not.toContain('href="/dashboard"');
});

test("landing e2e: claims, anti-slop, and accessibility checks pass", () => {
  expect(page).toContain("Exact revision and content hash. Exact, not latest.");
  expect(page).toContain("Self-hosted Corotum Cloud is free under AGPLv3.");
  expect(page).toContain("hosted corotum.com service.");
  expect(page).toContain('className="install-command"');
  expect(page).toContain('return "status-error"');
  expect(page).not.toContain("sync_device");
  expect(page).not.toContain("sync_all_devices");
  expect(page).not.toContain("—");
  expect(page).not.toContain("–");
  expect(styles).toContain(".landing a:focus-visible");
  expect(styles).toContain("overflow-x: clip");
  expect(styles).toContain(".status-error");
  expect(styles).toContain("background: var(--paper)");
  expect(styles).not.toContain("nth-child(3)");
  for (const token of slop) {
    expect(page.toLowerCase()).not.toContain(token);
    expect(styles.toLowerCase()).not.toContain(token);
  }
});
