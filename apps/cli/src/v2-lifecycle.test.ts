import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type DispositionLedger,
  planV2Reconcile,
  skillId,
  type V2DesiredState,
} from "../../../packages/core/src/index";
import { createArtifactArchive } from "../../../packages/skills-adapter/src/artifact-archive";
import { CanonicalSkillStore, hashSkillDirectory } from "../../../packages/skills-adapter/src/canonical-store";
import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import { LocalOperationalStateStore } from "./local-state";
import { V2LocalApplier } from "./v2-local-applier";
import { LifecycleRecoveryStore, V2LifecycleService } from "./v2-lifecycle";
import type { V2MutationProvider } from "./v2-mutations";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "corotum-v2-lifecycle-"));
  directories.push(path);
  return path;
}

function sourceKey(source: string): string {
  return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}

const repository = "https://example.test/team/state.git";
const emptyLedger: DispositionLedger = { version: 2, activeDispositions: {} };

function memoryProvider(state: V2DesiredState, ledger: DispositionLedger = emptyLedger): V2MutationProvider & {
  snapshot: () => { revisionId: string; state: V2DesiredState; ledger: DispositionLedger };
  failNextPush: (error: Error) => void;
} {
  let current = { revisionId: "rev-1", state, ledger };
  let nextPushError: Error | undefined;
  let pushes = 1;
  return {
    snapshot: () => current,
    failNextPush: (error) => {
      nextPushError = error;
    },
    pull: async () => current,
    push: async (input) => {
      if (nextPushError) {
        const error = nextPushError;
        nextPushError = undefined;
        throw error;
      }
      pushes += 1;
      current = { revisionId: `rev-${pushes}`, state: input.state, ledger: input.ledger };
      return current;
    },
  };
}

async function seedArtifact(path: string, name: string, body: string) {
  const input = join(path, `artifact-${name}`);
  await mkdir(input);
  await writeFile(join(input, "SKILL.md"), body);
  const archive = await createArtifactArchive(input);
  const id = skillId(`sk_${name}`);
  const locator = `artifacts/${id}/${archive.integrityHash.slice(7)}`;
  const storage = join(path, "storage", sourceKey(repository), locator);
  await mkdir(dirname(storage), { recursive: true });
  await Bun.write(storage, archive.bytes);
  const desired: V2DesiredState = {
    manifest: { version: 2, skills: [{ id, name, targets: ["codex"], resolutionStatus: "RESOLVED" }] },
    lockfile: {
      version: 2,
      skills: [{
        id,
        name,
        materialization: {
          kind: "artifact",
          artifact: { kind: "git-tree", locator, contentHash: archive.contentHash, integrityHash: archive.integrityHash, sizeBytes: archive.sizeBytes },
        },
      }],
    },
  };
  return { id, desired, archive, contentHash: archive.contentHash };
}

function harness(path: string) {
  const state = new LocalOperationalStateStore(join(path, "state.json"));
  const recovery = new LifecycleRecoveryStore(join(path, "lifecycle.json"));
  const applier = new V2LocalApplier(state, new CanonicalSkillStore(join(path, "canonical")), {
    storagePath: join(path, "storage"),
    repository,
    enabledAgentIds: ["codex"],
    homeDir: join(path, "home"),
  });
  return { state, recovery, applier };
}

async function install(path: string, name: string, body = "# Managed\n") {
  const seeded = await seedArtifact(path, name, body);
  const local = harness(path);
  await local.applier.apply({ state: seeded.desired, revisionId: "rev-1", skillIds: [seeded.id] });
  return { ...seeded, ...local };
}

