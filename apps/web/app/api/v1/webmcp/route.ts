import { env } from "cloudflare:workers";
import { requireUserId } from "../../../../src/api";
import type { AuthEnvironment } from "../../../../src/auth";
import { isHostedCloud } from "../../../../src/billing";
import { handleWebMcpReadOnlyTool } from "../../../../src/webmcp-http";

const workerEnv = env as unknown as AuthEnvironment;

export async function POST(request: Request) {
  return handleWebMcpReadOnlyTool(
    request,
    workerEnv.DB as never,
    await requireUserId(request, workerEnv),
    isHostedCloud(workerEnv),
  );
}
