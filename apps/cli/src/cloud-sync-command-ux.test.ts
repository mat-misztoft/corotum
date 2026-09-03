import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import { ExitCode } from "./cli-contracts";
import { defaultConfig } from "./config";
import { resolvePlatformPaths } from "./platform";

const roots: string[] = [];
const cli = join(import.meta.dir, "index.ts");
const timeout = 30_000;

const deviceToken = "plaintext-device-token-secret";
const deviceId = "dev_1";
const workspaceId = "ws_1";

const emptyState = {
  manifest: { version: 2, skills: [] },
  lockfile: { version: 2, skills: [] },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temp(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `corotum-cloud-sync-ux-${name}-`));
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

async function seedCloudHome(
  home: string,
  options?: { token?: string | null },
): Promise<void> {
  const resolved = paths(home);
  await writeJson(resolved.configFile, {
    ...defaultConfig(),
    mode: "cloud",
    workspaceId,
    deviceId,
  });
  if (options?.token !== null) {
    await writeJson(resolved.credentialsFile, {
      schemaVersion: 1,
      cloudDeviceToken: options?.token ?? deviceToken,
    });
  }
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

function startCloudServer(options?: {
  state?: typeof emptyState;
  revisionId?: string;
  unauthorized?: boolean;
}): {
  origin: string;
  stop: () => void;
  requests: string[];
  reports: Record<string, unknown>[];
  setState: (state: typeof emptyState, revisionId: string) => void;
} {
  const requests: string[] = [];
  const reports: Record<string, unknown>[] = [];
  let revisionId = options?.revisionId ?? "rev_empty";
  let state = options?.state ?? emptyState;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (options?.unauthorized) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (/\/api\/v1\/workspaces\/[^/]+\/state$/.test(url.pathname)) {
        if (request.method === "GET") {
          return Response.json({
            revisionId,
            revisionSequence: 1,
            state,
            dispositionLedger: { version: 2, activeDispositions: {} },
          });
        }
      }
      if (/\/api\/v1\/devices\/[^/]+\/sync-report$/.test(url.pathname)) {
        const body = (await request.json()) as Record<string, unknown>;
        reports.push(body);
        return Response.json({
          deviceId,
          workspaceId,
          appliedRevisionId: body.appliedRevisionId ?? null,
          appliedRevisionSequence: 1,
          syncStatus: body.syncStatus,
          lastErrorCode: body.lastErrorCode ?? null,
          lastErrorMessage: body.lastErrorMessage ?? null,
          lastSyncAt: Date.now(),
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    requests,
    reports,
    setState(next, nextRevision) {
      state = next;
      revisionId = nextRevision;
    },
  };
}

describe("real corotum Cloud status/diff/sync CLI", () => {
  test(
    "zero agents and missing skills dir status/diff/sync and report after verify",
    async () => {
      const home = await temp("empty");
      await seedCloudHome(home);
      const cloud = startCloudServer();
      try {
        const env = { COROTUM_CLOUD_ORIGIN: cloud.origin };
        const status = await spawnCli(
          home,
          ["--json", "--non-interactive", "status"],
          env,
        );
        expect(status.code).toBe(ExitCode.SUCCESS);
        expect(status.json).toMatchObject({
          outcome: "SUCCESS",
          command: "STATUS",
          mode: "cloud",
          revision: "rev_empty",
        });
        expect(status.stderr).not.toMatch(/\?|Choice|Continue|Open /);
        expect(JSON.stringify(status)).not.toContain(deviceToken);

        const diff = await spawnCli(
          home,
          ["--json", "--non-interactive", "diff"],
          env,
        );
        expect(diff.code).toBe(ExitCode.SUCCESS);
        expect(diff.json).toMatchObject({
          command: "DIFF",
          mode: "cloud",
        });

        const synced = await spawnCli(
          home,
          ["--json", "--non-interactive", "sync"],
          env,
        );
        expect(synced.code).toBe(ExitCode.SUCCESS);
        expect(synced.json).toMatchObject({
          outcome: "SUCCESS",
          status: "SYNCED",
          command: "SYNC",
          mode: "cloud",
          revision: "rev_empty",
          appliedRevision: "rev_empty",
        });
        expect(cloud.reports).toEqual([
          expect.objectContaining({
            appliedRevisionId: "rev_empty",
            syncStatus: "SYNCED",
          }),
        ]);
        expect(cloud.requests.some((item) => item.startsWith("GET ") && item.endsWith("/state"))).toBe(
          true,
        );
        expect(cloud.requests.some((item) => item.includes("/cli/pairings"))).toBe(
          false,
        );
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );

  test(
    "missing token is a typed corotum login error without pairing",
    async () => {
      const home = await temp("no-token");
      await seedCloudHome(home, { token: null });
      const started = Date.now();
      const result = await spawnCli(home, [
        "--json",
        "--non-interactive",
        "status",
      ]);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.code).toBe(ExitCode.AUTH_REQUIRED);
      expect(result.json?.outcome).toBe("AUTH_REQUIRED");
      expect(String(result.json?.error ?? result.stderr)).toContain(
        "corotum login",
      );
      expect(result.stderr).not.toMatch(/\?|Choice|Continue|Open /);

      const sync = await spawnCli(home, [
        "--json",
        "--non-interactive",
        "sync",
      ]);
      expect(sync.code).toBe(ExitCode.AUTH_REQUIRED);
      expect(String(sync.json?.error ?? sync.stderr)).toContain("corotum login");
    },
    timeout,
  );

  test(
    "expired token during pull is typed login, not a silent inspect",
    async () => {
      const home = await temp("expired");
      await seedCloudHome(home);
      const cloud = startCloudServer({ unauthorized: true });
      try {
        const result = await spawnCli(
          home,
          ["--json", "--non-interactive", "diff"],
          { COROTUM_CLOUD_ORIGIN: cloud.origin },
        );
        expect(result.code).toBe(ExitCode.AUTH_REQUIRED);
        expect(result.json?.outcome).toBe("AUTH_REQUIRED");
        expect(String(result.json?.error ?? result.stderr)).toContain(
          "corotum login",
        );
        expect(cloud.reports).toEqual([]);
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );

  test(
    "status/diff/sync use the locked revision and never walk source HEAD",
    async () => {
      const root = await temp("lock");
      const home = join(root, "home");
      await seedCloudHome(home);
      const notes = await skillRepo(root, "notes", "# Locked\n");
      await writeFile(join(notes.repository, "skills", "notes", "SKILL.md"), "# HEAD\n");
      await git(["-C", notes.repository, "add", "."]);
      await git(["-C", notes.repository, "commit", "-m", "head"]);
      const head = await git(["-C", notes.repository, "rev-parse", "HEAD"]);
      expect(head).not.toBe(notes.revision);

      const state = {
        manifest: {
          version: 2,
          skills: [
            {
              id: "sk_noteslock",
              name: "notes",
              targets: "all",
              source: {
                repository: notes.repository,
                path: "skills/notes",
                ref: "main",
              },
              resolutionStatus: "RESOLVED",
            },
          ],
        },
        lockfile: {
          version: 2,
          skills: [
            {
              id: "sk_noteslock",
              name: "notes",
              source: {
                repository: notes.repository,
                path: "skills/notes",
                ref: "main",
                revision: notes.revision,
                contentHash: notes.contentHash,
              },
              materialization: {
                kind: "source",
                contentHash: notes.contentHash,
              },
            },
          ],
        },
      };
      const cloud = startCloudServer({ state, revisionId: "rev_locked" });
      try {
        const env = { COROTUM_CLOUD_ORIGIN: cloud.origin };
        const status = await spawnCli(
          home,
          ["--json", "--non-interactive", "status"],
          env,
        );
        expect(status.code).toBe(ExitCode.SUCCESS);
        expect(status.json).toMatchObject({
          mode: "cloud",
          revision: "rev_locked",
        });

        const synced = await spawnCli(
          home,
          ["--json", "--non-interactive", "sync"],
          env,
        );
        expect(synced.code).toBe(ExitCode.SUCCESS);
        expect(synced.json).toMatchObject({
          status: "SYNCED",
          appliedRevision: "rev_locked",
        });
        expect(
          await readFile(join(home, ".agents", "skills", "notes", "SKILL.md"), "utf8"),
        ).toBe("# Locked\n");
        expect(cloud.reports[0]).toMatchObject({
          appliedRevisionId: "rev_locked",
          syncStatus: "SYNCED",
        });
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );

  test(
    "partial skill failure reports PARTIALLY_SYNCED and does not claim full success",
    async () => {
      const root = await temp("partial");
      const home = join(root, "home");
      await seedCloudHome(home);
      const notes = await skillRepo(root, "notes", "# Locked\n");
      const named = join(home, ".agents", "skills", "notes");
      await mkdir(named, { recursive: true });
      await writeFile(join(named, "SKILL.md"), "# Unmanaged\n");

      const state = {
        manifest: {
          version: 2,
          skills: [
            {
              id: "sk_notespartial",
              name: "notes",
              targets: "all",
              source: {
                repository: notes.repository,
                path: "skills/notes",
                ref: "main",
              },
              resolutionStatus: "RESOLVED",
            },
          ],
        },
        lockfile: {
          version: 2,
          skills: [
            {
              id: "sk_notespartial",
              name: "notes",
              source: {
                repository: notes.repository,
                path: "skills/notes",
                ref: "main",
                revision: notes.revision,
                contentHash: notes.contentHash,
              },
              materialization: {
                kind: "source",
                contentHash: notes.contentHash,
              },
            },
          ],
        },
      };
      const cloud = startCloudServer({ state, revisionId: "rev_partial" });
      try {
        const synced = await spawnCli(
          home,
          ["--json", "--non-interactive", "sync"],
          { COROTUM_CLOUD_ORIGIN: cloud.origin },
        );
        expect(synced.json?.status).not.toBe("SYNCED");
        expect(["PARTIALLY_SYNCED", "LOCAL_CONFLICT", "DRIFTED"]).toContain(
          synced.json?.status,
        );
        expect(synced.json?.outcome).not.toBe("SUCCESS");
        expect(await readFile(join(named, "SKILL.md"), "utf8")).toBe(
          "# Unmanaged\n",
        );
        expect(cloud.reports[0]).toMatchObject({
          syncStatus: expect.stringMatching(/PARTIALLY_SYNCED|DRIFTED/),
        });
        expect(cloud.reports[0]?.appliedRevisionId).not.toBe("rev_partial");
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );
});
