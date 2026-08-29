import { env } from "cloudflare:workers";
import type { AuthEnvironment } from "../../../../../../src/auth";
import {
  handleGetWorkspaceState,
  handlePutWorkspaceState,
} from "../../../../../../src/state-http";
import type { TokenDatabase } from "../../../../../../src/tokens";

// vinext's generated `cloudflare:workers` type does not include app bindings.
const workerEnv = env as unknown as AuthEnvironment;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handleGetWorkspaceState(
    request,
    workerEnv.DB as unknown as TokenDatabase,
    id,
  );
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handlePutWorkspaceState(
    request,
    workerEnv.DB as unknown as TokenDatabase,
    id,
  );
}
