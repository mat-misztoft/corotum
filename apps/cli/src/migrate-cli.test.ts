import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import { ARTIFACT_DESCRIPTOR_HEADER } from "../../../packages/saas-provider/src/index";
import { ExitCode } from "./cli-contracts";
import { defaultConfig } from "./config";
import { resolvePlatformPaths } from "./platform";

const roots: string[] = [];
const cli = join(import.meta.dir, "index.ts");
const timeout = 60_000;

const deviceToken = "plaintext-device-token-secret";
const deviceId = "dev_1";
const workspaceId = "ws_1";

const emptyState = {
  manifest: { version: 2, skills: [] as unknown[] },
  lockfile: { version: 2, skills: [] as unknown[] },
};

const emptyLedger = { version: 2, activeDispositions: {} };

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temp(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `corotum-migrate-cli-${name}-`));
  roots.push(path);
  return path;
}

function platformEnv(home: string) {
  return {
    homeDir: home,
    platform: process.platform as "darwin" | "linux" | "win32",
    env: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
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
  extra: Record<string, string | undefined> = {},
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
    ...Object.fromEntries(
      Object.entries(extra).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  };
}

type CliResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
  json?: Record<string, unknown>;
}>;

async function spawnCli(
  home: string,
  args: readonly string[],
  extraEnv: Record<string, string | undefined> = {},
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
): Promise<{ repository: string; revision: string; contentHash: string }> {
  const repository = join(root, `${name}.git`);
  await git(["init", "--initial-branch=main", repository]);
  await git(["-C", repository, "config", "user.email", "tests@corotum.invalid"]);
  await git(["-C", repository, "config", "user.name", "Corotum tests"]);
  await mkdir(join(repository, "skills", name), { recursive: true });
  await writeFile(join(repository, "skills", name, "SKILL.md"), body);
  await git(["-C", repository, "add", "."]);
  await git(["-C", repository, "commit", "-m", name]);
  return {
    repository,
    revision: await git(["-C", repository, "rev-parse", "HEAD"]),
    contentHash: (
      await scanNormalizedContent(join(repository, "skills", name))
    ).contentHash,
  };
}

async function readConfig(home: string) {
  return JSON.parse(await readFile(paths(home).configFile, "utf8")) as {
    mode: string | null;
    gitRepository: string | null;
    workspaceId: string | null;
  };
}

async function seedLogin(home: string): Promise<void> {
  const resolved = paths(home);
  const config = await readConfig(home).catch(() => defaultConfig());
  await writeJson(resolved.configFile, {
    ...defaultConfig(),
    ...config,
    workspaceId,
    deviceId,
  });
  await writeJson(resolved.credentialsFile, {
    schemaVersion: 1,
    cloudDeviceToken: deviceToken,
  });
}

async function seedCloudHome(home: string, options?: { token?: string | null }) {
  await writeJson(paths(home).configFile, {
    ...defaultConfig(),
    mode: "cloud",
    workspaceId,
    deviceId,
  });
  if (options?.token !== null) {
    await writeJson(paths(home).credentialsFile, {
      schemaVersion: 1,
      cloudDeviceToken: options?.token ?? deviceToken,
    });
  }
}

function sourceSkill(input: {
  id: string;
  name: string;
  repository: string;
  revision: string;
  contentHash: string;
}) {
  return {
    manifest: {
      id: input.id,
      name: input.name,
      targets: "all" as const,
      source: {
        repository: input.repository,
        path: `skills/${input.name}`,
        ref: "main",
      },
      resolutionStatus: "RESOLVED" as const,
    },
    lock: {
      id: input.id,
      name: input.name,
      source: {
        repository: input.repository,
        path: `skills/${input.name}`,
        ref: "main",
        revision: input.revision,
        contentHash: input.contentHash,
      },
      materialization: {
        kind: "source" as const,
        contentHash: input.contentHash,
      },
    },
  };
}

