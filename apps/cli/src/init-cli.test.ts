import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ExitCode } from "./cli-contracts";
import { defaultConfig } from "./config";
import { resolvePlatformPaths } from "./platform";

const roots: string[] = [];
const cli = join(import.meta.dir, "index.ts");
const timeout = 60_000;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await Bun.spawn(["chmod", "-R", "u+rwx", root], { stderr: "pipe", stdout: "pipe" }).exited;
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
  const path = await mkdtemp(join(tmpdir(), `corotum-init-cli-${name}-`));
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

function cliEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
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

async function writeFakeGit(bin: string, stderr: string): Promise<void> {
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "git version 2.45.0"
  exit 0
fi
echo ${JSON.stringify(stderr)} >&2
exit 128
`,
    { mode: 0o755 },
  );
  await chmod(join(bin, "git"), 0o755);
}

describe("real corotum init CLI", () => {
  test(
    "non-interactive missing provider never waits and requires repository or cloud",
    async () => {
      const home = await temp("missing-provider");
      const missing = await run(home, ["--json", "--non-interactive", "init"]);
      expect(missing.code).toBe(ExitCode.INVALID_CONFIG);
      expect(missing.json?.outcome).toBe("INVALID_CONFIG");
      expect(String(missing.json?.error ?? missing.stderr)).toContain("repository");
      expect(String(missing.json?.error ?? missing.stderr)).toContain("cloud");
    },
    timeout,
  );

  test(
    "zero-agent empty machine and missing global skill store initialize Git Sync",
    async () => {
      const root = await temp("empty");
      const remote = await stateRemote(root);
      const home = join(root, "home");
      const initialized = await run(home, [
        "--json",
        "--non-interactive",
        "init",
        "repository",
        remote,
      ]);
      expect(initialized.code).toBe(0);
      expect(initialized.stdout).toContain("Initialized Git Sync");
      const config = JSON.parse(await readFile(paths(home).configFile, "utf8")) as {
        mode: string;
        gitRepository: string;
        agents: Record<string, { enabled: boolean }>;
      };
      expect(config.mode).toBe("git");
      expect(config.gitRepository).toBe(remote);
      expect(config.agents).toEqual({});
    },
    timeout,
  );

  test(
    "legacy init <url> still works and existing global skills are discovered without agents",
    async () => {
      const root = await temp("skills");
      const remote = await stateRemote(root);
      const home = join(root, "home");
      const skill = join(home, ".agents", "skills", "notes");
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, "SKILL.md"), "# Notes\n");
      await mkdir(join(home, ".codex", "skills", "ignored"), { recursive: true });
      await writeFile(join(home, ".codex", "skills", "ignored", "SKILL.md"), "# Agent only\n");

      const initialized = await run(home, [
        "--json",
        "--non-interactive",
        "init",
        remote,
      ]);
      expect(initialized.code).toBe(0);
      expect(initialized.stderr).toContain("notes:");
      expect(initialized.stderr).not.toContain("ignored");
      expect(await readFile(join(skill, "SKILL.md"), "utf8")).toBe("# Notes\n");
      expect(await readFile(join(home, ".codex", "skills", "ignored", "SKILL.md"), "utf8")).toBe(
        "# Agent only\n",
      );
    },
    timeout,
  );

  test(
    "existing Corotum configuration is a typed already-initialized error",
    async () => {
      const home = await temp("configured");
      await writeJson(paths(home).configFile, {
        ...defaultConfig(),
        telemetry: false,
        mode: "git",
        gitRepository: "/tmp/already.git",
      });
      const result = await run(home, [
        "--json",
        "--non-interactive",
        "init",
        "repository",
        "/tmp/other.git",
      ]);
      expect(result.code).toBe(ExitCode.CONFLICT);
      expect(result.json?.outcome).toBe("CONFLICT");
      expect(String(result.json?.error ?? result.stderr)).toContain("already configured");
    },
    timeout,
  );

  test(
    "missing Git, invalid Git repo, unavailable remote, and Git auth failure are typed",
    async () => {
      const root = await temp("git-errors");
      const home = join(root, "home");

      const missingGitHome = join(root, "missing-git");
      const missing = await run(
        missingGitHome,
        ["--json", "--non-interactive", "init", "repository", "/tmp/state.git"],
        { PATH: join(root, "empty-bin") },
      );
      expect(missing.code).toBe(ExitCode.GENERAL_ERROR);
      expect(missing.json?.outcome).toBe("GENERAL_ERROR");
      expect(String(missing.json?.error ?? missing.stderr)).toContain("Git is not installed");

      const notRepo = join(root, "not-a-repo");
      await mkdir(notRepo, { recursive: true });
      const invalid = await run(home, [
        "--json",
        "--non-interactive",
        "init",
        "repository",
        notRepo,
      ]);
      expect(invalid.code).toBe(ExitCode.INVALID_CONFIG);
      expect(invalid.json?.outcome).toBe("INVALID_CONFIG");
      expect(String(invalid.json?.error ?? invalid.stderr)).toMatch(/invalid|not a Git repository/i);

      const unavailableBin = join(root, "unavailable-bin");
      await writeFakeGit(
        unavailableBin,
        "fatal: unable to access 'https://127.0.0.1:1/repo.git': Failed to connect",
      );
      const unavailable = await run(
        join(root, "unavailable-home"),
        ["--json", "--non-interactive", "init", "repository", "https://127.0.0.1:1/repo.git"],
        { PATH: unavailableBin },
      );
      expect(unavailable.code).toBe(ExitCode.NETWORK_ERROR);
      expect(unavailable.json?.outcome).toBe("NETWORK_ERROR");
      expect(String(unavailable.json?.error ?? unavailable.stderr)).toContain("unavailable");

      const authBin = join(root, "auth-bin");
      await writeFakeGit(authBin, "fatal: Authentication failed for 'https://example.test/repo.git'");
      const auth = await run(
        join(root, "auth-home"),
        ["--json", "--non-interactive", "init", "repository", "https://example.test/repo.git"],
        { PATH: authBin },
      );
      expect(auth.code).toBe(ExitCode.AUTH_REQUIRED);
      expect(auth.json?.outcome).toBe("AUTH_REQUIRED");
      expect(String(auth.json?.error ?? auth.stderr)).toContain("authentication");
    },
    timeout,
  );

  test(
    "already initialized Git desired state is a typed error and does not require agents",
    async () => {
      const root = await temp("remote-initialized");
      const remote = await stateRemote(root);
      const first = join(root, "first");
      const second = join(root, "second");
      const skill = join(first, ".agents", "skills", "notes");
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, "SKILL.md"), "# Notes\n");
      expect(
        (
          await run(first, [
            "--json",
            "--non-interactive",
            "--allow-artifacts",
            "init",
            "repository",
            remote,
            "--adopt-artifact",
            "notes",
          ])
        ).code,
      ).toBe(0);
      const retry = await run(second, [
        "--json",
        "--non-interactive",
        "init",
        "repository",
        remote,
      ]);
      expect(retry.code).toBe(ExitCode.CONFLICT);
      expect(String(retry.json?.error ?? retry.stderr)).toMatch(/already initialized/i);
    },
    timeout,
  );
});
