import { describe, expect, test } from "bun:test";
import type { AgentId } from "../../../packages/agent-targets/src/index";
import { revisionId } from "../../../packages/core/src/index";
import { createCli } from "./cli";
import { coalesceInitCandidates, divergentCandidates, InitService, type InitCandidate, type InitStateProvider } from "./init";
import { selectInitCandidates } from "./init-command";

const candidates: readonly InitCandidate[] = [
  { agentId: "codex", name: "review", path: "/home/a/.codex/skills/review", source: "owner/skills", contentHash: "sha256:exact" },
  { agentId: "pi", name: "review", path: "/home/a/.pi/agent/skills/review", source: "owner/skills", contentHash: "sha256:exact" },
];

function fixture() {
  const calls: unknown[] = [];
  const transitions: unknown[] = [];
  const provider = {
    pull: async () => ({
      kind: "success" as const,
      value: {
        revisionId: revisionId("base"),
        state: { manifest: { version: 1 as const, skills: [] }, lockfile: { version: 1 as const, skills: [] } },
      },
    }),
    push: async (input: { state: unknown }, transition: unknown) => {
      transitions.push(transition);
      return { kind: "success" as const, value: { revisionId: revisionId("next"), state: input.state } };
    },
  } satisfies InitStateProvider;
  const service = new InitService(
    provider,
    { resolve: async () => ({ repository: "https://github.com/owner/skills.git", revision: "abc", path: "review", contentHash: "sha256:exact" }) },
    { execute: async (input) => { calls.push(input); return { state: input.state, operations: [] }; } },
  );
  return { calls, service, transitions };
}

const execution = {
  enabledAgentIds: ["codex", "pi"] as AgentId[],
  homeDir: "/home/a",
  state: { schemaVersion: 1 as const, lastAppliedRevision: null, skills: {} },
};

