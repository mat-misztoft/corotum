import { env } from "cloudflare:workers";
import type { AuthEnvironment } from "../../../../../src/auth";
import type { PairingDatabase } from "../../../../../src/pairings";
import { handleCreatePairing } from "../../../../../src/pairings-http";

// vinext's generated `cloudflare:workers` type does not include app bindings.
const workerEnv = env as unknown as AuthEnvironment;

export async function POST(request: Request) {
  return handleCreatePairing(
    request,
    workerEnv.DB as unknown as PairingDatabase,
  );
}
