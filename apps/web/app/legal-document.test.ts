import { expect, test } from "bun:test";

const footer = await Bun.file(`${import.meta.dir}/site-footer.tsx`).text();
const terms = await Bun.file(`${import.meta.dir}/terms/page.tsx`).text();
const privacy = await Bun.file(`${import.meta.dir}/privacy/page.tsx`).text();

test("legal pages are linked only from the footer", () => {
  expect(footer).toContain('href="/terms"');
  expect(footer).toContain('href="/privacy"');
  expect(terms).toContain("support@corotum.com");
  expect(privacy).toContain("support@corotum.com");
  expect(terms).not.toContain("[CONTACT EMAIL]");
  expect(privacy).not.toContain("[CONTACT EMAIL]");
});
