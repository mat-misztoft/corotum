import { describe, expect, test } from "bun:test";
import { revisionId, skillId } from "../../../packages/core/src/index";
import { GitSourceError } from "../../../packages/skills-adapter/src/git-source";
import { UpdateService } from "./update";

const first = skillId("sk_first");
const second = skillId("sk_second");
const lock = (
  id: typeof first | typeof second,
  skill: string,
  revision = "a".repeat(40),
) => ({
  id,
  source: `https://example.test/${skill}.git`,
  skill,
  ref: "main",
  repository: `https://example.test/${skill}.git`,
  revision,
  path: skill,
  contentHash: `sha256:${revision}`,
});
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
    skills: [lock(first, "first"), lock(second, "second")],
  },
};
const execution = {
  enabledAgentIds: [] as const,
  homeDir: "/home/test",
  state: {
    schemaVersion: 1 as const,
    lastAppliedRevision: revisionId("base"),
    skills: {},
  },
};

function fixture(
  resolve = async (input: {
    id: typeof first | typeof second;
    skill: string;
  }) => ({
    repository: `https://example.test/${input.skill}.git`,
    revision: "a".repeat(40),
    path: input.skill,
    contentHash: `sha256:${"a".repeat(40)}`,
  }),
) {
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
    pushed,
    executed,
    provider,
    service: new UpdateService(provider, { resolve }, executor),
  };
}

describe("CLI update", () => {
  test("check contacts upstream without changing desired or local state", async () => {
    const { service, pushed, executed } = fixture();
    await expect(service.check()).resolves.toEqual([
      { skillId: first, skill: "first", status: "UP_TO_DATE" },
      { skillId: second, skill: "second", status: "UP_TO_DATE" },
    ]);
    expect({ pushed, executed }).toEqual({ pushed: [], executed: [] });
  });

  test("updates only the selected lock and installs its newly resolved exact content", async () => {
    const nextRevision = "b".repeat(40);
    const { service, pushed, executed } = fixture(async (input) => ({
      repository: `https://example.test/${input.skill}.git`,
      revision: input.id === first ? nextRevision : "a".repeat(40),
      path: input.skill,
      contentHash: `sha256:${input.id === first ? nextRevision : "a".repeat(40)}`,
    }));
    await expect(
      service.update({ name: "first", execution }),
    ).resolves.toMatchObject({
      kind: "updated",
      skills: [first],
      revision: "next",
    });
    expect(pushed).toEqual([
      expect.objectContaining({
        transition: expect.objectContaining({ type: "UPDATE", skillId: first }),
        input: expect.objectContaining({
          state: expect.objectContaining({
            lockfile: expect.objectContaining({
              skills: [
                expect.objectContaining({ id: first, revision: nextRevision }),
                expect.objectContaining({
                  id: second,
                  revision: "a".repeat(40),
                }),
              ],
            }),
          }),
        }),
      }),
    ]);
    expect(executed[0]).toMatchObject({
      plan: {
        operations: [
          { kind: "INSTALL", skill: { id: first, revision: nextRevision } },
        ],
      },
    });
  });

  test("reports unresolved and private source statuses without a desired-state mutation", async () => {
    const { service, pushed } = fixture(async (input) => {
      if (input.id === first)
        throw new GitSourceError("AUTH_REQUIRED", "authentication required");
      throw new Error("network unavailable");
    });
    await expect(service.check()).resolves.toEqual([
      { skillId: first, skill: "first", status: "AUTH_REQUIRED" },
      { skillId: second, skill: "second", status: "CHECK_FAILED" },
    ]);
    expect(pushed).toEqual([]);

    const unresolved = {
      ...desired,
      manifest: {
        ...desired.manifest,
        skills: [
          {
            ...desired.manifest.skills[0],
            resolutionStatus: "PENDING_RESOLUTION" as const,
          },
        ],
      },
    };
    const pendingProvider = {
      pull: async () => ({
        kind: "success" as const,
        value: { revisionId: revisionId("base"), state: unresolved },
      }),
      push: async () => {
        throw new Error("unreachable");
      },
    };
    const pending = new UpdateService(
      pendingProvider,
      {
        resolve: async () => {
          throw new Error("unreachable");
        },
      },
      { execute: async () => ({ state: execution.state, operations: [] }) },
    );
    await expect(pending.check("first")).resolves.toEqual([
      { skillId: first, skill: "first", status: "UNKNOWN" },
    ]);
  });

  test("uses the read-only provider path when PENDING_PUSH blocks a mutation", async () => {
    const { provider, service } = fixture();
    provider.pull = async () => ({
      kind: "failure" as const,
      error: {
        code: "CONFLICT" as const,
        message:
          "Resolve the previous PENDING_PUSH before changing desired state.",
      },
    });
    const readOnly = new UpdateService(
      {
        ...provider,
        pullReadOnly: async () => ({
          kind: "success" as const,
          value: { revisionId: revisionId("base"), state: desired },
        }),
      },
      {
        resolve: async (input) => ({
          repository: input.source,
          revision: "a".repeat(40),
          path: input.path,
          contentHash: `sha256:${"a".repeat(40)}`,
        }),
      },
      { execute: async () => ({ state: execution.state, operations: [] }) },
    );
    await expect(readOnly.check()).resolves.toHaveLength(2);
    await expect(service.update({ execution })).resolves.toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("PENDING_PUSH"),
    });
  });
});
