import { describe, expect, test } from "bun:test";
import { revisionId } from "../../../packages/core/src/index";
import { AdoptService } from "./adopt";
import {
  selectLocalCandidate,
  selectRepositoryCandidate,
} from "./adopt-command";

const state = {
  schemaVersion: 1 as const,
  lastAppliedRevision: null,
  skills: {},
};
const execution = {
  enabledAgentIds: ["codex"] as const,
  homeDir: "/home/test",
  state,
};
const local = {
  agentId: "codex" as const,
  contentHash: "sha256:local",
  name: "review",
  path: "/home/test/.codex/skills/review",
};
const repository = { name: "review", path: "skills/review" };

function fixture(contentHash = "sha256:local") {
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
          state: (input as { state: never }).state,
        },
      };
    },
  };
  const resolved = {
    repository: "https://github.com/owner/skills.git",
    revision: "a".repeat(40),
    path: "skills/review",
    contentHash,
  };
  const executor = {
    execute: async (input: unknown) => {
      executed.push(input);
      return { state, operations: [] };
    },
  };
  return {
    provider,
    resolved,
    pushed,
    executed,
    service: new AdoptService(provider, executor),
  };
}

describe("CLI adopt", () => {
  test("adopts a source-matched local skill through the shared reconcile path", async () => {
    const { service, pushed, executed, resolved } = fixture();
    expect(
      await service.adopt({
        source: "source",
        local,
        repository,
        ref: "main",
        resolved,
        replaceLocalMismatch: false,
        execution,
      }),
    ).toMatchObject({ kind: "adopted", revision: "next" });
    expect(pushed).toEqual([
      expect.objectContaining({
        transition: expect.objectContaining({ type: "ADOPT" }),
      }),
    ]);
    expect(executed[0]).toMatchObject({
      plan: {
        operations: [
          expect.objectContaining({
            kind: "INSTALL",
            skill: expect.objectContaining({
              revision: "a".repeat(40),
              contentHash: "sha256:local",
            }),
          }),
        ],
      },
      state: { skills: expect.any(Object) },
    });
  });

  test("leaves a mismatched local copy unmanaged unless replacement is explicitly approved", async () => {
    const { service, pushed, executed, resolved } =
      fixture("sha256:repository");
    expect(
      await service.adopt({
        source: "source",
        local,
        repository,
        ref: "main",
        resolved,
        replaceLocalMismatch: false,
        execution,
      }),
    ).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("explicit replacement"),
    });
    expect({ pushed, executed }).toEqual({ pushed: [], executed: [] });
  });

  test("blocks PENDING_PUSH before resolving or changing desired/local state", async () => {
    const { service, provider, pushed, executed, resolved } = fixture();
    provider.pull = async () => ({
      kind: "failure" as const,
      error: {
        code: "CONFLICT" as const,
        message:
          "Resolve the previous PENDING_PUSH before changing desired state.",
      },
    });
    expect(
      await service.adopt({
        source: "source",
        local,
        repository,
        ref: "main",
        resolved,
        replaceLocalMismatch: false,
        execution,
      }),
    ).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("PENDING_PUSH"),
    });
    expect({ pushed, executed }).toEqual({ pushed: [], executed: [] });
  });

  test("requires deterministic selection in no-TTY mode without changing either copy", async () => {
    await expect(
      selectLocalCandidate(
        [
          local,
          { ...local, agentId: "pi", path: "/home/test/.pi/skills/review" },
        ],
        true,
      ),
    ).rejects.toThrow("Multiple local copies");
    await expect(
      selectRepositoryCandidate(
        [repository, { ...repository, path: "nested/review" }],
        "review",
        true,
      ),
    ).rejects.toThrow("ambiguous");
  });
});
