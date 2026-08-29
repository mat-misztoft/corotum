import { isSameOrigin, jsonError } from "./api";
import { clientIp, protectCloudRequest } from "./cloud-protect";
import { readDeviceTargetStatus } from "./device-target-status";
import {
  DeviceNotFoundError,
  DeviceUnauthorizedError,
  type TokenDatabase,
} from "./tokens";

export async function handleGetDeviceTargetStatus(
  request: Request,
  db: TokenDatabase,
  deviceId: string,
  userId: string | null,
) {
  const blocked = await protectCloudRequest(request, db, {
    kind: "normal",
    identity: userId ? `user:${userId}` : `ip:${clientIp(request)}`,
  });
  if (blocked) return blocked;
  if (!isSameOrigin(request)) return jsonError("Invalid request origin", 403);
  if (!userId) return jsonError("Authentication required", 401);
  try {
    return Response.json(await readDeviceTargetStatus(db, userId, deviceId));
  } catch (error) {
    if (error instanceof DeviceNotFoundError)
      return jsonError(error.message, 404);
    if (error instanceof DeviceUnauthorizedError)
      return jsonError(error.message, 401);
    throw error;
  }
}
