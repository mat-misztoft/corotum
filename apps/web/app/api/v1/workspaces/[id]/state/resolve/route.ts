import { env } from "cloudflare:workers";
import type { AuthEnvironment } from "../../../../../../../src/auth";
import { isHostedCloud } from "../../../../../../../src/billing";
import { handlePostPendingResolution } from "../../../../../../../src/state-http";
import type { TokenDatabase } from "../../../../../../../src/tokens";

const workerEnv = env as unknown as AuthEnvironment;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handlePostPendingResolution(
    request,
    workerEnv.DB as unknown as TokenDatabase,
    id,
    isHostedCloud(workerEnv),
  );
}
