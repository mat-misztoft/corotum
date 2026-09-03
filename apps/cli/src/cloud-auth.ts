import { hostname } from "node:os";

import {
  CLI_VERSION_HEADER,
  DEVICE_TOKEN_HEADER,
} from "../../../packages/saas-provider/src/index";
import type { CliOutcome } from "./cli-contracts";
import type { ConfigStore, CredentialsStore } from "./config";

export const DEFAULT_CLOUD_ORIGIN = "https://corotum.com";
export const DEVICE_CODE_HEADER = "x-toolmirror-device-code";
export const PAIRING_LIFETIME_MS = 10 * 60 * 1000;
export const PAIRING_POLL_INTERVAL_MS = 1_000;

export class CloudAuthError extends Error {
  constructor(
    message: string,
    readonly outcome: CliOutcome,
  ) {
    super(message);
    this.name = "CloudAuthError";
  }
}

export type CloudDevice = Readonly<{
  name: string;
  platform: string;
  architecture: string;
  cliVersion: string;
}>;

export type CloudLoginResult = Readonly<{
  deviceId: string;
  workspaceId: string | null;
}>;

export type CloudLogoutResult = Readonly<{
  revoked: boolean;
  deviceId: string | null;
}>;

export type CloudAuthLogger = Readonly<{
  write: (event: string, details?: Record<string, unknown>) => Promise<void>;
}>;

export type CloudAuthDependencies = Readonly<{
  origin: string;
  config: Pick<ConfigStore, "set">;
  credentials: Pick<CredentialsStore, "load" | "save">;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  openUrl?: (url: string) => Promise<void>;
  logger?: CloudAuthLogger;
  device?: CloudDevice;
  pollIntervalMs?: number;
  openBrowser?: boolean;
  onPairing?: (info: { userCode: string; verificationUrl: string }) => void;
}>;

type PairingCreated = Readonly<{
  id: string;
  deviceCode: string;
  userCode: string;
  expiresAt: number;
}>;

type IssuedToken = Readonly<{
  token: string;
  deviceId: string;
  workspaceId: string | null;
}>;

/** Resolves a Cloud origin without allowing embedded secrets. */
export function cloudOriginFrom(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudAuthError("Cloud origin is invalid.", "INVALID_CONFIG");
  }
  if (url.username || url.password) {
    throw new CloudAuthError(
      "Cloud origin must not include credentials.",
      "INVALID_CONFIG",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CloudAuthError("Cloud origin is invalid.", "INVALID_CONFIG");
  }
  return url.origin;
}

export function defaultCloudDevice(cliVersion: string): CloudDevice {
  const name = hostname().trim() || "corotum-device";
  return {
    name: name.slice(0, 128),
    platform: process.platform,
    architecture: process.arch,
    cliVersion,
  };
}

export function verificationUrlFor(origin: string, userCode: string): string {
  const url = new URL("/activate", `${origin}/`);
  url.searchParams.set("code", userCode);
  return url.toString();
}

/**
 * Browser pairing login and token logout. The plaintext device token is written
 * only to credentials storage and is never returned to command output.
 */
export class CloudAuthService {
  private readonly origin: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly openUrl: ((url: string) => Promise<void>) | undefined;
  private readonly logger: CloudAuthLogger | undefined;
  private readonly device: CloudDevice;
  private readonly pollIntervalMs: number;
  private readonly openBrowser: boolean;
  private readonly onPairing:
    | ((info: { userCode: string; verificationUrl: string }) => void)
    | undefined;

  constructor(private readonly deps: CloudAuthDependencies) {
    this.origin = cloudOriginFrom(deps.origin);
    this.fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.openUrl = deps.openUrl;
    this.logger = deps.logger;
    this.device = deps.device ?? defaultCloudDevice("0.3.0");
    this.pollIntervalMs = deps.pollIntervalMs ?? PAIRING_POLL_INTERVAL_MS;
    this.openBrowser = deps.openBrowser ?? true;
    this.onPairing = deps.onPairing;
  }

  async login(): Promise<CloudLoginResult> {
    if ((await this.deps.credentials.load()).cloudDeviceToken) {
      throw new CloudAuthError(
        "Already logged in. Run corotum logout first.",
        "GENERAL_ERROR",
      );
    }

    const pairing = await this.createPairing();
    const verificationUrl = verificationUrlFor(this.origin, pairing.userCode);
    await this.log("cloud.login.started", { pairingId: pairing.id });
    this.onPairing?.({ userCode: pairing.userCode, verificationUrl });
    if (this.openBrowser && this.openUrl) {
      try {
        await this.openUrl(verificationUrl);
      } catch {
        // The user can still open the printed verification URL.
      }
    }

    await this.waitForApproval(pairing);
    const issued = await this.issueToken(pairing);
    try {
      await this.persistLogin(issued);
    } catch (error) {
      await this.revokeToken(issued.token).catch(() => undefined);
      throw error;
    }
    await this.log("cloud.login.completed", {
      deviceId: issued.deviceId,
      workspaceId: issued.workspaceId,
    });
    return {
      deviceId: issued.deviceId,
      workspaceId: issued.workspaceId,
    };
  }

  async logout(): Promise<CloudLogoutResult> {
    const token = (await this.deps.credentials.load()).cloudDeviceToken;
    if (!token) return { revoked: false, deviceId: null };

    let deviceId: string | null = null;
    let revokeError: unknown;
    try {
      deviceId = (await this.revokeToken(token)).deviceId;
    } catch (error) {
      if (
        !(error instanceof CloudAuthError) ||
        error.outcome !== "AUTH_REQUIRED"
      ) {
        revokeError = error;
      }
    }
    await this.clearLocalCredentials();
    await this.log("cloud.logout.completed", { deviceId });
    if (revokeError) throw revokeError;
    return { revoked: true, deviceId };
  }

