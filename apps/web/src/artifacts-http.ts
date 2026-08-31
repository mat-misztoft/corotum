import { DomainValidationError } from "../../../packages/core/src/index";
import { jsonError } from "./api";
import {
  ArtifactGcAmbiguousError,
  ArtifactMetadataError,
  ArtifactTransferError,
  type ArtifactBucket,
  type ArtifactTransfer,
  garbageCollectWorkspaceArtifacts,
  getWorkspaceArtifact,
  parseArtifactTransfer,
  putWorkspaceArtifact,
} from "./artifacts";
import {
  HostedEntitlementRequiredError,
  requireHostedCloudAccess,
} from "./billing";
import { protectCloudRequest } from "./cloud-protect";
import { loadCurrentDesiredState, RevisionConflictError } from "./revisions";
import {
  authenticateDeviceToken,
  DeviceUnauthorizedError,
  type TokenDatabase,
} from "./tokens";
import { deviceTokenFrom } from "./tokens-http";
import {
  requireDeviceWorkspaceAccess,
  WorkspaceAccessError,
} from "./workspaces";

export const ARTIFACT_DESCRIPTOR_HEADER = "x-corotum-artifact";

function artifactError(error: unknown) {
  if (error instanceof DeviceUnauthorizedError) return jsonError(error.message, 401);
  if (error instanceof HostedEntitlementRequiredError) return jsonError(error.message, 402);
  if (error instanceof WorkspaceAccessError) return jsonError(error.message, 404);
  if (error instanceof RevisionConflictError) return jsonError(error.message, 409);
  if (error instanceof ArtifactGcAmbiguousError) return jsonError(error.message, 409);
  if (error instanceof ArtifactMetadataError) return jsonError(error.message, 503);
  if (error instanceof ArtifactTransferError) {
    if (error.code === "ARTIFACT_UNAVAILABLE") return jsonError(error.message, 404);
    return jsonError(error.message, 400);
  }
  if (error instanceof DomainValidationError) return jsonError(error.message, 400);
  throw error;
}

async function authenticateArtifactRequest(
  request: Request,
  db: TokenDatabase,
  workspaceId: string,
  kind: "normal" | "mutation",
  hosted: boolean,
) {
  const blocked = await protectCloudRequest(request, db, { kind, requireCli: true });
  if (blocked) return { error: blocked };
  const token = deviceTokenFrom(request);
  if (!token) return { error: jsonError("Device token is required", 401) };
  try {
    const device = await authenticateDeviceToken(db, token);
    await requireDeviceWorkspaceAccess(db, device.deviceId, workspaceId);
    await requireHostedCloudAccess(db, device.userId, hosted);
    return { device };
  } catch (error) {
    return { error: artifactError(error) };
  }
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function readTransfer(request: Request): ArtifactTransfer {
  const raw = request.headers.get(ARTIFACT_DESCRIPTOR_HEADER);
  if (!raw) throw new ArtifactTransferError("VALIDATION_ERROR", "An artifact-backed descriptor is required.");
  try {
    return parseArtifactTransfer(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof ArtifactTransferError || error instanceof DomainValidationError) throw error;
    throw new ArtifactTransferError("VALIDATION_ERROR", "An artifact-backed descriptor is required.");
  }
}

export async function handlePutWorkspaceArtifact(
  request: Request,
  db: TokenDatabase,
  bucket: ArtifactBucket,
  workspaceId: string,
  hosted = false,
) {
  const authenticated = await authenticateArtifactRequest(request, db, workspaceId, "mutation", hosted);
  if ("error" in authenticated) return authenticated.error;
  try {
    const transfer = readTransfer(request);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const stored = await putWorkspaceArtifact(db, bucket, {
      workspaceId,
      userId: authenticated.device.userId,
      transfer,
      bytes,
    });
    return Response.json(stored);
  } catch (error) {
    return artifactError(error);
  }
}

export async function handleGetWorkspaceArtifact(
  request: Request,
  db: TokenDatabase,
  bucket: ArtifactBucket,
  workspaceId: string,
  hosted = false,
) {
  const authenticated = await authenticateArtifactRequest(request, db, workspaceId, "normal", hosted);
  if ("error" in authenticated) return authenticated.error;
  try {
    const transfer = readTransfer(request);
    const bytes = await getWorkspaceArtifact(bucket, { workspaceId, transfer });
    return new Response(arrayBufferOf(bytes), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        [ARTIFACT_DESCRIPTOR_HEADER]: JSON.stringify(transfer),
      },
    });
  } catch (error) {
    return artifactError(error);
  }
}

export async function handlePostWorkspaceArtifactGc(
  request: Request,
  db: TokenDatabase,
  bucket: ArtifactBucket,
  workspaceId: string,
  hosted = false,
) {
  const authenticated = await authenticateArtifactRequest(request, db, workspaceId, "mutation", hosted);
  if ("error" in authenticated) return authenticated.error;
  try {
    await loadCurrentDesiredState(db, authenticated.device.userId, workspaceId);
    const deleted = await garbageCollectWorkspaceArtifacts(db, bucket, workspaceId);
    return Response.json({ deleted });
  } catch (error) {
    return artifactError(error);
  }
}
