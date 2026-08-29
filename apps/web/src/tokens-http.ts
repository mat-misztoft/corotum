import { isSameOrigin, jsonError } from "./api";
import { clientIp, protectCloudRequest } from "./cloud-protect";
import { PairingNotFoundError } from "./pairings";
import {
  DeviceNotFoundError,
  DeviceUnauthorizedError,
  issueDeviceToken,
  logoutDeviceToken,
  PairingNotApprovedError,
  revokeDevice,
  TokenAlreadyIssuedError,
  type TokenDatabase,
} from "./tokens";

export function deviceTokenFrom(request: Request) {
  return request.headers.get("x-toolmirror-device-token");
}

function tokenError(error: unknown) {
  if (error instanceof PairingNotFoundError)
    return jsonError(error.message, 404);
  if (error instanceof DeviceNotFoundError)
    return jsonError(error.message, 404);
  if (error instanceof PairingNotApprovedError)
    return jsonError(error.message, 409);
  if (error instanceof TokenAlreadyIssuedError)
    return jsonError(error.message, 409);
  if (error instanceof DeviceUnauthorizedError)
    return jsonError(error.message, 401);
  throw error;
}

export async function handleIssueDeviceToken(
  request: Request,
  db: TokenDatabase,
  pairingId: string,
) {
  const blocked = await protectCloudRequest(request, db, {
    kind: "pairingAuth",
    requireCli: true,
  });
  if (blocked) return blocked;
  const deviceCode = request.headers.get("x-toolmirror-device-code");
  if (!deviceCode) return jsonError("Device code is required", 401);
  try {
    return Response.json(await issueDeviceToken(db, pairingId, deviceCode), {
      status: 201,
    });
  } catch (error) {
    return tokenError(error);
  }
}

export async function handleLogoutDevice(request: Request, db: TokenDatabase) {
  const blocked = await protectCloudRequest(request, db, {
    kind: "pairingAuth",
    requireCli: true,
  });
  if (blocked) return blocked;
  const token = deviceTokenFrom(request);
  if (!token) return jsonError("Device token is required", 401);
  try {
    const result = await logoutDeviceToken(db, token);
    return Response.json({ revoked: true, deviceId: result.deviceId });
  } catch (error) {
    return tokenError(error);
  }
}

export async function handleRevokeDevice(
  request: Request,
  db: TokenDatabase,
  deviceId: string,
  userId: string | null,
) {
  const blocked = await protectCloudRequest(request, db, {
    kind: "mutation",
    identity: userId ? `user:${userId}` : `ip:${clientIp(request)}`,
  });
  if (blocked) return blocked;
  if (!isSameOrigin(request)) return jsonError("Invalid request origin", 403);
  if (!userId) return jsonError("Authentication required", 401);
  try {
    await revokeDevice(db, userId, deviceId);
    return Response.json({ revoked: true, deviceId });
  } catch (error) {
    return tokenError(error);
  }
}
