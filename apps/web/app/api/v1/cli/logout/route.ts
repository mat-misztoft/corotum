import { env } from "cloudflare:workers";
import type { AuthEnvironment } from "../../../../../src/auth";
import type { TokenDatabase } from "../../../../../src/tokens";
import { handleLogoutDevice } from "../../../../../src/tokens-http";
import { eventDatabase } from "../../../../../src/workspace-events";

// vinext's generated `cloudflare:workers` type does not include app bindings.
const workerEnv = env as unknown as AuthEnvironment;

export async function POST(request: Request) {
  return handleLogoutDevice(
    request,
    eventDatabase(workerEnv) as unknown as TokenDatabase,
  );
}
