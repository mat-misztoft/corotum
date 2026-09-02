import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import { ExitCode } from "./cli-contracts";
import { resolvePlatformPaths } from "./platform";

const roots: string[] = [];
const cli = join(import.meta.dir, "index.ts");
const timeout = 60_000;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await Bun.spawn(["chmod", "-R", "u+rwx", root], {
        stderr: "pipe",
        stdout: "pipe",
      }).exited;
      await rm(root, { force: true, recursive: true });
    }),
  );
});

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}

async function temp(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `corotum-git-safety-${name}-`));
  roots.push(path);
  return path;
}

function platformEnv(home: string) {
  return {
    homeDir: home,
    platform: process.platform as "darwin" | "linux" | "win32",
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_RUNTIME_DIR: join(home, ".local", "runtime"),
    },
  };
}

function paths(home: string) {
  return resolvePlatformPaths(platformEnv(home));
}

function cliEnv(
  home: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const overlay = platformEnv(home).env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("XDG_")) env[key] = value;
  }
  return {
    ...env,
    ...overlay,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Corotum tests",
    GIT_AUTHOR_EMAIL: "tests@corotum.invalid",
    GIT_COMMITTER_NAME: "Corotum tests",
    GIT_COMMITTER_EMAIL: "tests@corotum.invalid",
    FORCE_COLOR: "0",
    ...extra,
  };
}

type CliResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
  json?: Record<string, unknown>;
}>;

async function run(
  home: string,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: join(import.meta.dir, "../../.."),
    env: cliEnv(home, extraEnv),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  let json: Record<string, unknown> | undefined;
  const line = stdout.trim().split("\n").at(-1);
  if (line?.startsWith("{")) json = JSON.parse(line) as Record<string, unknown>;
  return { code, stdout, stderr, json };
}

function errorText(result: CliResult): string {
  return String(result.json?.error ?? result.stderr);
}

function classifications(result: CliResult): readonly string[] {
  const items = result.json?.classifications as
    | readonly { classification?: string }[]
    | undefined;
  return (items ?? []).map((item) => String(item.classification));
}

async function writeSkill(directory: string, body: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), body);
}

function namedSkill(home: string, name: string): string {
  return join(home, ".agents", "skills", name);
}