describe("CLI init adoption", () => {
  test("coalesces exact source-known copies into one managed skill with both targets", async () => {
    expect(coalesceInitCandidates(candidates)).toEqual([{ source: "owner/skills", name: "review", contentHash: "sha256:exact", targets: ["codex", "pi"] }]);
    const { calls, service, transitions } = fixture();
    const result = await service.initialize({ candidates, selected: coalesceInitCandidates(candidates), nonInteractive: false, execution });
    expect(result.kind).toBe("initialized");
    expect(calls).toHaveLength(1);
    const input = calls[0] as { desired: { manifest: { skills: readonly { targets: unknown }[] } }; plan: { operations: readonly { kind: string }[] }; state: { skills: Record<string, { targets: Record<string, unknown> }> } };
    expect(input.desired.manifest.skills[0].targets).toEqual(["codex", "pi"]);
    expect(input.plan.operations).toHaveLength(1);
    expect(Object.keys(Object.values(input.state.skills)[0].targets)).toContain("codex\0/home/a/.codex/skills/review");
    expect(transitions).toEqual([expect.objectContaining({ type: "ADOPT" })]);
  });

  test("requires an interactive choice for divergent copies", async () => {
    const divergent = [...candidates, { ...candidates[1], contentHash: "sha256:other" }];
    expect(divergentCandidates(divergent)).toHaveLength(3);
    const { calls, service } = fixture();
    expect(await service.initialize({ candidates: divergent, selected: [], nonInteractive: false, execution })).toMatchObject({ kind: "selection-required" });
    expect(calls).toEqual([]);
  });

  test("uses the explicit TTY canonical-copy choice for divergent same-name skills", async () => {
    const divergent = [...candidates, { ...candidates[1], contentHash: "sha256:other" }];
    const selected = await selectInitCandidates(divergent, false, async () => 1);
    expect(selected).toEqual([{ source: "owner/skills", name: "review", contentHash: "sha256:other", targets: ["pi"] }]);
    const calls: unknown[] = [];
    const service = new InitService(
      {
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
        push: async (input, _transition) => ({
          kind: "success" as const,
          value: { revisionId: revisionId("next"), state: input.state },
        }),
      },
      { resolve: async () => ({ repository: "https://github.com/owner/skills.git", revision: "abc", path: "review", contentHash: "sha256:other" }) },
      { execute: async (input) => { calls.push(input); return { state: input.state, operations: [] }; } },
    );
    expect(await service.initialize({ candidates: divergent, selected, nonInteractive: false, execution })).toMatchObject({ kind: "initialized" });
    expect(calls).toHaveLength(1);
  });

  test("refuses divergent adoption without a TTY and leaves local state untouched", async () => {
    const divergent = [...candidates, { ...candidates[1], contentHash: "sha256:other" }];
    expect(await selectInitCandidates(divergent, true)).toEqual(coalesceInitCandidates(divergent));
    const { calls, service } = fixture();
    expect(await service.initialize({ candidates: divergent, selected: coalesceInitCandidates(candidates), nonInteractive: true, execution })).toMatchObject({ kind: "refused" });
    expect(calls).toEqual([]);
  });

  test("refuses to replace a non-empty desired state", async () => {
    const { calls } = fixture();
    const initialized = new InitService(
      {
        pull: async () => ({
          kind: "success" as const,
          value: {
            revisionId: revisionId("base"),
            state: {
              manifest: {
                version: 1 as const,
                skills: [{
                  id: "sk_existing" as never,
                  source: "owner/skills",
                  skill: "existing",
                  ref: "main",
                  targets: ["codex"] as AgentId[],
                  resolutionStatus: "RESOLVED" as const,
                }],
              },
              lockfile: { version: 1 as const, skills: [] },
            },
          },
        }),
        push: async () => { throw new Error("unreachable"); },
      } satisfies InitStateProvider,
      { resolve: async () => { throw new Error("unreachable"); } },
      { execute: async () => { throw new Error("unreachable"); } },
    );
    expect(await initialized.initialize({ candidates, selected: coalesceInitCandidates(candidates), nonInteractive: false, execution })).toMatchObject({ kind: "refused", reason: expect.stringContaining("already initialized") });
    expect(calls).toEqual([]);
  });

  test("bootstraps a genuinely empty Git desired-state repository before adoption", async () => {
    const calls: unknown[] = [];
    const bootstrap = new InitService(
      {
        pull: async () => ({ kind: "failure" as const, error: { code: "NETWORK_ERROR" as const, message: "Git repository has no HEAD." } }),
        push: async () => { throw new Error("unreachable"); },
        bootstrap: async (state) => ({ kind: "success" as const, value: { revisionId: revisionId("first"), state } }),
      },
      { resolve: async () => ({ repository: "https://github.com/owner/skills.git", revision: "abc", path: "review", contentHash: "sha256:exact" }) },
      { execute: async (input) => { calls.push(input); return { state: input.state, operations: [] }; } },
    );
    expect(await bootstrap.initialize({ candidates, selected: coalesceInitCandidates(candidates), nonInteractive: false, execution })).toMatchObject({ kind: "initialized", revision: "first" });
    expect(calls).toHaveLength(1);
  });

  test("does not invoke reconciliation when pending push blocks desired-state mutation", async () => {
    const { service, calls } = fixture();
    const blocked = new InitService(
      { pull: async () => ({ kind: "failure" as const, error: { code: "CONFLICT" as const, message: "Resolve the previous PENDING_PUSH before changing desired state." } }), push: async () => { throw new Error("unreachable"); } },
      { resolve: async () => { throw new Error("unreachable"); } },
      { execute: async () => { throw new Error("unreachable"); } },
    );
    expect(await blocked.initialize({ candidates, selected: coalesceInitCandidates(candidates), nonInteractive: false, execution })).toMatchObject({ kind: "refused", reason: expect.stringContaining("PENDING_PUSH") });
    expect(calls).toEqual([]);
    void service;
  });

  test("removes global init --source from normal CLI help parsing", () => {
    const output: string[] = [];
    const program = createCli({
      stdinIsTTY: true,
      writeError: () => undefined,
      writeOutput: (message) => output.push(message),
    });
    const help = program.commands.find((command) => command.name() === "init")?.helpInformation() ?? "";
    expect(help).toContain("init");
    expect(help).not.toMatch(/--source <repository>/);
    expect(help).toContain("--adopt-artifact");
  });
});
