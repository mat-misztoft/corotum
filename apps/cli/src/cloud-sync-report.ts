import {
  type DeviceSyncReportReceipt,
  type DeviceSyncStatus,
  type DeviceTargetReport,
  postDeviceSyncReport,
} from "../../../packages/saas-provider/src/index";
import { cloudOriginFrom } from "./cloud-auth";
import type { CredentialsStore } from "./config";

export type DeviceSyncAggregate = Readonly<{
  status: DeviceSyncStatus;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
}>;

export type { DeviceTargetReport };

export type CloudSyncReportDependencies = Readonly<{
  origin: string;
  deviceId: string;
  credentials: Pick<CredentialsStore, "load">;
  fetch?: typeof fetch;
  cliVersion?: string;
}>;

export class CloudSyncReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudSyncReportError";
  }
}

/** Drops local paths and secrets so Cloud only stores a short aggregate error. */
export function sanitizeSyncErrorMessage(
  message: string | null | undefined,
): string | null {
  if (!message) return null;
  const trimmed = message.trim();
  if (!trimmed) return null;
  if (/[/\\]/.test(trimmed) || /token|secret|password/i.test(trimmed)) {
    return "A local target failed.";
  }
  return trimmed.slice(0, 200);
}

export function deviceSyncAggregateFrom(result: {
  kind: "synced" | "partial";
  execution: {
    operations: readonly Readonly<{ status: string; error?: string }>[];
  };
  snapshot: {
    plan: {
      classifications: readonly Readonly<{ classification: string }>[];
    };
  };
}): DeviceSyncAggregate {
  if (result.kind === "synced") return { status: "SYNCED" };
  const failed = result.execution.operations.find(
    (operation) => operation.status === "ERROR",
  );
  if (failed) {
    return {
      status: "PARTIALLY_SYNCED",
      lastErrorCode: "TARGET_ERROR",
      lastErrorMessage: sanitizeSyncErrorMessage(
        failed.error ?? "A local target failed.",
      ),
    };
  }
  if (
    result.snapshot.plan.classifications.some(
      (item) => item.classification === "DRIFTED",
    )
  ) {
    return { status: "DRIFTED" };
  }
  return { status: "PARTIALLY_SYNCED" };
}

/**
 * Sends this device’s locally verified applied revision. The URL device id is
 * the configured local device; another device is never claimed.
 */
export class CloudSyncReportService {
  constructor(private readonly deps: CloudSyncReportDependencies) {}

  async report(input: {
    lastAppliedRevision: string | null;
    appliedRevisionId: string | null;
    aggregate: DeviceSyncAggregate;
    targets?: readonly DeviceTargetReport[];
  }): Promise<DeviceSyncReportReceipt> {
    if (input.appliedRevisionId !== input.lastAppliedRevision) {
      throw new CloudSyncReportError(
        "Sync report must use the locally verified applied revision.",
      );
    }
    if (input.aggregate.status === "SYNCED" && !input.appliedRevisionId) {
      throw new CloudSyncReportError(
        "A locally verified applied revision is required.",
      );
    }

    const token = (await this.deps.credentials.load()).cloudDeviceToken;
    if (!token) {
      throw new CloudSyncReportError("Cloud device authentication failed.");
    }

    const result = await postDeviceSyncReport({
      origin: cloudOriginFrom(this.deps.origin),
      deviceId: this.deps.deviceId,
      deviceToken: token,
      cliVersion: this.deps.cliVersion,
      fetch: this.deps.fetch,
      report: {
        appliedRevisionId: input.appliedRevisionId,
        syncStatus: input.aggregate.status,
        lastErrorCode: input.aggregate.lastErrorCode ?? null,
        lastErrorMessage: sanitizeSyncErrorMessage(
          input.aggregate.lastErrorMessage,
        ),
        targets: input.targets?.map((target) => ({
          skillId: target.skillId,
          agentId: target.agentId,
          status: target.status,
          errorCode: target.errorCode ?? null,
          errorMessage: sanitizeSyncErrorMessage(target.errorMessage),
          contentHash: target.contentHash ?? null,
        })),
      },
    });
    if (result.kind === "success") return result.value;
    throw new CloudSyncReportError(
      result.kind === "failure"
        ? result.error.message
        : (result.errors[0]?.message ?? "Cloud sync report failed."),
    );
  }
}
