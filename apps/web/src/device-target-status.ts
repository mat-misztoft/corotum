import { DeviceNotFoundError, type TokenDatabase } from "./tokens";

export const DEVICE_TARGET_STATUSES = [
  "SYNCED",
  "DRIFTED",
  "AUTH_REQUIRED",
  "ERROR",
] as const;

export const DEVICE_TARGET_AGENT_IDS = [
  "codex",
  "claude-code",
  "pi",
  "gemini-cli",
  "opencode",
  "cursor",
  "windsurf",
  "cline",
  "roo-code",
  "github-copilot",
  "kiro-cli",
] as const;

export type DeviceTargetStatus = (typeof DEVICE_TARGET_STATUSES)[number];
export type DeviceTargetAgentId = (typeof DEVICE_TARGET_AGENT_IDS)[number];

export type DeviceTargetReportInput = Readonly<{
  skillId: string;
  agentId: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  contentHash: string | null;
}>;

export type DeviceSkillTargetRecord = Readonly<{
  deviceId: string;
  workspaceId: string;
  skillId: string;
  agentId: DeviceTargetAgentId;
  status: DeviceTargetStatus;
  errorCode: string | null;
  errorMessage: string | null;
  contentHash: string | null;
  updatedAt: number;
}>;

export type DeviceTargetStatusView = Readonly<{
  deviceId: string;
  workspaceId: string;
  appliedRevisionSequence: number;
  syncStatus: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastSyncAt: number | null;
  targets: readonly Omit<DeviceSkillTargetRecord, "deviceId" | "workspaceId">[];
}>;

export class InvalidDeviceTargetError extends Error {
  constructor(message = "A valid device skill target is required") {
    super(message);
    this.name = "InvalidDeviceTargetError";
  }
}

export function isDeviceTargetStatus(
  value: string,
): value is DeviceTargetStatus {
  return (DEVICE_TARGET_STATUSES as readonly string[]).includes(value);
}

export function isDeviceTargetAgentId(
  value: string,
): value is DeviceTargetAgentId {
  return (DEVICE_TARGET_AGENT_IDS as readonly string[]).includes(value);
}

function clipError(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/[/\\]/.test(trimmed) || /token|secret|password/i.test(trimmed)) {
    return "A local target failed.";
  }
  return trimmed.slice(0, 200);
}

/**
 * Homogeneous outcomes keep their device state. Mixed SYNCED / DRIFTED /
 * AUTH_REQUIRED / ERROR fixtures collapse to PARTIALLY_SYNCED. AUTH_REQUIRED
 * is target-level only; a device of only AUTH_REQUIRED/ERROR is ERROR.
 */
export function aggregateDeviceSyncStatus(
  targets: readonly { status: DeviceTargetStatus }[],
  revisions?: Readonly<{ applied: number; current: number }>,
): "SYNCED" | "PARTIALLY_SYNCED" | "DRIFTED" | "BEHIND" | "ERROR" {
  if (targets.length === 0) return "SYNCED";
  const unique = new Set(targets.map((target) => target.status));
  if (unique.size === 1) {
    const only = targets[0].status;
    if (only === "SYNCED") {
      if (revisions && revisions.applied < revisions.current) return "BEHIND";
      return "SYNCED";
    }
    if (only === "DRIFTED") return "DRIFTED";
    return "ERROR";
  }
  return "PARTIALLY_SYNCED";
}

export function normalizeDeviceTargets(
  targets: readonly DeviceTargetReportInput[],
  now: number,
): DeviceSkillTargetRecord[] {
  return targets.map((target) => {
    if (!/^sk_[A-Za-z0-9]+$/.test(target.skillId)) {
      throw new InvalidDeviceTargetError("A valid skill ID is required");
    }
    if (!isDeviceTargetAgentId(target.agentId)) {
      throw new InvalidDeviceTargetError("A valid agent ID is required");
    }
    if (!isDeviceTargetStatus(target.status)) {
      throw new InvalidDeviceTargetError("A valid target status is required");
    }
    if (target.contentHash && /[/\\]/.test(target.contentHash)) {
      throw new InvalidDeviceTargetError(
        "Target content hashes cannot be paths",
      );
    }
    const failed =
      target.status === "ERROR" || target.status === "AUTH_REQUIRED";
    return {
      deviceId: "",
      workspaceId: "",
      skillId: target.skillId,
      agentId: target.agentId,
      status: target.status,
      errorCode: failed
        ? (clipError(target.errorCode) ??
          (target.status === "AUTH_REQUIRED"
            ? "AUTH_REQUIRED"
            : "TARGET_ERROR"))
        : null,
      errorMessage: failed ? clipError(target.errorMessage) : null,
      contentHash: target.contentHash,
      updatedAt: now,
    };
  });
}

