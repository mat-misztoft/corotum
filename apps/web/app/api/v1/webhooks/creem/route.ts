import { env } from "cloudflare:workers";
import type { AuthEnvironment } from "../../../../../src/auth";
import type {
  BillingDatabase,
  BillingEnvironment,
} from "../../../../../src/billing";
import { handleCreemWebhook } from "../../../../../src/billing-http";

// vinext's generated `cloudflare:workers` type does not include app bindings.
const workerEnv = env as unknown as AuthEnvironment & BillingEnvironment;

export async function POST(request: Request) {
  return handleCreemWebhook(
    request,
    workerEnv.DB as unknown as BillingDatabase,
    workerEnv,
  );
}
