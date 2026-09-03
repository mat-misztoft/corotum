import { describe, expect, test } from "bun:test";
import type { V2DesiredState } from "../../../packages/core/src/index";
import {
  V2CloudProviderError,
  type V2SaaSProvider,
} from "../../../packages/saas-provider/src/index";
import { CloudInitService } from "./init-cloud";

const empty: V2DesiredState = {
  manifest: { version: 2, skills: [] },
  lockfile: { version: 2, skills: [] },
};

function fixture(options?: {
  token?: string;
  workspace?: string;
  pullError?: string;
}) {
  let config = {
    schemaVersion: 1 as const,
    mode: null,
    workspaceId: options?.workspace ?? null,
    deviceId: options?.workspace ? "dev_existing" : null,
    skillsStoragePath: null,
    gitStoragePath: null,
    gitRepository: null,
    telemetry: null,
    installationId: null,
    agents: {},
  };
  let token = options?.token;
  let logins = 0;
  let pulls = 0;
  const service = new CloudInitService({
    config: { load: async () => config },
    credentials: {
      load: async () => ({
        schemaVersion: 1 as const,
        ...(token ? { cloudDeviceToken: token } : {}),
      }),
    },
    auth: {
      login: async () => {
        logins++;
        token = "device-token";
        config = {
          ...config,
          workspaceId: "ws_paired",
          deviceId: "dev_paired",
        };
        return { workspaceId: "ws_paired", deviceId: "dev_paired" };
      },
    },
    provider: ({ deviceToken, workspaceId }) => {
      expect(deviceToken).toBeTruthy();
      expect(workspaceId).toBeTruthy();
      return {
        pull: async () => {
          pulls++;
          if (options?.pullError) {
            throw new V2CloudProviderError("NETWORK_ERROR", options.pullError);
          }
          return {
            revisionId: "base",
            revisionSequence: 0,
            state: empty,
            ledger: { version: 2 as const, activeDispositions: {} },
          };
        },
      } as V2SaaSProvider;
    },
  });
  return { service, calls: () => ({ logins, pulls }) };
}

describe("Cloud init", () => {
  test("pairs when required before any desired-state mutation", async () => {
    const subject = fixture();
    await expect(subject.service.connect()).resolves.toMatchObject({
      workspaceId: "ws_paired",
    });
    expect(subject.calls()).toEqual({ logins: 1, pulls: 1 });
  });

  test("reuses an authenticated device without pairing", async () => {
    const subject = fixture({
      token: "existing-token",
      workspace: "ws_existing",
    });
    await expect(subject.service.connect()).resolves.toMatchObject({
      workspaceId: "ws_existing",
    });
    expect(subject.calls()).toEqual({ logins: 0, pulls: 1 });
  });

  test("does not initialize without hosted entitlement", async () => {
    const subject = fixture({
      token: "existing-token",
      workspace: "ws_existing",
      pullError: "Hosted Cloud subscription required",
    });
    await expect(subject.service.connect()).rejects.toEqual(
      expect.objectContaining({
        name: "CloudInitError",
        message: expect.stringContaining("subscription required"),
      }),
    );
    expect(subject.calls()).toEqual({ logins: 0, pulls: 1 });
  });
});
