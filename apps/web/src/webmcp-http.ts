import { isSameOrigin, jsonError, readJson } from "./api";
import { HostedEntitlementRequiredError } from "./billing";
import { clientIp, protectCloudRequest } from "./cloud-protect";
import { dashboardMutationErrorResponse } from "./dashboard-http";
import {
  executeWebMcpMutationTool,
  executeWebMcpReadOnlyTool,
  InvalidWebMcpMutationInputError,
  InvalidWebMcpToolError,
} from "./webmcp";

type WebMcpRequest = Readonly<{
  tool?: unknown;
  baseRevisionId?: unknown;
  idempotencyKey?: unknown;
  arguments?: unknown;
}>;

export async function handleWebMcpTool(
  request: Request,
  db: Parameters<typeof executeWebMcpReadOnlyTool>[0],
  userId: string | null,
  hosted: boolean,
) {
  const body = (await readJson(request)) as WebMcpRequest | null;
  if (!body) return jsonError("A WebMCP tool is required", 400);
  const mutation =
    body.tool === "add_skill" ||
    body.tool === "remove_skill" ||
    body.tool === "update_skill" ||
    body.tool === "set_skill_ref";
  const blocked = await protectCloudRequest(request, db as never, {
    kind: mutation ? "mutation" : "normal",
    identity: userId ? `user:${userId}` : `ip:${clientIp(request)}`,
  });
  if (blocked) return blocked;
  if (!userId) return jsonError("Authentication required", 401);
  if (mutation && !isSameOrigin(request))
    return jsonError("Invalid request origin", 403);

  try {
    if (!mutation) {
      return Response.json(
        await executeWebMcpReadOnlyTool(db, {
          userId,
          hosted,
          tool: body.tool,
        }),
      );
    }
    if (
      (body.baseRevisionId !== null &&
        typeof body.baseRevisionId !== "string") ||
      typeof body.idempotencyKey !== "string"
    ) {
      return jsonError(
        "A base revision and idempotency key are required for WebMCP mutations",
        400,
      );
    }
    return Response.json(
      await executeWebMcpMutationTool(db, {
        userId,
        hosted,
        tool: body.tool,
        baseRevisionId: body.baseRevisionId,
        idempotencyKey: body.idempotencyKey,
        arguments: body.arguments,
      }),
    );
  } catch (error) {
    if (error instanceof HostedEntitlementRequiredError)
      return jsonError(error.message, 402);
    if (
      error instanceof InvalidWebMcpToolError ||
      error instanceof InvalidWebMcpMutationInputError
    )
      return jsonError(error.message, 400);
    return dashboardMutationErrorResponse(error);
  }
}
