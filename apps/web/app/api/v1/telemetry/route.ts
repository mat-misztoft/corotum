import { env } from "cloudflare:workers";
import type { AuthEnvironment } from "../../../../src/auth";
import { handlePostTelemetry } from "../../../../src/telemetry-http";

const workerEnv = env as unknown as AuthEnvironment & {
  TOOLMIRROR_TELEMETRY: AnalyticsEngineDataset;
};

export async function POST(request: Request) {
  return handlePostTelemetry(
    request,
    workerEnv.DB as never,
    workerEnv.TOOLMIRROR_TELEMETRY,
  );
}