  private async persistLogin(issued: IssuedToken): Promise<void> {
    await this.deps.credentials.save({
      schemaVersion: 1,
      cloudDeviceToken: issued.token,
    });
    await this.deps.config.set("deviceId", issued.deviceId);
    await this.deps.config.set("workspaceId", issued.workspaceId);
  }

  private async clearLocalCredentials(): Promise<void> {
    await this.deps.credentials.save({ schemaVersion: 1 });
    await this.deps.config.set("deviceId", null);
    await this.deps.config.set("workspaceId", null);
  }

  private async createPairing(): Promise<PairingCreated> {
    const response = await this.request("/api/v1/cli/pairings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.device),
    });
    if (response.status !== 201) {
      throw await this.failure(response, "Unable to start Cloud pairing.");
    }
    const payload = (await response.json()) as Partial<PairingCreated>;
    if (
      typeof payload.id !== "string" ||
      typeof payload.deviceCode !== "string" ||
      typeof payload.userCode !== "string"
    ) {
      throw new CloudAuthError(
        "Cloud returned an invalid pairing.",
        "NETWORK_ERROR",
      );
    }
    return {
      id: payload.id,
      deviceCode: payload.deviceCode,
      userCode: payload.userCode,
      expiresAt:
        typeof payload.expiresAt === "number"
          ? payload.expiresAt
          : this.now() + PAIRING_LIFETIME_MS,
    };
  }

  private async waitForApproval(pairing: PairingCreated): Promise<void> {
    while (this.now() < pairing.expiresAt) {
      const status = await this.pairingStatus(pairing);
      if (status === "APPROVED") return;
      if (status === "EXPIRED" || status === "CONSUMED") {
        throw new CloudAuthError(
          "Cloud pairing expired. Run corotum login again.",
          "GENERAL_ERROR",
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw new CloudAuthError(
      "Cloud pairing expired. Run corotum login again.",
      "GENERAL_ERROR",
    );
  }

  private async pairingStatus(
    pairing: PairingCreated,
  ): Promise<"PENDING" | "APPROVED" | "EXPIRED" | "CONSUMED"> {
    const response = await this.request(
      `/api/v1/cli/pairings/${encodeURIComponent(pairing.id)}`,
      {
        method: "GET",
        headers: { [DEVICE_CODE_HEADER]: pairing.deviceCode },
      },
    );
    if (!response.ok) {
      throw await this.failure(response, "Unable to check Cloud pairing.");
    }
    const payload = (await response.json()) as { status?: unknown };
    if (
      payload.status === "PENDING" ||
      payload.status === "APPROVED" ||
      payload.status === "EXPIRED" ||
      payload.status === "CONSUMED"
    ) {
      return payload.status;
    }
    throw new CloudAuthError(
      "Cloud returned an invalid pairing.",
      "NETWORK_ERROR",
    );
  }

  private async issueToken(pairing: PairingCreated): Promise<IssuedToken> {
    const response = await this.request(
      `/api/v1/cli/pairings/${encodeURIComponent(pairing.id)}/token`,
      {
        method: "POST",
        headers: { [DEVICE_CODE_HEADER]: pairing.deviceCode },
      },
    );
    if (response.status !== 201) {
      throw await this.failure(response, "Unable to complete Cloud login.");
    }
    const payload = (await response.json()) as Partial<IssuedToken>;
    if (
      typeof payload.token !== "string" ||
      typeof payload.deviceId !== "string"
    ) {
      throw new CloudAuthError(
        "Cloud returned an invalid device token.",
        "NETWORK_ERROR",
      );
    }
    return {
      token: payload.token,
      deviceId: payload.deviceId,
      workspaceId:
        typeof payload.workspaceId === "string" ? payload.workspaceId : null,
    };
  }

  private async revokeToken(
    token: string,
  ): Promise<{ deviceId: string | null }> {
    const response = await this.request("/api/v1/cli/logout", {
      method: "POST",
      headers: { [DEVICE_TOKEN_HEADER]: token },
    });
    if (response.status === 401) {
      throw new CloudAuthError(
        "Cloud device authentication failed.",
        "AUTH_REQUIRED",
      );
    }
    if (!response.ok) {
      throw await this.failure(response, "Unable to log out of Cloud.");
    }
    const payload = (await response.json()) as { deviceId?: unknown };
    return {
      deviceId: typeof payload.deviceId === "string" ? payload.deviceId : null,
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set(CLI_VERSION_HEADER, this.device.cliVersion);
    try {
      return await this.fetch(`${this.origin}${path}`, { ...init, headers });
    } catch (error) {
      throw new CloudAuthError(
        error instanceof Error ? error.message : "Cloud request failed.",
        "NETWORK_ERROR",
      );
    }
  }

  private async failure(
    response: Response,
    fallback: string,
  ): Promise<CloudAuthError> {
    if (response.status === 426) {
      return new CloudAuthError(
        "This Cloud origin requires a newer CLI.",
        "GENERAL_ERROR",
      );
    }
    if (response.status === 401) {
      return new CloudAuthError(
        "Cloud device authentication failed.",
        "AUTH_REQUIRED",
      );
    }
    let message = fallback;
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload.error === "string" && payload.error.trim()) {
        message = payload.error;
      }
    } catch {
      // Keep the fallback when the body is not JSON.
    }
    return new CloudAuthError(
      message,
      response.status >= 500 ? "NETWORK_ERROR" : "GENERAL_ERROR",
    );
  }

  private async log(
    event: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.logger?.write(event, details);
    } catch {
      // Local logs must never change login or logout results.
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
