import { env } from "cloudflare:workers";
import { requireUserId } from "../../../../src/api";
import type { AuthEnvironment } from "../../../../src/auth";
import { isHostedCloud } from "../../../../src/billing";
import { handleDashboardGet, handleDashboardMutation } from "../../../../src/dashboard-http";

const workerEnv = env as unknown as AuthEnvironment;

export async function GET(request: Request) {
  return handleDashboardGet(workerEnv.DB as never, await requireUserId(request, workerEnv));
}

export async function POST(request: Request) {
  return handleDashboardMutation(request, workerEnv.DB as never, await requireUserId(request, workerEnv), isHostedCloud(workerEnv));
}
