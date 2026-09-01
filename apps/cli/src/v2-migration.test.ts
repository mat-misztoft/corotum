import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillId, type DispositionLedger, type V2DesiredState } from "../../../packages/core/src/index";
import { gitTreeHash, V2GitStateProvider } from "../../../packages/git-provider/src/index";
import { createArtifactArchive } from "../../../packages/skills-adapter/src/artifact-archive";
import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import { mergeV2MigrationSnapshots, migrateV2CloudToGit, migrateV2GitToCloud } from "./v2-migration";

const hash = `sha256:${"a".repeat(64)}` as const;
const emptyState = (): V2DesiredState => ({ manifest: { version: 2, skills: [] }, lockfile: { version: 2, skills: [] } });
const emptyLedger = (): DispositionLedger => ({ version: 2, activeDispositions: {} });

async function runGit(...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function realGit(root: string) {
  const remote = join(root, "remote.git");
  const worktree = join(root, "worktree");
  await runGit("init", "--initial-branch=main", worktree);
  await runGit("-C", worktree, "config", "user.email", "tests@corotum.invalid");
  await runGit("-C", worktree, "config", "user.name", "Corotum tests");
  await runGit("-C", worktree, "commit", "--allow-empty", "-m", "initial");
  await runGit("init", "--bare", remote);
  await runGit("-C", worktree, "remote", "add", "origin", remote);
  await runGit("-C", worktree, "push", "-u", "origin", "main");
  await runGit("--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const provider = new V2GitStateProvider(join(root, "cache"), remote, undefined, async () => undefined);
  await provider.push({ state: emptyState(), ledger: emptyLedger(), baseRevision: await runGit("-C", worktree, "rev-parse", "HEAD") });
  return provider;
}

function fakeCloud(initial?: Readonly<{ revisionId?: string | null; state?: V2DesiredState; ledger?: DispositionLedger }>) {
  let revisionId = initial?.revisionId ?? null;
  let current = { state: initial?.state ?? emptyState(), ledger: initial?.ledger ?? emptyLedger() };
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    snapshot: () => ({ revisionId, ...current }),
    pull: async () => ({ revisionId, ...current }),
    push: async (input: Readonly<{ state: V2DesiredState; ledger: DispositionLedger; baseRevision: string | null; artifacts: Readonly<Record<string, Uint8Array>> }>) => {
      if (input.baseRevision !== revisionId) throw new Error("Cloud desired state has changed.");
      for (const [id, bytes] of Object.entries(input.artifacts)) objects.set(id, bytes);
      current = { state: input.state, ledger: input.ledger };
      revisionId = `cloud-${objects.size}-${current.state.lockfile.skills.length}`;
      return { revisionId };
    },
    downloadArtifact: async (lock: { id: string }) => {
      const bytes = objects.get(lock.id);
      if (!bytes) throw new Error("artifact missing");
      return bytes;
    },
  };
}

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

test("Cloud-to-Git verifies an archive before one Git snapshot commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "corotum-v2-cloud-migration-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# adopted\n");
    const archive = await createArtifactArchive(source);
    const id = skillId("sk_artifact");
    const state: V2DesiredState = {
      manifest: { version: 2, skills: [{ id, name: "adopted", targets: "all", resolutionStatus: "RESOLVED" }] },
      lockfile: { version: 2, skills: [{ id, name: "adopted", materialization: { kind: "artifact", artifact: { kind: "r2-tar-zst", locator: `workspaces/ws_1/artifacts/${id}/${archive.integrityHash}.tar.zst`, ...archive } } }] },
    };
    let pushed = 0;
    const revision = await migrateV2CloudToGit({
      source: { state, ledger: { version: 2, activeDispositions: {} } },
      artifacts: { downloadArtifact: async () => archive.bytes },
      destination: {
        readArtifact: async () => { throw new Error("Cloud artifact should not read Git storage"); },
        pull: async () => ({ revisionId: "git-before", state, ledger: { version: 2, activeDispositions: {} } }),
        push: async (input) => {
          pushed++;
          expect(input.baseRevision).toBe("git-before");
          expect(await readFile(join(input.artifacts[id], "SKILL.md"), "utf8")).toBe("# adopted\n");
          expect(input.state.lockfile.skills[0]?.materialization).toMatchObject({ kind: "artifact", artifact: { kind: "git-tree", contentHash: archive.contentHash } });
          return { revisionId: "git-after" };
        },
      },
    });
    expect(revision).toBe("git-after");
    expect(pushed).toBe(1);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("v2 migration merge unions independent records and rejects identity or tombstone collisions", () => {
  const sourceId = skillId("sk_source");
  const destinationId = skillId("sk_destination");
  const source = { state: { manifest: { version: 2 as const, skills: [{ id: sourceId, name: "source", targets: "all" as const, resolutionStatus: "PENDING_RESOLUTION" as const }] }, lockfile: { version: 2 as const, skills: [] } }, ledger: { version: 2 as const, activeDispositions: {} } };
  const destination = { state: { manifest: { version: 2 as const, skills: [{ id: destinationId, name: "destination", targets: "all" as const, resolutionStatus: "PENDING_RESOLUTION" as const }] }, lockfile: { version: 2 as const, skills: [] } }, ledger: { version: 2 as const, activeDispositions: {} } };
  const merged = mergeV2MigrationSnapshots(source, destination);
  expect(merged).toMatchObject({ kind: "merged", state: { manifest: { skills: [{ id: destinationId }, { id: sourceId }] } } });
  expect(mergeV2MigrationSnapshots(source, { ...destination, state: { ...destination.state, manifest: { version: 2, skills: [{ ...destination.state.manifest.skills[0]!, id: skillId("sk_other"), name: "SOURCE" }] } } })).toEqual({ kind: "conflict", skills: ["source"] });
  expect(mergeV2MigrationSnapshots(source, { ...destination, ledger: { version: 2, activeDispositions: { [sourceId]: { skillId: sourceId, name: "source", disposition: "REMOVE", effectiveSequence: 1 } } } })).toEqual({ kind: "conflict", skills: ["source"] });
  const gitLock = { id: skillId("sk_gitkeep"), name: "gitkeep", materialization: { kind: "artifact" as const, artifact: { kind: "git-tree" as const, locator: "artifacts/gitkeep", contentHash: hash, integrityHash: hash, sizeBytes: 1 } } };
  const r2Lock = { id: skillId("sk_r2keep"), name: "r2keep", materialization: { kind: "artifact" as const, artifact: { kind: "r2-tar-zst" as const, locator: "r2/r2keep", contentHash: hash, integrityHash: hash, sizeBytes: 1 } } };
  const descriptors = mergeV2MigrationSnapshots(
    { state: { manifest: { version: 2, skills: [{ id: gitLock.id, name: "gitkeep", targets: "all", resolutionStatus: "RESOLVED" }] }, lockfile: { version: 2, skills: [gitLock] } }, ledger: emptyLedger() },
    { state: { manifest: { version: 2, skills: [{ id: r2Lock.id, name: "r2keep", targets: "all", resolutionStatus: "RESOLVED" }] }, lockfile: { version: 2, skills: [r2Lock] } }, ledger: emptyLedger() },
  );
  expect(descriptors).toMatchObject({ kind: "merged", state: { lockfile: { skills: [gitLock, r2Lock] } } });
});

test("Cloud-to-Git leaves Git untouched when an artifact is missing or corrupt", async () => {
  const root = await mkdtemp(join(tmpdir(), "corotum-v2-cloud-migration-failure-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# adopted\n");
    const archive = await createArtifactArchive(source);
    const id = skillId("sk_artifact");
    const artifact = { kind: "r2-tar-zst" as const, locator: "artifact", contentHash: archive.contentHash, integrityHash: archive.integrityHash, sizeBytes: archive.sizeBytes };
    const state: V2DesiredState = {
      manifest: { version: 2, skills: [{ id, name: "adopted", targets: "all", resolutionStatus: "RESOLVED" }] },
      lockfile: { version: 2, skills: [{ id, name: "adopted", materialization: { kind: "artifact", artifact } }] },
    };
    const corruptState: V2DesiredState = {
      ...state,
      lockfile: { version: 2, skills: [{ id, name: "adopted", materialization: { kind: "artifact", artifact: { ...artifact, integrityHash: `sha256:${"0".repeat(64)}` } } }] },
    };
    for (const input of [
      { state, downloadArtifact: async () => { throw new Error("artifact missing"); } },
      { state: corruptState, downloadArtifact: async () => archive.bytes },
    ]) {
      let pushed = 0;
      await expect(migrateV2CloudToGit({
        source: { state: input.state, ledger: emptyLedger() },
        artifacts: { downloadArtifact: input.downloadArtifact },
        destination: {
          readArtifact: async () => archive,
          pull: async () => ({ revisionId: "git-before", state: input.state, ledger: emptyLedger() }),
          push: async () => { pushed++; return { revisionId: "git-after" }; },
        },
      })).rejects.toThrow();
      expect(pushed).toBe(0);
    }
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Cloud-to-Git writes a fake-R2 archive to one real local-Git snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "corotum-v2-migration-git-r2-"));
  try {
    const remote = join(root, "remote.git");
    const worktree = join(root, "worktree");
    const artifactDirectory = join(root, "artifact");
    const git = async (...args: string[]) => {
      const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (exitCode !== 0) throw new Error(stderr);
      return stdout.trim();
    };
    await git("init", "--initial-branch=main", worktree);
    await git("-C", worktree, "config", "user.email", "tests@corotum.invalid");
    await git("-C", worktree, "config", "user.name", "Corotum tests");
    await git("-C", worktree, "commit", "--allow-empty", "-m", "initial");
    await git("init", "--bare", remote);
    await git("-C", worktree, "remote", "add", "origin", remote);
    await git("-C", worktree, "push", "-u", "origin", "main");
    await git("--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
    const provider = new V2GitStateProvider(join(root, "cache"), remote, undefined, async () => undefined);
    const initialRevision = await git("-C", worktree, "rev-parse", "HEAD");
    const seed: V2DesiredState = { manifest: { version: 2, skills: [] }, lockfile: { version: 2, skills: [] } };
    await provider.push({ state: seed, ledger: { version: 2, activeDispositions: {} }, baseRevision: initialRevision });
    const before = await provider.pull();
    await mkdir(artifactDirectory);
    await writeFile(join(artifactDirectory, "SKILL.md"), "# fake R2 artifact\n");
    const archive = await createArtifactArchive(artifactDirectory);
    const id = skillId("sk_faker2");
    const cloudState: V2DesiredState = {
      manifest: { version: 2, skills: [{ id, name: "fake-r2", targets: "all", resolutionStatus: "RESOLVED" }] },
      lockfile: { version: 2, skills: [{ id, name: "fake-r2", materialization: { kind: "artifact", artifact: { kind: "r2-tar-zst", locator: "r2/fake-r2", contentHash: archive.contentHash, integrityHash: archive.integrityHash, sizeBytes: archive.sizeBytes } } }] },
    };
    let downloads = 0;
    await migrateV2CloudToGit({
      source: { state: cloudState, ledger: { version: 2, activeDispositions: {} } },
      artifacts: { downloadArtifact: async () => { downloads++; return archive.bytes; } },
      destination: provider,
    });
    const after = await provider.pull();
    expect(downloads).toBe(1);
    expect(after.revisionId).not.toBe(before.revisionId);
    expect(after.state.manifest).toEqual(cloudState.manifest);
    expect(after.state.lockfile.skills[0]?.materialization).toMatchObject({ kind: "artifact", artifact: { kind: "git-tree", contentHash: archive.contentHash } });
    const restored = await provider.readArtifact(after.state.lockfile.skills[0]!);
    expect(restored.contentHash).toBe(archive.contentHash);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Cloud-to-Git reconstructs a retained Git tree without downloading it", async () => {
  const root = await mkdtemp(join(tmpdir(), "corotum-v2-retained-git-tree-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# retained\n");
    const archive = await createArtifactArchive(source);
    const treeHash = await gitTreeHash(source);
    const id = skillId("sk_retained");
    const state: V2DesiredState = {
      manifest: { version: 2, skills: [{ id, name: "retained", targets: "all", resolutionStatus: "RESOLVED" }] },
      lockfile: { version: 2, skills: [{ id, name: "retained", materialization: { kind: "artifact", artifact: { kind: "git-tree", locator: "artifacts/retained", ...archive, integrityHash: treeHash } } }] },
    };
    let downloads = 0;
    await migrateV2CloudToGit({
      source: { state, ledger: { version: 2, activeDispositions: {} } },
      artifacts: { downloadArtifact: async () => { downloads++; return archive.bytes; } },
      destination: {
        readArtifact: async (lock) => { expect(lock.id).toBe(id); return archive; },
        pull: async () => ({ revisionId: "git-before", state, ledger: { version: 2, activeDispositions: {} } }),
        push: async (input) => { expect(input.artifacts[id]).toBeDefined(); return { revisionId: "git-after" }; },
      },
    });
    expect(downloads).toBe(0);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Git-to-Cloud uploads a real local-Git artifact to fake R2 and leaves source metadata in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "corotum-v2-git-to-cloud-"));
  try {
    const provider = await realGit(root);
    const artifactDirectory = join(root, "artifact");
    await mkdir(artifactDirectory);
    await writeFile(join(artifactDirectory, "SKILL.md"), "# git artifact\n");
    const contentHash = (await scanNormalizedContent(artifactDirectory)).contentHash;
    const integrityHash = await gitTreeHash(artifactDirectory);
    const artifactId = skillId("sk_gitart");
    const sourceId = skillId("sk_gitsrc");
    const source = { repository: "https://example.test/repo.git", path: "skill", ref: "main" };
    const ledger: DispositionLedger = { version: 2, activeDispositions: { [skillId("sk_removed")]: { skillId: skillId("sk_removed"), name: "removed", disposition: "REMOVE", effectiveSequence: 4 } } };
    const state: V2DesiredState = {
      manifest: { version: 2, skills: [
        { id: artifactId, name: "adopted", targets: "all", resolutionStatus: "RESOLVED" },
        { id: sourceId, name: "upstream", targets: ["codex"], source, resolutionStatus: "RESOLVED" },
      ] },
      lockfile: { version: 2, skills: [
        { id: artifactId, name: "adopted", materialization: { kind: "artifact", artifact: { kind: "git-tree", locator: `artifacts/${artifactId}/${integrityHash.slice(7)}`, contentHash, integrityHash, sizeBytes: 1 } } },
        { id: sourceId, name: "upstream", source: { ...source, revision: "a".repeat(40), contentHash: hash }, materialization: { kind: "source", contentHash: hash } },
      ] },
    };
    const seeded = await provider.push({ state, ledger, baseRevision: (await provider.pull()).revisionId, artifacts: { [artifactId]: artifactDirectory } });
    const cloud = fakeCloud();
    const revision = await migrateV2GitToCloud({ source: seeded, artifacts: provider, destination: cloud, workspaceId: "ws_1" });
    expect(revision).toBe(cloud.snapshot().revisionId);
    expect(cloud.objects.has(artifactId)).toBe(true);
    expect(cloud.objects.has(sourceId)).toBe(false);
    expect(cloud.snapshot().ledger).toEqual(ledger);
    expect(cloud.snapshot().state.manifest).toEqual(state.manifest);
    expect(cloud.snapshot().state.lockfile.skills.find((lock) => lock.id === sourceId)).toEqual(state.lockfile.skills[1]);
    const uploaded = cloud.snapshot().state.lockfile.skills.find((lock) => lock.id === artifactId)?.materialization;
    expect(uploaded).toMatchObject({ kind: "artifact", artifact: { kind: "r2-tar-zst", contentHash } });
    if (uploaded?.kind !== "artifact") throw new Error("expected artifact lock");
    expect(uploaded.artifact.locator).toBe(`workspaces/ws_1/artifacts/${artifactId}/${uploaded.artifact.integrityHash}.tar.zst`);
    expect((await provider.pull()).revisionId).toBe(seeded.revisionId);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Git-to-Cloud leaves Git intact when Cloud transfer fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "corotum-v2-git-to-cloud-fail-"));
  try {
    const provider = await realGit(root);
    const artifactDirectory = join(root, "artifact");
    await mkdir(artifactDirectory);
    await writeFile(join(artifactDirectory, "SKILL.md"), "# git artifact\n");
    const contentHash = (await scanNormalizedContent(artifactDirectory)).contentHash;
    const integrityHash = await gitTreeHash(artifactDirectory);
    const id = skillId("sk_gitfail");
    const state: V2DesiredState = {
      manifest: { version: 2, skills: [{ id, name: "adopted", targets: "all", resolutionStatus: "RESOLVED" }] },
      lockfile: { version: 2, skills: [{ id, name: "adopted", materialization: { kind: "artifact", artifact: { kind: "git-tree", locator: `artifacts/${id}/${integrityHash.slice(7)}`, contentHash, integrityHash, sizeBytes: 1 } } }] },
    };
    const seeded = await provider.push({ state, ledger: emptyLedger(), baseRevision: (await provider.pull()).revisionId, artifacts: { [id]: artifactDirectory } });
    await expect(migrateV2GitToCloud({
      source: seeded, artifacts: provider, workspaceId: "ws_1",
      destination: { pull: async () => ({ revisionId: null, state: emptyState(), ledger: emptyLedger() }), push: async () => { throw new Error("upload interrupted"); } },
    })).rejects.toThrow("upload interrupted");
    expect((await provider.pull()).revisionId).toBe(seeded.revisionId);
    expect((await provider.pull()).state).toEqual(seeded.state);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Cloud-to-Git leaves Git intact when the snapshot commit is interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "corotum-v2-cloud-to-git-fail-"));
  try {
    const provider = await realGit(root);
    const before = await provider.pull();
    const source = join(root, "artifact");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# cloud artifact\n");
    const archive = await createArtifactArchive(source);
    const id = skillId("sk_cloudint");
    const state: V2DesiredState = {
      manifest: { version: 2, skills: [{ id, name: "adopted", targets: "all", resolutionStatus: "RESOLVED" }] },
      lockfile: { version: 2, skills: [{ id, name: "adopted", materialization: { kind: "artifact", artifact: { kind: "r2-tar-zst", locator: "r2/adopted", ...archive } } }] },
    };
    await expect(migrateV2CloudToGit({
      source: { state, ledger: emptyLedger() },
      artifacts: { downloadArtifact: async () => archive.bytes },
      destination: {
        readArtifact: (lock) => provider.readArtifact(lock),
        pull: () => provider.pull(),
        push: async () => { throw new Error("commit interrupted"); },
      },
    })).rejects.toThrow("commit interrupted");
    expect((await provider.pull()).revisionId).toBe(before.revisionId);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("Git-to-Cloud-to-Git and Cloud-to-Git-to-Cloud preserve logical desired state", async () => {
  const root = await mkdtemp(join(tmpdir(), "corotum-v2-roundtrip-"));
  try {
    const gitA = await realGit(join(root, "git-a"));
    const artifactDirectory = join(root, "artifact");
    await mkdir(artifactDirectory);
    await writeFile(join(artifactDirectory, "SKILL.md"), "# roundtrip\n");
    const contentHash = (await scanNormalizedContent(artifactDirectory)).contentHash;
    const integrityHash = await gitTreeHash(artifactDirectory);
    const artifactId = skillId("sk_roundart");
    const sourceId = skillId("sk_roundsrc");
    const source = { repository: "https://example.test/repo.git", path: "skill", ref: "main" };
    const ledger: DispositionLedger = { version: 2, activeDispositions: { [skillId("sk_tomb")]: { skillId: skillId("sk_tomb"), name: "gone", disposition: "UNMANAGE", effectiveSequence: 9 } } };
    const state: V2DesiredState = {
      manifest: { version: 2, skills: [
        { id: artifactId, name: "adopted", targets: ["pi"], resolutionStatus: "RESOLVED" },
        { id: sourceId, name: "upstream", targets: "all", source, resolutionStatus: "RESOLVED" },
      ] },
      lockfile: { version: 2, skills: [
        { id: artifactId, name: "adopted", materialization: { kind: "artifact", artifact: { kind: "git-tree", locator: `artifacts/${artifactId}/${integrityHash.slice(7)}`, contentHash, integrityHash, sizeBytes: 1 } } },
        { id: sourceId, name: "upstream", source: { ...source, revision: "b".repeat(40), contentHash: hash }, materialization: { kind: "source", contentHash: hash } },
      ] },
    };
    const seeded = await gitA.push({ state, ledger, baseRevision: (await gitA.pull()).revisionId, artifacts: { [artifactId]: artifactDirectory } });
    const cloud = fakeCloud();
    await migrateV2GitToCloud({ source: seeded, artifacts: gitA, destination: cloud, workspaceId: "ws_rt" });
    const gitB = await realGit(join(root, "git-b"));
    await migrateV2CloudToGit({ source: cloud.snapshot(), artifacts: cloud, destination: gitB });
    const backOnGit = await gitB.pull();
    expect(backOnGit.state.manifest).toEqual(state.manifest);
    expect(backOnGit.ledger).toEqual(ledger);
    expect(backOnGit.state.lockfile.skills.find((lock) => lock.id === sourceId)).toEqual(state.lockfile.skills[1]);
    expect(backOnGit.state.lockfile.skills.find((lock) => lock.id === artifactId)?.materialization).toMatchObject({ kind: "artifact", artifact: { kind: "git-tree", contentHash } });
    const cloudB = fakeCloud();
    await migrateV2GitToCloud({ source: backOnGit, artifacts: gitB, destination: cloudB, workspaceId: "ws_rt" });
    expect(cloudB.snapshot().state.manifest).toEqual(cloud.snapshot().state.manifest);
    expect(cloudB.snapshot().ledger).toEqual(ledger);
    expect(cloudB.snapshot().state.lockfile.skills.find((lock) => lock.id === sourceId)).toEqual(state.lockfile.skills[1]);
    expect(cloudB.snapshot().state.lockfile.skills.find((lock) => lock.id === artifactId)?.materialization).toMatchObject({ kind: "artifact", artifact: { kind: "r2-tar-zst", contentHash } });
    expect(cloudB.objects.has(artifactId)).toBe(true);
    expect(cloudB.objects.has(sourceId)).toBe(false);
  } finally { await rm(root, { force: true, recursive: true }); }
});
