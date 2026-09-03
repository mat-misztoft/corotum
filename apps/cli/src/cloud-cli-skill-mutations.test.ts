import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ARTIFACT_DESCRIPTOR_HEADER } from "../../../packages/saas-provider/src/index";
import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import { ExitCode } from "./cli-contracts";
import { defaultConfig } from "./config";
import { resolvePlatformPaths } from "./platform";

const roots: string[] = [];
const cli = join(import.meta.dir, "index.ts");
const timeout = 45_000;

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
    roots.splice(0).map(async (root) => {
      await Bun.spawn(["chmod", "-R", "u+rwx", root], {
        stderr: "pipe",
        stdout: "pipe",
      }).exited;
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function temp(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `corotum-cloud-mutations-${name}-`));
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

async function writeSkill(directory: string, body: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), body);
}

function namedSkill(home: string, name: string): string {
  return join(home, ".agents", "skills", name);
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
  await writeSkill(join(repository, "skills", name), body);
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
  revisionId?: string | null;
  hostedDenied?: boolean;
  unauthorized?: boolean;
}): {
  origin: string;
  stop: () => void;
  state: () => typeof emptyState;
} {
  const artifacts = new Map<string, Uint8Array>();
  let puts = 0;
  let revisionId = options?.revisionId ?? "rev_empty";
  let state = options?.state ?? emptyState;
  let ledger = emptyLedger;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
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
            revisionSequence: puts,
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
            return Response.json(
              { error: "Artifact object is missing." },
              { status: 404 },
            );
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
    state: () => state,
  };
}

