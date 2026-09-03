import { env } from "cloudflare:workers";
import { toNextJsHandler } from "better-auth/next-js";
import { type AuthEnvironment, createAuth } from "../../../../src/auth";
import { protectCloudRequest } from "../../../../src/cloud-protect";
import { createCloudflareEmailService } from "../../../../src/email";
import type {
  RateLimitDatabase,
  RateLimitKind,
} from "../../../../src/rate-limit";

// vinext's generated `cloudflare:workers` type does not include app bindings.
const workerEnv = env as unknown as AuthEnvironment;
const handlers = toNextJsHandler(
  createAuth(workerEnv, createCloudflareEmailService(workerEnv)),
);

async function withAuthRateLimit(
  request: Request,
  handler: (request: Request) => Promise<Response>,
  kind: RateLimitKind,
) {
  const blocked = await protectCloudRequest(
    request,
    workerEnv.DB as unknown as RateLimitDatabase,
    { kind },
  );
  if (blocked) return blocked;
  return handler(request);
}

export function GET(request: Request) {
  return withAuthRateLimit(request, handlers.GET, "normal");
}

export function POST(request: Request) {
  return withAuthRateLimit(request, handlers.POST, "pairingAuth");
}
