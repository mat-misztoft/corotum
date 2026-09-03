import { expect, test } from "bun:test";
import {
  CloudSyncReportError,
  CloudSyncReportService,
  deviceSyncAggregateFrom,
  deviceTargetReportsFrom,
  sanitizeSyncErrorMessage,
} from "./cloud-sync-report";

test("sync reports must use this device’s locally verified applied revision", async () => {
  const requests: Request[] = [];
  const service = new CloudSyncReportService({
    origin: "https://corotum.com",
    deviceId: "dev_1",
    credentials: {
      load: async () => ({
        schemaVersion: 1 as const,
        cloudDeviceToken: "device-token-secret",
      }),
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        deviceId: "dev_1",
        workspaceId: "ws_1",
        appliedRevisionId: "rev_local",
        appliedRevisionSequence: 1,
        syncStatus: "SYNCED",
        lastErrorCode: null,
        lastErrorMessage: null,
        lastSyncAt: 4_000,
      });
    },
  });

  await expect(
    service.report({
      lastAppliedRevision: "rev_local",
      appliedRevisionId: "rev_other",
      aggregate: { status: "SYNCED" },
    }),
  ).rejects.toThrow(CloudSyncReportError);

  await expect(
    service.report({
      lastAppliedRevision: null,
      appliedRevisionId: null,
      aggregate: { status: "SYNCED" },
    }),
  ).rejects.toThrow("locally verified applied revision");

  const receipt = await service.report({
    lastAppliedRevision: "rev_local",
    appliedRevisionId: "rev_local",
    aggregate: { status: "SYNCED" },
  });
  expect(receipt.deviceId).toBe("dev_1");
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe(
    "https://corotum.com/api/v1/devices/dev_1/sync-report",
  );
  expect(requests[0].url).not.toContain("dev_2");
  expect(await requests[0].json()).toEqual({
    appliedRevisionId: "rev_local",
    syncStatus: "SYNCED",
    lastErrorCode: null,
    lastErrorMessage: null,
  });
});

test("partial target outcomes stay visible in the reported aggregate", () => {
  expect(
    deviceSyncAggregateFrom({
      kind: "partial",
      execution: {
        operations: [
          { status: "SUCCESS" },
          {
            status: "ERROR",
            error: "Failed to write /Users/ada/.agents/skill",
          },
        ],
      },
      snapshot: { plan: { classifications: [] } },
    }),
  ).toEqual({
    status: "PARTIALLY_SYNCED",
    lastErrorCode: "TARGET_ERROR",
    lastErrorMessage: "A local target failed.",
  });
  expect(sanitizeSyncErrorMessage("device-token-secret leaked")).toBe(
    "A local target failed.",
  );
});

test("failed skill operations become per-agent target reports", () => {
  expect(
    deviceTargetReportsFrom({
      operations: [
        { skillId: "sk_ok", status: "SUCCESS" },
        {
          skillId: "sk_fail",
          status: "ERROR",
          error: "Failed to write /Users/ada/.agents/skill",
        },
      ],
      actual: {
        skills: {
          sk_fail: { targets: [{ agentId: "pi" }, { agentId: "codex" }] },
        },
      },
    }),
  ).toEqual([
    {
      skillId: "sk_fail",
      agentId: "pi",
      status: "ERROR",
      errorCode: "TARGET_ERROR",
      errorMessage: "A local target failed.",
    },
    {
      skillId: "sk_fail",
      agentId: "codex",
      status: "ERROR",
      errorCode: "TARGET_ERROR",
      errorMessage: "A local target failed.",
    },
  ]);
});

test("sync reports send sanitized per-agent target outcomes", async () => {
  const requests: Request[] = [];
  const service = new CloudSyncReportService({
    origin: "https://corotum.com",
    deviceId: "dev_1",
    credentials: {
      load: async () => ({
        schemaVersion: 1 as const,
        cloudDeviceToken: "device-token-secret",
      }),
    },
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        deviceId: "dev_1",
        workspaceId: "ws_1",
        appliedRevisionId: "rev_local",
        appliedRevisionSequence: 1,
        syncStatus: "PARTIALLY_SYNCED",
        lastErrorCode: "TARGET_ERROR",
        lastErrorMessage: "A local target failed.",
        lastSyncAt: 4_000,
      });
    },
  });

  await service.report({
    lastAppliedRevision: "rev_local",
    appliedRevisionId: "rev_local",
    aggregate: { status: "PARTIALLY_SYNCED" },
    targets: [
      {
        skillId: "sk_01Jreview",
        agentId: "codex",
        status: "ERROR",
        errorMessage: "Failed to write /Users/ada/.agents/skill",
      },
    ],
  });
  expect(await requests[0].json()).toMatchObject({
    targets: [
      {
        skillId: "sk_01Jreview",
        agentId: "codex",
        status: "ERROR",
        errorMessage: "A local target failed.",
        contentHash: null,
      },
    ],
  });
});