describe("v2 remove/unmanage/restore lifecycle", () => {
  test("remove writes REMOVE then deletes only hash-verified ownership", async () => {
    const path = await root();
    const { id, desired, applier, state, recovery, contentHash } = await install(path, "review");
    const provider = memoryProvider(desired);
    const service = new V2LifecycleService(provider, applier, state, recovery);
    const target = join(path, "home", ".codex", "skills", "review");
    expect((await lstat(target)).isSymbolicLink()).toBe(true);

    expect(await service.remove("review")).toMatchObject({ kind: "success", operation: "REMOVE", revision: "rev-2" });
    expect(provider.snapshot().ledger.activeDispositions[id]).toMatchObject({ disposition: "REMOVE", name: "review" });
    expect(provider.snapshot().state.manifest.skills).toEqual([]);
    expect(await lstat(join(path, "canonical", "review")).catch(() => null)).toBeNull();
    expect(await lstat(target).catch(() => null)).toBeNull();
    expect(await recovery.load()).toBeNull();
    expect(await state.load()).toMatchObject({ lastAppliedRevision: "rev-2", skills: {} });
    expect(contentHash.startsWith("sha256:")).toBe(true);
  });

  test("remove leaves an unmanaged same-name directory unchanged", async () => {
    const path = await root();
    const { id, desired, applier, state, recovery } = await install(path, "review");
    const target = join(path, "home", ".codex", "skills", "review");
    await rm(target, { force: true, recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "# Unmanaged\n");
    const before = await readFile(join(target, "SKILL.md"), "utf8");
    const service = new V2LifecycleService(memoryProvider(desired), applier, state, recovery);

    expect(await service.remove(id)).toMatchObject({ kind: "local-conflict" });
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe(before);
    expect(await readFile(join(path, "canonical", "review", "SKILL.md"), "utf8")).toBe("# Managed\n");
    expect((await state.load())?.skills[id]).toBeDefined();
  });

  test("unmanage writes UNMANAGE and converts a verified symlink to a copy", async () => {
    const path = await root();
    const { id, desired, applier, state, recovery } = await install(path, "review");
    const target = join(path, "home", ".codex", "skills", "review");
    const service = new V2LifecycleService(memoryProvider(desired), applier, state, recovery);

    expect(await service.unmanage("review")).toMatchObject({ kind: "success", operation: "UNMANAGE" });
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("# Managed\n");
    expect(await readFile(join(path, "canonical", "review", "SKILL.md"), "utf8")).toBe("# Managed\n");
    expect((await state.load())?.skills[id]).toBeUndefined();
  });

  test("unmanage preserves an existing copy-fallback target", async () => {
    const path = await root();
    const { id, desired, applier, state, recovery } = await install(path, "review");
    const target = join(path, "home", ".codex", "skills", "review");
    await rm(target, { force: true, recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "# Managed\n");
    const expectedHash = await hashSkillDirectory(target);
    const saved = await state.load();
    const skill = saved!.skills[id]!;
    const key = Object.keys(skill.targets)[0]!;
    await state.save({
      ...saved!,
      skills: {
        [id]: {
          ...skill,
          targets: { [key]: { ...skill.targets[key]!, mode: "copy", expectedHash } },
        },
      },
    });
    const service = new V2LifecycleService(memoryProvider(desired), applier, state, recovery);
    expect(await service.unmanage(id)).toMatchObject({ kind: "success" });
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("# Managed\n");
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
  });

  test("restore repairs a missing recorded target from the exact lock and refuses drift", async () => {
    const path = await root();
    const { id, desired, applier, state, recovery } = await install(path, "review");
    const target = join(path, "home", ".codex", "skills", "review");
    await rm(target, { force: true, recursive: true });
    const provider = memoryProvider(desired);
    const service = new V2LifecycleService(provider, applier, state, recovery);

    expect(await service.restore("review")).toMatchObject({ kind: "success", operation: "RESTORE" });
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(path, "canonical", "review", "SKILL.md"), "utf8")).toBe("# Managed\n");
    expect(provider.snapshot().state.manifest.skills).toHaveLength(1);

    await rm(target, { force: true, recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "# Drifted target\n");
    expect(await service.restore(id)).toMatchObject({ kind: "local-conflict" });
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("# Drifted target\n");
  });

  test("restore never overwrites an unmanaged target", async () => {
    const path = await root();
    const { id, desired, applier, state, recovery } = await install(path, "review");
    const saved = await state.load();
    await state.save({ ...saved!, skills: { [id]: { ...saved!.skills[id]!, targets: {} } } });
    const other = join(path, "home", ".codex", "skills", "review");
    await rm(other, { force: true, recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "SKILL.md"), "# Hands off\n");
    const service = new V2LifecycleService(memoryProvider(desired), applier, state, recovery);
    await service.restore(id);
    expect(await readFile(join(other, "SKILL.md"), "utf8")).toBe("# Hands off\n");
  });

  test("remove of drifted canonical content is refused before desired-state mutation", async () => {
    const path = await root();
    const { id, desired, applier, state, recovery } = await install(path, "review");
    await writeFile(join(path, "canonical", "review", "SKILL.md"), "# Drifted\n");
    const provider = memoryProvider(desired);
    const service = new V2LifecycleService(provider, applier, state, recovery);
    expect(await service.remove("review")).toMatchObject({ kind: "drifted" });
    expect(provider.snapshot().state.manifest.skills).toHaveLength(1);
    expect(provider.snapshot().ledger.activeDispositions[id]).toBeUndefined();
    expect(await readFile(join(path, "canonical", "review", "SKILL.md"), "utf8")).toBe("# Drifted\n");
    expect(await recovery.load()).toBeNull();
  });

  test("desired-state success then local failure leaves a recovery marker and no synced revision", async () => {
    const path = await root();
    const { id, desired, state, recovery } = await install(path, "review");
    const provider = memoryProvider(desired);
    const failing = {
      applyRemove: async () => {
        throw new Error("disk full");
      },
      applyUnmanage: async () => {
        throw new Error("unused");
      },
      applyRestore: async () => {
        throw new Error("unused");
      },
    };
    const service = new V2LifecycleService(provider, failing, state, recovery);
    expect(await service.remove(id)).toMatchObject({
      kind: "persisted-not-applied",
      revision: "rev-2",
      reason: "disk full",
    });
    expect(provider.snapshot().ledger.activeDispositions[id]?.disposition).toBe("REMOVE");
    expect(await recovery.load()).toMatchObject({ operation: "REMOVE", phase: "desired-persisted", revision: "rev-2" });
    expect((await state.load())?.lastAppliedRevision).toBe("rev-1");
    expect((await state.load())?.skills[id]).toBeDefined();
  });

  test("local success then operational-state failure is retried without a false synced status", async () => {
    const path = await root();
    const { id, desired, applier, recovery, state } = await install(path, "review");
    const provider = memoryProvider(desired);
    let saves = 0;
    const persist = state.save.bind(state);
    state.save = async (value) => {
      saves += 1;
      if (saves === 1) throw new Error("state write failed");
      return persist(value);
    };
    const service = new V2LifecycleService(provider, applier, state, recovery);
    expect(await service.remove(id)).toMatchObject({
      kind: "persisted-not-applied",
      reason: "state write failed",
    });
    expect((await state.load())?.lastAppliedRevision).toBe("rev-1");
    expect(await recovery.load()).toMatchObject({ phase: "locally-applied" });

    expect(await service.remove(id)).toMatchObject({ kind: "success", revision: "rev-2" });
    expect(await recovery.load()).toBeNull();
    expect((await state.load())?.lastAppliedRevision).toBe("rev-2");
    expect(await lstat(join(path, "canonical", "review")).catch(() => null)).toBeNull();
  });

  test("offline provider failure changes nothing", async () => {
    const path = await root();
    const { id, applier, state, recovery } = await install(path, "review");
    const service = new V2LifecycleService(
      {
        pull: async () => {
          throw new Error("network unreachable");
        },
        push: async () => {
          throw new Error("unused");
        },
      },
      applier,
      state,
      recovery,
    );
    expect(await service.remove(id)).toMatchObject({ kind: "refused", reason: "network unreachable" });
    expect((await state.load())?.skills[id]).toBeDefined();
    expect(await recovery.load()).toBeNull();
    expect(await readFile(join(path, "canonical", "review", "SKILL.md"), "utf8")).toBe("# Managed\n");
  });

  test("retries a desired-persisted remove without pushing again", async () => {
    const path = await root();
    const { id, desired, applier, state, recovery } = await install(path, "review");
    const provider = memoryProvider(desired);
    const failing = {
      applyRemove: async () => {
        throw new Error("disk full");
      },
      applyUnmanage: async () => {
        throw new Error("unused");
      },
      applyRestore: async () => {
        throw new Error("unused");
      },
    };
    expect(await new V2LifecycleService(provider, failing, state, recovery).remove(id)).toMatchObject({
      kind: "persisted-not-applied",
    });
    const pushed = provider.snapshot().revisionId;
    const service = new V2LifecycleService(provider, applier, state, recovery);
    expect(await service.remove("review")).toMatchObject({ kind: "success", revision: pushed });
    expect(provider.snapshot().revisionId).toBe(pushed);
  });

  test("re-add after unmanage with a modified copy is LOCAL_CONFLICT", async () => {
    const path = await root();
    const { id, desired, applier, state, recovery } = await install(path, "review");
    const provider = memoryProvider(desired);
    const lifecycle = new V2LifecycleService(provider, applier, state, recovery);
    expect(await lifecycle.unmanage(id)).toMatchObject({ kind: "success" });
    const target = join(path, "home", ".codex", "skills", "review");
    await writeFile(join(target, "SKILL.md"), "# Edited after unmanage\n");
    const readded = skillId("sk_readded");
    const lock = desired.lockfile.skills[0]!;
    const next: V2DesiredState = {
      manifest: { version: 2, skills: [{ id: readded, name: "review", targets: ["codex"], resolutionStatus: "RESOLVED" }] },
      lockfile: { version: 2, skills: [{ ...lock, id: readded }] },
    };
    await expect(applier.apply({ state: next, revisionId: "rev-3", skillIds: [readded] })).rejects.toThrow(
      /not verified Corotum-owned content|Unmanaged or ambiguous target/,
    );
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("# Edited after unmanage\n");
    const actualHash = (await scanNormalizedContent(target)).contentHash;
    expect(
      planV2Reconcile(
        next,
        { skills: { [readded]: { managed: false, contentHash: actualHash } } },
        provider.snapshot().ledger,
      ).classifications.some((entry) => entry.classification === "LOCAL_CONFLICT" || entry.classification === "DRIFTED"),
    ).toBe(true);
  });

  test("materializes restore from a real Git archive lock", async () => {
    const path = await root();
    const repositoryPath = join(path, "upstream");
    await git(["init", "--initial-branch=main", repositoryPath]);
    await git(["-C", repositoryPath, "config", "user.email", "tests@corotum.invalid"]);
    await git(["-C", repositoryPath, "config", "user.name", "Corotum tests"]);
    await mkdir(join(repositoryPath, "review"));
    await writeFile(join(repositoryPath, "review", "SKILL.md"), "# Pinned\n");
    await git(["-C", repositoryPath, "add", "."]);
    await git(["-C", repositoryPath, "commit", "-m", "pinned"]);
    const revision = (await git(["-C", repositoryPath, "rev-parse", "HEAD"])).trim();
    const contentHash = (await scanNormalizedContent(join(repositoryPath, "review"))).contentHash;
    await writeFile(join(repositoryPath, "review", "SKILL.md"), "# Moved HEAD\n");
    await git(["-C", repositoryPath, "commit", "-am", "moved"]);

    const id = skillId("sk_git");
    const desired: V2DesiredState = {
      manifest: { version: 2, skills: [{ id, name: "review", targets: ["codex"], resolutionStatus: "RESOLVED" }] },
      lockfile: {
        version: 2,
        skills: [{
          id,
          name: "review",
          source: { repository: repositoryPath, path: "review", ref: "main", revision, contentHash },
          materialization: { kind: "source", contentHash },
        }],
      },
    };
    const local = harness(path);
    await local.applier.apply({ state: desired, revisionId: "rev-1", skillIds: [id] });
    const target = join(path, "home", ".codex", "skills", "review");
    await rm(target, { force: true, recursive: true });
    const service = new V2LifecycleService(memoryProvider(desired), local.applier, local.state, local.recovery);
    expect(await service.restore(id)).toMatchObject({ kind: "success" });
    expect(await readFile(join(path, "canonical", "review", "SKILL.md"), "utf8")).toBe("# Pinned\n");
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
  });
});

async function git(args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}
