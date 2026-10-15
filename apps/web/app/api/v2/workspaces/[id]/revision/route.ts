import { env } from "cloudflare:workers";
import type { AuthEnvironment } from "../../../../../../src/auth";
import { isHostedCloud } from "../../../../../../src/billing";
import { handleGetWorkspaceRevision } from "../../../../../../src/state-http";
import { eventDatabase } from "../../../../../../src/workspace-events";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const workerEnv = env as unknown as AuthEnvironment;
  const { id } = await context.params;
  return handleGetWorkspaceRevision(
    request,
    eventDatabase(workerEnv) as never,
    id,
    isHostedCloud(workerEnv),
  );
}
