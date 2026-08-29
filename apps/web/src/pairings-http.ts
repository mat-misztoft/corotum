import { isSameOrigin, jsonError, readJson } from "./api";
import { protectCloudRequest } from "./cloud-protect";
import {
  approvePairing,
  createPairing,
  getPairingStatus,
  InvalidPairingInputError,
  PairingAlreadyApprovedError,
  type PairingDatabase,
  type PairingDevice,
  PairingExpiredError,
  PairingNotFoundError,
} from "./pairings";

function pairingError(error: unknown) {
  if (error instanceof InvalidPairingInputError)
    return jsonError(error.message, 400);
  if (error instanceof PairingNotFoundError)
    return jsonError(error.message, 404);
  if (error instanceof PairingExpiredError)
    return jsonError(error.message, 410);
  if (error instanceof PairingAlreadyApprovedError)
    return jsonError(error.message, 409);
  throw error;
}

export async function handleCreatePairing(
  request: Request,
  db: PairingDatabase,
) {
  const blocked = await protectCloudRequest(request, db, {
    kind: "pairingAuth",
    requireCli: true,
  });
  if (blocked) return blocked;
  const body = await readJson(request);
  if (!body || typeof body !== "object")
    return jsonError("Invalid request", 400);
  const { name, platform, architecture, cliVersion } =
    body as Partial<PairingDevice>;
  if (
    typeof name !== "string" ||
    typeof platform !== "string" ||
    typeof architecture !== "string" ||
    typeof cliVersion !== "string"
  )
    return jsonError("Invalid request", 400);

  try {
    return Response.json(
      await createPairing(db, { name, platform, architecture, cliVersion }),
      { status: 201 },
    );
  } catch (error) {
    return pairingError(error);
  }
}

export async function handleGetPairing(
  request: Request,
  db: PairingDatabase,
  id: string,
) {
  const blocked = await protectCloudRequest(request, db, {
    kind: "pairingAuth",
    requireCli: true,
  });
  if (blocked) return blocked;
  const deviceCode = request.headers.get("x-toolmirror-device-code");
  if (!deviceCode) return jsonError("Device code is required", 401);
  try {
    return Response.json(await getPairingStatus(db, id, deviceCode));
  } catch (error) {
    return pairingError(error);
  }
}

export async function handleApprovePairing(
  request: Request,
  db: PairingDatabase,
  id: string,
  userId: string | null,
) {
  const blocked = await protectCloudRequest(request, db, {
    kind: "pairingAuth",
  });
  if (blocked) return blocked;
  if (!isSameOrigin(request)) return jsonError("Invalid request origin", 403);
  if (!userId) return jsonError("Authentication required", 401);
  const body = await readJson(request);
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { userCode?: unknown }).userCode !== "string"
  )
    return jsonError("Invalid request", 400);

  try {
    const result = await approvePairing(
      db,
      userId,
      id,
      (body as { userCode: string }).userCode,
    );
    return Response.json({ pairingId: id, ...result });
  } catch (error) {
    return pairingError(error);
  }
}
