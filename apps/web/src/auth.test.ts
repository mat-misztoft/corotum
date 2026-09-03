import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { createMagicLinkPlugin, validateAuthConfiguration } from "./auth";
import type { EmailService } from "./email";

const authOrigin = "https://corotum.example";

const productionConfig = {
  BETTER_AUTH_SECRET: "a-secure-secret-with-at-least-thirty-two-characters",
  BETTER_AUTH_URL: "https://corotum.example",
  GITHUB_CLIENT_ID: "github-id",
  GITHUB_CLIENT_SECRET: "github-secret",
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  COROTUM_ENVIRONMENT: "production" as const,
};

test("hosted and self-hosted production require a secret, URL, and both OAuth providers", () => {
  expect(validateAuthConfiguration(productionConfig)).toMatchObject({
    github: { clientId: "github-id" },
    google: { clientId: "google-id" },
  });
  expect(() =>
    validateAuthConfiguration({
      ...productionConfig,
      BETTER_AUTH_SECRET: "short",
    }),
  ).toThrow("BETTER_AUTH_SECRET");
  expect(() =>
    validateAuthConfiguration({
      ...productionConfig,
      GITHUB_CLIENT_SECRET: undefined,
    }),
  ).toThrow("GitHub OAuth");
  expect(() =>
    validateAuthConfiguration({
      ...productionConfig,
      BETTER_AUTH_URL: undefined,
    }),
  ).toThrow("BETTER_AUTH_URL");
});

test("local development can use an ephemeral development-only auth secret", () => {
  expect(
    validateAuthConfiguration({ COROTUM_ENVIRONMENT: "development" }),
  ).toMatchObject({
    github: undefined,
    google: undefined,
  });
});

test("OAuth linking may use a different email and Corotum email can change", async () => {
  const source = await Bun.file(new URL("./auth.ts", import.meta.url)).text();
  expect(source).toContain("allowDifferentEmails: true");
  expect(source).toContain("allowUnlinkingAll: true");
  expect(source).toContain("changeEmail: { enabled: true }");
  expect(source).toContain("persistAccountDisplayLabel(");
});

