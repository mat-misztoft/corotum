import { jsonError, readJson } from "./api";
import { protectCloudRequest } from "./cloud-protect";
import type { RateLimitDatabase } from "./rate-limit";
import {
  ingestAnonymousTelemetry,
  parseAnonymousTelemetryEvent,
} from "./telemetry";

export async function handlePostTelemetry(
  request: Request,
  db: RateLimitDatabase,
  analytics: AnalyticsEngineDataset,
) {
  const blocked = await protectCloudRequest(request, db, {
    kind: "normal",
    requireCli: true,
  });
  if (blocked) return blocked;

  const event = parseAnonymousTelemetryEvent(await readJson(request));
  if (!event) return jsonError("Invalid anonymous telemetry event", 400);
  ingestAnonymousTelemetry(analytics, event);
  return new Response(null, { status: 204 });
}
