import { env } from "cloudflare:workers";
import { requireUserId } from "../../../../../src/api";
import type { AuthEnvironment } from "../../../../../src/auth";
import { isHostedCloud } from "../../../../../src/billing";
import { handleDashboardSettingsGet } from "../../../../../src/dashboard-settings";

const workerEnv = env as unknown as AuthEnvironment;

export async function GET(request: Request) {
  return handleDashboardSettingsGet(
    workerEnv.DB as never,
    await requireUserId(request, workerEnv),
    isHostedCloud(workerEnv),
  );
}
