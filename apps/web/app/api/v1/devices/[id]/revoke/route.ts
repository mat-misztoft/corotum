import { env } from "cloudflare:workers";
import { requireUserId } from "../../../../../../src/api";
import type { AuthEnvironment } from "../../../../../../src/auth";
import type { TokenDatabase } from "../../../../../../src/tokens";
import { handleRevokeDevice } from "../../../../../../src/tokens-http";

// vinext's generated `cloudflare:workers` type does not include app bindings.
const workerEnv = env as unknown as AuthEnvironment;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handleRevokeDevice(
    request,
    workerEnv.DB as unknown as TokenDatabase,
    id,
    await requireUserId(request, workerEnv),
  );
}
