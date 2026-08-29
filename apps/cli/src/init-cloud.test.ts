import { describe, expect, test } from "bun:test";
import {
  type DesiredState,
  revisionId,
} from "../../../packages/core/src/index";
import type { InitStateProvider } from "./init";
import { CloudInitService } from "./init-cloud";

const candidate = {
  agentId: "codex" as const,
  name: "review",
  path: "/home/a/.codex/skills/review",
  source: "owner/skills",
  contentHash: "sha256:exact",
};
const empty: DesiredState = {
  manifest: { version: 1, skills: [] },
  lockfile: { version: 1, skills: [] },
};

function fixture(options?: {
  token?: string;
  workspace?: string;
  pullError?: string;
  existing?: boolean;
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
  let pushes = 0;
  let executions = 0;
  const provider: InitStateProvider = {
    pull: async () =>
      options?.pullError
        ? {
            kind: "failure" as const,
            error: {
              code: "NETWORK_ERROR" as const,
              message: options.pullError,
            },
          }
        : {
            kind: "success" as const,
            value: {
              revisionId: revisionId("base"),
              state: options?.existing
                ? {
                    ...empty,
                    manifest: {
                      version: 1,
                      skills: [
                        {
                          id: "sk_existing" as never,
                          source: "owner/skills",
                          skill: "existing",
                          ref: "main",
                          targets: ["codex"],
                          resolutionStatus: "RESOLVED",
                        },
                      ],
                    },
                  }
                : empty,
            },
          },
    push: async (input) => {
      pushes++;
      return {
        kind: "success" as const,
        value: { revisionId: revisionId("next"), state: input.state },
      };
    },
  };
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
      return provider;
    },
    resolver: {
      resolve: async () => ({
        repository: "https://github.com/owner/skills.git",
        revision: "abc",
        path: "review",
        contentHash: "sha256:exact",
      }),
    },
    executor: {
      execute: async (input) => {
        executions++;
        return { state: input.state, operations: [] };
      },
    },
  });
  return { service, calls: () => ({ logins, pushes, executions }) };
}

const input = {
  candidates: [candidate],
  selected: [
    {
      source: "owner/skills",
      name: "review",
      contentHash: "sha256:exact",
      targets: ["codex" as const],
    },
  ],
  nonInteractive: false,
  execution: {
    enabledAgentIds: ["codex" as const],
    homeDir: "/home/a",
    state: { schemaVersion: 1 as const, lastAppliedRevision: null, skills: {} },
  },
};

describe("Cloud init", () => {
  test("pairs when required, initializes an empty workspace, and adopts selected skills", async () => {
    const subject = fixture();
    await expect(subject.service.initialize(input)).resolves.toMatchObject({
      kind: "initialized",
      revision: "next",
    });
    expect(subject.calls()).toEqual({ logins: 1, pushes: 1, executions: 1 });
  });

  test("reuses an authenticated device without pairing and refuses an existing workspace before local adoption", async () => {
    const subject = fixture({
      token: "existing-token",
      workspace: "ws_existing",
      existing: true,
    });
    await expect(subject.service.initialize(input)).resolves.toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("already initialized"),
    });
    expect(subject.calls()).toEqual({ logins: 0, pushes: 0, executions: 0 });
  });

  test("does not mutate desired state or local ownership without hosted entitlement", async () => {
    const subject = fixture({
      token: "existing-token",
      workspace: "ws_existing",
      pullError: "Hosted Cloud subscription required",
    });
    await expect(subject.service.initialize(input)).rejects.toEqual(
      expect.objectContaining({
        name: "CloudInitError",
        message: expect.stringContaining("subscription required"),
      }),
    );
    expect(subject.calls()).toEqual({ logins: 0, pushes: 0, executions: 0 });
  });
});
