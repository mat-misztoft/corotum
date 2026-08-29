import { describe, expect, test } from "bun:test";
import { revisionId, skillId } from "../../../packages/core/src/index";
import { AddService } from "./add";
import { selectCandidate } from "./add-command";

const state = {
  schemaVersion: 1 as const,
  lastAppliedRevision: null,
  skills: {},
};
const execution = { enabledAgentIds: [], homeDir: "/home/test", state };

function fixture() {
  const pushed: unknown[] = [];
  const executed: unknown[] = [];
  const provider = {
    pull: async () => ({
      kind: "success" as const,
      value: {
        revisionId: revisionId("base"),
        state: {
          manifest: { version: 1 as const, skills: [] },
          lockfile: { version: 1 as const, skills: [] },
        },
      },
    }),
    push: async (input: unknown, transition: unknown) => {
      pushed.push({ input, transition });
      return {
        kind: "success" as const,
        value: {
          revisionId: revisionId("next"),
          state: (input as { state: unknown }).state,
        },
      };
    },
  };
  const resolver = {
    resolve: async () => ({
      repository: "https://github.com/owner/skills.git",
      revision: "a".repeat(40),
      path: "skills/review",
      contentHash: "sha256:review",
    }),
  };
  const executor = {
    execute: async (input: unknown) => {
      executed.push(input);
      return { state, operations: [] };
    },
  };
  return {
    executed,
    provider,
    pushed,
    resolver,
    service: new AddService(provider, resolver, executor),
  };
}

describe("CLI add", () => {
  test("selects a named skill deterministically and requires --skill for multi-skill automation", async () => {
    const candidates = [
      { name: "review", path: "skills/review" },
      { name: "frontend", path: "skills/frontend" },
    ];
    expect(await selectCandidate(candidates, "review", true)).toEqual(
      candidates[0],
    );
    await expect(selectCandidate(candidates, undefined, true)).rejects.toThrow(
      "Use --skill",
    );
  });

  test("adds immutable resolved content through the shared reconcile path", async () => {
    const { executed, pushed, service } = fixture();
    const result = await service.add({
      source: "https://github.com/owner/skills.git",
      candidate: { name: "review", path: "skills/review" },
      ref: "main",
      execution,
    });
    expect(result).toMatchObject({ kind: "added", revision: "next" });
    expect(pushed).toEqual([
      expect.objectContaining({
        transition: expect.objectContaining({ type: "ADD" }),
      }),
    ]);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      plan: {
        operations: [
          expect.objectContaining({
            kind: "INSTALL",
            skill: expect.objectContaining({
              revision: "a".repeat(40),
              contentHash: "sha256:review",
            }),
          }),
        ],
      },
    });
  });

  test("does not resolve, push, or reconcile an existing source and skill", async () => {
    let resolved = false;
    let pushed = false;
    let executed = false;
    const service = new AddService(
      {
        pull: async () => ({
          kind: "success" as const,
          value: {
            revisionId: revisionId("base"),
            state: {
              manifest: {
                version: 1 as const,
                skills: [
                  {
                    id: skillId("sk_existing"),
                    source: "source",
                    skill: "review",
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
                    id: skillId("sk_existing"),
                    source: "source",
                    skill: "review",
                    ref: "main",
                    repository: "source",
                    revision: "a",
                    path: "review",
                    contentHash: "sha256:a",
                  },
                ],
              },
            },
          },
        }),
        push: async () => {
          pushed = true;
          throw new Error("unreachable");
        },
      },
      {
        resolve: async () => {
          resolved = true;
          throw new Error("unreachable");
        },
      },
      {
        execute: async () => {
          executed = true;
          throw new Error("unreachable");
        },
      },
    );
    expect(
      await service.add({
        source: "source",
        candidate: { name: "review", path: "review" },
        ref: "main",
        execution,
      }),
    ).toEqual({ kind: "duplicate", skillId: skillId("sk_existing") });
    expect({ executed, pushed, resolved }).toEqual({
      executed: false,
      pushed: false,
      resolved: false,
    });
  });

  test("leaves desired and local state untouched when pending push or resolution blocks add", async () => {
    const { executed, provider, pushed, resolver, service } = fixture();
    provider.pull = async () => ({
      kind: "failure" as const,
      error: {
        code: "CONFLICT" as const,
        message:
          "Resolve the previous PENDING_PUSH before changing desired state.",
      },
    });
    expect(
      await service.add({
        source: "source",
        candidate: { name: "review", path: "review" },
        ref: "main",
        execution,
      }),
    ).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("PENDING_PUSH"),
    });
    expect({ executed, pushed }).toEqual({ executed: [], pushed: [] });
    resolver.resolve = async () => {
      throw new Error("unavailable");
    };
    provider.pull = async () => ({
      kind: "success" as const,
      value: {
        revisionId: revisionId("base"),
        state: {
          manifest: { version: 1 as const, skills: [] },
          lockfile: { version: 1 as const, skills: [] },
        },
      },
    });
    expect(
      await service.add({
        source: "source",
        candidate: { name: "review", path: "review" },
        ref: "main",
        execution,
      }),
    ).toMatchObject({ kind: "refused", reason: "unavailable" });
    expect({ executed, pushed }).toEqual({ executed: [], pushed: [] });
  });
});
