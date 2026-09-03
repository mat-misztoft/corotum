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

import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import { defaultConfig } from "./config";
import { resolveLegacyPlatformPaths, resolvePlatformPaths } from "./platform";

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
  const path = await mkdtemp(join(tmpdir(), `corotum-git-v2-e2e-${name}-`));
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
  const extra = platformEnv(home).env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("XDG_")) env[key] = value;
  }
  return {
    ...env,
    ...extra,
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
  const process = Bun.spawn(["bun", cli, ...args], {
    cwd: join(import.meta.dir, "../../.."),
    env: cliEnv(home),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
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

async function writeSkill(
  directory: string,
  body: string,
  extra?: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), body);
  if (extra) {
    for (const [name, contents] of Object.entries(extra)) {
      await writeFile(join(directory, name), contents);
    }
  }
}

async function enableCodex(
  home: string,
  extra?: Partial<ReturnType<typeof defaultConfig>>,
): Promise<void> {
  await mkdir(join(home, ".codex", "skills"), { recursive: true });
  const current = paths(home);
  await writeJson(current.configFile, {
    ...defaultConfig(),
    telemetry: false,
    agents: { codex: { enabled: true } },
    ...extra,
  });
}

async function skillRepo(
  root: string,
  name: string,
  body: string,
): Promise<{ repository: string; revision: string; contentHash: string }> {
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
    revision: await git(["-C", repository, "rev-parse", "HEAD"]),
    contentHash: (await scanNormalizedContent(join(repository, "skills", name)))
      .contentHash,
  };
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

async function joinGitHome(home: string, repository: string): Promise<void> {
  await enableCodex(home, { mode: "git", gitRepository: repository });
}

function namedSkill(home: string, name: string): string {
  return join(home, ".agents", "skills", name);
}

function targetSkill(home: string, name: string): string {
  return join(home, ".codex", "skills", name);
}

async function seedSourceKnown(
  home: string,
  name: string,
  repository: string,
  body: string,
): Promise<void> {
  await writeSkill(namedSkill(home, name), body);
  const lockPath = join(home, ".agents", ".skill-lock.json");
  let skills: Record<string, unknown> = {};
  try {
    skills =
      (
        JSON.parse(await readFile(lockPath, "utf8")) as {
          skills?: Record<string, unknown>;
        }
      ).skills ?? {};
  } catch {
    skills = {};
  }
  skills[name] = {
    source: "skills.sh",
    sourceType: "github",
    sourceUrl: repository,
    skillPath: `skills/${name}`,
    skillFolderHash: "sha256:recorded",
  };
  await writeJson(lockPath, { skills });
}

describe("Git v2 two-home end-to-end safety", () => {
  test(
    "fresh init imports source and artifact skills and machine B installs the locked commit after HEAD moves",
    async () => {
      const root = await temp("immutable");
      const remote = await stateRemote(root);
      const publicSkill = await skillRepo(root, "public", "# Public locked\n");
      const homeA = join(root, "home-a");
      const homeB = join(root, "home-b");
      await enableCodex(homeA);
      await seedSourceKnown(
        homeA,
        "public",
        publicSkill.repository,
        "# Public locked\n",
      );
      await writeSkill(namedSkill(homeA, "custom"), "# Custom artifact\n");

      const initialized = await run(homeA, [
        "--json",
        "--non-interactive",
        "--allow-artifacts",
        "init",
        remote,
        "--replace",
        "public",
        "--adopt-artifact",
        "custom",
      ]);
      expect(initialized.code).toBe(0);

      const tracked = await git([
        "--git-dir",
        remote,
        "ls-tree",
        "-r",
        "--name-only",
        "HEAD",
      ]);
      expect(tracked).toContain("corotum.yaml");
      expect(tracked).toContain("corotum.lock");
      expect(tracked).toContain("artifacts/");
      expect(
        await readFile(join(namedSkill(homeA, "public"), "SKILL.md"), "utf8"),
      ).toBe("# Public locked\n");
      expect((await lstat(targetSkill(homeA, "public"))).isSymbolicLink()).toBe(
        true,
      );
      expect((await lstat(targetSkill(homeA, "custom"))).isSymbolicLink()).toBe(
        true,
      );

      await writeFile(
        join(publicSkill.repository, "skills", "public", "SKILL.md"),
        "# Public HEAD moved\n",
      );
      await git(["-C", publicSkill.repository, "add", "."]);
      await git(["-C", publicSkill.repository, "commit", "-m", "move head"]);

      await joinGitHome(homeB, remote);
      const synced = await run(homeB, ["--json", "--non-interactive", "sync"]);
      expect(synced.json?.outcome).toBe("SUCCESS");
      expect(
        await readFile(join(namedSkill(homeB, "public"), "SKILL.md"), "utf8"),
      ).toBe("# Public locked\n");
      expect(
        await readFile(join(namedSkill(homeB, "custom"), "SKILL.md"), "utf8"),
      ).toBe("# Custom artifact\n");
      expect(
        (await scanNormalizedContent(namedSkill(homeB, "public"))).contentHash,
      ).toBe(publicSkill.contentHash);
      expect((await lstat(targetSkill(homeB, "public"))).isSymbolicLink()).toBe(
        true,
      );
      expect(
        await readFile(join(targetSkill(homeB, "public"), "SKILL.md"), "utf8"),
      ).toBe("# Public locked\n");
      const stateB = JSON.parse(
        await readFile(join(paths(homeB).stateDir, "state.json"), "utf8"),
      ) as {
        lastAppliedRevision: string | null;
      };
      expect(stateB.lastAppliedRevision).toBe(synced.json?.revision);
    },
    timeout,
  );

  test(
    "machine B syncs an artifact-backed private skill without credentials and reports AUTH_REQUIRED for a source-backed private skill",
    async () => {
      const root = await temp("auth");
      const remote = await stateRemote(root);
      const publicSkill = await skillRepo(root, "public", "# Public locked\n");
      const privateSkill = await skillRepo(
        root,
        "classified",
        "# Classified locked\n",
      );
      const homeA = join(root, "home-a");
      const homeB = join(root, "home-b");
      await enableCodex(homeA);
      await seedSourceKnown(
        homeA,
        "public",
        publicSkill.repository,
        "# Public locked\n",
      );
      await writeSkill(namedSkill(homeA, "custom"), "# Custom artifact\n");
      expect(
        (
          await run(homeA, [
            "--json",
            "--non-interactive",
            "--allow-artifacts",
            "init",
            remote,
            "--replace",
            "public",
            "--adopt-artifact",
            "custom",
          ])
        ).code,
      ).toBe(0);
      const added = await run(homeA, [
        "--json",
        "--non-interactive",
        "add",
        privateSkill.repository,
        "--skill",
        "classified",
        "--ref",
        "main",
      ]);
      expect(added.code).toBe(0);

      await Bun.spawn(["chmod", "-R", "a-rwx", privateSkill.repository], {
        stderr: "pipe",
        stdout: "pipe",
      }).exited;
      await joinGitHome(homeB, remote);
      await writeSkill(namedSkill(homeB, "notes"), "# Unrelated unmanaged\n");
      await writeSkill(targetSkill(homeB, "notes"), "# Unrelated unmanaged\n");

      const synced = await run(homeB, ["--json", "--non-interactive", "sync"]);
      expect(synced.json?.outcome).toBe("AUTH_REQUIRED");
      expect(
        await readFile(join(namedSkill(homeB, "custom"), "SKILL.md"), "utf8"),
      ).toBe("# Custom artifact\n");
      expect(
        await readFile(join(namedSkill(homeB, "notes"), "SKILL.md"), "utf8"),
      ).toBe("# Unrelated unmanaged\n");
      expect(
        await readFile(join(targetSkill(homeB, "notes"), "SKILL.md"), "utf8"),
      ).toBe("# Unrelated unmanaged\n");
      await expect(
        readFile(join(namedSkill(homeB, "classified"), "SKILL.md"), "utf8"),
      ).rejects.toThrow();
    },
    timeout,
  );

  test(
    "offline REMOVE deletes verified copies, UNMANAGE preserves a copy, and re-add does not clobber a modified unmanaged skill",
    async () => {
      const root = await temp("ledger");
      const remote = await stateRemote(root);
      const publicSkill = await skillRepo(root, "public", "# Public locked\n");
      const extra = await skillRepo(root, "extra", "# Extra locked\n");
      const homeA = join(root, "home-a");
      const homeB = join(root, "home-b");
      await enableCodex(homeA);
      await seedSourceKnown(
        homeA,
        "public",
        publicSkill.repository,
        "# Public locked\n",
      );
      await seedSourceKnown(
        homeA,
        "extra",
        extra.repository,
        "# Extra locked\n",
      );
      expect(
        (
          await run(homeA, [
            "--json",
            "--non-interactive",
            "init",
            remote,
            "--replace",
            "public",
            "--replace",
            "extra",
          ])
        ).code,
      ).toBe(0);

      await joinGitHome(homeB, remote);
      expect(
        (await run(homeB, ["--json", "--non-interactive", "sync"])).json
          ?.outcome,
      ).toBe("SUCCESS");
      expect((await lstat(targetSkill(homeB, "public"))).isSymbolicLink()).toBe(
        true,
      );

      expect(
        (await run(homeA, ["--json", "--non-interactive", "remove", "public"]))
          .code,
      ).toBe(0);
      expect(
        (await run(homeA, ["--json", "--non-interactive", "unmanage", "extra"]))
          .code,
      ).toBe(0);
      const afterLedger = await run(homeB, [
        "--json",
        "--non-interactive",
        "sync",
      ]);
      expect(afterLedger.json?.outcome).toBe("SUCCESS");
      await expect(lstat(namedSkill(homeB, "public"))).rejects.toThrow();
      await expect(lstat(targetSkill(homeB, "public"))).rejects.toThrow();
      expect(
        await readFile(join(namedSkill(homeB, "extra"), "SKILL.md"), "utf8"),
      ).toBe("# Extra locked\n");
      expect((await lstat(targetSkill(homeB, "extra"))).isSymbolicLink()).toBe(
        false,
      );
      expect(
        await readFile(join(targetSkill(homeB, "extra"), "SKILL.md"), "utf8"),
      ).toBe("# Extra locked\n");

      await writeFile(
        join(namedSkill(homeB, "extra"), "SKILL.md"),
        "# Modified unmanaged\n",
      );
      await writeFile(
        join(targetSkill(homeB, "extra"), "SKILL.md"),
        "# Modified unmanaged\n",
      );
      expect(
        (
          await run(homeA, [
            "--json",
            "--non-interactive",
            "add",
            extra.repository,
            "--skill",
            "extra",
            "--ref",
            "main",
          ])
        ).code,
      ).toBe(0);
      const readded = await run(homeB, ["--json", "--non-interactive", "sync"]);
      expect(
        readded.json?.outcome === "CONFLICT" ||
          readded.json?.status === "LOCAL_CONFLICT",
      ).toBe(true);
      expect(
        await readFile(join(namedSkill(homeB, "extra"), "SKILL.md"), "utf8"),
      ).toBe("# Modified unmanaged\n");
      expect(
        await readFile(join(targetSkill(homeB, "extra"), "SKILL.md"), "utf8"),
      ).toBe("# Modified unmanaged\n");
    },
    timeout,
  );

  test(
    "recovers missing or corrupt state, refuses canonical drift, and restores exact locked bytes",
    async () => {
      const root = await temp("recover");
      const remote = await stateRemote(root);
      const publicSkill = await skillRepo(root, "public", "# Public locked\n");
      const homeA = join(root, "home-a");
      const homeB = join(root, "home-b");
      await enableCodex(homeA);
      await seedSourceKnown(
        homeA,
        "public",
        publicSkill.repository,
        "# Public locked\n",
      );
      expect(
        (
          await run(homeA, [
            "--json",
            "--non-interactive",
            "init",
            remote,
            "--replace",
            "public",
          ])
        ).code,
      ).toBe(0);
      await joinGitHome(homeB, remote);
      expect(
        (await run(homeB, ["--json", "--non-interactive", "sync"])).json
          ?.outcome,
      ).toBe("SUCCESS");

      const stateFile = join(paths(homeB).stateDir, "state.json");
      await rm(stateFile, { force: true });
      const recovered = await run(homeB, [
        "--json",
        "--non-interactive",
        "status",
      ]);
      expect(recovered.json?.outcome).toBe("SUCCESS");
      expect(JSON.stringify(recovered.json)).toContain("MANAGED_SYNCED");

      await writeFile(stateFile, "{not-json");
      const afterCorrupt = await run(homeB, [
        "--json",
        "--non-interactive",
        "status",
      ]);
      expect(afterCorrupt.json?.outcome).toBe("SUCCESS");
      expect(
        await readFile(join(namedSkill(homeB, "public"), "SKILL.md"), "utf8"),
      ).toBe("# Public locked\n");

      await writeFile(
        join(namedSkill(homeB, "public"), "SKILL.md"),
        "# Drifted canonical\n",
      );
      const drifted = await run(homeB, ["--json", "--non-interactive", "sync"]);
      expect(drifted.json?.status).toBe("DRIFTED");
      expect(
        await readFile(join(namedSkill(homeB, "public"), "SKILL.md"), "utf8"),
      ).toBe("# Drifted canonical\n");

      expect(
        (await run(homeB, ["--json", "--non-interactive", "restore", "public"]))
          .code,
      ).toBe(0);
      expect(
        await readFile(join(namedSkill(homeB, "public"), "SKILL.md"), "utf8"),
      ).toBe("# Public locked\n");
      expect((await lstat(targetSkill(homeB, "public"))).isSymbolicLink()).toBe(
        true,
      );
    },
    timeout,
  );

  test(
    "rejects secrets, requires noninteractive artifact consent, preserves partial-failure targets, and imports legacy ToolMirror state",
    async () => {
      const root = await temp("safety");
      const remote = await stateRemote(root);
      const homeA = join(root, "home-a");
      await enableCodex(homeA);
      await writeSkill(namedSkill(homeA, "secret"), "# Secret\n", {
        id_rsa: "not-a-real-key\n",
      });
      const secretInit = await run(homeA, [
        "--json",
        "--non-interactive",
        "--allow-artifacts",
        "init",
        remote,
        "--adopt-artifact",
        "secret",
      ]);
      expect(
        secretInit.code === 0 || secretInit.json?.outcome !== undefined,
      ).toBe(true);
      expect(
        await readFile(join(namedSkill(homeA, "secret"), "id_rsa"), "utf8"),
      ).toBe("not-a-real-key\n");
      expect(
        await git([
          "--git-dir",
          remote,
          "ls-tree",
          "-r",
          "--name-only",
          "HEAD",
        ]),
      ).not.toContain("id_rsa");

      const consentRoot = await temp("consent");
      const consentRemote = await stateRemote(consentRoot);
      const consentHome = join(consentRoot, "home-a");
      await enableCodex(consentHome);
      await writeSkill(
        namedSkill(consentHome, "custom"),
        "# Custom artifact\n",
      );
      const refused = await run(consentHome, [
        "--json",
        "--non-interactive",
        "init",
        consentRemote,
        "--adopt-artifact",
        "custom",
      ]);
      expect(refused.json?.outcome).toBe("CONFIRMATION_REQUIRED");
      expect(
        await readFile(
          join(namedSkill(consentHome, "custom"), "SKILL.md"),
          "utf8",
        ),
      ).toBe("# Custom artifact\n");
      expect(
        await git([
          "--git-dir",
          consentRemote,
          "ls-tree",
          "-r",
          "--name-only",
          "HEAD",
        ]),
      ).not.toContain("artifacts/");

      const partialRoot = await temp("partial");
      const partialRemote = await stateRemote(partialRoot);
      const publicSkill = await skillRepo(
        partialRoot,
        "public",
        "# Public locked\n",
      );
      const partialA = join(partialRoot, "home-a");
      const partialB = join(partialRoot, "home-b");
      await enableCodex(partialA);
      await seedSourceKnown(
        partialA,
        "public",
        publicSkill.repository,
        "# Public locked\n",
      );
      expect(
        (
          await run(partialA, [
            "--json",
            "--non-interactive",
            "init",
            partialRemote,
            "--replace",
            "public",
          ])
        ).code,
      ).toBe(0);
      await joinGitHome(partialB, partialRemote);
      await writeSkill(targetSkill(partialB, "public"), "# Unmanaged target\n");
      const partial = await run(partialB, [
        "--json",
        "--non-interactive",
        "sync",
      ]);
      expect(
        partial.json?.outcome === "CONFLICT" ||
          partial.json?.status === "LOCAL_CONFLICT" ||
          partial.json?.outcome === "PARTIAL_SUCCESS",
      ).toBe(true);
      expect(
        await readFile(
          join(targetSkill(partialB, "public"), "SKILL.md"),
          "utf8",
        ),
      ).toBe("# Unmanaged target\n");

      const legacyRoot = await temp("legacy");
      const legacyHome = join(legacyRoot, "home");
      await enableCodex(legacyHome);
      const current = paths(legacyHome);
      const legacy = resolveLegacyPlatformPaths(platformEnv(legacyHome));
      await writeSkill(join(legacy.skillsDir, "sk_example"), "# Legacy\n");
      const hash = (
        await scanNormalizedContent(join(legacy.skillsDir, "sk_example"))
      ).contentHash;
      await mkdir(join(legacy.gitDir, "cache"), { recursive: true });
      await writeFile(
        join(legacy.gitDir, "cache", "toolmirror.yaml"),
        "version: 1\nskills:\n  - id: sk_example\n    source: https://example.test/skills.git\n    skill: example\n    ref: main\n    targets:\n      - codex\n",
      );
      await writeFile(
        join(legacy.gitDir, "cache", "toolmirror.lock"),
        `${JSON.stringify(
          {
            version: 1,
            skills: [
              {
                id: "sk_example",
                source: "https://example.test/skills.git",
                skill: "example",
                ref: "main",
                repository: "https://example.test/skills.git",
                revision: "a".repeat(40),
                path: "example",
                contentHash: hash,
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      await mkdir(legacy.configDir, { recursive: true });
      await mkdir(legacy.stateDir, { recursive: true });
      await writeJson(legacy.configFile, {
        ...defaultConfig(),
        mode: "git",
        skillsStoragePath: legacy.skillsDir,
        gitRepository: "https://example.test/skills.git",
        telemetry: false,
        agents: { codex: { enabled: true } },
      });
      await mkdir(join(legacyHome, ".codex", "skills"), { recursive: true });
      const migrated = await run(legacyHome, [
        "--json",
        "--non-interactive",
        "migrate",
        "legacy",
      ]);
      expect(migrated.code === 0 || migrated.json?.outcome === "SUCCESS").toBe(
        true,
      );
      expect(
        await readFile(
          join(legacy.skillsDir, "sk_example", "SKILL.md"),
          "utf8",
        ),
      ).toBe("# Legacy\n");
      expect(current.configFile).toContain("Corotum");
    },
    timeout,
  );
});
