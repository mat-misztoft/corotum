import { expect, test } from "bun:test";
import { Glob } from "bun";

const webRoot = `${import.meta.dir}/..`;
const page = await Bun.file(`${webRoot}/app/page.tsx`).text();
const styles = await Bun.file(`${webRoot}/app/globals.css`).text();
const motion = await Bun.file(`${webRoot}/app/landing-flow-story.tsx`).text();
const builtCss = [
  ...new Glob("dist/**/*.css").scanSync({ cwd: webRoot }),
].sort();

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
  },
);
