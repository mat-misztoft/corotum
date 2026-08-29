import {
  DomainValidationError,
  parseRevisionTransition,
  type RevisionTransition,
  validateDesiredState,
} from "../../../packages/core/src/index";
import { jsonError, readJson } from "./api";
import {
  HostedEntitlementRequiredError,
  requireHostedCloudAccess,
} from "./billing";
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
  if (error instanceof HostedEntitlementRequiredError)
    return jsonError(error.message, 402);
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
  hosted: boolean,
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
    await requireHostedCloudAccess(db, device.userId, hosted);
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

function containsEmbeddedCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

type ResolutionPayload = Readonly<{
  skillId: string;
  baseRevision: string;
  idempotencyKey: string;
  repository: string;
  revision: string;
  path: string;
  contentHash: string;
}>;

function readResolution(value: unknown): ResolutionPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const fields = [
    "skillId",
    "baseRevision",
    "idempotencyKey",
    "repository",
    "revision",
    "path",
    "contentHash",
  ] as const;
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = payload[field];
    if (typeof value !== "string" || !value.trim()) return null;
    values[field] = value.trim();
  }
  return values as ResolutionPayload;
}

export async function handleGetWorkspaceState(
  request: Request,
  db: TokenDatabase,
  workspaceId: string,
  hosted = false,
) {
  const authenticated = await authenticateStateRequest(
    request,
    db,
    workspaceId,
    "normal",
    hosted,
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

/**
 * Resolves exactly one pending skill from a device-provided immutable Git result.
 * The Worker only validates and persists the result; it never clones a source.
 */
export async function handlePostPendingResolution(
  request: Request,
  db: TokenDatabase,
  workspaceId: string,
  hosted = false,
) {
  const authenticated = await authenticateStateRequest(
    request,
    db,
    workspaceId,
    "mutation",
    hosted,
  );
  if ("error" in authenticated) return authenticated.error;
  const payload = readResolution(await readJson(request));
  if (!payload)
    return jsonError("A complete pending resolution is required", 400);
  if (containsEmbeddedCredentials(payload.repository))
    return jsonError("Repository must not include credentials", 400);

  try {
    const current = await loadCurrentDesiredState(
      db,
      authenticated.device.userId,
      workspaceId,
    );
    if (current.id !== payload.baseRevision) throw new RevisionConflictError();
    const pending = current.state.manifest.skills.find(
      (skill) => skill.id === payload.skillId,
    );
    if (!pending || pending.resolutionStatus !== "PENDING_RESOLUTION")
      throw new DomainValidationError(
        "VALIDATION_ERROR",
        "Skill is not pending resolution.",
      );
    const state = {
      manifest: {
        version: 1 as const,
        skills: current.state.manifest.skills.map((skill) =>
          skill.id === pending.id
            ? { ...skill, resolutionStatus: "RESOLVED" as const }
            : skill,
        ),
      },
      lockfile: {
        version: 1 as const,
        skills: [
          ...current.state.lockfile.skills,
          {
            id: pending.id,
            source: pending.source,
            skill: pending.skill,
            ref: pending.ref,
            repository: payload.repository,
            revision: payload.revision,
            path: payload.path,
            contentHash: payload.contentHash,
          },
        ],
      },
    };
    const revision = await mutateDesiredState(db as never, {
      workspaceId,
      userId: authenticated.device.userId,
      baseRevisionId: payload.baseRevision,
      idempotencyKey: payload.idempotencyKey,
      actor: { type: "device", id: authenticated.device.deviceId },
      state,
      transition: {
        type: "UPDATE",
        skillId: pending.id,
        metadata: { resolution: "resolved" },
      },
    });
    return Response.json(envelope(revision));
  } catch (error) {
    return stateError(error);
  }
}

export async function handlePutWorkspaceState(
  request: Request,
  db: TokenDatabase,
  workspaceId: string,
  hosted = false,
) {
  const authenticated = await authenticateStateRequest(
    request,
    db,
    workspaceId,
    "mutation",
    hosted,
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
    const sources = [
      ...state.manifest.skills.map((skill) => skill.source),
      ...state.lockfile.skills.flatMap((skill) => [
        skill.source,
        skill.repository,
      ]),
    ];
    if (sources.some((value) => containsEmbeddedCredentials(value))) {
      return jsonError("Repository must not include credentials", 400);
    }
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
