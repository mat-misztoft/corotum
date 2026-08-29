import { expect, test } from "bun:test";
import { validEmail } from "./sign-in-form";

const page = await Bun.file(`${import.meta.dir}/page.tsx`).text();
const form = await Bun.file(`${import.meta.dir}/sign-in-form.tsx`).text();

test("sign-in keeps GitHub, Google, and a keyboard-operable email path", () => {
  expect(page).toContain("<SignInForm />");
  expect(form).toContain("Continue with GitHub");
  expect(form).toContain("Continue with Google");
  expect(form).toContain('type="submit"');
  expect(form).toContain('htmlFor="email"');
  expect(form).toContain('id="email"');
  expect(form).toContain('autoComplete="email"');
  expect(form).toContain('type="email"');
  expect(form).toContain('callbackURL: "/dashboard"');
});

test("email validation and request states retain disclosure-safe messaging", () => {
  expect(validEmail("ada@example.com")).toBe(true);
  expect(validEmail("not-an-email")).toBe(false);
  expect(form).toContain('state === "submitting"');
  expect(form).toContain('role="alert"');
  expect(form).toContain("Check your inbox");
  expect(form).toContain("We sent you a sign-in link.");
  expect(form).not.toContain("account exists");
  expect(form).not.toContain("new account");
  expect(form).toContain("ref={confirmationRef}");
});
