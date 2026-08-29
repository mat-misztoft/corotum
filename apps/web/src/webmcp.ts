import { requireHostedCloudAccess } from "./billing";
import { type DashboardView, readDashboard } from "./dashboard";
import type { DeviceUpdateStatus } from "./sync-report";

type WebMcpDatabase = Parameters<typeof readDashboard>[0];

const UPDATE_STATUSES = new Set<DeviceUpdateStatus>([
  "UP_TO_DATE",
  "UPDATE_AVAILABLE",
  "UNKNOWN",
  "AUTH_REQUIRED",
  "CHECK_FAILED",
]);

export const WEBMCP_READ_ONLY_TOOLS = [
  "list_skills",
  "list_devices",
  "get_sync_status",
  "check_skill_updates",
] as const;

export type WebMcpReadOnlyTool = (typeof WEBMCP_READ_ONLY_TOOLS)[number];

type UpdateRow = Readonly<{
  deviceId: string;
  skillId: string;
  status: string;
  checkedAt: number;
}>;

type SkillUpdate = Readonly<{
  skillId: string;
  status: DeviceUpdateStatus;
  reports: readonly Readonly<{
    deviceId: string;
    status: DeviceUpdateStatus;
    checkedAt: number;
  }>[];
}>;

function isWebMcpReadOnlyTool(value: unknown): value is WebMcpReadOnlyTool {
  return (
    typeof value === "string" &&
    (WEBMCP_READ_ONLY_TOOLS as readonly string[]).includes(value)
  );
}

function updateStatus(
  rows: readonly Pick<UpdateRow, "status">[],
): DeviceUpdateStatus {
  if (rows.some((row) => row.status === "AUTH_REQUIRED"))
    return "AUTH_REQUIRED";
  if (rows.some((row) => row.status === "CHECK_FAILED")) return "CHECK_FAILED";
  if (rows.some((row) => row.status === "UPDATE_AVAILABLE"))
    return "UPDATE_AVAILABLE";
  if (rows.some((row) => row.status === "UP_TO_DATE")) return "UP_TO_DATE";
  return "UNKNOWN";
}

/** Projects only device-reported update checks; WebMCP never contacts a Git remote. */
async function readKnownSkillUpdates(
  db: WebMcpDatabase,
  userId: string,
  dashboard: DashboardView,
): Promise<readonly SkillUpdate[]> {
  const rows = await db
    .prepare(
      `SELECT dsu.device_id AS deviceId, dsu.skill_id AS skillId,
              dsu.status AS status, dsu.checked_at AS checkedAt
       FROM device_skill_updates dsu
       JOIN devices d ON d.id = dsu.device_id
       JOIN device_workspaces dw ON dw.device_id = d.id
        AND dw.workspace_id = dsu.workspace_id AND dw.is_active = 1
       WHERE dsu.workspace_id = ? AND d.user_id = ? AND d.revoked_at IS NULL
       ORDER BY dsu.skill_id, dsu.checked_at DESC`,
    )
    .bind(dashboard.workspace.id, userId)
    .all<UpdateRow>();
  const known = (rows.results ?? []).filter((row) =>
    UPDATE_STATUSES.has(row.status as DeviceUpdateStatus),
  );
  return dashboard.skills.map((skill) => {
    const skillId = skill.id;
    const reports = known
      .filter((row) => row.skillId === skillId)
      .map((row) => ({
        deviceId: row.deviceId,
        status: row.status as DeviceUpdateStatus,
        checkedAt: row.checkedAt,
      }));
    return { skillId, status: updateStatus(reports), reports };
  });
}

/** Shared read model for WebMCP. It has no desired-state or device side effects. */
export async function executeWebMcpReadOnlyTool(
  db: WebMcpDatabase,
  input: Readonly<{ userId: string; hosted: boolean; tool: unknown }>,
) {
  if (!isWebMcpReadOnlyTool(input.tool)) throw new InvalidWebMcpToolError();
  await requireHostedCloudAccess(db, input.userId, input.hosted);
  const dashboard = await readDashboard(db, input.userId);
  switch (input.tool) {
    case "list_skills":
      return {
        workspace: dashboard.workspace,
        revision: dashboard.revision,
        skills: dashboard.skills,
      };
    case "list_devices":
      return {
        workspace: dashboard.workspace,
        revision: dashboard.revision,
        devices: dashboard.devices,
      };
    case "get_sync_status":
      return {
        workspace: dashboard.workspace,
        revision: dashboard.revision,
        devices: dashboard.devices.map(
          ({
            id,
            appliedRevisionSequence,
            syncStatus,
            lastSyncAt,
            lastErrorCode,
            lastErrorMessage,
            targets,
          }) => ({
            id,
            appliedRevisionSequence,
            syncStatus,
            lastSyncAt,
            lastErrorCode,
            lastErrorMessage,
            targets,
          }),
        ),
      };
    case "check_skill_updates":
      return {
        workspace: dashboard.workspace,
        revision: dashboard.revision,
        skills: await readKnownSkillUpdates(db, input.userId, dashboard),
      };
  }
}

export class InvalidWebMcpToolError extends Error {
  constructor() {
    super("Unknown WebMCP read-only tool");
    this.name = "InvalidWebMcpToolError";
  }
}
