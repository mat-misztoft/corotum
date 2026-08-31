import { expect, test } from "bun:test";

const page = await Bun.file(`${import.meta.dir}/not-found.tsx`).text();
const styles = await Bun.file(`${import.meta.dir}/globals.css`).text();

test("unknown routes use the Corotum not-found App Router entry", () => {
  expect(page).toContain("export default function NotFound()");
  expect(page).toContain("Page not found");
  expect(page).toContain("This route does not exist");
  expect(page).toContain('href="/"');
  expect(page).toContain('href="/sign-in"');
  expect(page).toContain('className="not-found-page"');
  expect(styles).toContain(".not-found-page");
  expect(styles).toContain("@media (max-width: 850px)");
  expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
});
