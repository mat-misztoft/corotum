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

test("landing e2e: sticky flow and state-lines stay product-semantic", () => {
  expect(page).toContain("From skill to synced state.");
  expect(page).toContain("<FlowStory>");
  expect(page).toContain("data-line={lineKind(status)}");
  expect(motion).toContain("aria-current");
  expect(motion).toContain("prefers-reduced-motion: reduce");
  expect(styles).toContain("@keyframes reconcile-travel");
  expect(styles).toContain("@keyframes axis-flow");
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

test("landing e2e: status is labeled in text and line style, not color alone", () => {
  expect(page).toContain('return "✓"');
  expect(page).toContain('return "≠"');
  expect(page).toContain('return "!"');
  expect(page).toContain("SYNCED");
  expect(page).toContain("BEHIND");
  expect(page).toContain("DRIFTED");
  expect(page).toContain("AUTH_REQUIRED");
  expect(page).toContain("LOCKED");
  expect(styles).toContain("border-top-style: dashed");
  expect(styles).toContain("border-top-style: dotted");
  expect(styles).toContain("border-top-style: solid");
});

test.skipIf(builtCss.length === 0)(
  "landing e2e: built CSS preserves reduced-motion kill switch",
  async () => {
    const css = await Bun.file(`${webRoot}/${builtCss[0]}`).text();
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toMatch(/animation:\s*none/);
    expect(css).toContain("reconcile-travel");
    expect(css).toContain(".landing-header");
    expect(css).toContain("background:var(--paper)");
  },
);

test("landing e2e: visual QA evidence records desktop and mobile PASS",
  () => {
    expect(qa).toContain("## Desktop comparison (1440)");
    expect(qa).toContain("## Mobile comparison (390 / max-width 850 and 500)");
    for (const axis of [
      "Layout",
      "Hierarchy",
      "Typography",
      "Palette",
      "Spacing",
      "Motion",
    ]) {
      expect(qa).toContain(`| ${axis} | PASS`);
    }
    expect(qa.match(/\| FAIL \|/g) ?? []).toEqual([]);
  },
);

test("landing e2e: login and Cloud CTAs go to /sign-in", () => {
  expect(page).toContain('<a href="/sign-in">Sign in</a>');
  expect(page.match(/href="\/sign-in"/g)?.length).toBe(3);
  expect(page).not.toContain('href="/dashboard"');
});

test("landing e2e: claims, anti-slop, and accessibility checks pass", () => {
  expect(page).toContain("$5.99/month · $59.90/year");
  expect(page).toContain("Agents manage desired state");
  expect(page).toContain("Exact revision and content hash. Exact, not latest.");
  expect(page).toContain('aria-label="Official install command"');
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
