import { describe, expect, test } from "bun:test";
import { revisionId, skillId } from "../../../packages/core/src/index";
import { RemoveService } from "./remove";

const id = skillId("sk_remove");
const state = {
  schemaVersion: 1 as const,
  lastAppliedRevision: revisionId("base"),
  skills: {
    [id]: {
      canonicalPath: "/store/remove",
      contentHash: "sha256:locked",
      targets: {
        "codex\0/home/test/.codex/skills/remove": {
          agentId: "codex" as const,
          mode: "symlink" as const,
          path: "/home/test/.codex/skills/remove",
        },
      },
    },
  },
};

function fixture() {
  const pushed: unknown[] = [];
  const executed: unknown[] = [];
  const provider = {
    pull: async () => ({
      kind: "success" as const,
      value: {
        revisionId: revisionId("base"),
        state: {
          manifest: {
            version: 1 as const,
            skills: [
              {
                id,
                source: "source",
                skill: "remove",
                ref: "main",
                targets: "all" as const,
                resolutionStatus: "RESOLVED" as const,
              },
            ],
          },
          lockfile: {
            version: 1 as const,
            skills: [
              {
                id,
                source: "source",
                skill: "remove",
                ref: "main",
                repository: "source",
                revision: "a".repeat(40),
                path: "remove",
                contentHash: "sha256:locked",
              },
            ],
          },
        },
      },
    }),
    push: async (input: unknown, transition: unknown) => {
      pushed.push({ input, transition });
      return {
        kind: "success" as const,
        value: {
          revisionId: revisionId("next"),
          state: (input as { state: never }).state,
        },
      };
    },
  };
  const executor = {
    execute: async (input: unknown) => {
      executed.push(input);
      return { state, operations: [] };
    },
  };
  return {
    provider,
    pushed,
    executed,
    service: new RemoveService(provider, executor),
  };
}

const execution = {
  enabledAgentIds: ["codex"] as const,
  homeDir: "/home/test",
  state,
};

describe("CLI remove and unmanage", () => {
  test("removes desired state through REMOVE reconciliation", async () => {
    const { service, pushed, executed } = fixture();
    expect(
      await service.remove({ name: "remove", operation: "REMOVE", execution }),
    ).toMatchObject({ kind: "removed", revision: "next" });
    expect(pushed).toEqual([
      expect.objectContaining({
        transition: { type: "REMOVE", skillId: id, metadata: {} },
      }),
    ]);
    expect(executed[0]).toMatchObject({
      plan: { operations: [{ kind: "REMOVE", skillId: id }] },
      desired: { manifest: { skills: [] }, lockfile: { skills: [] } },
    });
  });

  test("unmanage uses UNMANAGE reconciliation and keeps an approved conflicting target out of ownership", async () => {
    const { service, pushed, executed } = fixture();
    expect(
      await service.remove({
        name: id,
        operation: "UNMANAGE",
        unmanageChoices: { "/home/test/.codex/skills/remove": "keep" },
        execution,
      }),
    ).toMatchObject({ kind: "unmanaged" });
    expect(pushed).toEqual([
      expect.objectContaining({
        transition: { type: "UNMANAGE", skillId: id, metadata: {} },
      }),
    ]);
    expect(executed[0]).toMatchObject({
      plan: { operations: [{ kind: "UNMANAGE", skillId: id }] },
      state: { skills: { [id]: { targets: {} } } },
    });
  });

  test("blocks PENDING_PUSH before changing desired or local state", async () => {
    const { service, provider, pushed, executed } = fixture();
    provider.pull = async () => ({
      kind: "failure" as const,
      error: {
        code: "CONFLICT" as const,
        message:
          "Resolve the previous PENDING_PUSH before changing desired state.",
      },
    });
    expect(
      await service.remove({ name: "remove", operation: "REMOVE", execution }),
    ).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("PENDING_PUSH"),
    });
    expect({ pushed, executed }).toEqual({ pushed: [], executed: [] });
  });
});
