import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import { ExitCode } from "./cli-contracts";
import { defaultConfig } from "./config";
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
  const path = await mkdtemp(join(tmpdir(), `corotum-git-ux-${name}-`));
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

async function writeSkill(directory: string, body: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), body);
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

function namedSkill(home: string, name: string): string {
  return join(home, ".agents", "skills", name);
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

describe("corotum config Git Sync UX", () => {
  test(
    "inspects Git Sync and Cloud keys without agents and never prompts",
    async () => {
      const root = await temp("config");
      const home = join(root, "home");
      const remote = await stateRemote(root);
      expect((await initGit(home, remote)).code).toBe(0);

      const listed = await run(home, [
        "--json",
        "--non-interactive",
        "config",
        "list",
      ]);
      expect(listed.code).toBe(0);
      expect(listed.json).toMatchObject({
        outcome: "SUCCESS",
        config: {
          mode: "git",
          gitRepository: remote,
          workspaceId: null,
          deviceId: null,
          agents: {},
        },
      });

      const implicit = await run(home, ["--json", "--non-interactive", "config"]);
      expect(implicit.code).toBe(0);
      expect(implicit.json).toMatchObject({ outcome: "SUCCESS", config: { mode: "git" } });

      const repo = await run(home, [
        "--json",
        "--non-interactive",
        "config",
        "get",
        "gitRepository",
      ]);
      expect(repo.json).toMatchObject({
        outcome: "SUCCESS",
        key: "gitRepository",
        value: remote,
      });
      const cloud = await run(home, [
        "--json",
        "--non-interactive",
        "config",
        "get",
        "workspaceId",
      ]);
      expect(cloud.json).toMatchObject({
        outcome: "SUCCESS",
        key: "workspaceId",
        value: null,
      });

      const set = await run(home, [
        "--json",
        "--non-interactive",
        "config",
        "set",
        "telemetry",
        "false",
      ]);
      expect(set.code).toBe(0);
      expect(set.json).toMatchObject({
        outcome: "SUCCESS",
        key: "telemetry",
        value: false,
      });
      expect(set.stderr).not.toMatch(/\?|Choice|Continue/);

      const origin = await run(home, [
        "--json",
        "--non-interactive",
        "config",
        "set",
        "origin",
        "https://corotum.mixon.dev",
      ]);
      expect(origin.code).toBe(0);
      expect(origin.json).toMatchObject({
        outcome: "SUCCESS",
        key: "origin",
        value: "https://corotum.mixon.dev",
      });
      const gotOrigin = await run(home, [
        "--json",
        "--non-interactive",
        "config",
        "get",
        "origin",
      ]);
      expect(gotOrigin.json).toMatchObject({
        outcome: "SUCCESS",
        key: "origin",
        value: "https://corotum.mixon.dev",
      });

      const readonly = await run(home, [
        "--json",
        "--non-interactive",
        "config",
        "set",
        "gitRepository",
        "https://example.test/other.git",
      ]);
      expect(readonly.code).toBe(ExitCode.INVALID_CONFIG);
      expect(String(readonly.json?.error ?? readonly.stderr)).toMatch(/read-only/i);

      const unknown = await run(home, [
        "--json",
        "--non-interactive",
        "config",
        "get",
        "not-a-key",
      ]);
      expect(unknown.code).toBe(ExitCode.INVALID_CONFIG);
      expect(String(unknown.json?.error ?? unknown.stderr)).toContain("Unknown config key");

      const emptyHome = join(root, "empty");
      const emptyList = await run(emptyHome, [
        "--json",
        "--non-interactive",
        "config",
        "list",
      ]);
      expect(emptyList.code).toBe(0);
      expect(emptyList.json).toMatchObject({
        outcome: "SUCCESS",
        config: defaultConfig(),
      });
    },
    timeout,
  );
});

describe("Git Sync command failures", () => {
  test(
    "empty machine, missing Git, bad repository, unavailable remote, and auth are typed",
    async () => {
      const root = await temp("failures");
      const home = join(root, "home");

      const uninitialized = await run(home, [
        "--json",
        "--non-interactive",
        "status",
      ]);
      expect(uninitialized.code).toBe(ExitCode.INVALID_CONFIG);
      expect(String(uninitialized.json?.error ?? uninitialized.stderr)).toContain(
        "corotum init",
      );

      const remote = await stateRemote(root);
      expect((await initGit(home, remote)).code).toBe(0);

      const missing = await run(
        home,
        ["--json", "--non-interactive", "add", "https://example.test/skills.git"],
        { PATH: join(root, "empty-bin") },
      );
      expect(missing.code).toBe(ExitCode.GENERAL_ERROR);
      expect(String(missing.json?.error ?? missing.stderr)).toContain(
        "Git is not installed",
      );

      const notRepo = join(root, "not-a-repo");
      await mkdir(notRepo, { recursive: true });
      const invalid = await run(home, [
        "--json",
        "--non-interactive",
        "add",
        notRepo,
        "--skill",
        "notes",
      ]);
      expect(invalid.code).toBe(ExitCode.INVALID_CONFIG);
      expect(String(invalid.json?.error ?? invalid.stderr)).toMatch(
        /invalid|not a Git repository/i,
      );

      const unavailableBin = join(root, "unavailable-bin");
      await writeFakeGit(
        unavailableBin,
        "fatal: unable to access 'https://127.0.0.1:1/repo.git': Failed to connect",
      );
      const unavailable = await run(
        home,
        ["--json", "--non-interactive", "status"],
        { PATH: unavailableBin },
      );
      expect(unavailable.code).toBe(ExitCode.NETWORK_ERROR);
      expect(String(unavailable.json?.error ?? unavailable.stderr)).toContain(
        "unavailable",
      );

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
      expect(String(auth.json?.error ?? auth.stderr)).toMatch(/authentication/i);
    },
    timeout,
  );
});

describe("Git Sync command lifecycle", () => {
  test(
    "zero-agent add/status/diff/sync/update/set-ref/restore/unmanage/remove and adopt",
    async () => {
      const root = await temp("lifecycle");
      const remote = await stateRemote(root);
      const notes = await skillRepo(root, "notes", "# Notes\n");
      const tasks = await skillRepo(root, "tasks", "# Tasks\n");
      const home = join(root, "home");

      expect((await initGit(home, remote)).code).toBe(0);
      expect(JSON.parse(await readFile(paths(home).configFile, "utf8"))).toMatchObject({
        mode: "git",
        agents: {},
      });

      const addedNotes = await run(home, [
        "--json",
        "--non-interactive",
        "add",
        notes.repository,
        "--skill",
        "notes",
        "--ref",
        "main",
      ]);
      expect(addedNotes.code).toBe(0);
      expect(addedNotes.json).toMatchObject({ outcome: "SUCCESS", status: "ADDED" });
      expect(await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes\n",
      );

      const addedTasks = await run(home, [
        "--json",
        "--non-interactive",
        "add",
        tasks.repository,
        "--skill",
        "tasks",
        "--ref",
        "main",
      ]);
      expect(addedTasks.code).toBe(0);

      const status = await run(home, ["--json", "--non-interactive", "status"]);
      expect(status.code).toBe(0);
      expect(status.json).toMatchObject({ command: "STATUS" });

      const diff = await run(home, ["--json", "--non-interactive", "diff"]);
      expect(diff.code).toBe(0);
      expect(diff.json).toMatchObject({ command: "DIFF" });

      const synced = await run(home, ["--json", "--non-interactive", "sync"]);
      expect(synced.code).toBe(0);
      expect(synced.json).toMatchObject({ command: "SYNC" });

      const checked = await run(home, [
        "--json",
        "--non-interactive",
        "update",
        "--check",
      ]);
      expect(checked.code).toBe(0);
      expect(checked.json).toMatchObject({ outcome: "SUCCESS", status: "CHECKED" });
      const checkedSkills = checked.json?.skills as
        | readonly { name: string; status: string }[]
        | undefined;
      expect(checkedSkills?.map((skill) => skill.name).sort()).toEqual([
        "notes",
        "tasks",
      ]);
      expect(checkedSkills?.every((skill) => skill.status === "UP_TO_DATE")).toBe(
        true,
      );
      const revisionBeforeCheck = await git(["--git-dir", remote, "rev-parse", "HEAD"]);

      await writeSkill(join(notes.repository, "skills", "notes"), "# Notes v2\n");
      await git(["-C", notes.repository, "add", "."]);
      await git(["-C", notes.repository, "commit", "-m", "notes v2"]);
      await git(["-C", notes.repository, "tag", "v2"]);

      const available = await run(home, [
        "--json",
        "--non-interactive",
        "update",
        "--check",
        "notes",
      ]);
      expect(available.json).toMatchObject({ status: "CHECKED" });
      expect(
        (available.json?.skills as { status: string }[])[0]?.status,
      ).toBe("UPDATE_AVAILABLE");
      expect(await git(["--git-dir", remote, "rev-parse", "HEAD"])).toBe(
        revisionBeforeCheck,
      );
      expect(await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes\n",
      );

      const updatedOne = await run(home, [
        "--json",
        "--non-interactive",
        "update",
        "notes",
      ]);
      expect(updatedOne.code).toBe(0);
      expect(updatedOne.json).toMatchObject({ status: "UPDATED" });
      expect(await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes v2\n",
      );
      expect(await readFile(join(namedSkill(home, "tasks"), "SKILL.md"), "utf8")).toBe(
        "# Tasks\n",
      );

      const updatedAll = await run(home, [
        "--json",
        "--non-interactive",
        "update",
      ]);
      expect(updatedAll.code).toBe(0);
      expect(updatedAll.json?.status).toBe("UPDATED");

      const setRef = await run(home, [
        "--json",
        "--non-interactive",
        "set-ref",
        "notes",
        "v2",
      ]);
      expect(setRef.code).toBe(0);
      expect(setRef.json).toMatchObject({ status: "SET_REF", ref: "v2" });
      expect(await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes v2\n",
      );

      await writeFile(join(namedSkill(home, "notes"), "SKILL.md"), "# drifted\n");
      const restored = await run(home, [
        "--json",
        "--non-interactive",
        "restore",
        "notes",
      ]);
      expect(restored.code).toBe(0);
      expect(await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8")).toBe(
        "# Notes v2\n",
      );

      const unmanaged = await run(home, [
        "--json",
        "--non-interactive",
        "unmanage",
        "tasks",
      ]);
      expect(unmanaged.code).toBe(0);
      expect(await readFile(join(namedSkill(home, "tasks"), "SKILL.md"), "utf8")).toBe(
        "# Tasks\n",
      );

      const removed = await run(home, [
        "--json",
        "--non-interactive",
        "remove",
        "notes",
      ]);
      expect(removed.code).toBe(0);

      const adoptHome = join(root, "adopt-home");
      expect((await initGit(adoptHome, await stateRemote(join(root, "adopt-state")))).code).toBe(0);
      await writeSkill(namedSkill(adoptHome, "notes"), "# Local notes\n");
      const adopted = await run(adoptHome, [
        "--json",
        "--non-interactive",
        "--allow-artifacts",
        "adopt",
        "notes",
        "--source",
        notes.repository,
        "--ref",
        "main",
      ]);
      expect(adopted.code).toBe(0);
      expect(adopted.json).toMatchObject({ status: "ADOPTED" });
      expect(
        await readFile(join(namedSkill(adoptHome, "notes"), "SKILL.md"), "utf8"),
      ).toBe("# Local notes\n");
    },
    timeout,
  );
});
