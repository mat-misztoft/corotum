import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { createMagicLinkPlugin } from "../src/auth";
import type { EmailService } from "../src/email";

const secret = "a-secure-secret-with-at-least-thirty-two-characters";

/**
 * Integration test of the real SignInForm + Better Auth magic-link plugin.
 * Full Worker E2E (wrangler, Cloudflare EMAIL capture, session cookie on
 * `/dashboard`) is not available in this harness.
 */
test("email-auth integration: real sign-in form posts a magic link and confirms", async () => {
  const built = await Bun.build({
    entrypoints: [`${import.meta.dir}/sign-in-form-entry.tsx`],
    target: "browser",
    format: "esm",
  });
  if (!built.success) {
    throw new Error(built.logs.map((log) => String(log)).join("\n"));
  }
  const script = built.outputs.find((output) => output.path.endsWith(".js"));
  if (!script) throw new Error("expected a bundled sign-in form");

  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL, image TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL);
    CREATE TABLE account (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, userId TEXT NOT NULL, accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt INTEGER, refreshTokenExpiresAt INTEGER, scope TEXT, password TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt INTEGER NOT NULL, createdAt INTEGER, updatedAt INTEGER);
  `);

  const messages: Parameters<EmailService["sendAuthenticationEmail"]>[0][] = [];
  const email: EmailService = {
    async sendAuthenticationEmail(message) {
      messages.push(message);
    },
  };
  let auth: ReturnType<typeof betterAuth>;
  let magicLinkRequests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/sign-in.js") {
        return new Response(script, {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }
      if (url.pathname === "/sign-in") {
        return new Response(
          `<!doctype html><html><body><div id="root"></div><script type="module" src="/sign-in.js"></script></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (url.pathname.startsWith("/api/auth/")) {
        if (
          request.method === "POST" &&
          url.pathname === "/api/auth/sign-in/magic-link"
        ) {
          magicLinkRequests += 1;
        }
        return auth.handler(request);
      }
      return new Response("not found", { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  auth = betterAuth({
    baseURL: origin,
    secret,
    advanced: { disableOriginCheck: false },
    database,
    rateLimit: { enabled: false },
    plugins: [createMagicLinkPlugin(email)],
  });

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/sign-in`);
    await page.getByRole("button", { name: "Continue with GitHub" }).waitFor();
    await page.getByRole("button", { name: "Continue with Google" }).waitFor();
    await page.getByLabel("Email address").waitFor();
    await page.getByLabel("Email address").fill("ada@example.com");
    await page.getByRole("button", { name: "Continue with email" }).click();
    await page.getByRole("heading", { name: "Check your inbox" }).waitFor();
    expect(await page.getByText("We sent you a sign-in link.").textContent()).toBe(
      "We sent you a sign-in link.",
    );
    expect(magicLinkRequests).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.to).toBe("ada@example.com");
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 30_000);
