import { expect, test } from "bun:test";
import { HostedEntitlementRequiredError } from "./billing";
import { executeWebMcpMutationTool, executeWebMcpReadOnlyTool } from "./webmcp";
import { handleWebMcpTool } from "./webmcp-http";

const launchEnd = Date.parse("2026-10-01T00:00:00.000Z");

async function afterLaunch<T>(run: () => Promise<T>) {
  const now = Date.now;
  Date.now = () => launchEnd;
  try {
    return await run();
  } finally {
    Date.now = now;
  }
}

function readOnlyDatabase() {
  let writes = 0;
  const db = {
    prepare(query: string) {
      return {
        bind(..._values: unknown[]) {
          return {
            async first<T>() {
              if (query.includes("FROM workspaces WHERE owner_user_id"))
                return {
                  id: "ws_1",
                  ownerUserId: "user_1",
                  name: "My workspace",
                } as T;
              if (
                query.includes("FROM workspaces WHERE id = ? AND owner_user_id")
              )
                return {
                  id: "ws_1",
                  ownerUserId: "user_1",
                  name: "My workspace",
                } as T;
              if (
                query.includes(
                  "FROM workspaces w\n       LEFT JOIN workspace_revisions",
                )
              )
                return {
                  sequence: 4,
                  id: "rev_4",
                  manifestJson: JSON.stringify({
                    version: 1,
                    skills: [
                      {
                        id: "sk_alpha",
                        source: "github.com/example/skills",
                        skill: "alpha",
                        ref: "main",
                        targets: "all",
                        resolutionStatus: "RESOLVED",
                      },
                    ],
                  }),
                  lockfileJson: JSON.stringify({
                    version: 1,
                    skills: [
                      {
                        id: "sk_alpha",
                        source: "github.com/example/skills",
                        skill: "alpha",
                        ref: "main",
                        repository: "github.com/example/skills",
                        revision: "abc",
                        path: "alpha",
                        contentHash: "sha256:abc",
                      },
                    ],
                  }),
                } as T;
              if (query.includes("FROM subscriptions")) return null;
              return null;
            },
            async all<T>() {
              if (query.includes("FROM devices d JOIN device_workspaces"))
                return {
                  results: [
                    {
                      id: "dev_1",
                      name: "Mac",
                      platform: "darwin",
                      architecture: "arm64",
                      cliVersion: "0.1.0",
                      appliedRevisionSequence: 4,
                      syncStatus: "SYNCED",
                      lastSyncAt: 1,
                      lastErrorCode: null,
                      lastErrorMessage: null,
                    },
                  ] as T[],
                };
              if (query.includes("FROM device_skill_targets"))
                return {
                  results: [
                    {
                      deviceId: "dev_1",
                      skillId: "sk_alpha",
                      agentId: "pi",
                      status: "SYNCED",
                      errorCode: null,
                      errorMessage: null,
                      contentHash: "sha256:abc",
                      updatedAt: 1,
                    },
                  ] as T[],
                };
              if (query.includes("FROM device_skill_updates"))
                return {
                  results: [
                    {
                      deviceId: "dev_1",
                      skillId: "sk_alpha",
                      status: "UPDATE_AVAILABLE",
                      checkedAt: 2,
                    },
                  ] as T[],
                };
              return { results: [] as T[] };
            },
            async run() {
              writes += 1;
            },
          };
        },
      };
    },
    writes: () => writes,
  };
  return db;
}

test("WebMCP read-only tools project authorized current workspace data without writes", async () => {
  const db = readOnlyDatabase();
  const input = {
    userId: "user_1",
    hosted: false,
    tool: "list_skills",
  } as const;
  const skills = await executeWebMcpReadOnlyTool(db as never, input);
  expect(skills).toMatchObject({
    revision: { id: "rev_4", sequence: 4 },
    skills: [{ id: "sk_alpha", locked: true }],
  });

  const devices = await executeWebMcpReadOnlyTool(db as never, {
    ...input,
    tool: "list_devices",
  });
  expect(devices).toMatchObject({
    devices: [{ id: "dev_1", syncStatus: "SYNCED" }],
  });

  const status = await executeWebMcpReadOnlyTool(db as never, {
    ...input,
    tool: "get_sync_status",
  });
  expect(status).toMatchObject({
    devices: [{ id: "dev_1", targets: [{ agentId: "pi", status: "SYNCED" }] }],
  });
  expect(db.writes()).toBe(0);
});

