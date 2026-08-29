import type { WorkspaceDatabase } from "./workspaces";

export const RATE_LIMITS = {
  normal: { limit: 120, windowMs: 60_000 },
  mutation: { limit: 30, windowMs: 60_000 },
  pairingAuth: { limit: 10, windowMs: 60_000 },
} as const;

export type RateLimitKind = keyof typeof RATE_LIMITS;
export type RateLimitDatabase = WorkspaceDatabase;

type WindowRow = { count: number; windowStart: number };

export function clientIp(request: Request) {
  const connecting = request.headers.get("cf-connecting-ip")?.trim();
  if (connecting) return connecting;
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  if (forwarded) return forwarded;
  return "unknown";
}

export function rateLimitKey(kind: RateLimitKind, identity: string) {
  return `${kind}:${identity}`;
}

export async function consumeRateLimit(
  db: RateLimitDatabase,
  kind: RateLimitKind,
  identity: string,
  now = Date.now(),
) {
  const { limit, windowMs } = RATE_LIMITS[kind];
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const key = rateLimitKey(kind, identity);
  const existing = await db
    .prepare(
      "SELECT count, window_start AS windowStart FROM rate_limit_windows WHERE key = ?",
    )
    .bind(key)
    .first<WindowRow>();

  const count =
    existing && existing.windowStart === windowStart ? existing.count : 0;
  if (count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((windowStart + windowMs - now) / 1000),
      ),
    };
  }

  await db
    .prepare(
      "INSERT INTO rate_limit_windows (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN rate_limit_windows.window_start = excluded.window_start THEN rate_limit_windows.count + 1 ELSE 1 END, window_start = excluded.window_start",
    )
    .bind(key, windowStart)
    .run();
  return { allowed: true, retryAfterSeconds: 0 };
}

export function rateLimitedResponse(retryAfterSeconds: number) {
  return Response.json(
    { error: "Rate limit exceeded" },
    {
      status: 429,
      headers: { "retry-after": String(retryAfterSeconds) },
    },
  );
}
