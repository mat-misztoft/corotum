import {
  dashboardMutationResult,
  type DashboardMutation,
  type DashboardView,
  mutateDashboard,
  readDashboard,
} from "./dashboard";
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

export const WEBMCP_MUTATION_TOOLS = [
  "add_skill",
  "remove_skill",
  "update_skill",
  "set_skill_ref",
] as const;

export type WebMcpReadOnlyTool = (typeof WEBMCP_READ_ONLY_TOOLS)[number];
export type WebMcpMutationTool = (typeof WEBMCP_MUTATION_TOOLS)[number];

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
  return typeof value === "string" && (WEBMCP_READ_ONLY_TOOLS as readonly string[]).includes(value);
}

function isWebMcpMutationTool(value: unknown): value is WebMcpMutationTool {
  return typeof value === "string" && (WEBMCP_MUTATION_TOOLS as readonly string[]).includes(value);
}

function updateStatus(rows: readonly Pick<UpdateRow, "status">[]): DeviceUpdateStatus {
  if (rows.some((row) => row.status === "AUTH_REQUIRED")) return "AUTH_REQUIRED";
  if (rows.some((row) => row.status === "CHECK_FAILED")) return "CHECK_FAILED";
  if (rows.some((row) => row.status === "UPDATE_AVAILABLE")) return "UPDATE_AVAILABLE";
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
  const known = (rows.results ?? []).filter((row) => UPDATE_STATUSES.has(row.status as DeviceUpdateStatus));
  return dashboard.skills.map((skill) => {
    const skillId = skill.id;
    const reports = known.filter((row) => row.skillId === skillId).map((row) => ({
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
  const dashboard = await readDashboard(db, input.userId);
  switch (input.tool) {
    case "list_skills": return { workspace: dashboard.workspace, revision: dashboard.revision, skills: dashboard.skills };
    case "list_devices": return { workspace: dashboard.workspace, revision: dashboard.revision, devices: dashboard.devices };
    case "get_sync_status": return {
      workspace: dashboard.workspace,
      revision: dashboard.revision,
      devices: dashboard.devices.map(({ id, appliedRevisionSequence, syncStatus, lastSyncAt, lastErrorCode, lastErrorMessage, targets }) => ({ id, appliedRevisionSequence, syncStatus, lastSyncAt, lastErrorCode, lastErrorMessage, targets })),
    };
    case "check_skill_updates": return { workspace: dashboard.workspace, revision: dashboard.revision, skills: await readKnownSkillUpdates(db, input.userId, dashboard) };
  }
}

/** Maps WebMCP tool arguments to the dashboard mutation service without adding a second mutation path. */
function webMcpMutation(tool: WebMcpMutationTool, input: unknown): DashboardMutation {
  if (!input || typeof input !== "object") throw new InvalidWebMcpMutationInputError();
  const value = input as Record<string, unknown>;
  const string = (key: string) => typeof value[key] === "string" ? value[key] : null;
  const targets = value.targets;
  if (targets !== undefined && targets !== "all" && (!Array.isArray(targets) || targets.some((target) => typeof target !== "string"))) {
    throw new InvalidWebMcpMutationInputError();
  }
  switch (tool) {
    case "add_skill": {
      const source = string("source");
      const skill = string("skill");
      const ref = value.ref === undefined ? undefined : string("ref");
      const path = value.path === undefined ? undefined : string("path");
      if (!source || !skill || (value.ref !== undefined && !ref) || (value.path !== undefined && !path)) throw new InvalidWebMcpMutationInputError();
      return { type: "ADD", source, skill, ref: ref ?? undefined, path: path ?? undefined, targets: targets as "all" | string[] | undefined };
    }
    case "remove_skill": {
      const skillId = string("skillId");
      if (!skillId) throw new InvalidWebMcpMutationInputError();
      return { type: "REMOVE", skillId };
    }
    case "update_skill": {
      const skillId = string("skillId");
      if (!skillId) throw new InvalidWebMcpMutationInputError();
      return { type: "UPDATE", skillId };
    }
    case "set_skill_ref": {
      const skillId = string("skillId");
      const ref = string("ref");
      if (!skillId || !ref) throw new InvalidWebMcpMutationInputError();
      return { type: "SET_REF", skillId, ref };
    }
  }
}

/** WebMCP changes desired state only; a device must later run sync and report the revision. */
export async function executeWebMcpMutationTool(
  db: WebMcpDatabase,
  input: Readonly<{
    userId: string;
    hosted: boolean;
    tool: unknown;
    baseRevisionId: string | null;
    idempotencyKey: string;
    arguments: unknown;
  }>,
) {
  if (!isWebMcpMutationTool(input.tool)) throw new InvalidWebMcpToolError();
  const revision = await mutateDashboard(db, {
    userId: input.userId,
    hosted: input.hosted,
    baseRevisionId: input.baseRevisionId,
    idempotencyKey: input.idempotencyKey,
    mutation: webMcpMutation(input.tool, input.arguments),
  });
  return dashboardMutationResult(revision);
}

export class InvalidWebMcpToolError extends Error {
  constructor() {
    super("Unknown WebMCP tool");
    this.name = "InvalidWebMcpToolError";
  }
}

export class InvalidWebMcpMutationInputError extends Error {
  constructor() {
    super("Invalid WebMCP mutation arguments");
    this.name = "InvalidWebMcpMutationInputError";
  }
}
