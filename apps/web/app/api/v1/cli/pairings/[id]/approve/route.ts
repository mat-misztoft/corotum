import { env } from "cloudflare:workers";
import { requireUserId } from "../../../../../../../src/api";
import type { AuthEnvironment } from "../../../../../../../src/auth";
import type { PairingDatabase } from "../../../../../../../src/pairings";
import { handleApprovePairing } from "../../../../../../../src/pairings-http";

// vinext's generated `cloudflare:workers` type does not include app bindings.
const workerEnv = env as unknown as AuthEnvironment;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handleApprovePairing(
    request,
    workerEnv.DB as unknown as PairingDatabase,
    id,
    await requireUserId(request, workerEnv),
  );
}
