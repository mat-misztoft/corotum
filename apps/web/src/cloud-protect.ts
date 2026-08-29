import {
  cliVersionFrom,
  incompatibleCliResponse,
  isCompatibleCliVersion,
} from "./cli-compat";
import {
  clientIp,
  consumeRateLimit,
  type RateLimitDatabase,
  type RateLimitKind,
  rateLimitedResponse,
} from "./rate-limit";

export { clientIp };

export async function protectCloudRequest(
  request: Request,
  db: RateLimitDatabase,
  options: {
    kind: RateLimitKind;
    requireCli?: boolean;
    identity?: string;
    now?: number;
  },
) {
  const identity = options.identity ?? `ip:${clientIp(request)}`;
  const result = await consumeRateLimit(
    db,
    options.kind,
    identity,
    options.now,
  );
  if (!result.allowed) return rateLimitedResponse(result.retryAfterSeconds);
  if (options.requireCli && !isCompatibleCliVersion(cliVersionFrom(request))) {
    return incompatibleCliResponse();
  }
  return null;
}
