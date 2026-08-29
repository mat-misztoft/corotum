import { expect, test } from "bun:test";
import {
  aggregateDeviceSyncStatus,
  lastErrorFromTargets,
  normalizeDeviceTargets,
} from "./device-target-status";

test("device aggregates derive from mixed SYNCED, DRIFTED, AUTH_REQUIRED, and ERROR fixtures", () => {
  expect(aggregateDeviceSyncStatus([{ status: "SYNCED" }])).toBe("SYNCED");
  expect(aggregateDeviceSyncStatus([{ status: "DRIFTED" }])).toBe("DRIFTED");
  expect(aggregateDeviceSyncStatus([{ status: "ERROR" }])).toBe("ERROR");
  expect(aggregateDeviceSyncStatus([{ status: "AUTH_REQUIRED" }])).toBe(
    "ERROR",
  );
  expect(
    aggregateDeviceSyncStatus([{ status: "SYNCED" }, { status: "SYNCED" }], {
      applied: 1,
      current: 2,
    }),
  ).toBe("BEHIND");
  expect(
    aggregateDeviceSyncStatus([
      { status: "SYNCED" },
      { status: "DRIFTED" },
      { status: "AUTH_REQUIRED" },
      { status: "ERROR" },
    ]),
  ).toBe("PARTIALLY_SYNCED");
});

test("failed target errors stay on the ERROR row and surface in the aggregate", () => {
  const targets = normalizeDeviceTargets(
    [
      {
        skillId: "sk_01Jok",
        agentId: "codex",
        status: "SYNCED",
        errorCode: "ignored",
        errorMessage: "ignored",
        contentHash: "sha256:ok",
      },
      {
        skillId: "sk_01Jok",
        agentId: "pi",
        status: "ERROR",
        errorCode: "TARGET_ERROR",
        errorMessage: "Failed to write /Users/ada/.agents/skill",
        contentHash: null,
      },
    ],
    4_000,
  );
  expect(targets[0]).toMatchObject({
    status: "SYNCED",
    errorCode: null,
    errorMessage: null,
    contentHash: "sha256:ok",
  });
  expect(targets[1]).toMatchObject({
    status: "ERROR",
    errorCode: "TARGET_ERROR",
    errorMessage: "A local target failed.",
  });
  expect(lastErrorFromTargets(targets)).toEqual({
    lastErrorCode: "TARGET_ERROR",
    lastErrorMessage: "A local target failed.",
  });
});
