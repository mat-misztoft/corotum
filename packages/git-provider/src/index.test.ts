import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type DesiredState,
  revisionId,
  serializeLockfile,
  serializeManifest,
  skillId,
} from "../../core/src/index";
import { GitStateProvider, GitStorageMigrator } from "./index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function fixture(): Promise<
  Readonly<{ bare: string; worktree: string }>
> {
  const root = await mkdtemp(join(tmpdir(), "toolmirror-git-state-"));
  temporaryDirectories.push(root);
  const worktree = join(root, "worktree");
  const bare = join(root, "remote.git");
  await git(["init", "--initial-branch=main", worktree]);
  await git([
    "-C",
    worktree,
    "config",
    "user.email",
    "tests@toolmirror.invalid",
  ]);
  await git(["-C", worktree, "config", "user.name", "ToolMirror tests"]);
  await git(["-C", worktree, "commit", "--allow-empty", "-m", "initial"]);
  await git(["init", "--bare", bare]);
  await git(["-C", worktree, "remote", "add", "origin", bare]);
  await git(["-C", worktree, "push", "-u", "origin", "main"]);
  await git(["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return { bare, worktree };
}

function state(
  reverse = false,
  alphaRef = "main",
  betaRef = "v1",
): DesiredState {
  const skills = [
    {
      id: skillId("sk_gitA"),
      source: "https://github.com/example/skills.git",
      skill: "alpha",
      ref: alphaRef,
      targets: "all" as const,
      resolutionStatus: "RESOLVED" as const,
    },
    {
      id: skillId("sk_gitB"),
      source: "https://github.com/example/skills.git",
      skill: "beta",
      ref: betaRef,
      targets: ["codex", "pi"] as const,
      resolutionStatus: "RESOLVED" as const,
    },
  ];
  const locked = skills.map((skill, index) => ({
    id: skill.id,
    source: skill.source,
    skill: skill.skill,
    ref: skill.ref,
    repository: skill.source,
    revision: `abcdef${index}`,
    path: `skills/${skill.skill}`,
    contentHash: `sha256:${skill.skill}`,
  }));
  return {
    manifest: { version: 1, skills: reverse ? [...skills].reverse() : skills },
    lockfile: { version: 1, skills: reverse ? [...locked].reverse() : locked },
  };
}

async function git(args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

describe("GitStateProvider", () => {
  test("keeps an initial push pending until an empty remote accepts it", async () => {
    const root = await mkdtemp(join(tmpdir(), "toolmirror-git-bootstrap-"));
    temporaryDirectories.push(root);
    const bare = join(root, "remote.git");
    await git(["init", "--bare", bare]);
    const hook = join(bare, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    const provider = new GitStateProvider(join(root, "cache"), bare);
    expect(await provider.bootstrap(state())).toMatchObject({
      kind: "failure",
      error: { code: "CONFLICT" },
    });
    await rm(hook);
    expect(await provider.pull()).toMatchObject({
      kind: "success",
      value: { state: state() },
    });
  });

  test("stops before creating its cache when Git preflight fails", async () => {
    const source = await fixture();
    const storage = join(source.worktree, "toolmirror-cache");
    const provider = new GitStateProvider(storage, source.bare, async () => ({
      exitCode: 127,
      stderr: "git: command not found",
      stdout: new Uint8Array(),
    }));

    const result = await provider.push(
      { state: state(), baseRevision: null },
      { type: "ADD", skillId: skillId("sk_gitA"), metadata: {} },
    );

    expect(result).toEqual(expect.objectContaining({ kind: "failure" }));
    await expect(readFile(storage, "utf8")).rejects.toThrow();
  });

  test("commits canonical full snapshots with transition metadata in its own clone", async () => {
    const source = await fixture();
    const storage = join(source.worktree, "toolmirror-cache");
    const provider = new GitStateProvider(storage, source.bare);
    const before = revisionId(
      (await git(["-C", source.worktree, "rev-parse", "HEAD"])).trim(),
    );

    const result = await provider.push(
      { state: state(), baseRevision: before },
      {
        type: "ADD",
        skillId: skillId("sk_gitA"),
        metadata: { source: "test" },
      },
    );

    expect(result).toEqual(expect.objectContaining({ kind: "success" }));
    const cache = (await readdir(storage))[0];
    expect(cache).toBeString();
    const cachePath = join(storage, cache as string);
    expect(cachePath).not.toBe(source.worktree);
    expect(await readFile(join(cachePath, "toolmirror.yaml"), "utf8")).toBe(
      serializeManifest(state().manifest),
    );
    expect(await readFile(join(cachePath, "toolmirror.lock"), "utf8")).toBe(
      serializeLockfile(state().lockfile),
    );
    expect(
      await readFile(join(cachePath, "toolmirror.transition.json"), "utf8"),
    ).toContain('"type":"ADD"');
    await expect(
      readFile(join(source.worktree, "toolmirror.yaml"), "utf8"),
    ).rejects.toThrow();
  });

  test("writes byte-identical clone files for equivalent desired state", async () => {
    const source = await fixture();
    const provider = new GitStateProvider(
      join(source.worktree, "cache"),
      source.bare,
    );
    const base = revisionId(
      (await git(["-C", source.worktree, "rev-parse", "HEAD"])).trim(),
    );
    const transition = {
      type: "ADD" as const,
      skillId: skillId("sk_gitA"),
      metadata: {},
    };
    const first = await provider.push(
      { state: state(), baseRevision: base },
      transition,
    );
    if (first.kind !== "success") throw new Error("fixture mutation failed");
    const second = await provider.push(
      { state: state(true), baseRevision: first.value.revisionId },
      transition,
    );

    expect(second).toEqual(expect.objectContaining({ kind: "success" }));
    expect(second.kind === "success" && second.value.state).toEqual(state());
  });

  test("migrates an owned cache only after preserving history and desired state", async () => {
    const source = await fixture();
    const oldStorage = join(source.worktree, "old-cache");
    const newStorage = join(source.worktree, "new-cache");
    const provider = new GitStateProvider(oldStorage, source.bare);
    const base = revisionId(
      (await git(["-C", source.worktree, "rev-parse", "HEAD"])).trim(),
    );
    const pushed = await provider.push(
      { state: state(), baseRevision: base },
      { type: "ADD", skillId: skillId("sk_gitA"), metadata: {} },
    );
    if (pushed.kind !== "success") throw new Error("fixture mutation failed");
    const oldCache = join(oldStorage, (await readdir(oldStorage))[0] as string);
    const beforeHistory = await git(["-C", oldCache, "rev-list", "--all"]);
    const beforeManifest = await readFile(
      join(oldCache, "toolmirror.yaml"),
      "utf8",
    );
    let configuredStorage = oldStorage;

    await new GitStorageMigrator().migrate({
      from: oldStorage,
      to: newStorage,
      source: source.bare,
      persist: async () => {
        configuredStorage = newStorage;
      },
    });

    const newCache = join(newStorage, (await readdir(newStorage))[0] as string);
    expect(configuredStorage).toBe(newStorage);
    expect(await git(["-C", newCache, "rev-list", "--all"])).toBe(
      beforeHistory,
    );
    expect(await readFile(join(newCache, "toolmirror.yaml"), "utf8")).toBe(
      beforeManifest,
    );
    await expect(stat(oldStorage)).rejects.toThrow();
    await new GitStorageMigrator().migrate({
      from: newStorage,
      to: newStorage,
      source: source.bare,
      persist: async () => {
        throw new Error("same-path migration must not persist");
      },
    });
    expect(await readdir(newStorage)).toHaveLength(1);
  });

  test("leaves the current cache and configuration active when copying fails", async () => {
    const source = await fixture();
    const oldStorage = join(source.worktree, "old-cache");
    const newStorage = join(source.worktree, "new-cache");
    const provider = new GitStateProvider(oldStorage, source.bare);
    const base = revisionId(
      (await git(["-C", source.worktree, "rev-parse", "HEAD"])).trim(),
    );
    const pushed = await provider.push(
      { state: state(), baseRevision: base },
      { type: "ADD", skillId: skillId("sk_gitA"), metadata: {} },
    );
    if (pushed.kind !== "success") throw new Error("fixture mutation failed");
    let configuredStorage = oldStorage;

    await expect(
      new GitStorageMigrator(undefined, async () => {
        throw new Error("copy failed");
      }).migrate({
        from: oldStorage,
        to: newStorage,
        source: source.bare,
        persist: async () => {
          configuredStorage = newStorage;
        },
      }),
    ).rejects.toThrow("copy failed");

    expect(configuredStorage).toBe(oldStorage);
    expect(await readdir(oldStorage)).toHaveLength(1);
    await expect(stat(newStorage)).rejects.toThrow();
  });

  test("leaves the current cache and configuration active when verification fails", async () => {
    const source = await fixture();
    const oldStorage = join(source.worktree, "old-cache");
    const newStorage = join(source.worktree, "new-cache");
    const provider = new GitStateProvider(oldStorage, source.bare);
    const base = revisionId(
      (await git(["-C", source.worktree, "rev-parse", "HEAD"])).trim(),
    );
    const pushed = await provider.push(
      { state: state(), baseRevision: base },
      { type: "ADD", skillId: skillId("sk_gitA"), metadata: {} },
    );
    if (pushed.kind !== "success") throw new Error("fixture mutation failed");
    let configuredStorage = oldStorage;

    await expect(
      new GitStorageMigrator(undefined, async (from, to) => {
        await cp(from, to, { errorOnExist: true, recursive: true });
        const cache = (await readdir(to))[0] as string;
        await writeFile(join(to, cache, "toolmirror.lock"), "corrupt");
      }).migrate({
        from: oldStorage,
        to: newStorage,
        source: source.bare,
        persist: async () => {
          configuredStorage = newStorage;
        },
      }),
    ).rejects.toThrow("does not match");

    expect(configuredStorage).toBe(oldStorage);
    expect(await readdir(oldStorage)).toHaveLength(1);
    await expect(stat(newStorage)).rejects.toThrow();
  });

  test("persists PENDING_PUSH, blocks mutations, and retries it before sync", async () => {
    const source = await fixture();
    const storage = join(source.worktree, "cache");
    const first = new GitStateProvider(storage, source.bare);
    const base = revisionId(
      (await git(["-C", source.worktree, "rev-parse", "HEAD"])).trim(),
    );
    const initial = await first.push(
      { state: state(), baseRevision: base },
      { type: "ADD", skillId: skillId("sk_gitA"), metadata: {} },
    );
    if (initial.kind !== "success") throw new Error("fixture mutation failed");

    const hook = join(source.bare, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const pending = await first.push(
      {
        state: state(false, "pending"),
        baseRevision: initial.value.revisionId,
      },
      { type: "SET_REF", skillId: skillId("sk_gitA"), metadata: {} },
    );
    expect(pending).toEqual(
      expect.objectContaining({
        kind: "failure",
        error: expect.objectContaining({ code: "CONFLICT" }),
      }),
    );

    const restarted = new GitStateProvider(storage, source.bare);
    const blocked = await restarted.push(
      { state: state(false, "later"), baseRevision: initial.value.revisionId },
      { type: "SET_REF", skillId: skillId("sk_gitA"), metadata: {} },
    );
    expect(blocked).toEqual(
      expect.objectContaining({
        kind: "failure",
        error: expect.objectContaining({ code: "CONFLICT" }),
      }),
    );

    await rm(hook);
    const recovered = await restarted.pull();
    expect(recovered).toEqual(
      expect.objectContaining({
        kind: "success",
        value: expect.objectContaining({
          state: expect.objectContaining({
            manifest: expect.objectContaining({
              skills: expect.arrayContaining([
                expect.objectContaining({ ref: "pending" }),
              ]),
            }),
          }),
        }),
      }),
    );
  });

  test("replays independent pending changes and exposes same-skill choices", async () => {
    const source = await fixture();
    const storage = join(source.worktree, "cache-a");
    const base = revisionId(
      (await git(["-C", source.worktree, "rev-parse", "HEAD"])).trim(),
    );
    const local = new GitStateProvider(storage, source.bare);
    const initial = await local.push(
      { state: state(), baseRevision: base },
      { type: "ADD", skillId: skillId("sk_gitA"), metadata: {} },
    );
    if (initial.kind !== "success") throw new Error("fixture mutation failed");
    const hook = join(source.bare, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await local.push(
      { state: state(false, "local"), baseRevision: initial.value.revisionId },
      { type: "SET_REF", skillId: skillId("sk_gitA"), metadata: {} },
    );
    await rm(hook);
    const remote = new GitStateProvider(
      join(source.worktree, "cache-b"),
      source.bare,
    );
    const remoteChange = await remote.push(
      {
        state: state(false, "main", "remote"),
        baseRevision: initial.value.revisionId,
      },
      { type: "SET_REF", skillId: skillId("sk_gitB"), metadata: {} },
    );
    if (remoteChange.kind !== "success")
      throw new Error("remote mutation failed");

    const replayed = await local.pull();
    expect(replayed).toEqual(expect.objectContaining({ kind: "success" }));
    expect(
      replayed.kind === "success" && replayed.value.state.manifest.skills,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: skillId("sk_gitA"), ref: "local" }),
        expect.objectContaining({ id: skillId("sk_gitB"), ref: "remote" }),
      ]),
    );

    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await local.push(
      {
        state: state(false, "local-conflict", "remote"),
        baseRevision:
          replayed.kind === "success" ? replayed.value.revisionId : base,
      },
      { type: "SET_REF", skillId: skillId("sk_gitA"), metadata: {} },
    );
    await rm(hook);
    const currentRemote = await remote.pull();
    if (currentRemote.kind !== "success") throw new Error("remote pull failed");
    const remoteConflict = await remote.push(
      {
        state: state(false, "remote-conflict", "remote"),
        baseRevision: currentRemote.value.revisionId,
      },
      { type: "SET_REF", skillId: skillId("sk_gitA"), metadata: {} },
    );
    if (remoteConflict.kind !== "success")
      throw new Error("remote conflict failed");

    const conflict = await local.resolvePendingPush();
    expect(conflict).toEqual(
      expect.objectContaining({
        kind: "conflict",
        conflicts: [expect.objectContaining({ skillId: skillId("sk_gitA") })],
      }),
    );
    const keptRemote = await local.resolvePendingPush("keep-remote");
    expect(keptRemote).toEqual({ kind: "resolved" });
  });

  test("refuses incomplete Git state before committing", async () => {
    const source = await fixture();
    const provider = new GitStateProvider(
      join(source.worktree, "cache"),
      source.bare,
    );
    const base = revisionId(
      (await git(["-C", source.worktree, "rev-parse", "HEAD"])).trim(),
    );
    const incomplete = {
      ...state(),
      lockfile: { version: 1 as const, skills: [] },
    };

    const result = await provider.push(
      { state: incomplete, baseRevision: base },
      { type: "ADD", skillId: skillId("sk_gitA"), metadata: {} },
    );

    expect(result).toEqual(expect.objectContaining({ kind: "failure" }));
    expect(
      (
        await git(["-C", source.worktree, "rev-list", "--count", "HEAD"])
      ).trim(),
    ).toBe("1");
  });
});