function startCloudServer(options?: {
  state?: typeof emptyState;
  revisionId?: string | null;
  hostedDenied?: boolean;
  unauthorized?: boolean;
}): {
  origin: string;
  stop: () => void;
  requests: string[];
  puts: number;
  state: () => typeof emptyState;
  artifacts: Map<string, Uint8Array>;
} {
  const requests: string[] = [];
  const artifacts = new Map<string, Uint8Array>();
  let puts = 0;
  let revisionId = options?.revisionId ?? null;
  let state = options?.state ?? emptyState;
  let ledger = emptyLedger;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (options?.unauthorized) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (options?.hostedDenied) {
        return Response.json(
          { error: "Hosted Cloud subscription required" },
          { status: 402 },
        );
      }
      if (/\/api\/v1\/workspaces\/[^/]+\/state$/.test(url.pathname)) {
        if (request.method === "GET") {
          return Response.json({
            revisionId,
            revisionSequence: revisionId ? 1 : 0,
            state,
            dispositionLedger: ledger,
          });
        }
        if (request.method === "PUT") {
          const body = (await request.json()) as {
            state?: typeof emptyState;
            baseRevision?: string | null;
            dispositionLedger?: typeof emptyLedger;
          };
          if ((body.baseRevision ?? null) !== revisionId) {
            return Response.json(
              { error: "Cloud desired state has changed." },
              { status: 409 },
            );
          }
          state = body.state ?? state;
          ledger = body.dispositionLedger ?? ledger;
          puts += 1;
          revisionId = `rev_${puts}`;
          return Response.json({
            revisionId,
            revisionSequence: puts,
            state,
            dispositionLedger: ledger,
          });
        }
      }
      if (/\/api\/v1\/workspaces\/[^/]+\/artifacts$/.test(url.pathname)) {
        const descriptor = JSON.parse(
          request.headers.get(ARTIFACT_DESCRIPTOR_HEADER) ?? "null",
        ) as { artifact?: { locator?: string } } | null;
        const locator = descriptor?.artifact?.locator;
        if (!locator) {
          return Response.json({ error: "missing artifact" }, { status: 400 });
        }
        if (request.method === "PUT") {
          artifacts.set(locator, new Uint8Array(await request.arrayBuffer()));
          return new Response(null, { status: 204 });
        }
        if (request.method === "GET") {
          const bytes = artifacts.get(locator);
          if (!bytes) {
            return Response.json({ error: "Artifact object is missing." }, { status: 404 });
          }
          return new Response(bytes, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    requests,
    get puts() {
      return puts;
    },
    state: () => state,
    artifacts,
  };
}

describe("real corotum migrate CLI", () => {
  test(
    "missing strategy, invalid strategy, already-on-mode, missing login, and cancel do not mutate",
    async () => {
      const root = await temp("refuse");
      const remote = await stateRemote(root);
      const gitHome = join(root, "git-home");
      const unmanaged = join(gitHome, ".agents", "skills", "keep-me", "SKILL.md");
      await mkdir(dirname(unmanaged), { recursive: true });
      await writeFile(unmanaged, "# Unmanaged\n");
      expect(
        (
          await spawnCli(gitHome, [
            "--json",
            "--non-interactive",
            "init",
            "repository",
            remote,
          ])
        ).code,
      ).toBe(0);

      const missing = await spawnCli(gitHome, [
        "--json",
        "--non-interactive",
        "migrate",
        "cloud",
      ]);
      expect(missing.code).toBe(ExitCode.INVALID_CONFIG);
      expect(missing.json?.outcome).toBe("INVALID_CONFIG");
      expect(String(missing.json?.error ?? missing.stderr)).toContain(
        "--strategy",
      );
      expect((await readConfig(gitHome)).mode).toBe("git");
      expect(await readFile(unmanaged, "utf8")).toBe("# Unmanaged\n");

      const invalid = await spawnCli(gitHome, [
        "--json",
        "--non-interactive",
        "migrate",
        "cloud",
        "--strategy",
        "overwrite",
      ]);
      expect(invalid.code).toBe(ExitCode.INVALID_CONFIG);
      expect(String(invalid.json?.error ?? invalid.stderr)).toContain(
        "--strategy",
      );
      expect((await readConfig(gitHome)).mode).toBe("git");

      const alreadyGit = await spawnCli(gitHome, [
        "--json",
        "--non-interactive",
        "migrate",
        "git",
        remote,
        "--strategy",
        "replace",
      ]);
      expect(alreadyGit.code).toBe(ExitCode.CONFLICT);
      expect(alreadyGit.json?.outcome).toBe("CONFLICT");
      expect(String(alreadyGit.json?.error ?? alreadyGit.stderr)).toContain(
        "already using Git Sync",
      );

      const noLogin = await spawnCli(gitHome, [
        "--json",
        "--non-interactive",
        "migrate",
        "cloud",
        "--strategy",
        "replace",
      ]);
      expect(noLogin.code).toBe(ExitCode.AUTH_REQUIRED);
      expect(noLogin.json?.outcome).toBe("AUTH_REQUIRED");
      expect(String(noLogin.json?.error ?? noLogin.stderr)).toContain(
        "corotum login",
      );
      expect((await readConfig(gitHome)).mode).toBe("git");

      await seedLogin(gitHome);
      const cloud = startCloudServer();
      try {
        const cancelled = await spawnCli(
          gitHome,
          [
            "--json",
            "--non-interactive",
            "migrate",
            "cloud",
            "--strategy",
            "cancel",
            "--origin",
            cloud.origin,
          ],
          { COROTUM_CLOUD_ORIGIN: cloud.origin },
        );
        expect(cancelled.code).toBe(ExitCode.SUCCESS);
        expect(cancelled.json).toMatchObject({
          outcome: "SUCCESS",
          status: "CANCELLED",
        });
        expect((await readConfig(gitHome)).mode).toBe("git");
        expect(cloud.puts).toBe(0);
        expect(await readFile(unmanaged, "utf8")).toBe("# Unmanaged\n");
      } finally {
        cloud.stop();
      }

      const cloudHome = join(root, "cloud-home");
      await seedCloudHome(cloudHome);
      const alreadyCloud = await spawnCli(cloudHome, [
        "--json",
        "--non-interactive",
        "migrate",
        "cloud",
        "--strategy",
        "replace",
      ]);
      expect(alreadyCloud.code).toBe(ExitCode.CONFLICT);
      expect(String(alreadyCloud.json?.error ?? alreadyCloud.stderr)).toContain(
        "already using Cloud",
      );

      const missingRepo = await spawnCli(cloudHome, [
        "--json",
        "--non-interactive",
        "migrate",
        "git",
        "--strategy",
        "replace",
      ]);
      expect(missingRepo.code).toBe(ExitCode.INVALID_CONFIG);
      expect(missingRepo.json?.outcome).toBe("INVALID_CONFIG");
      expect(String(missingRepo.json?.error ?? missingRepo.stderr)).toMatch(
        /Git repository URL/i,
      );
      expect((await readConfig(cloudHome)).mode).toBe("cloud");

      const noToken = join(root, "cloud-no-token");
      await seedCloudHome(noToken, { token: null });
      const cloudNoLogin = await spawnCli(noToken, [
        "--json",
        "--non-interactive",
        "migrate",
        "git",
        remote,
        "--strategy",
        "replace",
      ]);
      expect(cloudNoLogin.code).toBe(ExitCode.AUTH_REQUIRED);
      expect(String(cloudNoLogin.json?.error ?? cloudNoLogin.stderr)).toContain(
        "corotum login",
      );
    },
    timeout,
  );

  test(
    "hosted 402 migrate-in does not switch mode; self-host replace and merge succeed",
    async () => {
      const root = await temp("hosted");
      const remote = await stateRemote(root);
      const other = await skillRepo(root, "other", "# Other\n");
      const home = join(root, "home");
      expect(
        (
          await spawnCli(home, [
            "--json",
            "--non-interactive",
            "init",
            "repository",
            remote,
          ])
        ).code,
      ).toBe(0);
      await seedLogin(home);

      const hosted = startCloudServer({ hostedDenied: true });
      try {
        const denied = await spawnCli(
          home,
          [
            "--json",
            "--non-interactive",
            "migrate",
            "cloud",
            "--strategy",
            "replace",
            "--origin",
            hosted.origin,
          ],
          { COROTUM_CLOUD_ORIGIN: hosted.origin },
        );
        expect(denied.code).toBe(ExitCode.GENERAL_ERROR);
        expect(String(denied.json?.error ?? denied.stderr)).toContain(
          "Hosted Cloud subscription required",
        );
        expect((await readConfig(home)).mode).toBe("git");
      } finally {
        hosted.stop();
      }

      const cloud = startCloudServer();
      try {
        const replaced = await spawnCli(
          home,
          [
            "--json",
            "--non-interactive",
            "migrate",
            "cloud",
            "--strategy",
            "replace",
            "--origin",
            cloud.origin,
          ],
          { COROTUM_CLOUD_ORIGIN: cloud.origin },
        );
        expect(replaced.code).toBe(ExitCode.SUCCESS);
        expect(replaced.json).toMatchObject({
          outcome: "SUCCESS",
          status: "MIGRATED",
          strategy: "replace",
        });
        expect((await readConfig(home)).mode).toBe("cloud");
        expect(cloud.puts).toBe(1);
      } finally {
        cloud.stop();
      }

      const mergeHome = join(root, "merge");
      const notes = await skillRepo(root, "notes", "# Notes\n");
      const mergeRemote = await stateRemote(join(root, "merge-remote"));
      await mkdir(join(mergeHome, ".agents", "skills"), { recursive: true });
      expect(
        (
          await spawnCli(mergeHome, [
            "--json",
            "--non-interactive",
            "init",
            "repository",
            mergeRemote,
          ])
        ).code,
      ).toBe(0);
      expect(
        (
          await spawnCli(mergeHome, [
            "--json",
            "--non-interactive",
            "add",
            notes.repository,
            "--skill",
            "notes",
          ])
        ).code,
      ).toBe(0);
      await seedLogin(mergeHome);
      const otherSkill = sourceSkill({
        id: "sk_cloudother",
        name: "other",
        repository: other.repository,
        revision: other.revision,
        contentHash: other.contentHash,
      });
      const mergeCloud = startCloudServer({
        revisionId: "rev_existing",
        state: {
          manifest: { version: 2, skills: [otherSkill.manifest] },
          lockfile: { version: 2, skills: [otherSkill.lock] },
        },
      });
      try {
        const merged = await spawnCli(
          mergeHome,
          [
            "--json",
            "--non-interactive",
            "migrate",
            "cloud",
            "--strategy",
            "merge",
            "--origin",
            mergeCloud.origin,
          ],
          { COROTUM_CLOUD_ORIGIN: mergeCloud.origin },
        );
        expect(merged.code).toBe(ExitCode.SUCCESS);
        expect(merged.json).toMatchObject({
          outcome: "SUCCESS",
          status: "MIGRATED",
          strategy: "merge",
        });
        const names = mergeCloud
          .state()
          .manifest.skills.map((skill) => (skill as { name: string }).name)
          .sort();
        expect(names).toEqual(["notes", "other"]);
        expect((await readConfig(mergeHome)).mode).toBe("cloud");
      } finally {
        mergeCloud.stop();
      }
    },
    timeout,
  );

  test(
    "Git direction requires system Git and artifacts plus source metadata round-trip",
    async () => {
      const root = await temp("roundtrip");
      const emptyBin = join(root, "empty-bin");
      await mkdir(emptyBin, { recursive: true });
      const cloudHome = join(root, "missing-git");
      await seedCloudHome(cloudHome);
      const dest = await stateRemote(join(root, "missing-git-remote"));
      const missingGit = await spawnCli(
        cloudHome,
        [
          "--json",
          "--non-interactive",
          "--allow-artifacts",
          "migrate",
          "git",
          dest,
          "--strategy",
          "replace",
        ],
        { PATH: emptyBin },
      );
      expect(missingGit.code).toBe(ExitCode.GENERAL_ERROR);
      expect(String(missingGit.json?.error ?? missingGit.stderr)).toContain(
        "Git is not installed",
      );
      expect((await readConfig(cloudHome)).mode).toBe("cloud");

      const remote = await stateRemote(root);
      const publicSkill = await skillRepo(root, "public", "# Public locked\n");
      const home = join(root, "home");
      await mkdir(join(home, ".agents", "skills", "custom"), { recursive: true });
      await writeFile(
        join(home, ".agents", "skills", "custom", "SKILL.md"),
        "# Custom artifact\n",
      );
      await mkdir(join(home, ".agents", "skills", "keep-me"), { recursive: true });
      await writeFile(
        join(home, ".agents", "skills", "keep-me", "SKILL.md"),
        "# Unmanaged stays\n",
      );
      expect(
        (
          await spawnCli(home, [
            "--json",
            "--non-interactive",
            "--allow-artifacts",
            "init",
            "repository",
            remote,
            "--adopt-artifact",
            "custom",
          ])
        ).code,
      ).toBe(0);
      expect(
        (
          await spawnCli(home, [
            "--json",
            "--non-interactive",
            "add",
            publicSkill.repository,
            "--skill",
            "public",
          ])
        ).code,
      ).toBe(0);
      await seedLogin(home);
      const cloud = startCloudServer();
      try {
        const toCloud = await spawnCli(
          home,
          [
            "--json",
            "--non-interactive",
            "migrate",
            "cloud",
            "--strategy",
            "replace",
            "--origin",
            cloud.origin,
          ],
          { COROTUM_CLOUD_ORIGIN: cloud.origin },
        );
        expect(toCloud.code).toBe(ExitCode.SUCCESS);
        expect((await readConfig(home)).mode).toBe("cloud");
        expect(await readFile(join(home, ".agents", "skills", "keep-me", "SKILL.md"), "utf8")).toBe(
          "# Unmanaged stays\n",
        );
        const cloudSkills = cloud.state().lockfile.skills as Array<{
          name: string;
          source?: { repository: string; revision: string };
          materialization: { kind: string; artifact?: { kind: string; locator: string } };
        }>;
        const publicLock = cloudSkills.find((skill) => skill.name === "public");
        const customLock = cloudSkills.find((skill) => skill.name === "custom");
        expect(publicLock?.source?.repository).toBe(publicSkill.repository);
        expect(publicLock?.source?.revision).toBe(publicSkill.revision);
        expect(customLock?.materialization.kind).toBe("artifact");
        expect(customLock?.materialization.artifact?.kind).toBe("r2-tar-zst");
        expect(cloud.artifacts.size).toBe(1);

        const backRemote = await stateRemote(join(root, "back"));
        const toGit = await spawnCli(
          home,
          [
            "--json",
            "--non-interactive",
            "--allow-artifacts",
            "migrate",
            "git",
            backRemote,
            "--strategy",
            "replace",
            "--origin",
            cloud.origin,
          ],
          { COROTUM_CLOUD_ORIGIN: cloud.origin },
        );
        expect(toGit.code).toBe(ExitCode.SUCCESS);
        expect(toGit.json).toMatchObject({
          outcome: "SUCCESS",
          status: "MIGRATED",
          strategy: "replace",
        });
        const config = await readConfig(home);
        expect(config.mode).toBe("git");
        expect(config.gitRepository).toBe(backRemote);
        expect(await readFile(join(home, ".agents", "skills", "keep-me", "SKILL.md"), "utf8")).toBe(
          "# Unmanaged stays\n",
        );
        const tracked = await git([
          "--git-dir",
          backRemote,
          "ls-tree",
          "-r",
          "--name-only",
          "HEAD",
        ]);
        expect(tracked).toContain("corotum.yaml");
        expect(tracked).toContain("corotum.lock");
        expect(tracked).toContain("artifacts/");
        const lockfile = JSON.parse(
          await git(["--git-dir", backRemote, "show", "HEAD:corotum.lock"]),
        ) as {
          skills: Array<{
            name: string;
            source?: { repository: string; revision: string };
            materialization: { kind: string; artifact?: { kind: string } };
          }>;
        };
        const backPublic = lockfile.skills.find((skill) => skill.name === "public");
        const backCustom = lockfile.skills.find((skill) => skill.name === "custom");
        expect(backPublic?.source?.repository).toBe(publicSkill.repository);
        expect(backPublic?.source?.revision).toBe(publicSkill.revision);
        expect(backCustom?.materialization.artifact?.kind).toBe("git-tree");
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );
});
