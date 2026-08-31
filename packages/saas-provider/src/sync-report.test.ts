import { expect, test } from "bun:test";
import { CLI_VERSION_HEADER, DEVICE_TOKEN_HEADER, SaaSProvider } from "./index";
import { postDeviceSyncReport } from "./sync-report";

test("SaaSProvider still does not expose reporting on the state boundary", () => {
  const saas: SaaSProvider = new SaaSProvider({
    origin: "https://corotum.com",
    workspaceId: "ws_1",
    deviceToken: "token",
    fetch: async () => new Response("{}"),
  });
  expect("report" in saas).toBe(false);
  expect("syncReport" in saas).toBe(false);
});

test("postDeviceSyncReport sends only this device id and aggregate", async () => {
  const requests: Request[] = [];
  const result = await postDeviceSyncReport({
    origin: "https://corotum.com",
    deviceId: "dev_1",
    deviceToken: "device-token-secret",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        deviceId: "dev_1",
        workspaceId: "ws_1",
        appliedRevisionId: "rev_1",
        appliedRevisionSequence: 1,
        syncStatus: "PARTIALLY_SYNCED",
        lastErrorCode: "TARGET_ERROR",
        lastErrorMessage: "One agent target failed.",
        lastSyncAt: 4_000,
      });
    },
    report: {
      appliedRevisionId: "rev_1",
      syncStatus: "PARTIALLY_SYNCED",
      lastErrorCode: "TARGET_ERROR",
      lastErrorMessage: "One agent target failed.",
    },
  });

  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe("POST");
  expect(requests[0].url).toBe(
    "https://corotum.com/api/v1/devices/dev_1/sync-report",
  );
  expect(requests[0].url).not.toContain("dev_2");
  expect(requests[0].headers.get(DEVICE_TOKEN_HEADER)).toBe(
    "device-token-secret",
  );
  expect(requests[0].headers.get(CLI_VERSION_HEADER)).toBe("0.1.0");
  expect(await requests[0].json()).toEqual({
    appliedRevisionId: "rev_1",
    syncStatus: "PARTIALLY_SYNCED",
    lastErrorCode: "TARGET_ERROR",
    lastErrorMessage: "One agent target failed.",
  });
  expect(result).toMatchObject({
    kind: "success",
    value: { deviceId: "dev_1", syncStatus: "PARTIALLY_SYNCED" },
  });
});

test("postDeviceSyncReport includes device-performed update checks", async () => {
  const requests: Request[] = [];
  await postDeviceSyncReport({
    origin: "https://corotum.com",
    deviceId: "dev_1",
    deviceToken: "device-token-secret",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        deviceId: "dev_1",
        workspaceId: "ws_1",
        appliedRevisionId: null,
        appliedRevisionSequence: 0,
        syncStatus: "ERROR",
        lastErrorCode: null,
        lastErrorMessage: null,
        lastSyncAt: 4_000,
      });
    },
    report: {
      appliedRevisionId: null,
      syncStatus: "ERROR",
      updates: [{ skillId: "sk_01Jreview", status: "AUTH_REQUIRED" }],
    },
  });
  expect(await requests[0].json()).toMatchObject({
    updates: [{ skillId: "sk_01Jreview", status: "AUTH_REQUIRED" }],
  });
});

test("Cloud origin must not include embedded credentials", async () => {
  expect(
    await postDeviceSyncReport({
      origin: "https://user:secret@corotum.com",
      deviceId: "dev_1",
      deviceToken: "token",
      report: { appliedRevisionId: "rev_1", syncStatus: "SYNCED" },
    }),
  ).toMatchObject({
    kind: "failure",
    error: { code: "VALIDATION_ERROR" },
  });
});

test("postDeviceSyncReport includes per-agent target outcomes when provided", async () => {
  const requests: Request[] = [];
  await postDeviceSyncReport({
    origin: "https://corotum.com",
    deviceId: "dev_1",
    deviceToken: "device-token-secret",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        deviceId: "dev_1",
        workspaceId: "ws_1",
        appliedRevisionId: "rev_1",
        appliedRevisionSequence: 1,
        syncStatus: "PARTIALLY_SYNCED",
        lastErrorCode: "TARGET_ERROR",
        lastErrorMessage: "One agent target failed.",
        lastSyncAt: 4_000,
      });
    },
    report: {
      appliedRevisionId: "rev_1",
      syncStatus: "PARTIALLY_SYNCED",
      targets: [
        {
          skillId: "sk_01Jreview",
          agentId: "codex",
          status: "ERROR",
          errorCode: "TARGET_ERROR",
          errorMessage: "One agent target failed.",
          contentHash: null,
        },
      ],
    },
  });
  expect(await requests[0].json()).toEqual({
    appliedRevisionId: "rev_1",
    syncStatus: "PARTIALLY_SYNCED",
    lastErrorCode: null,
    lastErrorMessage: null,
    targets: [
      {
        skillId: "sk_01Jreview",
        agentId: "codex",
        status: "ERROR",
        errorCode: "TARGET_ERROR",
        errorMessage: "One agent target failed.",
        contentHash: null,
      },
    ],
  });
});
