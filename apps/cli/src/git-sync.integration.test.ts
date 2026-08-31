import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type DesiredState,
  planReconcile,
  revisionId,
  skillId,
  type LockedSkill,
} from "../../../packages/core/src/index";
import { GitStateProvider } from "../../../packages/git-provider/src/index";
import {
  GitSkillMaterializer,
  type GitCommandRunner,
} from "../../../packages/skills-adapter/src/git-source";
import { CanonicalSkillStore, hashSkillDirectory } from "../../../packages/skills-adapter/src/canonical-store";
import { LocalOperationalStateStore, type LocalOperationalState } from "./local-state";
import { LocalReconcileExecutor } from "./reconcile-executor";
import { RestoreService } from "./restore";
import { SyncService } from "./sync";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function git(args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "corotum-two-home-"));
  roots.push(root);
  const source = join(root, "source");
  const remote = join(root, "state.git");
  const stateWorktree = join(root, "state-worktree");
  await git(["init", "--initial-branch=main", source]);
  await git(["-C", source, "config", "user.email", "tests@corotum.invalid"]);
  await git(["-C", source, "config", "user.name", "Corotum tests"]);
  for (const [name, contents] of [["adopted", "adopted exact bytes\n"], ["added", "added exact bytes\n"]] as const) {
    await mkdir(join(source, "skills", name), { recursive: true });
    await writeFile(join(source, "skills", name, "SKILL.md"), contents);
  }
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "skills"]);

  await git(["init", "--initial-branch=main", stateWorktree]);
  await git(["-C", stateWorktree, "config", "user.email", "tests@corotum.invalid"]);
  await git(["-C", stateWorktree, "config", "user.name", "Corotum tests"]);
  await git(["-C", stateWorktree, "commit", "--allow-empty", "-m", "initial"]);
  await git(["init", "--bare", remote]);
  await git(["-C", stateWorktree, "remote", "add", "origin", remote]);
  await git(["-C", stateWorktree, "push", "-u", "origin", "main"]);
  await git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return { root, source, remote, stateWorktree };
}

function desired(locks: readonly LockedSkill[]): DesiredState {
  return {
    manifest: {
      version: 1,
      skills: locks.map((lock) => ({
        id: lock.id,
        source: lock.source,
        skill: lock.skill,
        ref: lock.ref,
        targets: "all" as const,
        resolutionStatus: "RESOLVED" as const,
      })),
    },
    lockfile: { version: 1, skills: locks },
  };
}

function emptyState(): LocalOperationalState {
  return { schemaVersion: 1, lastAppliedRevision: null, skills: {} };
}

async function lockFor(
  source: string,
  id: ReturnType<typeof skillId>,
  name: string,
): Promise<LockedSkill> {
  const resolved = await new GitSkillMaterializer().resolve({
    id,
    source,
    skill: name,
    ref: "main",
    path: `skills/${name}`,
  });
  return { id, source, skill: name, ref: "main", ...resolved };
}

