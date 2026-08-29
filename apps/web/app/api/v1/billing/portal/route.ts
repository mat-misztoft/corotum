import { env } from "cloudflare:workers";
import { requireSession } from "../../../../../src/api";
import type { AuthEnvironment } from "../../../../../src/auth";
import {
  type BillingDatabase,
  type BillingEnvironment,
  createCreemClient,
} from "../../../../../src/billing";
import { handleBillingPortal } from "../../../../../src/billing-http";

// vinext's generated `cloudflare:workers` type does not include app bindings.
const workerEnv = env as unknown as AuthEnvironment & BillingEnvironment;

export async function POST(request: Request) {
  return handleBillingPortal(
    request,
    workerEnv.DB as unknown as BillingDatabase,
    workerEnv,
    createCreemClient(workerEnv),
    await requireSession(request, workerEnv),
  );
}
