import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type CliIo, runCli } from "./cli";
import { ExitCode } from "./cli-contracts";
import { defaultConfig } from "./config";
import { resolvePlatformPaths } from "./platform";

const roots: string[] = [];
const cli = join(import.meta.dir, "index.ts");
const timeout = 20_000;

const deviceCode = "device-code-secret-value";
const deviceToken = "plaintext-device-token-secret";
const userCode = "WXYZ-1234";
const deviceId = "dev_1";
const workspaceId = "ws_1";
const pairingId = "pair_init";

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
  const path = await mkdtemp(join(tmpdir(), `corotum-init-cloud-cli-${name}-`));
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

function fixtureIo(stdinIsTTY: boolean): {
  io: CliIo;
  output: string[];
  errors: string[];
} {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      stdinIsTTY,
      writeError: (message) => errors.push(message),
      writeOutput: (message) => output.push(message),
      readQuestion: async () => {
        throw new Error("init cloud must not prompt");
      },
    },
    output,
    errors,
  };
}

const isolatedKeys = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "COROTUM_CLOUD_ORIGIN",
] as const;

async function withIsolatedHome<T>(
  home: string,
  extra: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of isolatedKeys) previous.set(key, process.env[key]);
  Object.assign(process.env, platformEnv(home).env, extra);
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function startCloudServer(options?: { stateStatus?: number }): {
  origin: string;
  stop: () => void;
  requests: string[];
} {
  const requests: string[] = [];
  let revisionId: string | null = null;
  let state: typeof emptyState = emptyState;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method === "POST" && url.pathname === "/api/v1/cli/pairings") {
        return Response.json(
          {
            id: pairingId,
            deviceCode,
            userCode,
            expiresAt: Date.now() + 60_000,
          },
          { status: 201 },
        );
      }
      if (
        request.method === "GET" &&
        url.pathname === `/api/v1/cli/pairings/${pairingId}`
      ) {
        return Response.json({ status: "APPROVED" });
      }
      if (
        request.method === "POST" &&
        url.pathname === `/api/v1/cli/pairings/${pairingId}/token`
      ) {
        return Response.json(
          { token: deviceToken, deviceId, workspaceId },
          { status: 201 },
        );
      }
      if (/\/api\/v1\/workspaces\/[^/]+\/state$/.test(url.pathname)) {
        if (options?.stateStatus === 402) {
          return Response.json(
            { error: "Hosted Cloud subscription required" },
            { status: 402 },
          );
        }
        if (request.method === "GET") {
          return Response.json({
            revisionId,
            revisionSequence: revisionId ? 1 : 0,
            state,
            dispositionLedger: { version: 2, activeDispositions: {} },
          });
        }
        if (request.method === "PUT") {
          const body = (await request.json()) as { state?: typeof emptyState };
          if (body.state) state = body.state;
          revisionId = "rev_init";
          return Response.json({
            revisionId,
            revisionSequence: 1,
            state,
            dispositionLedger: { version: 2, activeDispositions: {} },
          });
        }
      }
      if (/\/api\/v1\/workspaces\/[^/]+\/artifacts$/.test(url.pathname)) {
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    requests,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function seedPairedDevice(home: string): Promise<void> {
  const resolved = paths(home);
  await writeJson(resolved.credentialsFile, {
    schemaVersion: 1,
    cloudDeviceToken: deviceToken,
  });
  await writeJson(resolved.configFile, {
    ...defaultConfig(),
    workspaceId,
    deviceId,
  });
}

describe("real corotum init cloud CLI", () => {
  test(
    "clean HOME, zero agents, and missing skills dir initialize Cloud Sync",
    async () => {
      const home = await temp("empty");
      const cloud = startCloudServer();
      await seedPairedDevice(home);
      try {
        const started = Date.now();
        const result = await spawnCli(home, [
          "--json",
          "--non-interactive",
          "init",
          "cloud",
          "--origin",
          cloud.origin,
        ]);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("Initialized Corotum Cloud");
        expect(JSON.stringify(result)).not.toContain(deviceToken);
        const config = JSON.parse(await readFile(paths(home).configFile, "utf8")) as {
          mode: string;
          workspaceId: string;
          agents: Record<string, { enabled: boolean }>;
        };
        expect(config.mode).toBe("cloud");
        expect(config.workspaceId).toBe(workspaceId);
        expect(config.agents).toEqual({});
        expect(cloud.requests.some((item) => item.endsWith("/state"))).toBe(true);
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );

  test(
    "existing global skills are discovered without agents and stay local unless adopted",
    async () => {
      const home = await temp("skills");
      const cloud = startCloudServer();
      await seedPairedDevice(home);
      const skill = join(home, ".agents", "skills", "notes");
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, "SKILL.md"), "# Notes\n");
      await mkdir(join(home, ".codex", "skills", "ignored"), { recursive: true });
      await writeFile(
        join(home, ".codex", "skills", "ignored", "SKILL.md"),
        "# Agent only\n",
      );
      try {
        const result = await spawnCli(home, [
          "--json",
          "--non-interactive",
          "init",
          "cloud",
          "--origin",
          cloud.origin,
        ]);
        expect(result.code).toBe(0);
        expect(result.stderr).toContain("notes:");
        expect(result.stderr).not.toContain("ignored");
        expect(await readFile(join(skill, "SKILL.md"), "utf8")).toBe("# Notes\n");
        expect(
          await readFile(join(home, ".codex", "skills", "ignored", "SKILL.md"), "utf8"),
        ).toBe("# Agent only\n");
        const config = JSON.parse(await readFile(paths(home).configFile, "utf8")) as {
          mode: string;
          agents: Record<string, { enabled: boolean }>;
        };
        expect(config.mode).toBe("cloud");
        expect(config.agents).toEqual({});
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );

  test(
    "already initialized git or cloud is a typed ALREADY_INITIALIZED error",
    async () => {
      const gitHome = await temp("already-git");
      await writeJson(paths(gitHome).configFile, {
        ...defaultConfig(),
        mode: "git",
        gitRepository: "/tmp/already.git",
      });
      const git = await spawnCli(gitHome, [
        "--json",
        "--non-interactive",
        "init",
        "cloud",
      ]);
      expect(git.code).toBe(ExitCode.CONFLICT);
      expect(git.json?.outcome).toBe("CONFLICT");
      expect(String(git.json?.error ?? git.stderr)).toContain("already configured");

      const cloudHome = await temp("already-cloud");
      await writeJson(paths(cloudHome).configFile, {
        ...defaultConfig(),
        mode: "cloud",
        workspaceId,
        deviceId,
      });
      const cloud = await spawnCli(cloudHome, [
        "--json",
        "--non-interactive",
        "init",
        "cloud",
      ]);
      expect(cloud.code).toBe(ExitCode.CONFLICT);
      expect(cloud.json?.outcome).toBe("CONFLICT");
      expect(String(cloud.json?.error ?? cloud.stderr)).toContain("already configured");
    },
    timeout,
  );

  test(
    "hosted 402 fails init after pairing and does not require agents",
    async () => {
      const home = await temp("hosted-402");
      const cloud = startCloudServer({ stateStatus: 402 });
      const fixture = fixtureIo(true);
      try {
        const code = await withIsolatedHome(
          home,
          { COROTUM_CLOUD_ORIGIN: cloud.origin },
          () => runCli(["--json", "init", "cloud", "--origin", cloud.origin], fixture.io),
        );
        expect(code).toBe(ExitCode.GENERAL_ERROR);
        expect(homedir()).not.toBe(home);
        const printed = `${fixture.output.join("")}${fixture.errors.join("")}`;
        expect(printed).toContain("Hosted Cloud subscription required");
        expect(printed).toContain("Pairing succeeded");
        expect(printed).not.toContain(deviceToken);
        expect(printed).not.toContain(deviceCode);
        expect(cloud.requests.some((item) => item.includes("/cli/pairings"))).toBe(
          true,
        );
        const config = JSON.parse(await readFile(paths(home).configFile, "utf8")) as {
          mode: string | null;
          workspaceId: string | null;
        };
        expect(config.mode).toBeNull();
        expect(config.workspaceId).toBe(workspaceId);
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );

  test(
    "non-interactive missing login fails typed without polling",
    async () => {
      const home = await temp("no-login");
      const started = Date.now();
      const result = await spawnCli(home, [
        "--json",
        "--non-interactive",
        "init",
        "cloud",
        "--origin",
        "https://corotum.com",
      ]);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.code).toBe(ExitCode.GENERAL_ERROR);
      expect(result.json?.outcome).toBe("GENERAL_ERROR");
      expect(String(result.json?.error ?? result.stderr)).toContain(
        "interactive terminal",
      );
    },
    timeout,
  );

  test(
    "TTY init cloud completes without an agent on a clean machine",
    async () => {
      const home = await temp("tty-cloud");
      const cloud = startCloudServer();
      const fixture = fixtureIo(true);
      await seedPairedDevice(home);
      try {
        const code = await withIsolatedHome(
          home,
          { COROTUM_CLOUD_ORIGIN: cloud.origin },
          () => runCli(["init", "cloud", "--origin", cloud.origin], fixture.io),
        );
        expect(code).toBe(ExitCode.SUCCESS);
        expect(fixture.output.join("")).toContain("Initialized Corotum Cloud");
        expect(`${fixture.output.join("")}${fixture.errors.join("")}`).not.toContain(
          deviceToken,
        );
        const config = JSON.parse(await readFile(paths(home).configFile, "utf8")) as {
          mode: string;
          agents: Record<string, { enabled: boolean }>;
        };
        expect(config.mode).toBe("cloud");
        expect(config.agents).toEqual({});
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );
});