function createMagicLinkRuntime() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL, image TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL);
    CREATE TABLE account (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, userId TEXT NOT NULL, accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt INTEGER, refreshTokenExpiresAt INTEGER, scope TEXT, password TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt INTEGER NOT NULL, createdAt INTEGER, updatedAt INTEGER);
  `);
  const messages: Parameters<EmailService["sendAuthenticationEmail"]>[0][] = [];
  const emailService: EmailService = {
    async sendAuthenticationEmail(message) {
      messages.push(message);
    },
  };
  const auth = betterAuth({
    baseURL: authOrigin,
    secret: productionConfig.BETTER_AUTH_SECRET,
    advanced: { disableOriginCheck: false },
    database,
    rateLimit: { enabled: false },
    plugins: [createMagicLinkPlugin(emailService)],
  });

  return { auth, database, messages };
}

function requestMagicLink(auth: ReturnType<typeof betterAuth>, email: string) {
  return auth.api.signInMagicLink({
    body: { email, callbackURL: "/dashboard" },
    headers: new Headers({ origin: authOrigin }),
  });
}

function magicLinkToken(message: Parameters<EmailService["sendAuthenticationEmail"]>[0]) {
  return new URL(message.link).searchParams.get("token")!;
}

test("magic links use hashed Better Auth tokens and the email boundary", async () => {
  const messages: Parameters<EmailService["sendAuthenticationEmail"]>[0][] = [];
  const service: EmailService = {
    async sendAuthenticationEmail(message) {
      messages.push(message);
    },
  };
  const plugin = createMagicLinkPlugin(service);

  expect(plugin.options.storeToken).toBe("hashed");
  expect(plugin.options.rateLimit).toEqual({ window: 60, max: 10 });
  await plugin.options.sendMagicLink({
    email: "ada@example.com",
    url: "https://corotum.example/api/auth/magic-link/verify?token=secret",
    token: "secret",
  });

  expect(messages).toEqual([
    {
      to: "ada@example.com",
      subject: "Sign in to Corotum",
      link: "https://corotum.example/api/auth/magic-link/verify?token=secret",
    },
  ]);
});

test("magic links create or reuse an account, persist a hash, and consume tokens once", async () => {
  const { auth, database, messages } = createMagicLinkRuntime();
  const now = Date.now();
  database
    .query(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("known-user", "Known", "known@example.com", 1, now, now);

  const known = await requestMagicLink(auth, "known@example.com");
  const unknown = await requestMagicLink(auth, "new@example.com");
  expect(known).toEqual(unknown);
  expect(known).toEqual({ status: true });

  const token = magicLinkToken(messages[1]!);
  const stored = database
    .query<{ identifier: string }, []>("SELECT identifier FROM verification")
    .all();
  expect(stored).toHaveLength(2);
  expect(stored.map((row) => row.identifier)).not.toContain(token);

  const response = await auth.handler(
    new Request(messages[1]!.link, { headers: { origin: authOrigin } }),
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`${authOrigin}/dashboard`);
  expect(response.headers.get("set-cookie")).toContain("better-auth.session_token");
  expect(database.query("SELECT * FROM user").all()).toHaveLength(2);
  expect(database.query("SELECT * FROM session").all()).toHaveLength(1);

  const consumed = await auth.handler(
    new Request(messages[1]!.link, { headers: { origin: authOrigin } }),
  );
  expect(consumed.status).toBe(302);
  expect(consumed.headers.get("location")).toContain("error=INVALID_TOKEN");
  expect(database.query("SELECT * FROM session").all()).toHaveLength(1);
});

test("magic links reject unsafe redirects and expired or malformed tokens without a session", async () => {
  const { auth, database, messages } = createMagicLinkRuntime();
  await requestMagicLink(auth, "ada@example.com");
  database.exec("UPDATE verification SET expiresAt = 0");

  const expired = await auth.handler(new Request(messages[0]!.link));
  expect(expired.status).toBe(302);
  expect(expired.headers.get("location")).toContain("error=INVALID_TOKEN");

  const malformedToken = await auth.handler(
    new Request(
      `${authOrigin}/api/auth/magic-link/verify?token=malformed&callbackURL=/dashboard`,
    ),
  );
  expect(malformedToken.headers.get("location")).toContain("error=INVALID_TOKEN");
  expect(database.query("SELECT * FROM session").all()).toHaveLength(0);

  await requestMagicLink(auth, "ada@example.com");
  const issuedLink = messages[1]!.link;
  const unsafeLink = new URL(issuedLink);
  unsafeLink.searchParams.set("callbackURL", "https://attacker.example");
  const unsafe = await auth.handler(new Request(unsafeLink));
  expect(unsafe.status).toBe(403);
  expect(database.query("SELECT * FROM session").all()).toHaveLength(0);

  const permitted = await auth.handler(new Request(issuedLink));
  expect(permitted.headers.get("location")).toBe(`${authOrigin}/dashboard`);
  expect(database.query("SELECT * FROM session").all()).toHaveLength(1);

  const malformedLink = new URL(issuedLink);
  malformedLink.searchParams.set("callbackURL", "javascript:alert(1)");
  const malformed = await auth.handler(new Request(malformedLink));
  expect(malformed.status).toBe(403);
  expect(database.query("SELECT * FROM session").all()).toHaveLength(1);
});

test("magic links reuse a same-email OAuth user instead of silently duplicating it", async () => {
  const { auth, database, messages } = createMagicLinkRuntime();
  const now = Date.now();
  database
    .query(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("oauth-user", "Ada", "ada@example.com", 1, now, now);
  database
    .query(
      "INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("github-account", "123", "github", "oauth-user", now, now);

  await requestMagicLink(auth, "ada@example.com");
  const response = await auth.handler(new Request(messages[0]!.link));
  expect(response.status).toBe(302);
  expect(database.query("SELECT * FROM user").all()).toHaveLength(1);
  expect(
    database.query<{ userId: string }, []>("SELECT userId FROM session").get(),
  ).toEqual({ userId: "oauth-user" });
});
