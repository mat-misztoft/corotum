import { jsonError, readJson } from "./api";
import {
  HostedEntitlementRequiredError,
  requireHostedCloudAccess,
} from "./billing";
import { protectCloudRequest } from "./cloud-protect";
import {
  acceptDeviceSyncReport,
  InvalidSyncReportError,
  SyncReportRevisionError,
} from "./sync-report";
import {
  authenticateDeviceToken,
  DeviceUnauthorizedError,
  type TokenDatabase,
} from "./tokens";
import { deviceTokenFrom } from "./tokens-http";
import { WorkspaceAccessError } from "./workspaces";

function reportError(error: unknown) {
  if (error instanceof DeviceUnauthorizedError)
    return jsonError(error.message, 401);
  if (error instanceof HostedEntitlementRequiredError)
    return jsonError(error.message, 402);
  if (error instanceof WorkspaceAccessError)
    return jsonError(error.message, 404);
  if (
    error instanceof InvalidSyncReportError ||
    error instanceof SyncReportRevisionError
  ) {
    return jsonError(error.message, 400);
  }
  throw error;
}

export async function handlePostDeviceSyncReport(
  request: Request,
  db: TokenDatabase,
  deviceId: string,
  hosted = false,
) {
  const blocked = await protectCloudRequest(request, db, {
    kind: "mutation",
    requireCli: true,
  });
  if (blocked) return blocked;
  const token = deviceTokenFrom(request);
  if (!token) return jsonError("Device token is required", 401);

  try {
    const device = await authenticateDeviceToken(db, token);
    if (device.deviceId !== deviceId) throw new DeviceUnauthorizedError();
    await requireHostedCloudAccess(db, device.userId, hosted);
    const body = await readJson(request);
    if (!body || typeof body !== "object")
      return jsonError("Invalid request", 400);
    const payload = body as {
      appliedRevisionId?: unknown;
      syncStatus?: unknown;
      lastErrorCode?: unknown;
      lastErrorMessage?: unknown;
    };
    if (
      payload.appliedRevisionId !== undefined &&
      payload.appliedRevisionId !== null &&
      typeof payload.appliedRevisionId !== "string"
    ) {
      return jsonError("A locally verified applied revision is required", 400);
    }
    if (typeof payload.syncStatus !== "string") {
      return jsonError("A valid device sync aggregate is required", 400);
    }
    return Response.json(
      await acceptDeviceSyncReport(db, {
        deviceId: device.deviceId,
        appliedRevisionId:
          typeof payload.appliedRevisionId === "string"
            ? payload.appliedRevisionId
            : null,
        syncStatus: payload.syncStatus,
        lastErrorCode:
          typeof payload.lastErrorCode === "string"
            ? payload.lastErrorCode
            : null,
        lastErrorMessage:
          typeof payload.lastErrorMessage === "string"
            ? payload.lastErrorMessage
            : null,
      }),
    );
  } catch (error) {
    return reportError(error);
  }
}
