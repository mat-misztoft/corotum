import { describe, expect, test } from "bun:test";

import type {
  ActualState,
  DesiredState,
  DesiredStateEnvelope,
  LockedSkill,
  SkillId,
} from "../../../packages/core/src/index";
import type { LocalOperationalState } from "./local-state";
import { SyncService } from "./sync";
import { detectedAgentStatuses } from "./sync-command";

const id = "sk_sync" as SkillId;
const lock = {
  id,
  source: "https://example.test/skills.git",
  skill: "example",
  ref: "main",
  repository: "https://example.test/skills.git",
  revision: "a".repeat(40),
  path: "example",
  contentHash: "sha256:exact",
} as LockedSkill;
const desired: DesiredState = {
  manifest: {
    version: 1,
    skills: [
      {
        id,
        source: lock.source,
        skill: lock.skill,
        ref: lock.ref,
        targets: "all",
        resolutionStatus: "RESOLVED",
      },
    ],
  },
  lockfile: { version: 1, skills: [lock] },
};
const envelope: DesiredStateEnvelope = {
  revisionId: "revision-1" as never,
  state: desired,
};
const empty: LocalOperationalState = {
  schemaVersion: 1,
  lastAppliedRevision: null,
  skills: {},
};

describe("sync agent detection", () => {
  test("reports a newly detected agent as disabled unless an interactive user approves it", () => {
    expect(detectedAgentStatuses([{ id: "pi" }], false)).toEqual([
      { id: "pi", status: "DETECTED_DISABLED" },
    ]);
    expect(detectedAgentStatuses([{ id: "pi" }], true)).toEqual([
      { id: "pi", status: "ENABLED" },
    ]);
  });
});

describe("SyncService", () => {
  test("status and diff inspection use read-only pull and do not execute", async () => {
    let readOnlyPulls = 0;
    let pulls = 0;
    let executes = 0;
    const service = new SyncService(
      {
        pull: async () => {
          pulls += 1;
          return { kind: "success", value: envelope } as const;
        },
        pullReadOnly: async () => {
          readOnlyPulls += 1;
          return { kind: "success", value: envelope } as const;
        },
        push: async () => ({ kind: "success", value: envelope }),
      },
      {
        execute: async () => {
          executes += 1;
          throw new Error("must not execute");
        },
      },
      async () => ({ skills: {} }),
    );

    const result = await service.inspect(empty);
    expect(result).toMatchObject({
      kind: "ready",
      snapshot: { plan: { operations: [{ kind: "INSTALL", skill: lock }] } },
    });
    expect({ readOnlyPulls, pulls, executes }).toEqual({
      readOnlyPulls: 1,
      pulls: 0,
      executes: 0,
    });
  });

  test("sync pulls before planning, executes the exact lock, and verifies after apply", async () => {
    const calls: string[] = [];
    let actual: ActualState = { skills: {} };
    const state: LocalOperationalState = {
      schemaVersion: 1,
      lastAppliedRevision: "revision-1" as never,
      skills: {
        [id]: {
          canonicalPath: "/canonical/example",
          contentHash: lock.contentHash,
          targets: {},
        },
      },
    };
    const service = new SyncService(
      {
        pull: async () => {
          calls.push("pull");
          return { kind: "success", value: envelope } as const;
        },
        push: async () => ({ kind: "success", value: envelope }),
      },
      {
        execute: async (input) => {
          calls.push("execute");
          expect(input.plan.operations).toEqual([
            { kind: "INSTALL", skill: lock },
          ]);
          actual = {
            skills: { [id]: { contentHash: lock.contentHash, managed: true } },
          };
          return {
            state,
            operations: [
              {
                kind: "INSTALL",
                skillId: id,
                status: "SUCCESS",
                targetOutcomes: [],
              },
            ],
          };
        },
      },
      async () => actual,
    );

    const result = await service.sync({
      execution: { state: empty, enabledAgentIds: [], homeDir: "/home/test" },
    });
    expect(result).toMatchObject({
      kind: "synced",
      snapshot: { plan: { operations: [] } },
    });
    expect(calls).toEqual(["pull", "execute"]);
  });

  test("preserves target-level execution failures as partial success", async () => {
    const service = new SyncService(
      {
        pull: async () => ({ kind: "success", value: envelope }),
        push: async () => ({ kind: "success", value: envelope }),
      },
      {
        execute: async () => ({
          state: empty,
          operations: [
            {
              kind: "INSTALL",
              skillId: id,
              status: "ERROR",
              targetOutcomes: [],
              error: "read-only target",
            },
          ],
        }),
      },
      async () => ({ skills: {} }),
    );

    await expect(
      service.sync({
        execution: { state: empty, enabledAgentIds: [], homeDir: "/home/test" },
      }),
    ).resolves.toMatchObject({ kind: "partial" });
  });
});
