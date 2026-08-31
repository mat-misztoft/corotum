import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clientIp,
  consumeRateLimit,
  RATE_LIMITS,
  type RateLimitDatabase,
  type RateLimitKind,
  rateLimitedResponse,
} from "./rate-limit";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

async function limitDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrationFiles = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    const sql = await Bun.file(join(migrationsDirectory, file)).text();
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }

  const db: RateLimitDatabase = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              return (sqlite.query(query).get(...values) as T) ?? null;
            },
            async run() {
              sqlite.query(query).run(...values);
              return {};
            },
            async all<T>() {
              return { results: sqlite.query(query).all(...values) as T[] };
            },
          };
        },
      };
    },
  };
  return { db, sqlite };
}

async function consumeUntil(
  db: RateLimitDatabase,
  kind: RateLimitKind,
  identity: string,
  times: number,
  now = 60_000,
) {
  let last = { allowed: true, retryAfterSeconds: 0 };
  for (let index = 0; index < times; index += 1) {
    last = await consumeRateLimit(db, kind, identity, now);
  }
  return last;
}

test("architecture rate limits exist for normal, mutation, and pairing/auth traffic", () => {
  expect(RATE_LIMITS.normal).toEqual({ limit: 120, windowMs: 60_000 });
  expect(RATE_LIMITS.mutation).toEqual({ limit: 30, windowMs: 60_000 });
  expect(RATE_LIMITS.pairingAuth).toEqual({ limit: 10, windowMs: 60_000 });
});

test("each rate-limit class throttles after its configured window budget", async () => {
  const { db } = await limitDb();
  expect(await consumeUntil(db, "pairingAuth", "ip:1.1.1.1", 10)).toEqual({
    allowed: true,
    retryAfterSeconds: 0,
  });
  expect(
    await consumeRateLimit(db, "pairingAuth", "ip:1.1.1.1", 60_000),
  ).toEqual({
    allowed: false,
    retryAfterSeconds: 60,
  });
  expect(await consumeUntil(db, "mutation", "user:user_1", 30)).toEqual({
    allowed: true,
    retryAfterSeconds: 0,
  });
  expect(await consumeRateLimit(db, "mutation", "user:user_1", 60_000)).toEqual(
    {
      allowed: false,
      retryAfterSeconds: 60,
    },
  );
  expect(await consumeUntil(db, "normal", "device:dev_1", 120)).toEqual({
    allowed: true,
    retryAfterSeconds: 0,
  });
  expect(await consumeRateLimit(db, "normal", "device:dev_1", 60_000)).toEqual({
    allowed: false,
    retryAfterSeconds: 60,
  });
});

test("rate limits are isolated per identity and reset when the window advances", async () => {
  const { db } = await limitDb();
  await consumeUntil(db, "pairingAuth", "ip:9.9.9.9", 10);
  expect(
    (await consumeRateLimit(db, "pairingAuth", "ip:8.8.8.8", 60_000)).allowed,
  ).toBe(true);
  expect(
    (await consumeRateLimit(db, "pairingAuth", "ip:9.9.9.9", 120_000)).allowed,
  ).toBe(true);
});

test("throttled responses use 429 and Retry-After", async () => {
  const response = rateLimitedResponse(12);
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("12");
  expect(await response.json()).toEqual({ error: "Rate limit exceeded" });
});

test("client IP prefers Cloudflare connecting IP over X-Forwarded-For", () => {
  expect(
    clientIp(
      new Request("https://corotum.com", {
        headers: {
          "cf-connecting-ip": "203.0.113.10",
          "x-forwarded-for": "198.51.100.1, 192.0.2.1",
        },
      }),
    ),
  ).toBe("203.0.113.10");
  expect(
    clientIp(
      new Request("https://corotum.com", {
        headers: { "x-forwarded-for": "198.51.100.1, 192.0.2.1" },
      }),
    ),
  ).toBe("198.51.100.1");
  expect(clientIp(new Request("https://corotum.com"))).toBe("unknown");
});