export function lastErrorFromTargets(
  targets: readonly Pick<
    DeviceSkillTargetRecord,
    "status" | "errorCode" | "errorMessage"
  >[],
): { lastErrorCode: string | null; lastErrorMessage: string | null } {
  const failed =
    targets.find((target) => target.status === "ERROR") ??
    targets.find((target) => target.status === "AUTH_REQUIRED");
  if (!failed) return { lastErrorCode: null, lastErrorMessage: null };
  return {
    lastErrorCode: failed.errorCode,
    lastErrorMessage: failed.errorMessage,
  };
}

/** Replaces the device’s current target rows. Omitted reports leave prior rows. */
export async function replaceDeviceSkillTargets(
  db: TokenDatabase,
  input: Readonly<{
    deviceId: string;
    workspaceId: string;
    targets: readonly DeviceSkillTargetRecord[];
  }>,
) {
  await db.batch([
    db
      .prepare(
        `DELETE FROM device_skill_targets
         WHERE device_id = ? AND workspace_id = ?`,
      )
      .bind(input.deviceId, input.workspaceId),
    ...input.targets.map((target) =>
      db
        .prepare(
          `INSERT INTO device_skill_targets (
             device_id, workspace_id, skill_id, agent_id, status,
             error_code, error_message, content_hash, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.deviceId,
          input.workspaceId,
          target.skillId,
          target.agentId,
          target.status,
          target.errorCode,
          target.errorMessage,
          target.contentHash,
          target.updatedAt,
        ),
    ),
  ]);
}

export async function listDeviceSkillTargets(
  db: TokenDatabase,
  deviceId: string,
  workspaceId: string,
): Promise<
  readonly Omit<DeviceSkillTargetRecord, "deviceId" | "workspaceId">[]
> {
  const rows = await db
    .prepare(
      `SELECT skill_id AS skillId,
              agent_id AS agentId,
              status,
              error_code AS errorCode,
              error_message AS errorMessage,
              content_hash AS contentHash,
              updated_at AS updatedAt
       FROM device_skill_targets
       WHERE device_id = ? AND workspace_id = ?
       ORDER BY skill_id, agent_id`,
    )
    .bind(deviceId, workspaceId)
    .all<Omit<DeviceSkillTargetRecord, "deviceId" | "workspaceId">>();
  return rows.results ?? [];
}

/** Dashboard/API projection from relational target rows, never devices JSON. */
export async function readDeviceTargetStatus(
  db: TokenDatabase,
  userId: string,
  deviceId: string,
): Promise<DeviceTargetStatusView> {
  const membership = await db
    .prepare(
      `SELECT devices.id AS deviceId,
              device_workspaces.workspace_id AS workspaceId,
              device_workspaces.applied_revision_sequence AS appliedRevisionSequence,
              device_workspaces.sync_status AS syncStatus,
              device_workspaces.last_error_code AS lastErrorCode,
              device_workspaces.last_error_message AS lastErrorMessage,
              device_workspaces.last_sync_at AS lastSyncAt
       FROM devices
       JOIN device_workspaces
         ON device_workspaces.device_id = devices.id
        AND device_workspaces.is_active = 1
       WHERE devices.id = ? AND devices.user_id = ?`,
    )
    .bind(deviceId, userId)
    .first<{
      deviceId: string;
      workspaceId: string;
      appliedRevisionSequence: number;
      syncStatus: string;
      lastErrorCode: string | null;
      lastErrorMessage: string | null;
      lastSyncAt: number | null;
    }>();
  if (!membership) throw new DeviceNotFoundError();

  return {
    ...membership,
    targets: await listDeviceSkillTargets(
      db,
      membership.deviceId,
      membership.workspaceId,
    ),
  };
}
