import { env } from "cloudflare:workers";
import type { AuthEnvironment } from "../../../../../../src/auth";
import { isHostedCloud } from "../../../../../../src/billing";
import { handlePostDeviceSyncReport } from "../../../../../../src/sync-report-http";
import type { TokenDatabase } from "../../../../../../src/tokens";

// vinext's generated `cloudflare:workers` type does not include app bindings.
const workerEnv = env as unknown as AuthEnvironment;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handlePostDeviceSyncReport(
    request,
    workerEnv.DB as unknown as TokenDatabase,
    id,
    isHostedCloud(workerEnv),
  );
}
