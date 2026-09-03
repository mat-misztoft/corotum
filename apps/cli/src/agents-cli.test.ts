import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
  const path = await mkdtemp(join(tmpdir(), `corotum-agents-cli-${name}-`));
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

function cliEnv(home: string): Record<string, string> {
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
  };
}

type CliResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
  json?: Record<string, unknown>;
}>;

async function run(home: string, args: readonly string[]): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: join(import.meta.dir, "../../.."),
    env: cliEnv(home),
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
  await git([
    "-C",
    repository,
    "config",
    "user.email",
    "tests@corotum.invalid",
  ]);
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

function namedSkill(home: string, name: string): string {
  return join(home, ".agents", "skills", name);
}

function targetSkill(home: string, name: string): string {
  return join(home, ".codex", "skills", name);
}

function agentFrom(
  payload: Record<string, unknown> | undefined,
  id: string,
): { detected: boolean; enabled: boolean } | undefined {
  const agents = payload?.agents;
  if (!Array.isArray(agents)) return undefined;
  return agents.find((agent) => {
    return (
      typeof agent === "object" &&
      agent !== null &&
      "id" in agent &&
      agent.id === id
    );
  }) as { detected: boolean; enabled: boolean } | undefined;
}

describe("real corotum agents CLI", () => {
  test(
    "scan detects without enabling and unknown agents fail",
    async () => {
      const home = await temp("scan");
      await mkdir(join(home, ".codex"), { recursive: true });
      const listed = await run(home, ["--json", "--non-interactive", "agents"]);
      const scanned = await run(home, [
        "--json",
        "--non-interactive",
        "agents",
        "scan",
      ]);
      expect(listed.code).toBe(ExitCode.SUCCESS);
      expect(scanned.code).toBe(ExitCode.SUCCESS);
      expect(listed.json?.command).toBe("AGENTS");
      expect(scanned.json?.command).toBe("AGENTS_SCAN");
      expect(agentFrom(scanned.json, "codex")).toMatchObject({
        detected: true,
        enabled: false,
      });
      expect(agentFrom(scanned.json, "pi")?.enabled).toBe(false);
      await expect(access(paths(home).configFile)).rejects.toThrow();

      const unknown = await run(home, [
        "--json",
        "--non-interactive",
        "agents",
        "enable",
        "not-an-agent",
      ]);
      expect(unknown.code).toBe(ExitCode.GENERAL_ERROR);
      expect(String(unknown.json?.error ?? unknown.stderr)).toContain(
        "Supported agents",
      );
    },
    timeout,
  );

  test(
    "Git Sync manages skills with zero agents, enable exposes later, disable removes only exposure",
    async () => {
      const root = await temp("zero-agent");
      const remote = await stateRemote(root);
      const notes = await skillRepo(root, "notes", "# Notes\n");
      const home = join(root, "home");

      const initialized = await run(home, [
        "--json",
        "--non-interactive",
        "init",
        "repository",
        remote,
      ]);
      expect(initialized.code).toBe(0);
      const added = await run(home, [
        "--json",
        "--non-interactive",
        "add",
        notes.repository,
        "--skill",
        "notes",
        "--ref",
        "main",
      ]);
      expect(added.code).toBe(0);
      expect(
        await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8"),
      ).toBe("# Notes\n");
      await expect(lstat(targetSkill(home, "notes"))).rejects.toThrow();

      const configBefore = JSON.parse(
        await readFile(paths(home).configFile, "utf8"),
      ) as { agents: Record<string, { enabled: boolean }> };
      expect(configBefore.agents).toEqual({});
      const revisionBefore = await git([
        "--git-dir",
        remote,
        "rev-parse",
        "HEAD",
      ]);

      await mkdir(join(home, ".codex"), { recursive: true });
      const scanned = await run(home, [
        "--json",
        "--non-interactive",
        "agents",
        "scan",
      ]);
      expect(agentFrom(scanned.json, "codex")).toMatchObject({
        detected: true,
        enabled: false,
      });
      const configAfterScan = JSON.parse(
        await readFile(paths(home).configFile, "utf8"),
      ) as { agents: Record<string, { enabled: boolean }> };
      expect(configAfterScan.agents).toEqual({});

      const enabled = await run(home, [
        "--json",
        "--non-interactive",
        "agents",
        "enable",
        "codex",
      ]);
      expect(enabled.code).toBe(0);
      expect(enabled.json).toMatchObject({
        command: "AGENTS_ENABLE",
        agent: "codex",
        enabled: true,
      });
      expect((await lstat(targetSkill(home, "notes"))).isSymbolicLink()).toBe(
        true,
      );
      expect(
        await readFile(join(targetSkill(home, "notes"), "SKILL.md"), "utf8"),
      ).toBe("# Notes\n");

      const disabled = await run(home, [
        "--json",
        "--non-interactive",
        "agents",
        "disable",
        "codex",
      ]);
      expect(disabled.code).toBe(0);
      expect(disabled.json).toMatchObject({
        command: "AGENTS_DISABLE",
        agent: "codex",
        enabled: false,
      });
      await expect(lstat(targetSkill(home, "notes"))).rejects.toThrow();
      expect(
        await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8"),
      ).toBe("# Notes\n");
      expect(
        (await scanNormalizedContent(namedSkill(home, "notes"))).contentHash,
      ).toBe(notes.contentHash);
      expect(await git(["--git-dir", remote, "rev-parse", "HEAD"])).toBe(
        revisionBefore,
      );
      const configAfter = JSON.parse(
        await readFile(paths(home).configFile, "utf8"),
      ) as { agents: Record<string, { enabled: boolean }>; mode: string };
      expect(configAfter.mode).toBe("git");
      expect(configAfter.agents).toEqual({ codex: { enabled: false } });
    },
    timeout,
  );
});