test("check_skill_updates returns reported status only and has no side effects", async () => {
  const db = readOnlyDatabase();
  const result = await executeWebMcpReadOnlyTool(db as never, {
    userId: "user_1",
    hosted: false,
    tool: "check_skill_updates",
  });
  expect(result).toMatchObject({
    skills: [
      {
        skillId: "sk_alpha",
        status: "UPDATE_AVAILABLE",
        reports: [{ deviceId: "dev_1", status: "UPDATE_AVAILABLE" }],
      },
    ],
  });
  expect(db.writes()).toBe(0);
});

function mutationDatabase() {
  let batches = 0;
  const db = {
    prepare(query: string) {
      return {
        bind(..._values: unknown[]) {
          return {
            async first<T>() {
              if (query.includes("FROM workspaces WHERE owner_user_id"))
                return {
                  id: "ws_1",
                  ownerUserId: "user_1",
                  name: "My workspace",
                } as T;
              if (query.includes("FROM idempotency_records")) return null;
              if (
                query.includes(
                  "FROM workspaces w\n       LEFT JOIN workspace_revisions",
                )
              )
                return {
                  sequence: 0,
                  id: null,
                  manifestJson: null,
                  lockfileJson: null,
                } as T;
              if (query.includes("SELECT current_revision_sequence"))
                return { currentRevisionSequence: 0 } as T;
              if (
                query.includes("FROM workspaces WHERE id = ? AND owner_user_id")
              )
                return {
                  id: "ws_1",
                  ownerUserId: "user_1",
                  name: "My workspace",
                } as T;
              return null;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(_statements: readonly unknown[]) {
      batches += 1;
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
    },
    batches: () => batches,
  };
  return db;
}

test("WebMCP mutations delegate to the dashboard service and report pending resolution", async () => {
  const db = mutationDatabase();
  const result = await executeWebMcpMutationTool(db as never, {
    userId: "user_1",
    hosted: false,
    tool: "add_skill",
    baseRevisionId: null,
    idempotencyKey: "webmcp-add-1",
    arguments: {
      source: "https://github.com/example/skills.git",
      skill: "review",
      ref: "main",
    },
  });
  expect(result.revisionSequence).toBe(1);
  expect(result.pendingResolution).toHaveLength(1);
  expect(db.batches()).toBe(1);

  await expect(
    executeWebMcpMutationTool(db as never, {
      userId: "user_1",
      hosted: false,
      tool: "add_skill",
      baseRevisionId: null,
      idempotencyKey: "",
      arguments: {
        source: "https://github.com/example/skills.git",
        skill: "review",
      },
    }),
  ).rejects.toThrow("idempotency key is required");
  expect(db.batches()).toBe(1);
});

test("WebMCP transport rejects missing authorization, base revision, and idempotency before a revision", async () => {
  const db = mutationDatabase();
  const unauthorized = await handleWebMcpTool(
    new Request("https://corotum.com/api/v1/webmcp", {
      method: "POST",
      body: JSON.stringify({
        tool: "add_skill",
        baseRevisionId: null,
        idempotencyKey: "key",
        arguments: {
          source: "https://example.com/skills.git",
          skill: "review",
        },
      }),
    }),
    db as never,
    null,
    false,
  );
  expect(unauthorized.status).toBe(401);
  expect(db.batches()).toBe(0);

  const missingConcurrency = await handleWebMcpTool(
    new Request("https://corotum.com/api/v1/webmcp", {
      method: "POST",
      body: JSON.stringify({
        tool: "add_skill",
        arguments: {
          source: "https://example.com/skills.git",
          skill: "review",
        },
      }),
    }),
    db as never,
    "user_1",
    false,
  );
  expect(missingConcurrency.status).toBe(400);
  expect(db.batches()).toBe(0);
});

test("WebMCP reads remain available while hosted writes require entitlement", async () => {
  const db = readOnlyDatabase();
  await expect(
    executeWebMcpReadOnlyTool(db as never, {
      userId: "user_1",
      hosted: false,
      tool: "sync_all_devices",
    }),
  ).rejects.toThrow("Unknown WebMCP");
  await expect(
    executeWebMcpReadOnlyTool(db as never, {
      userId: "user_1",
      hosted: true,
      tool: "list_skills",
    }),
  ).resolves.toBeDefined();
  await expect(
    afterLaunch(() =>
      executeWebMcpMutationTool(db as never, {
        userId: "user_1",
        hosted: true,
        tool: "add_skill",
        baseRevisionId: null,
        idempotencyKey: "hosted-denied",
        arguments: {
          source: "https://github.com/example/skills.git",
          skill: "review",
        },
      }),
    ),
  ).rejects.toBeInstanceOf(HostedEntitlementRequiredError);
});
