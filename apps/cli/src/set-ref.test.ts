import { describe, expect, test } from "bun:test";
import { revisionId, skillId } from "../../../packages/core/src/index";
import { SetRefService } from "./set-ref";

const first = skillId("sk_first");
const second = skillId("sk_second");
const oldRevision = "a".repeat(40);
const nextRevision = "b".repeat(40);
const desired = {
  manifest: {
    version: 1 as const,
    skills: [
      {
        id: first,
        source: "https://example.test/first.git",
        skill: "first",
        ref: "main",
        targets: "all" as const,
        resolutionStatus: "RESOLVED" as const,
      },
      {
        id: second,
        source: "https://example.test/second.git",
        skill: "second",
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
        id: first,
        source: "https://example.test/first.git",
        skill: "first",
        ref: "main",
        repository: "https://example.test/first.git",
        revision: oldRevision,
        path: "first",
        contentHash: `sha256:${oldRevision}`,
      },
      {
        id: second,
        source: "https://example.test/second.git",
        skill: "second",
        ref: "main",
        repository: "https://example.test/second.git",
        revision: oldRevision,
        path: "second",
        contentHash: `sha256:${oldRevision}`,
      },
    ],
  },
};
const execution = {
  enabledAgentIds: [] as const,
  homeDir: "/home/test",
  state: { schemaVersion: 1 as const, lastAppliedRevision: null, skills: {} },
};

function fixture() {
  const pushed: unknown[] = [];
  const executed: unknown[] = [];
  const provider = {
    pull: async () => ({
      kind: "success" as const,
      value: { revisionId: revisionId("base"), state: desired },
    }),
    push: async (input: unknown, transition: unknown) => {
      pushed.push({ input, transition });
      return {
        kind: "success" as const,
        value: {
          revisionId: revisionId("next"),
          state: (input as { state: typeof desired }).state,
        },
      };
    },
  };
  const resolver = {
    resolve: async () => ({
      repository: "https://example.test/first.git",
      revision: nextRevision,
      path: "first",
      contentHash: `sha256:${nextRevision}`,
    }),
  };
  const executor = {
    execute: async (input: unknown) => {
      executed.push(input);
      return {
        state: execution.state,
        operations: [{ status: "SUCCESS" as const }],
      };
    },
  };
  return {
    provider,
    resolver,
    pushed,
    executed,
    service: new SetRefService(provider, resolver, executor),
  };
}

describe("CLI set-ref", () => {
  test("atomically changes the manifest ref and exact lock, then installs that lock", async () => {
    const { service, pushed, executed } = fixture();
    await expect(
      service.setRef({ name: "first", ref: "v2", execution }),
    ).resolves.toEqual({
      kind: "set",
      skillId: first,
      revision: revisionId("next"),
    });
    expect(pushed).toEqual([
      expect.objectContaining({
        transition: {
          type: "SET_REF",
          skillId: first,
          metadata: { ref: "v2" },
        },
        input: expect.objectContaining({
          state: expect.objectContaining({
            manifest: expect.objectContaining({
              skills: expect.arrayContaining([
                expect.objectContaining({ id: first, ref: "v2" }),
                expect.objectContaining({ id: second, ref: "main" }),
              ]),
            }),
            lockfile: expect.objectContaining({
              skills: expect.arrayContaining([
                expect.objectContaining({
                  id: first,
                  ref: "v2",
                  revision: nextRevision,
                }),
                expect.objectContaining({
                  id: second,
                  ref: "main",
                  revision: oldRevision,
                }),
              ]),
            }),
          }),
        }),
      }),
    ]);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      plan: {
        operations: [
          {
            kind: "INSTALL",
            skill: { id: first, ref: "v2", revision: nextRevision },
          },
        ],
      },
    });
  });

  test("does not change desired or local state when source resolution fails", async () => {
    const { provider, resolver, pushed, executed, service } = fixture();
    resolver.resolve = async () => {
      throw new Error("unknown ref");
    };
    await expect(
      service.setRef({ name: "first", ref: "missing", execution }),
    ).resolves.toEqual({
      kind: "refused",
      reason: "unknown ref",
    });
    expect({ pushed, executed }).toEqual({ pushed: [], executed: [] });
    expect(provider).toBeDefined();
  });

  test("blocks PENDING_PUSH before resolving or persisting a ref change", async () => {
    const { provider, resolver, pushed, executed, service } = fixture();
    let resolved = false;
    resolver.resolve = async () => {
      resolved = true;
      throw new Error("unreachable");
    };
    provider.pull = async () => ({
      kind: "failure" as const,
      error: {
        code: "CONFLICT" as const,
        message:
          "Resolve the previous PENDING_PUSH before changing desired state.",
      },
    });
    await expect(
      service.setRef({ name: "first", ref: "v2", execution }),
    ).resolves.toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("PENDING_PUSH"),
    });
    expect({ pushed, executed, resolved }).toEqual({
      pushed: [],
      executed: [],
      resolved: false,
    });
  });
});
