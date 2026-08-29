import { jsonError, readJson } from "./api";
import { HostedEntitlementRequiredError } from "./billing";
import { clientIp, protectCloudRequest } from "./cloud-protect";
import { executeWebMcpReadOnlyTool, InvalidWebMcpToolError } from "./webmcp";

export async function handleWebMcpReadOnlyTool(
  request: Request,
  db: Parameters<typeof executeWebMcpReadOnlyTool>[0],
  userId: string | null,
  hosted: boolean,
) {
  const blocked = await protectCloudRequest(request, db as never, {
    kind: "normal",
    identity: userId ? `user:${userId}` : `ip:${clientIp(request)}`,
  });
  if (blocked) return blocked;
  if (!userId) return jsonError("Authentication required", 401);
  const body = (await readJson(request)) as { tool?: unknown } | null;
  if (!body) return jsonError("A WebMCP tool is required", 400);
  try {
    return Response.json(
      await executeWebMcpReadOnlyTool(db, { userId, hosted, tool: body.tool }),
    );
  } catch (error) {
    if (error instanceof HostedEntitlementRequiredError)
      return jsonError(error.message, 402);
    if (error instanceof InvalidWebMcpToolError)
      return jsonError(error.message, 400);
    throw error;
  }
}
