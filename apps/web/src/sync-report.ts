import {
  aggregateDeviceSyncStatus,
  type DeviceTargetReportInput,
  lastErrorFromTargets,
  normalizeDeviceTargets,
  replaceDeviceSkillTargets,
} from "./device-target-status";
import type { TokenDatabase } from "./tokens";
import { WorkspaceAccessError } from "./workspaces";

export const DEVICE_SYNC_STATUSES = [
  "SYNCED",
  "PARTIALLY_SYNCED",
  "DRIFTED",
  "BEHIND",
  "ERROR",
] as const;

export type DeviceSyncStatus = (typeof DEVICE_SYNC_STATUSES)[number];

export type DeviceSyncReportInput = Readonly<{
  deviceId: string;
  appliedRevisionId: string | null;
  syncStatus: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  targets?: readonly DeviceTargetReportInput[];
}>;

export type DeviceSyncReportRecord = Readonly<{
  deviceId: string;
  workspaceId: string;
  appliedRevisionId: string | null;
  appliedRevisionSequence: number;
  syncStatus: DeviceSyncStatus;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastSyncAt: number;
}>;

export type SyncReportDatabase = TokenDatabase;

export class InvalidSyncReportError extends Error {
  constructor(message = "A valid device sync report is required") {
    super(message);
    this.name = "InvalidSyncReportError";
  }
}

export class SyncReportRevisionError extends Error {
  constructor() {
    super("Applied revision was not found in this workspace");
    this.name = "SyncReportRevisionError";
  }
}

function isDeviceSyncStatus(value: string): value is DeviceSyncStatus {
  return (DEVICE_SYNC_STATUSES as readonly string[]).includes(value);
}

function clipError(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 200) : null;
}

/**
 * Stores the reporting device’s verified applied revision, optional target
 * rows, and the derived aggregate. It never writes another device or executes
 * remote sync.
 */
export async function acceptDeviceSyncReport(
  db: SyncReportDatabase,
  input: DeviceSyncReportInput,
  now = Date.now(),
): Promise<DeviceSyncReportRecord> {
  if (!isDeviceSyncStatus(input.syncStatus)) {
    throw new InvalidSyncReportError(
      "A valid device sync aggregate is required",
    );
  }
  if (input.syncStatus === "SYNCED" && !input.appliedRevisionId) {
    throw new InvalidSyncReportError(
      "A locally verified applied revision is required",
    );
  }

  const membership = await db
    .prepare(
      `SELECT device_workspaces.workspace_id AS workspaceId,
              device_workspaces.applied_revision_sequence AS appliedRevisionSequence,
              workspaces.current_revision_sequence AS currentRevisionSequence
       FROM device_workspaces
       JOIN workspaces ON workspaces.id = device_workspaces.workspace_id
       WHERE device_workspaces.device_id = ? AND device_workspaces.is_active = 1`,
    )
    .bind(input.deviceId)
    .first<{
      workspaceId: string;
      appliedRevisionSequence: number;
      currentRevisionSequence: number;
    }>();
  if (!membership) throw new WorkspaceAccessError();

  let appliedRevisionSequence = membership.appliedRevisionSequence;
  if (input.appliedRevisionId) {
    const revision = await db
      .prepare(
        `SELECT revision_sequence AS sequence
         FROM workspace_revisions
         WHERE id = ? AND workspace_id = ?`,
      )
      .bind(input.appliedRevisionId, membership.workspaceId)
      .first<{ sequence: number }>();
    if (!revision) throw new SyncReportRevisionError();
    appliedRevisionSequence = revision.sequence;
  }

  const targets = input.targets
    ? normalizeDeviceTargets(input.targets, now)
    : null;
  const syncStatus =
    targets && targets.length > 0
      ? aggregateDeviceSyncStatus(targets, {
          applied: appliedRevisionSequence,
          current: membership.currentRevisionSequence,
        })
      : input.syncStatus;
  const fromTargets =
    targets && targets.length > 0 ? lastErrorFromTargets(targets) : null;
  const lastErrorCode =
    syncStatus === "SYNCED" || syncStatus === "BEHIND"
      ? null
      : (fromTargets?.lastErrorCode ?? clipError(input.lastErrorCode));
  const lastErrorMessage =
    syncStatus === "SYNCED" || syncStatus === "BEHIND"
      ? null
      : (fromTargets?.lastErrorMessage ?? clipError(input.lastErrorMessage));

  const updated = await db
    .prepare(
      `UPDATE device_workspaces
       SET applied_revision_sequence = ?,
           sync_status = ?,
           last_sync_at = ?,
           last_error_code = ?,
           last_error_message = ?
       WHERE device_id = ? AND is_active = 1 AND workspace_id = ?`,
    )
    .bind(
      appliedRevisionSequence,
      syncStatus,
      now,
      lastErrorCode,
      lastErrorMessage,
      input.deviceId,
      membership.workspaceId,
    )
    .run();
  if ((updated as { meta?: { changes?: number } }).meta?.changes !== 1) {
    throw new WorkspaceAccessError();
  }
  if (targets) {
    await replaceDeviceSkillTargets(db, {
      deviceId: input.deviceId,
      workspaceId: membership.workspaceId,
      targets,
    });
  }

  return {
    deviceId: input.deviceId,
    workspaceId: membership.workspaceId,
    appliedRevisionId: input.appliedRevisionId,
    appliedRevisionSequence,
    syncStatus,
    lastErrorCode,
    lastErrorMessage,
    lastSyncAt: now,
  };
}