async function stateRemote(root: string): Promise<string> {
  const worktree = join(root, "state-worktree");
  const bare = join(root, "state.git");
  await git(["init", "--initial-branch=main", worktree]);
  await git(["-C", worktree, "config", "user.email", "tests@corotum.invalid"]);
  await git(["-C", worktree, "config", "user.name", "Corotum tests"]);
  await git(["-C", worktree, "commit", "--allow-empty", "-m", "initial"]);
  await git(["init", "--bare", bare]);
  await git(["-C", worktree, "remote", "add", "origin", bare]);
  await git(["-C", worktree, "push", "-u", "origin", "main"]);
  await git(["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return bare;
}

async function skillRepo(
  root: string,
  name: string,
  body: string,
): Promise<{ repository: string; contentHash: string }> {
  const repository = join(root, `${name}.git`);
  await git(["init", "--initial-branch=main", repository]);
  await git(["-C", repository, "config", "user.email", "tests@corotum.invalid"]);
  await git(["-C", repository, "config", "user.name", "Corotum tests"]);
  await writeSkill(join(repository, "skills", name), body);
  await git(["-C", repository, "add", "."]);
  await git(["-C", repository, "commit", "-m", name]);
  return {
    repository,
    contentHash: (await scanNormalizedContent(join(repository, "skills", name)))
      .contentHash,
  };
}

async function writeFakeGit(bin: string, stderr: string): Promise<void> {
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "git version 2.45.0"
    exit 0
  fi
done
echo ${JSON.stringify(stderr)} >&2
exit 128
`,
    { mode: 0o755 },
  );
  await chmod(join(bin, "git"), 0o755);
}

async function denyPush(remote: string): Promise<void> {
  const hook = join(remote, "hooks", "pre-receive");
  await writeFile(hook, "#!/bin/sh\necho denied-by-hook >&2\nexit 1\n", {
    mode: 0o755,
  });
  await chmod(hook, 0o755);
}

async function allowPush(remote: string): Promise<void> {
  await rm(join(remote, "hooks", "pre-receive"), { force: true });
}

async function initGit(home: string, remote: string): Promise<CliResult> {
  return run(home, [
    "--json",
    "--non-interactive",
    "init",
    "repository",
    remote,
  ]);
}

async function addSkill(
  home: string,
  repository: string,
  skill: string,
): Promise<CliResult> {
  return run(home, [
    "--json",
    "--non-interactive",
    "add",
    repository,
    "--skill",
    skill,
    "--ref",
    "main",
  ]);
}

describe("Git Sync safety/recovery regression", () => {
  test(
    "sync installs the exact locked revision and never follows a later upstream HEAD",
    async () => {
      const root = await temp("lock");
      const remote = await stateRemote(root);
      const notes = await skillRepo(root, "notes", "# Notes locked\n");
      const homeA = join(root, "home-a");
      const homeB = join(root, "home-b");

      expect((await initGit(homeA, remote)).code).toBe(0);
      expect(JSON.parse(await readFile(paths(homeA).configFile, "utf8"))).toMatchObject({
        mode: "git",
        agents: {},
      });
      expect((await addSkill(homeA, notes.repository, "notes")).code).toBe(0);
      expect(await readFile(join(namedSkill(homeA, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes locked\n",
      );
      expect(
        (await scanNormalizedContent(namedSkill(homeA, "notes"))).contentHash,
      ).toBe(notes.contentHash);

      const ready = await run(homeA, ["--json", "--non-interactive", "status"]);
      expect(ready.json).toMatchObject({
        schemaVersion: 1,
        command: "STATUS",
        outcome: "SUCCESS",
      });
      expect(classifications(ready)).toContain("MANAGED_SYNCED");
      const lockedRevision = String(ready.json?.revision);

      await writeSkill(join(notes.repository, "skills", "notes"), "# Notes HEAD\n");
      await git(["-C", notes.repository, "add", "."]);
      await git(["-C", notes.repository, "commit", "-m", "move head"]);

      const afterHead = await run(homeA, ["--json", "--non-interactive", "sync"]);
      expect(afterHead.json).toMatchObject({ command: "SYNC", status: "SYNCED" });
      expect(afterHead.json?.revision).toBe(lockedRevision);
      expect(await readFile(join(namedSkill(homeA, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes locked\n",
      );

      const checked = await run(homeA, [
        "--json",
        "--non-interactive",
        "update",
        "--check",
        "notes",
      ]);
      expect(checked.json).toMatchObject({ status: "CHECKED" });
      expect(
        (checked.json?.skills as { status: string }[])[0]?.status,
      ).toBe("UPDATE_AVAILABLE");
      expect(await readFile(join(namedSkill(homeA, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes locked\n",
      );

      expect((await initGit(homeB, remote)).code).toBe(0);
      const syncedB = await run(homeB, ["--json", "--non-interactive", "sync"]);
      expect(syncedB.json).toMatchObject({ status: "SYNCED" });
      expect(await readFile(join(namedSkill(homeB, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes locked\n",
      );
      expect(
        (await scanNormalizedContent(namedSkill(homeB, "notes"))).contentHash,
      ).toBe(notes.contentHash);
      expect(JSON.parse(await readFile(paths(homeB).configFile, "utf8")).agents).toEqual(
        {},
      );
    },
    timeout,
  );

  test(
    "detects drift, refuses ordinary sync overwrite, restores safely, and verifies remove ownership",
    async () => {
      const root = await temp("drift");
      const remote = await stateRemote(root);
      const notes = await skillRepo(root, "notes", "# Notes locked\n");
      const home = join(root, "home");
      expect((await initGit(home, remote)).code).toBe(0);
      expect((await addSkill(home, notes.repository, "notes")).code).toBe(0);

      await writeFile(join(namedSkill(home, "notes"), "SKILL.md"), "# Drifted\n");
      const driftedStatus = await run(home, [
        "--json",
        "--non-interactive",
        "status",
      ]);
      expect(driftedStatus.json).toMatchObject({
        command: "STATUS",
        status: "DRIFTED",
      });
      expect(classifications(driftedStatus)).toContain("DRIFTED");

      const driftedDiff = await run(home, ["--json", "--non-interactive", "diff"]);
      expect(driftedDiff.json).toMatchObject({ command: "DIFF", status: "DRIFTED" });

      const driftedSync = await run(home, ["--json", "--non-interactive", "sync"]);
      expect(driftedSync.json?.status).toBe("DRIFTED");
      expect(driftedSync.json?.status).not.toBe("SYNCED");
      expect(await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Drifted\n",
      );

      const blockedRemove = await run(home, [
        "--json",
        "--non-interactive",
        "remove",
        "notes",
      ]);
      expect(blockedRemove.code).not.toBe(0);
      expect(errorText(blockedRemove)).toMatch(/verified Corotum-owned|DRIFTED|drift/i);
      expect(await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Drifted\n",
      );

      const restored = await run(home, [
        "--json",
        "--non-interactive",
        "restore",
        "notes",
      ]);
      expect(restored.code).toBe(0);
      expect(await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes locked\n",
      );

      const unknown = await run(home, [
        "--json",
        "--non-interactive",
        "remove",
        "not-a-skill",
      ]);
      expect(unknown.code).not.toBe(0);
      expect(errorText(unknown)).toMatch(/not found|ambiguous/i);
      expect(await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes locked\n",
      );

      const unrecorded = join(root, "unrecorded");
      expect((await initGit(unrecorded, await stateRemote(join(root, "other")))).code).toBe(0);
      await writeSkill(namedSkill(unrecorded, "notes"), "# Local only\n");
      const restoreUnrecorded = await run(unrecorded, [
        "--json",
        "--non-interactive",
        "restore",
        "notes",
      ]);
      expect(restoreUnrecorded.code).not.toBe(0);
      expect(errorText(restoreUnrecorded)).toMatch(/not found|unrecorded|unverified/i);
      expect(
        await readFile(join(namedSkill(unrecorded, "notes"), "SKILL.md"), "utf8"),
      ).toBe("# Local only\n");
    },
    timeout,
  );

  test(
    "preserves unmanaged collisions, unmanage copies, re-add semantics, and never destroys by name or hash alone",
    async () => {
      const root = await temp("unmanage");
      const remote = await stateRemote(root);
      const notes = await skillRepo(root, "notes", "# Notes locked\n");
      const tasks = await skillRepo(root, "tasks", "# Tasks locked\n");
      const homeA = join(root, "home-a");
      const homeB = join(root, "home-b");

      expect((await initGit(homeA, remote)).code).toBe(0);
      expect((await addSkill(homeA, notes.repository, "notes")).code).toBe(0);
      expect((await addSkill(homeA, tasks.repository, "tasks")).code).toBe(0);

      expect((await initGit(homeB, remote)).code).toBe(0);
      await writeSkill(namedSkill(homeB, "notes"), "# Unmanaged notes\n");
      await writeSkill(namedSkill(homeB, "keep-me"), "# Keep me\n");
      const collided = await run(homeB, ["--json", "--non-interactive", "sync"]);
      expect(collided.json?.status).not.toBe("SYNCED");
      expect(collided.json?.status).toBe("LOCAL_CONFLICT");
      expect(await readFile(join(namedSkill(homeB, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Unmanaged notes\n",
      );
      expect(await readFile(join(namedSkill(homeB, "keep-me"), "SKILL.md"), "utf8")).toBe(
        "# Keep me\n",
      );
      expect(await readFile(join(namedSkill(homeB, "tasks"), "SKILL.md"), "utf8")).toBe(
        "# Tasks locked\n",
      );

      const unmanaged = await run(homeA, [
        "--json",
        "--non-interactive",
        "unmanage",
        "tasks",
      ]);
      expect(unmanaged.code).toBe(0);
      expect(await readFile(join(namedSkill(homeA, "tasks"), "SKILL.md"), "utf8")).toBe(
        "# Tasks locked\n",
      );
      await writeFile(join(namedSkill(homeA, "tasks"), "SKILL.md"), "# Kept locally\n");

      const sameHash = join(root, "same-hash");
      expect((await initGit(sameHash, remote)).code).toBe(0);
      await writeSkill(namedSkill(sameHash, "notes"), "# Notes locked\n");
      await writeSkill(namedSkill(sameHash, "imposter"), "# Notes locked\n");
      const removed = await run(homeA, [
        "--json",
        "--non-interactive",
        "remove",
        "notes",
      ]);
      expect(removed.code).toBe(0);
      await expect(readFile(join(namedSkill(homeA, "notes"), "SKILL.md"), "utf8")).rejects.toThrow();
      expect(await readFile(join(namedSkill(homeA, "tasks"), "SKILL.md"), "utf8")).toBe(
        "# Kept locally\n",
      );

      const afterRemove = await run(sameHash, ["--json", "--non-interactive", "sync"]);
      expect(
        await readFile(join(namedSkill(sameHash, "notes"), "SKILL.md"), "utf8"),
      ).toBe("# Notes locked\n");
      expect(
        await readFile(join(namedSkill(sameHash, "imposter"), "SKILL.md"), "utf8"),
      ).toBe("# Notes locked\n");

      const readded = await run(homeA, [
        "--json",
        "--non-interactive",
        "add",
        tasks.repository,
        "--skill",
        "tasks",
        "--ref",
        "main",
      ]);
      expect(readded.json?.status).not.toBe("SYNCED");
      expect(await readFile(join(namedSkill(homeA, "tasks"), "SKILL.md"), "utf8")).toBe(
        "# Kept locally\n",
      );
      const afterReadd = await run(homeA, ["--json", "--non-interactive", "sync"]);
      expect(afterReadd.json?.status).not.toBe("SYNCED");
      expect(await readFile(join(namedSkill(homeA, "tasks"), "SKILL.md"), "utf8")).toBe(
        "# Kept locally\n",
      );
    },
    timeout,
  );

  test(
    "recovers missing content and corrupt operational state, and partial apply never claims SYNCED",
    async () => {
      const root = await temp("recover");
      const remote = await stateRemote(root);
      const notes = await skillRepo(root, "notes", "# Notes locked\n");
      const tasks = await skillRepo(root, "tasks", "# Tasks locked\n");
      const home = join(root, "home");
      expect((await initGit(home, remote)).code).toBe(0);
      expect((await addSkill(home, notes.repository, "notes")).code).toBe(0);
      expect((await addSkill(home, tasks.repository, "tasks")).code).toBe(0);

      await rm(namedSkill(home, "notes"), { recursive: true, force: true });
      const missing = await run(home, ["--json", "--non-interactive", "status"]);
      expect(classifications(missing)).toContain("MISSING");
      expect(missing.json?.status).not.toBe("SYNCED");

      const repaired = await run(home, ["--json", "--non-interactive", "sync"]);
      expect(repaired.json).toMatchObject({ status: "SYNCED" });
      expect(await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes locked\n",
      );

      const stateFile = join(paths(home).stateDir, "state.json");
      await writeFile(stateFile, "{not-json");
      const corrupt = await run(home, ["--json", "--non-interactive", "status"]);
      expect(corrupt.code).toBe(0);
      expect(corrupt.json?.outcome).toBe("SUCCESS");
      expect(await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes locked\n",
      );
      expect(await readFile(join(namedSkill(home, "tasks"), "SKILL.md"), "utf8")).toBe(
        "# Tasks locked\n",
      );

      await rm(stateFile, { force: true });
      const recovered = await run(home, ["--json", "--non-interactive", "status"]);
      expect(recovered.json?.outcome).toBe("SUCCESS");
      expect(classifications(recovered)).toEqual(
        expect.arrayContaining(["MANAGED_SYNCED"]),
      );

      const partialHome = join(root, "partial");
      expect((await initGit(partialHome, remote)).code).toBe(0);
      await writeSkill(namedSkill(partialHome, "notes"), "# Collision\n");
      const partial = await run(partialHome, ["--json", "--non-interactive", "sync"]);
      expect(partial.json?.status).toBe("LOCAL_CONFLICT");
      expect(partial.json?.status).not.toBe("SYNCED");
      expect(partial.json?.appliedRevision == null).toBe(true);
      expect(
        await readFile(join(namedSkill(partialHome, "notes"), "SKILL.md"), "utf8"),
      ).toBe("# Collision\n");
      expect(
        await readFile(join(namedSkill(partialHome, "tasks"), "SKILL.md"), "utf8"),
      ).toBe("# Tasks locked\n");
    },
    timeout,
  );

  test(
    "offline, auth, pull, and push failures stay recoverable without false SYNCED or unmanaged data loss",
    async () => {
      const root = await temp("failures");
      const remote = await stateRemote(root);
      const notes = await skillRepo(root, "notes", "# Notes locked\n");
      const tasks = await skillRepo(root, "tasks", "# Tasks locked\n");
      const home = join(root, "home");
      expect((await initGit(home, remote)).code).toBe(0);
      expect((await addSkill(home, notes.repository, "notes")).code).toBe(0);
      await writeSkill(namedSkill(home, "keep-me"), "# Unmanaged keep\n");

      const authBin = join(root, "auth-bin");
      await writeFakeGit(
        authBin,
        "fatal: Authentication failed for 'https://example.test/repo.git'",
      );
      const auth = await run(
        home,
        ["--json", "--non-interactive", "sync"],
        { PATH: authBin },
      );
      expect(auth.code).toBe(ExitCode.AUTH_REQUIRED);
      expect(errorText(auth)).toMatch(/authentication/i);
      expect(auth.json?.status).not.toBe("SYNCED");
      expect(await readFile(join(namedSkill(home, "keep-me"), "SKILL.md"), "utf8")).toBe(
        "# Unmanaged keep\n",
      );
      expect(await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes locked\n",
      );

      const offlineBin = join(root, "offline-bin");
      await writeFakeGit(
        offlineBin,
        "fatal: unable to access 'https://127.0.0.1:1/repo.git': Failed to connect",
      );
      const offline = await run(
        home,
        ["--json", "--non-interactive", "status"],
        { PATH: offlineBin },
      );
      expect(offline.code).toBe(ExitCode.NETWORK_ERROR);
      expect(errorText(offline)).toMatch(/unavailable|connect/i);
      expect(offline.json?.status).not.toBe("SYNCED");
      expect(await readFile(join(namedSkill(home, "keep-me"), "SKILL.md"), "utf8")).toBe(
        "# Unmanaged keep\n",
      );

      await Bun.spawn(["chmod", "-R", "a-rwx", remote], {
        stderr: "pipe",
        stdout: "pipe",
      }).exited;
      const pull = await run(home, ["--json", "--non-interactive", "sync"]);
      expect(pull.code).not.toBe(0);
      expect(pull.json?.status).not.toBe("SYNCED");
      expect(await readFile(join(namedSkill(home, "keep-me"), "SKILL.md"), "utf8")).toBe(
        "# Unmanaged keep\n",
      );
      await Bun.spawn(["chmod", "-R", "u+rwx", remote], {
        stderr: "pipe",
        stdout: "pipe",
      }).exited;

      const recoveredPull = await run(home, ["--json", "--non-interactive", "sync"]);
      expect(recoveredPull.json).toMatchObject({ status: "SYNCED" });
      expect(await readFile(join(namedSkill(home, "keep-me"), "SKILL.md"), "utf8")).toBe(
        "# Unmanaged keep\n",
      );

      await denyPush(remote);
      const pushed = await addSkill(home, tasks.repository, "tasks");
      expect(pushed.code).not.toBe(0);
      expect(pushed.json?.status).not.toBe("SYNCED");
      expect(pushed.json?.status).not.toBe("ADDED");
      expect(await readFile(join(namedSkill(home, "keep-me"), "SKILL.md"), "utf8")).toBe(
        "# Unmanaged keep\n",
      );
      expect(await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes locked\n",
      );

      await allowPush(remote);
      const retried = await run(home, ["--json", "--non-interactive", "sync"]);
      expect(retried.json?.status).not.toBeUndefined();
      if (retried.json?.status !== "SYNCED") {
        const added = await addSkill(home, tasks.repository, "tasks");
        expect(["ADDED", "DUPLICATE", "PERSISTED_NOT_APPLIED"]).toContain(
          added.json?.status,
        );
        const afterAdd = await run(home, ["--json", "--non-interactive", "sync"]);
        expect(afterAdd.json?.status === "SYNCED" || afterAdd.json?.status === "LOCAL_CONFLICT").toBe(
          true,
        );
      }
      expect(await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes locked\n",
      );
      expect(await readFile(join(namedSkill(home, "keep-me"), "SKILL.md"), "utf8")).toBe(
        "# Unmanaged keep\n",
      );
      expect(await readFile(join(namedSkill(home, "tasks"), "SKILL.md"), "utf8")).toBe(
        "# Tasks locked\n",
      );

      const finalStatus = await run(home, ["--json", "--non-interactive", "status"]);
      expect(finalStatus.json).toMatchObject({ outcome: "SUCCESS" });
      expect(classifications(finalStatus)).toEqual(
        expect.arrayContaining(["MANAGED_SYNCED"]),
      );
      expect(classifications(finalStatus)).not.toContain("UNMANAGED");
    },
    timeout,
  );
});
