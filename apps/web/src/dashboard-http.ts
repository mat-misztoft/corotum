import { HostedEntitlementRequiredError } from "./billing";
import { type DashboardMutation, mutateDashboard, readDashboard } from "./dashboard";
import { isSameOrigin, jsonError, readJson } from "./api";
import { InvalidIdempotencyKeyError, RevisionConflictError } from "./revisions";

function errorResponse(error: unknown) {
  if (error instanceof HostedEntitlementRequiredError) return jsonError(error.message, 402);
  if (error instanceof RevisionConflictError || (error instanceof Error && error.message === "BASE_REVISION_CONFLICT")) return jsonError("The workspace changed before this mutation could be applied.", 409);
  if (error instanceof InvalidIdempotencyKeyError) return jsonError(error.message, 400);
  if (error instanceof Error && ["INVALID_SKILL", "INVALID_REF", "SKILL_NOT_FOUND", "Repository must not include credentials"].includes(error.message)) return jsonError(error.message, 400);
  throw error;
}

export async function handleDashboardGet(db: Parameters<typeof readDashboard>[0], userId: string | null) {
  if (!userId) return jsonError("Authentication required", 401);
  try { return Response.json(await readDashboard(db, userId)); } catch (error) { return errorResponse(error); }
}

export async function handleDashboardMutation(
  request: Request,
  db: Parameters<typeof mutateDashboard>[0],
  userId: string | null,
  hosted: boolean,
) {
  if (!userId) return jsonError("Authentication required", 401);
  if (!isSameOrigin(request)) return jsonError("Invalid request origin", 403);
  const body = await readJson(request) as { baseRevisionId?: unknown; idempotencyKey?: unknown; mutation?: unknown } | null;
  if (!body || (body.baseRevisionId !== null && typeof body.baseRevisionId !== "string") || typeof body.idempotencyKey !== "string" || !body.mutation || typeof body.mutation !== "object") return jsonError("Invalid dashboard mutation", 400);
  try {
    const revision = await mutateDashboard(db, {
      userId, hosted, baseRevisionId: body.baseRevisionId, idempotencyKey: body.idempotencyKey,
      mutation: body.mutation as DashboardMutation,
    });
    return Response.json({ revisionId: revision.id, revisionSequence: revision.sequence, pendingResolution: revision.state.manifest.skills.filter((skill) => skill.resolutionStatus === "PENDING_RESOLUTION").map((skill) => skill.id) });
  } catch (error) { return errorResponse(error); }
}
