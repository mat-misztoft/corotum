import { describe, expect, test } from "bun:test";
import type { DispositionLedger, V2DesiredState } from "../../../packages/core/src/index";
import { V2MutationService, type V2MutationProvider } from "./v2-mutations";

const hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const revision = "a".repeat(40);
const ledger: DispositionLedger = { version: 2, activeDispositions: {} };

function provider(state: V2DesiredState): V2MutationProvider & { pushes: number } {
  let current = state; let pushes = 0;
  return {
    get pushes() { return pushes; },
    pull: async () => ({ revisionId: revision, state: current, ledger }),
    push: async (input) => { pushes++; current = input.state; return { revisionId: revision, state: current, ledger }; },
  };
}
const empty: V2DesiredState = { manifest: { version: 2, skills: [] }, lockfile: { version: 2, skills: [] } };
const resolver = { resolve: async (source: { repository: string; path: string; ref: string }) => ({ ...source, revision, contentHash: hash }) };

describe("v2 mutation commands", () => {
  test("add locks an immutable source and does not alter an existing ref", async () => {
    const state = provider(empty);
    const service = new V2MutationService(state, resolver);
    const added = await service.add({ name: "alpha", source: { repository: "https://example.test/a.git", path: "alpha", ref: "main" } });
    expect(added.kind).toBe("success");
    const duplicate = await service.add({ name: "alpha", source: { repository: "https://example.test/a.git", path: "alpha", ref: "next" } });
    expect(duplicate.kind).toBe("duplicate");
    const saved = await state.pull();
    expect(saved.state.manifest.skills[0]?.source?.ref).toBe("main");
    expect(saved.state.lockfile.skills[0]?.materialization).toEqual({ kind: "source", contentHash: hash });
  });

  test("artifact adoption keeps optional provenance and null-source update is explicit", async () => {
    const state = provider(empty);
    const service = new V2MutationService(state, resolver);
    const adopted = await service.adoptArtifact({ name: "local", targets: "all", artifactDirectory: "/staged/local", contentHash: hash, integrityHash: hash, sizeBytes: 1 });
    expect(adopted.kind).toBe("success");
    const result = await service.update("local");
    expect(result[0]).toMatchObject({ kind: "source-unavailable" });
  });

  test("updates an adopted artifact through retained provenance while check remains read-only", async () => {
    const state = provider(empty);
    const applied: unknown[] = [];
    let resolvedRevision = revision;
    const service = new V2MutationService(
      state,
      { resolve: async (source) => ({ ...source, revision: resolvedRevision, contentHash: hash }) },
      { apply: async (input) => { applied.push(input); } },
    );
    const source = { repository: "https://example.test/a.git", path: "alpha", ref: "main" };
    const adopted = await service.adoptArtifact({
      name: "alpha", source, targets: "all", artifactDirectory: "/staged/alpha",
      contentHash: hash, integrityHash: hash, sizeBytes: 1,
    });
    expect(adopted.kind).toBe("success");
    const beforeCheck = state.pushes;
    expect(await service.check("alpha")).toEqual([
      { skillId: adopted.skillId, status: "UPDATE_AVAILABLE" },
    ]);
    expect(state.pushes).toBe(beforeCheck);

    resolvedRevision = "b".repeat(40);
    expect(await service.update("alpha")).toEqual([
      { kind: "success", skillId: adopted.skillId, revision },
    ]);
    const saved = await state.pull();
    expect(saved.state.manifest.skills[0]?.source).toEqual(source);
    expect(saved.state.lockfile.skills[0]?.materialization).toEqual({ kind: "source", contentHash: hash });
    expect(applied).toHaveLength(2);
  });

  test("keeps a persisted snapshot recoverable when local application fails", async () => {
    const state = provider(empty);
    const service = new V2MutationService(state, resolver, {
      apply: async () => { throw new Error("disk full"); },
    });
    const result = await service.add({
      name: "alpha",
      source: { repository: "https://example.test/a.git", path: "alpha", ref: "main" },
    });
    expect(result).toMatchObject({ kind: "persisted-not-applied", revision, reason: "disk full" });
    expect((await state.pull()).state.lockfile.skills[0]?.source?.revision).toBe(revision);
  });

  test("continues an update after a durable but locally failed application", async () => {
    let current = empty;
    let revisionNumber = 0;
    const state: V2MutationProvider = {
      pull: async () => ({ revisionId: `revision-${revisionNumber}`, state: current, ledger }),
      push: async (input) => {
        if (input.baseRevision !== `revision-${revisionNumber}`) throw new Error("stale base revision");
        current = input.state;
        revisionNumber++;
        return { revisionId: `revision-${revisionNumber}`, state: current, ledger };
      },
    };
    let resolvedRevision = revision;
    const service = new V2MutationService(state, {
      resolve: async (source) => ({ ...source, revision: resolvedRevision, contentHash: hash }),
    }, { apply: async () => { throw new Error("disk full"); } });
    await service.add({ name: "alpha", source: { repository: "https://example.test/a.git", path: "alpha", ref: "main" } });
    await service.add({ name: "beta", source: { repository: "https://example.test/b.git", path: "beta", ref: "main" } });
    resolvedRevision = "b".repeat(40);

    expect((await service.update()).map((result) => result.kind)).toEqual([
      "persisted-not-applied",
      "persisted-not-applied",
    ]);
  });

  test("does not persist when resolution fails", async () => {
    const state = provider(empty);
    const service = new V2MutationService(state, {
      resolve: async () => { throw new Error("upstream unavailable"); },
    });
    expect(await service.add({
      name: "alpha",
      source: { repository: "https://example.test/a.git", path: "alpha", ref: "main" },
    })).toMatchObject({ kind: "refused", reason: "upstream unavailable" });
    expect(state.pushes).toBe(0);
  });

  test("set-ref resolves before persistence and check is read-only", async () => {
    const state = provider(empty);
    const service = new V2MutationService(state, resolver);
    await service.add({ name: "alpha", source: { repository: "https://example.test/a.git", path: "alpha", ref: "main" } });
    const before = state.pushes;
    expect(await service.check("alpha")).toEqual([{ skillId: (await state.pull()).state.manifest.skills[0]?.id, status: "UP_TO_DATE" }]);
    expect(state.pushes).toBe(before);
    await service.setRef("alpha", "v1");
    expect((await state.pull()).state.manifest.skills[0]?.source?.ref).toBe("v1");
  });
});
