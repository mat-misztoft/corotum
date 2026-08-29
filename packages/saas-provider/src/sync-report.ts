import type { Result } from "../../core/src/index";
import { CLI_VERSION_HEADER, DEVICE_TOKEN_HEADER } from "./headers";

export const DEVICE_SYNC_STATUSES = [
  "SYNCED",
  "PARTIALLY_SYNCED",
  "DRIFTED",
  "BEHIND",
  "ERROR",
] as const;

export type DeviceSyncStatus = (typeof DEVICE_SYNC_STATUSES)[number];

export type DeviceSyncReportPayload = Readonly<{
  appliedRevisionId: string | null;
  syncStatus: DeviceSyncStatus;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
}>;

export type DeviceSyncReportReceipt = Readonly<{
  deviceId: string;
  workspaceId: string;
  appliedRevisionId: string | null;
  appliedRevisionSequence: number;
  syncStatus: DeviceSyncStatus;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastSyncAt: number;
}>;

export type PostDeviceSyncReportOptions = Readonly<{
  origin: string;
  deviceId: string;
  deviceToken: string;
  cliVersion?: string;
  fetch?: typeof fetch;
  report: DeviceSyncReportPayload;
}>;

/** Posts one device’s locally verified aggregate. It never targets another device. */
export async function postDeviceSyncReport(
  options: PostDeviceSyncReportOptions,
): Promise<Result<DeviceSyncReportReceipt>> {
  const origin = new URL(options.origin);
  if (origin.username || origin.password) {
    return {
      kind: "failure",
      error: {
        code: "VALIDATION_ERROR",
        message: "Cloud origin must not include credentials.",
      },
    };
  }
  if (!DEVICE_SYNC_STATUSES.includes(options.report.syncStatus)) {
    return {
      kind: "failure",
      error: {
        code: "VALIDATION_ERROR",
        message: "A valid device sync aggregate is required.",
      },
    };
  }

  try {
    const response = await (options.fetch ?? globalThis.fetch.bind(globalThis))(
      `${origin.origin}/api/v1/devices/${encodeURIComponent(options.deviceId)}/sync-report`,
      {
        method: "POST",
        headers: {
          [DEVICE_TOKEN_HEADER]: options.deviceToken,
          [CLI_VERSION_HEADER]: options.cliVersion ?? "0.1.0",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          appliedRevisionId: options.report.appliedRevisionId,
          syncStatus: options.report.syncStatus,
          lastErrorCode: options.report.lastErrorCode ?? null,
          lastErrorMessage: options.report.lastErrorMessage ?? null,
        }),
      },
    );
    return await readReceipt(response);
  } catch (error) {
    return {
      kind: "failure",
      error: {
        code: "NETWORK_ERROR",
        message:
          error instanceof Error ? error.message : "Cloud request failed.",
      },
    };
  }
}

async function readReceipt(
  response: Response,
): Promise<Result<DeviceSyncReportReceipt>> {
  if (response.status === 401) {
    return {
      kind: "failure",
      error: {
        code: "AUTH_REQUIRED",
        message: "Cloud device authentication failed.",
      },
    };
  }
  if (response.status === 402) {
    return {
      kind: "failure",
      error: {
        code: "AUTH_REQUIRED",
        message: "Hosted Cloud subscription required",
      },
    };
  }
  if (response.status === 426) {
    return {
      kind: "failure",
      error: { code: "DEVICE_ERROR", message: "CLI upgrade required." },
    };
  }
  if (!response.ok) {
    return {
      kind: "failure",
      error: {
        code: response.status === 400 ? "VALIDATION_ERROR" : "NETWORK_ERROR",
        message: await responseMessage(response),
      },
    };
  }

  const payload = (await response.json()) as Partial<DeviceSyncReportReceipt>;
  if (!isReceipt(payload)) {
    return {
      kind: "failure",
      error: {
        code: "VALIDATION_ERROR",
        message: "Cloud returned an invalid sync report.",
      },
    };
  }
  return { kind: "success", value: payload };
}

function isReceipt(
  payload: Partial<DeviceSyncReportReceipt>,
): payload is DeviceSyncReportReceipt {
  return (
    typeof payload.deviceId === "string" &&
    typeof payload.workspaceId === "string" &&
    (payload.appliedRevisionId === null ||
      typeof payload.appliedRevisionId === "string") &&
    typeof payload.appliedRevisionSequence === "number" &&
    typeof payload.syncStatus === "string" &&
    DEVICE_SYNC_STATUSES.includes(payload.syncStatus) &&
    (payload.lastErrorCode === null ||
      typeof payload.lastErrorCode === "string") &&
    (payload.lastErrorMessage === null ||
      typeof payload.lastErrorMessage === "string") &&
    typeof payload.lastSyncAt === "number"
  );
}

async function responseMessage(response: Response) {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim())
      return payload.error;
  } catch {
    // Fall through to the status text when the body is not JSON.
  }
  return response.statusText || "Cloud request failed.";
}
