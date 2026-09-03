import { DomainValidationError } from "../../../packages/core/src/index";
import { isSameOrigin, jsonError, readJson } from "./api";
import {
  HostedEntitlementRequiredError,
  hasHostedCloudAccess,
} from "./billing";
import {
  type DashboardMutation,
  dashboardMutationResult,
  mutateDashboard,
  readDashboard,
} from "./dashboard";
import { InvalidIdempotencyKeyError, RevisionConflictError } from "./revisions";

export function dashboardMutationErrorResponse(error: unknown) {
  if (error instanceof HostedEntitlementRequiredError)
    return jsonError(error.message, 402);
  if (
    error instanceof RevisionConflictError ||
    (error instanceof Error && error.message === "BASE_REVISION_CONFLICT")
  )
    return jsonError(
      "The workspace changed before this mutation could be applied.",
      409,
    );
  if (error instanceof InvalidIdempotencyKeyError)
    return jsonError(error.message, 400);
  if (error instanceof DomainValidationError)
    return jsonError(error.message, 400);
  if (
    error instanceof Error &&
    [
      "INVALID_SKILL",
      "INVALID_REF",
      "SKILL_NOT_FOUND",
      "Repository must not include credentials",
    ].includes(error.message)
  )
    return jsonError(error.message, 400);
  throw error;
}

export async function handleDashboardGet(
  db: Parameters<typeof readDashboard>[0],
  userId: string | null,
  hosted = false,
) {
  if (!userId) return jsonError("Authentication required", 401);
  try {
    const dashboard = await readDashboard(db, userId);
    return Response.json({
      ...dashboard,
      cloudAllowed: await hasHostedCloudAccess(db, userId, hosted),
    });
  } catch (error) {
    return dashboardMutationErrorResponse(error);
  }
}

export async function handleDashboardMutation(
  request: Request,
  db: Parameters<typeof mutateDashboard>[0],
  userId: string | null,
  hosted: boolean,
) {
  if (!userId) return jsonError("Authentication required", 401);
  if (!isSameOrigin(request)) return jsonError("Invalid request origin", 403);
  const body = (await readJson(request)) as {
    baseRevisionId?: unknown;
    idempotencyKey?: unknown;
    mutation?: unknown;
  } | null;
  if (
    !body ||
    (body.baseRevisionId !== null && typeof body.baseRevisionId !== "string") ||
    typeof body.idempotencyKey !== "string" ||
    !body.mutation ||
    typeof body.mutation !== "object"
  )
    return jsonError("Invalid dashboard mutation", 400);
  try {
    const revision = await mutateDashboard(db, {
      userId,
      hosted,
      baseRevisionId: body.baseRevisionId,
      idempotencyKey: body.idempotencyKey,
      mutation: body.mutation as DashboardMutation,
    });
    return Response.json(dashboardMutationResult(revision));
  } catch (error) {
    return dashboardMutationErrorResponse(error);
  }
}