describe("Git Sync two-home safety", () => {
  test("adopts and adds on one home, then installs identical locked bytes on another", async () => {
    const { root, source, remote, stateWorktree } = await fixture();
    const adopted = await lockFor(source, skillId("sk_adopted"), "adopted");
    const added = await lockFor(source, skillId("sk_added"), "added");
    const machineA = new GitStateProvider(join(root, "home-a", "git"), remote);
    const base = revisionId((await git(["-C", stateWorktree, "rev-parse", "HEAD"])).trim());
    const adoption = await machineA.push(
      { state: desired([adopted]), baseRevision: base },
      { type: "ADOPT", skillId: adopted.id, metadata: {} },
    );
    expect(adoption).toMatchObject({ kind: "success" });
    if (adoption.kind !== "success") throw new Error("adoption fixture failed");
    const addition = await machineA.push(
      { state: desired([adopted, added]), baseRevision: adoption.value.revisionId },
      { type: "ADD", skillId: added.id, metadata: {} },
    );
    expect(addition).toMatchObject({ kind: "success" });

    const homeB = join(root, "home-b");
    const executor = new LocalReconcileExecutor(
      new LocalOperationalStateStore(join(homeB, "state", "state.json")),
      new CanonicalSkillStore(join(homeB, "skills")),
    );
    const synced = await new SyncService(
      new GitStateProvider(join(homeB, "git"), remote),
      executor,
    ).sync({ execution: { state: emptyState(), enabledAgentIds: [], homeDir: homeB } });

    expect(synced).toMatchObject({ kind: "synced" });
    for (const lock of [adopted, added]) {
      expect(await hashSkillDirectory(join(homeB, "skills", lock.id))).toBe(lock.contentHash);
      expect(await readFile(join(homeB, "skills", lock.id, "SKILL.md"), "utf8")).toBe(
        await readFile(join(source, lock.path, "SKILL.md"), "utf8"),
      );
    }
  });

  test("keeps drift until explicit restore and never overwrites an unmanaged target", async () => {
    const { root, source } = await fixture();
    const lock = await lockFor(source, skillId("sk_drift"), "adopted");
    const home = join(root, "home");
    const store = new CanonicalSkillStore(join(home, "skills"));
    await mkdir(join(home, ".codex", "skills", lock.skill), { recursive: true });
    await writeFile(join(home, ".codex", "skills", lock.skill, "SKILL.md"), "unmanaged bytes\n");
    const executor = new LocalReconcileExecutor(
      new LocalOperationalStateStore(join(home, "state", "state.json")),
      store,
    );
    const installed = await executor.execute({
      plan: planReconcile(desired([lock]), { skills: {} }),
      desired: desired([lock]),
      revision: revisionId("one"),
      state: emptyState(),
      enabledAgentIds: ["codex"],
      homeDir: home,
    });
    expect(installed.operations[0]).toMatchObject({
      status: "SUCCESS",
      targetOutcomes: [expect.objectContaining({ status: "PRESERVED_UNMANAGED" })],
    });
    expect(await readFile(join(home, ".codex", "skills", lock.skill, "SKILL.md"), "utf8")).toBe("unmanaged bytes\n");

    await store.replaceFromDirectory(lock.id, join(source, lock.path), lock.contentHash);
    await writeFile(join(home, "skills", lock.id, "SKILL.md"), "drifted bytes\n");
    const driftedState: LocalOperationalState = {
      schemaVersion: 1,
      lastAppliedRevision: revisionId("one"),
      skills: {
        [lock.id]: { canonicalPath: store.pathFor(lock.id), contentHash: lock.contentHash, targets: {} },
      },
    };
    expect(planReconcile(desired([lock]), {
      skills: { [lock.id]: { contentHash: await hashSkillDirectory(store.pathFor(lock.id)), managed: true } },
    }).classifications).toContainEqual({ skillId: lock.id, classification: "DRIFTED" });

    const restored = await new RestoreService(
      { pull: async () => ({ kind: "success", value: { revisionId: revisionId("one"), state: desired([lock]) } }) },
      executor,
    ).restore({ all: true, execution: { state: driftedState, enabledAgentIds: [], homeDir: home } });
    expect(restored).toMatchObject({ kind: "restored" });
    expect(await hashSkillDirectory(store.pathFor(lock.id))).toBe(lock.contentHash);
  });

  test("preserves REMOVE, UNMANAGE, and re-add dispositions for offline homes", async () => {
    const { source } = await fixture();
    const lock = await lockFor(source, skillId("sk_offline"), "adopted");
    const actual = { skills: { [lock.id]: { contentHash: lock.contentHash, managed: true } } };
    const absent: DesiredState = { manifest: { version: 1, skills: [] }, lockfile: { version: 1, skills: [] } };

    expect(planReconcile(absent, actual, [{ type: "REMOVE", skillId: lock.id, metadata: {} }]).operations).toEqual([
      { kind: "REMOVE", skillId: lock.id },
    ]);
    expect(planReconcile(absent, actual, [{ type: "UNMANAGE", skillId: lock.id, metadata: {} }]).operations).toEqual([
      { kind: "UNMANAGE", skillId: lock.id },
    ]);
    expect(planReconcile(desired([lock]), actual, [{ type: "UNMANAGE", skillId: lock.id, metadata: {} }]).operations).toEqual([]);
  });

  test("reports private Git authentication without persisting credentials or state", async () => {
    const root = await mkdtemp(join(tmpdir(), "corotum-auth-required-"));
    roots.push(root);
    const runner: GitCommandRunner = async ({ args }) =>
      args[0] === "--version"
        ? { exitCode: 0, stderr: "", stdout: new TextEncoder().encode("git version") }
        : { exitCode: 128, stderr: "Permission denied (publickey).", stdout: new Uint8Array() };
    const storage = join(root, "cache");
    const result = await new GitStateProvider(storage, "git@private.example:owner/skills.git", runner).pull();
    expect(result).toEqual(expect.objectContaining({ kind: "failure", error: expect.objectContaining({ code: "AUTH_REQUIRED" }) }));
    await expect(readFile(storage, "utf8")).rejects.toThrow();
  });
});