describe("real corotum Cloud skill mutation CLI", () => {
  test(
    "zero-agent add/adopt/update/set-ref/restore/unmanage/remove leave unmanaged files",
    async () => {
      const root = await temp("lifecycle");
      const notes = await skillRepo(root, "notes", "# Notes\n");
      const tasks = await skillRepo(root, "tasks", "# Tasks\n");
      const home = join(root, "home");
      await seedCloudHome(home);
      await writeSkill(namedSkill(home, "keep-me"), "# Unmanaged\n");
      const cloud = startCloudServer();
      const env = { COROTUM_CLOUD_ORIGIN: cloud.origin };
      try {
        const added = await spawnCli(
          home,
          [
            "--json",
            "--non-interactive",
            "add",
            notes.repository,
            "--skill",
            "notes",
            "--ref",
            "main",
          ],
          env,
        );
        expect(added.code).toBe(0);
        expect(added.json).toMatchObject({
          outcome: "SUCCESS",
          status: "ADDED",
        });
        expect(
          await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8"),
        ).toBe("# Notes\n");
        expect(JSON.stringify(added)).not.toContain(deviceToken);

        await writeSkill(namedSkill(home, "tasks"), "# Local tasks\n");
        const adopted = await spawnCli(
          home,
          [
            "--json",
            "--non-interactive",
            "adopt",
            "tasks",
            "--source",
            tasks.repository,
            "--ref",
            "main",
          ],
          env,
        );
        expect(adopted.code).toBe(0);
        expect(adopted.json).toMatchObject({
          outcome: "SUCCESS",
          status: "ADOPTED",
        });
        expect(
          await readFile(join(namedSkill(home, "tasks"), "SKILL.md"), "utf8"),
        ).toBe("# Local tasks\n");

        await writeSkill(join(notes.repository, "skills", "notes"), "# Notes v2\n");
        await git(["-C", notes.repository, "add", "."]);
        await git(["-C", notes.repository, "commit", "-m", "notes v2"]);
        await git(["-C", notes.repository, "tag", "v2"]);

        const checked = await spawnCli(
          home,
          ["--json", "--non-interactive", "update", "--check", "notes"],
          env,
        );
        expect(checked.json).toMatchObject({ status: "CHECKED" });
        expect(
          (checked.json?.skills as { status: string }[])[0]?.status,
        ).toBe("UPDATE_AVAILABLE");

        const updated = await spawnCli(
          home,
          ["--json", "--non-interactive", "update", "notes"],
          env,
        );
        expect(updated.code).toBe(0);
        expect(updated.json).toMatchObject({ status: "UPDATED" });
        expect(
          await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8"),
        ).toBe("# Notes v2\n");

        const setRef = await spawnCli(
          home,
          ["--json", "--non-interactive", "set-ref", "notes", "v2"],
          env,
        );
        expect(setRef.code).toBe(0);
        expect(setRef.json).toMatchObject({ status: "SET_REF", ref: "v2" });

        await writeFile(join(namedSkill(home, "notes"), "SKILL.md"), "# Drift\n");
        const restored = await spawnCli(
          home,
          ["--json", "--non-interactive", "restore", "notes"],
          env,
        );
        expect(restored.code).toBe(0);
        expect(
          await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8"),
        ).toBe("# Notes v2\n");

        const unmanaged = await spawnCli(
          home,
          ["--json", "--non-interactive", "unmanage", "tasks"],
          env,
        );
        expect(unmanaged.code).toBe(0);
        expect(
          await readFile(join(namedSkill(home, "tasks"), "SKILL.md"), "utf8"),
        ).toBe("# Local tasks\n");

        const removed = await spawnCli(
          home,
          ["--json", "--non-interactive", "remove", "notes"],
          env,
        );
        expect(removed.code).toBe(0);
        await expect(
          readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8"),
        ).rejects.toThrow();
        expect(
          await readFile(join(namedSkill(home, "keep-me"), "SKILL.md"), "utf8"),
        ).toBe("# Unmanaged\n");
        expect(JSON.parse(await readFile(paths(home).configFile, "utf8"))).toMatchObject({
          mode: "cloud",
          agents: {},
        });
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );

  test(
    "missing login, hosted 402, and private source AUTH_REQUIRED are typed",
    async () => {
      const root = await temp("errors");
      const home = join(root, "home");
      const privateSkill = await skillRepo(root, "classified", "# Secret\n");
      await seedCloudHome(home, { token: null });

      const noLogin = await spawnCli(home, [
        "--json",
        "--non-interactive",
        "add",
        privateSkill.repository,
        "--skill",
        "classified",
      ]);
      expect(noLogin.code).toBe(ExitCode.AUTH_REQUIRED);
      expect(String(noLogin.json?.error ?? noLogin.stderr)).toContain(
        "corotum login",
      );

      await seedCloudHome(home);
      const hosted = startCloudServer({ hostedDenied: true });
      try {
        const denied = await spawnCli(
          home,
          [
            "--json",
            "--non-interactive",
            "add",
            privateSkill.repository,
            "--skill",
            "classified",
            "--ref",
            "main",
          ],
          { COROTUM_CLOUD_ORIGIN: hosted.origin },
        );
        expect(denied.code).toBe(ExitCode.GENERAL_ERROR);
        expect(String(denied.json?.error ?? denied.stderr)).toContain(
          "Hosted Cloud subscription required",
        );
      } finally {
        hosted.stop();
      }

      await Bun.spawn(["chmod", "-R", "a-rwx", privateSkill.repository], {
        stderr: "pipe",
        stdout: "pipe",
      }).exited;
      const cloud = startCloudServer();
      try {
        const auth = await spawnCli(
          home,
          [
            "--json",
            "--non-interactive",
            "add",
            privateSkill.repository,
            "--skill",
            "classified",
            "--ref",
            "main",
          ],
          { COROTUM_CLOUD_ORIGIN: cloud.origin },
        );
        expect(auth.code).toBe(ExitCode.AUTH_REQUIRED);
        expect(JSON.stringify(auth)).not.toContain(deviceToken);
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );

  test(
    "CLI update resolves PENDING_RESOLUTION when Git is available",
    async () => {
      const root = await temp("pending");
      const notes = await skillRepo(root, "notes", "# Notes\n");
      const home = join(root, "home");
      await seedCloudHome(home);
      const pending = {
        manifest: {
          version: 2,
          skills: [
            {
              id: "sk_pendingnotes000000000000000001",
              name: "notes",
              targets: "all",
              source: {
                repository: notes.repository,
                path: "skills/notes",
                ref: "main",
              },
              resolutionStatus: "PENDING_RESOLUTION",
            },
          ],
        },
        lockfile: { version: 2, skills: [] },
      };
      const cloud = startCloudServer({ state: pending, revisionId: "rev_pending" });
      try {
        const updated = await spawnCli(
          home,
          ["--json", "--non-interactive", "update", "notes"],
          { COROTUM_CLOUD_ORIGIN: cloud.origin },
        );
        expect(updated.code).toBe(0);
        expect(updated.json).toMatchObject({ status: "UPDATED" });
        const resolved = cloud.state().manifest.skills[0] as {
          resolutionStatus?: string;
        };
        expect(resolved.resolutionStatus).toBe("RESOLVED");
        expect(
          await readFile(join(namedSkill(home, "notes"), "SKILL.md"), "utf8"),
        ).toBe("# Notes\n");
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );
});
