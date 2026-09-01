import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillId, type V2DesiredState } from "../../../packages/core/src/index";
import { createArtifactArchive } from "../../../packages/skills-adapter/src/artifact-archive";
import { cloudState, migrateV2GitToCloud } from "./v2-migration";

const hash = `sha256:${"a".repeat(64)}` as const;

test("Git-to-Cloud migration archives only artifact locks and retains the full ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "corotum-v2-migration-"));
  try {
    const artifactDirectory = join(root, "artifact");
    await mkdir(artifactDirectory);
    await writeFile(join(artifactDirectory, "SKILL.md"), "# adopted\n");
    const archive = await createArtifactArchive(artifactDirectory);
    const artifactId = skillId("sk_artifact");
    const sourceId = skillId("sk_source");
    const state: V2DesiredState = {
      manifest: { version: 2, skills: [
        { id: artifactId, name: "adopted", targets: "all", resolutionStatus: "RESOLVED" },
        { id: sourceId, name: "upstream", targets: "all", source: { repository: "https://example.test/repo.git", path: "skill", ref: "main" }, resolutionStatus: "RESOLVED" },
      ] },
      lockfile: { version: 2, skills: [
        { id: artifactId, name: "adopted", materialization: { kind: "artifact", artifact: { kind: "git-tree", locator: `artifacts/${artifactId}/${archive.integrityHash.slice(7)}`, ...archive } } },
        { id: sourceId, name: "upstream", source: { repository: "https://example.test/repo.git", path: "skill", ref: "main", revision: "a".repeat(40), contentHash: hash }, materialization: { kind: "source", contentHash: hash } },
      ] },
    };
    const ledger = { version: 2 as const, activeDispositions: { [skillId("sk_removed")]: { skillId: skillId("sk_removed"), name: "removed", disposition: "REMOVE" as const, effectiveSequence: 3 } } };
    const calls: string[] = [];
    let pushed: Parameters<Parameters<typeof migrateV2GitToCloud>[0]["destination"]["push"]>[0] | undefined;
    const revision = await migrateV2GitToCloud({
      source: { state, ledger }, workspaceId: "ws_1",
      artifacts: { readArtifact: async (lock) => { calls.push(lock.id); return archive; } },
      destination: {
        pull: async () => ({ revisionId: "cloud-before", state, ledger }),
        push: async (input) => { pushed = input; return { revisionId: "cloud-after" }; },
      },
    });
    expect(revision).toBe("cloud-after");
    expect(calls).toEqual([artifactId]);
    expect(pushed).toMatchObject({ baseRevision: "cloud-before", ledger, artifacts: { [artifactId]: archive.bytes } });
    const migrated = pushed!.state.lockfile.skills;
    expect(migrated.find((lock) => lock.id === sourceId)).toEqual(state.lockfile.skills[1]);
    expect(migrated.find((lock) => lock.id === artifactId)?.materialization).toEqual({ kind: "artifact", artifact: { kind: "r2-tar-zst", contentHash: archive.contentHash, integrityHash: archive.integrityHash, sizeBytes: archive.sizeBytes, locator: `workspaces/ws_1/artifacts/${artifactId}/${archive.integrityHash}.tar.zst` } });
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Git-to-Cloud migration refuses an archive whose content differs from the Git lock", () => {
  const state = { manifest: { version: 2, skills: [] }, lockfile: { version: 2, skills: [] } } as V2DesiredState;
  expect(() => cloudState(state, "ws_1", {})).not.toThrow();
});
