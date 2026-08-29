import { describe, expect, test } from "bun:test";

import type { DesiredState, StateProvider } from "../../../packages/core/src/index";
import { revisionId, skillId } from "../../../packages/core/src/index";
import { MigrationService } from "./migrate";

function state(name: string, suffix = "a"): DesiredState {
  const id = skillId(`sk_${suffix}`);
  return {
    manifest: { version: 1, skills: [{ id, source: `https://example.test/${name}.git`, skill: name, ref: "main", targets: ["codex"], resolutionStatus: "RESOLVED" }] },
    lockfile: { version: 1, skills: [{ id, source: `https://example.test/${name}.git`, skill: name, ref: "main", repository: `https://example.test/${name}.git`, revision: "abc123", path: name, contentHash: `sha256:${name}` }] },
  };
}

function provider(initial: DesiredState, revision = "source") {
  let current = initial;
  let pushes = 0;
  const value = () => ({ revisionId: revisionId(revision), state: current });
  return {
    provider: {
      pull: async () => ({ kind: "success" as const, value: value() }),
      push: async ({ state: next }: { state: DesiredState }) => {
        pushes += 1;
        current = next;
        return { kind: "success" as const, value: value() };
      },
    } as StateProvider & { push: (input: { state: DesiredState }, transition: unknown) => Promise<unknown> },
    state: () => current,
    pushes: () => pushes,
  };
}

describe("MigrationService", () => {
  test("replaces Cloud destination without changing the Git source", async () => {
    const source = provider(state("source", "a"), "git-revision");
    const target = provider(state("destination", "b"), "cloud-revision");
    const result = await new MigrationService(source.provider, target.provider as never).migrate("replace");
    expect(result).toMatchObject({ kind: "migrated", strategy: "replace" });
    expect(target.state()).toEqual(source.state());
    expect(source.pushes()).toBe(0);
  });

  test("merges independent skills while preserving their locked fields", async () => {
    const source = provider(state("source", "a"));
    const target = provider(state("destination", "b"));
    const result = await new MigrationService(source.provider, target.provider as never).migrate("merge");
    expect(result.kind).toBe("migrated");
    expect(target.state().manifest.skills.map((skill) => skill.id)).toEqual([skillId("sk_b"), skillId("sk_a")]);
    expect(target.state().lockfile.skills.map((skill) => [skill.revision, skill.contentHash])).toEqual([["abc123", "sha256:destination"], ["abc123", "sha256:source"]]);
  });

  test("leaves both providers unchanged for cancellation and same-skill conflicts", async () => {
    const source = provider(state("skill", "a"));
    const target = provider({ ...state("skill", "a"), manifest: { version: 1, skills: [{ ...state("skill", "a").manifest.skills[0], ref: "release" }] } });
    const service = new MigrationService(source.provider, target.provider as never);
    expect(await service.migrate("cancel")).toEqual({ kind: "cancelled" });
    expect(target.pushes()).toBe(0);
    expect(await service.migrate("merge")).toEqual({ kind: "conflict", skills: ["skill"] });
    expect(target.pushes()).toBe(0);
    expect(source.pushes()).toBe(0);
  });

  test("does not bootstrap a Git destination while PENDING_PUSH remains unresolved", async () => {
    const source = provider(state("source", "a"));
    let bootstrapped = false;
    const pendingDestination = {
      pull: async () => ({ kind: "failure" as const, error: { code: "CONFLICT" as const, message: "Resolve the previous PENDING_PUSH before changing desired state." } }),
      push: async () => ({ kind: "failure" as const, error: { code: "CONFLICT" as const, message: "unexpected" } }),
      bootstrap: async () => { bootstrapped = true; return { kind: "success" as const, value: { revisionId: revisionId("new"), state: state("source", "a") } }; },
    };
    const result = await new MigrationService(source.provider, pendingDestination).migrate("replace");
    expect(result).toEqual({ kind: "refused", reason: "Resolve the previous PENDING_PUSH before changing desired state." });
    expect(bootstrapped).toBe(false);
  });
});
