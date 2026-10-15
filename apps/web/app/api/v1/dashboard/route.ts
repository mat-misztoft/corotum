import { env } from "cloudflare:workers";
import { requireUserId } from "../../../../src/api";
import type { AuthEnvironment } from "../../../../src/auth";
import { isHostedCloud } from "../../../../src/billing";
import {
  handleDashboardGet,
  handleDashboardMutation,
} from "../../../../src/dashboard-http";
import { eventDatabase } from "../../../../src/workspace-events";

const workerEnv = env as unknown as AuthEnvironment;

export async function GET(request: Request) {
  return handleDashboardGet(
    eventDatabase(workerEnv) as never,
    await requireUserId(request, workerEnv),
    isHostedCloud(workerEnv),
  );
}

export async function POST(request: Request) {
  return handleDashboardMutation(
    request,
    eventDatabase(workerEnv) as never,
    await requireUserId(request, workerEnv),
    isHostedCloud(workerEnv),
  );
}
