import {
  DomainValidationError,
  parseRevisionTransition,
  type RevisionTransition,
  validateDesiredState,
} from "../../../packages/core/src/index";
import { jsonError, readJson } from "./api";
import { protectCloudRequest } from "./cloud-protect";
import {
  type CloudRevision,
  InvalidIdempotencyKeyError,
  loadCurrentDesiredState,
  mutateDesiredState,
  RevisionConflictError,
} from "./revisions";
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

function envelope(
  revision: CloudRevision | Awaited<ReturnType<typeof loadCurrentDesiredState>>,
) {
  return {
    revisionId: revision.id,
    revisionSequence: revision.sequence,
    state: revision.state,
  };
}

function stateError(error: unknown) {
  if (error instanceof DeviceUnauthorizedError)
    return jsonError(error.message, 401);
  if (error instanceof WorkspaceAccessError)
    return jsonError(error.message, 404);
  if (error instanceof RevisionConflictError)
    return jsonError(error.message, 409);
  if (error instanceof InvalidIdempotencyKeyError)
    return jsonError(error.message, 400);
  if (error instanceof DomainValidationError)
    return jsonError(error.message, 400);
  throw error;
}

async function authenticateStateRequest(
  request: Request,
  db: TokenDatabase,
  workspaceId: string,
  kind: "normal" | "mutation",
) {
  const blocked = await protectCloudRequest(request, db, {
    kind,
    requireCli: true,
  });
  if (blocked) return { error: blocked };
  const token = deviceTokenFrom(request);
  if (!token) return { error: jsonError("Device token is required", 401) };
  try {
    const device = await authenticateDeviceToken(db, token);
    await requireDeviceWorkspaceAccess(db, device.deviceId, workspaceId);
    return { device };
  } catch (error) {
    return { error: stateError(error) };
  }
}

function readTransition(value: unknown): RevisionTransition | null {
  if (!value || typeof value !== "object") return null;
  try {
    return parseRevisionTransition(JSON.stringify(value));
  } catch {
    return null;
  }
}

export async function handleGetWorkspaceState(
  request: Request,
  db: TokenDatabase,
  workspaceId: string,
) {
  const authenticated = await authenticateStateRequest(
    request,
    db,
    workspaceId,
    "normal",
  );
  if ("error" in authenticated) return authenticated.error;
  try {
    return Response.json(
      envelope(
        await loadCurrentDesiredState(
          db,
          authenticated.device.userId,
          workspaceId,
        ),
      ),
    );
  } catch (error) {
    return stateError(error);
  }
}

export async function handlePutWorkspaceState(
  request: Request,
  db: TokenDatabase,
  workspaceId: string,
) {
  const authenticated = await authenticateStateRequest(
    request,
    db,
    workspaceId,
    "mutation",
  );
  if ("error" in authenticated) return authenticated.error;
  const body = await readJson(request);
  if (!body || typeof body !== "object")
    return jsonError("Invalid request", 400);
  const payload = body as {
    state?: unknown;
    baseRevision?: unknown;
    idempotencyKey?: unknown;
    transition?: unknown;
  };
  if (
    payload.baseRevision !== null &&
    typeof payload.baseRevision !== "string"
  ) {
    return jsonError("A base revision is required", 400);
  }
  const transition = readTransition(payload.transition);
  if (!transition) return jsonError("A revision transition is required", 400);
  const idempotencyKey =
    (typeof payload.idempotencyKey === "string" && payload.idempotencyKey) ||
    request.headers.get("idempotency-key") ||
    "";
  if (!payload.state || typeof payload.state !== "object")
    return jsonError("Desired state is required", 400);

  try {
    const state = validateDesiredState(payload.state as never, "cloud");
    const revision = await mutateDesiredState(db as never, {
      workspaceId,
      userId: authenticated.device.userId,
      baseRevisionId: payload.baseRevision,
      idempotencyKey,
      actor: { type: "device", id: authenticated.device.deviceId },
      state,
      transition,
    });
    return Response.json(envelope(revision));
  } catch (error) {
    return stateError(error);
  }
}
