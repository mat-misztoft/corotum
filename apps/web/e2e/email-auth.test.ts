import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { createMagicLinkPlugin } from "../src/auth";
import type { EmailService } from "../src/email";

const secret = "a-secure-secret-with-at-least-thirty-two-characters";

function deliveredLink(
  message: Parameters<EmailService["sendAuthenticationEmail"]>[0] | undefined,
) {
  if (!message) throw new Error("Expected a delivered magic link");
  return message.link;
}

const emailAuthTest =
  process.env.TOOLMIRROR_EMAIL_AUTH_E2E === "1" ? test : test.skip;

emailAuthTest(
  "email-auth E2E: browser magic links create and reuse accounts without disclosure",
  async () => {
    const database = new Database(":memory:");
    database.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL, image TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL);
    CREATE TABLE account (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, userId TEXT NOT NULL, accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt INTEGER, refreshTokenExpiresAt INTEGER, scope TEXT, password TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt INTEGER NOT NULL, createdAt INTEGER, updatedAt INTEGER);
  `);

    const messages: Parameters<EmailService["sendAuthenticationEmail"]>[0][] =
      [];
    const email: EmailService = {
      async sendAuthenticationEmail(message) {
        messages.push(message);
      },
    };
    let auth: ReturnType<typeof betterAuth>;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/auth/")) return auth.handler(request);
        if (url.pathname === "/sign-in") {
          return new Response(
            `<!doctype html><form><label>Email <input name="email" type="email"></label><button>Continue with email</button></form><p role="status"></p><script>document.querySelector("form").addEventListener("submit", async event => { event.preventDefault(); const email = document.querySelector("input").value; await fetch("/api/auth/sign-in/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, callbackURL: "/dashboard" }) }); document.querySelector("[role=status]").textContent = "Check your inbox"; });</script>`,
            { headers: { "content-type": "text/html" } },
          );
        }
        if (url.pathname === "/dashboard")
          return new Response("Authenticated dashboard");
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
      async function request(address: string) {
        await page.goto(`${origin}/sign-in`);
        await page.locator("input").fill(address);
        await page.locator("button").click();
        await page.waitForFunction(
          () =>
            document.querySelector("[role=status]")?.textContent ===
            "Check your inbox",
        );
      }

      await request("new@example.com");
      await request("known@example.com");
      expect(messages).toHaveLength(2);
      expect(await page.getByRole("status").textContent()).toBe(
        "Check your inbox",
      );

      await page.goto(deliveredLink(messages[0]));
      expect(await page.locator("body").innerText()).toContain(
        "Authenticated dashboard",
      );
      expect(database.query("SELECT * FROM user").all()).toHaveLength(1);
      expect(database.query("SELECT * FROM session").all()).toHaveLength(1);

      await page.goto(deliveredLink(messages[1]));
      expect(database.query("SELECT * FROM user").all()).toHaveLength(2);

      const now = Date.now();
      database
        .query(
          "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("oauth-user", "OAuth", "oauth@example.com", 1, now, now);
      database
        .query(
          "INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("github-account", "123", "github", "oauth-user", now, now);

      await request("oauth@example.com");
      await page.goto(deliveredLink(messages.at(-1)));
      expect(
        database
          .query("SELECT * FROM user WHERE email = 'oauth@example.com'")
          .all(),
      ).toHaveLength(1);
      expect(
        database
          .query<{ userId: string }, []>(
            "SELECT userId FROM session ORDER BY createdAt DESC LIMIT 1",
          )
          .get(),
      ).toEqual({ userId: "oauth-user" });
    } finally {
      await browser.close();
      server.stop(true);
    }
  },
  30_000,
);
