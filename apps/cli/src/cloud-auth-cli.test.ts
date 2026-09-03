import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type CliIo, runCli } from "./cli";
import { ExitCode } from "./cli-contracts";
import { DEFAULT_CLOUD_ORIGIN } from "./cloud-auth";
import { resolvePlatformPaths } from "./platform";

const roots: string[] = [];
const cli = join(import.meta.dir, "index.ts");
const timeout = 20_000;

const deviceCode = "device-code-secret-value";
const deviceToken = "plaintext-device-token-secret";
const userCode = "ABCD-EFGH";
const deviceId = "dev_1";
const workspaceId = "ws_1";
const pairingId = "pair_1";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temp(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `corotum-cloud-auth-cli-${name}-`));
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
        throw new Error("login must not prompt");
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

function startPairingServer(options?: {
  expire?: boolean;
  logoutStatus?: number;
  billingStatus?: number;
}): { origin: string; stop: () => void; requests: string[] } {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/v1/billing/status") {
        return Response.json(
          { error: "Hosted Cloud subscription required" },
          { status: options?.billingStatus ?? 402 },
        );
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/v1/cli/pairings"
      ) {
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
        return Response.json({
          status: options?.expire ? "EXPIRED" : "APPROVED",
        });
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
      if (request.method === "POST" && url.pathname === "/api/v1/cli/logout") {
        return Response.json(
          { revoked: true, deviceId },
          { status: options?.logoutStatus ?? 200 },
        );
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

async function writeCredentials(
  home: string,
  token = deviceToken,
): Promise<void> {
  const file = paths(home).credentialsFile;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ schemaVersion: 1, cloudDeviceToken: token }, null, 2)}\n`,
  );
}

describe("real corotum login CLI", () => {
  test(
    "TTY pairing prints the verification URL and user code, never the device token",
    async () => {
      const home = await temp("tty");
      const cloud = startPairingServer({ billingStatus: 402 });
      const fixture = fixtureIo(true);
      try {
        const code = await withIsolatedHome(
          home,
          { COROTUM_CLOUD_ORIGIN: cloud.origin },
          () => runCli(["login", "--origin", cloud.origin], fixture.io),
        );
        expect(code).toBe(ExitCode.SUCCESS);
        expect(homedir()).not.toBe(home);
        const printed = `${fixture.output.join("")}${fixture.errors.join("")}`;
        expect(fixture.errors.join("")).toContain(
          `Open ${cloud.origin}/activate?code=${userCode} and approve this device.`,
        );
        expect(fixture.errors.join("")).toContain(`Code: ${userCode}`);
        expect(fixture.output.join("")).toContain(
          `Logged in to ${cloud.origin}`,
        );
        expect(printed).not.toContain(deviceToken);
        expect(printed).not.toContain(deviceCode);
        expect(cloud.requests.some((item) => item.includes("billing"))).toBe(
          false,
        );
        const credentials = await readFile(paths(home).credentialsFile, "utf8");
        expect(JSON.parse(credentials)).toEqual({
          schemaVersion: 1,
          cloudDeviceToken: deviceToken,
        });
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );

  test(
    "non-interactive and missing TTY fail typed without hanging",
    async () => {
      const home = await temp("noninteractive");
      const started = Date.now();
      const missingTty = await spawnCli(home, [
        "--json",
        "login",
        "--origin",
        "https://corotum.com",
      ]);
      const flagged = await spawnCli(home, [
        "--json",
        "--non-interactive",
        "login",
      ]);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(missingTty.code).toBe(ExitCode.GENERAL_ERROR);
      expect(flagged.code).toBe(ExitCode.GENERAL_ERROR);
      expect(missingTty.json).toMatchObject({
        schemaVersion: 1,
        outcome: "GENERAL_ERROR",
        error:
          "Cloud login requires an interactive terminal to display the pairing code. Re-run without --non-interactive.",
      });
      expect(JSON.stringify(missingTty)).not.toContain(deviceToken);
      expect(flagged.json?.outcome).toBe("GENERAL_ERROR");
    },
    timeout,
  );

  test(
    "invalid origin and credentials in origin are typed INVALID_CONFIG errors",
    async () => {
      const home = await temp("origin");
      const invalid = await spawnCli(home, [
        "--json",
        "login",
        "--origin",
        "not-a-url",
      ]);
      const credentials = await spawnCli(home, [
        "--json",
        "login",
        "--origin",
        "https://user:secret@corotum.com",
      ]);
      expect(invalid.code).toBe(ExitCode.INVALID_CONFIG);
      expect(invalid.json).toMatchObject({
        schemaVersion: 1,
        outcome: "INVALID_CONFIG",
        error: "Cloud origin is invalid.",
      });
      expect(credentials.code).toBe(ExitCode.INVALID_CONFIG);
      expect(credentials.json).toMatchObject({
        outcome: "INVALID_CONFIG",
        error: "Cloud origin must not include credentials.",
      });
      expect(JSON.stringify(credentials)).not.toContain("secret");
    },
    timeout,
  );

  test(
    "network failure and expired pairing are typed and write no credentials",
    async () => {
      const home = await temp("fail");
      const unreachableIo = fixtureIo(true);
      const unreachable = await withIsolatedHome(home, {}, () =>
        runCli(
          ["--json", "login", "--origin", "http://127.0.0.1:1"],
          unreachableIo.io,
        ),
      );
      expect(unreachable).toBe(ExitCode.NETWORK_ERROR);
      expect(unreachableIo.output.join("")).toContain(
        '"outcome":"NETWORK_ERROR"',
      );

      const cloud = startPairingServer({ expire: true });
      const fixture = fixtureIo(true);
      try {
        const code = await withIsolatedHome(
          home,
          { COROTUM_CLOUD_ORIGIN: cloud.origin },
          () => runCli(["--json", "login"], fixture.io),
        );
        expect(code).toBe(ExitCode.GENERAL_ERROR);
        expect(fixture.output.join("")).toContain("Cloud pairing expired");
        expect(
          `${fixture.output.join("")}${fixture.errors.join("")}`,
        ).not.toContain(deviceToken);
      } finally {
        cloud.stop();
      }
      await expect(
        readFile(paths(home).credentialsFile, "utf8"),
      ).rejects.toThrow();
    },
    timeout,
  );

  test("default origin is hosted Cloud and env overrides --origin", () => {
    expect(DEFAULT_CLOUD_ORIGIN).toBe("https://corotum.com");
  });

  test(
    "COROTUM_CLOUD_ORIGIN overrides the default origin for login",
    async () => {
      const home = await temp("env-origin");
      const cloud = startPairingServer();
      const fixture = fixtureIo(true);
      try {
        const code = await withIsolatedHome(
          home,
          { COROTUM_CLOUD_ORIGIN: cloud.origin },
          () => runCli(["--json", "login"], fixture.io),
        );
        expect(code).toBe(ExitCode.SUCCESS);
        expect(fixture.output.join("")).toContain(`"deviceId":"${deviceId}"`);
        expect(fixture.output.join("")).not.toContain(deviceToken);
        expect(cloud.requests[0]).toBe("POST /api/v1/cli/pairings");
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );
});

describe("real corotum logout CLI", () => {
  test(
    "revokes the server token and deletes local Cloud credentials",
    async () => {
      const home = await temp("logout");
      const cloud = startPairingServer();
      await writeCredentials(home);
      try {
        const result = await spawnCli(
          home,
          ["--json", "logout", "--origin", cloud.origin],
          { COROTUM_CLOUD_ORIGIN: undefined },
        );
        expect(result.code).toBe(ExitCode.SUCCESS);
        expect(result.json).toMatchObject({
          schemaVersion: 1,
          outcome: "SUCCESS",
          revoked: true,
          deviceId,
        });
        expect(JSON.stringify(result)).not.toContain(deviceToken);
        expect(
          await readFile(paths(home).credentialsFile, "utf8"),
        ).not.toContain(deviceToken);
        expect(cloud.requests).toContain("POST /api/v1/cli/logout");
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );

  test(
    "revoke failure is typed and still deletes local credentials",
    async () => {
      const home = await temp("revoke-fail");
      const cloud = startPairingServer({ logoutStatus: 503 });
      await writeCredentials(home);
      try {
        const result = await spawnCli(home, [
          "--json",
          "logout",
          "--origin",
          cloud.origin,
        ]);
        expect(result.code).toBe(ExitCode.NETWORK_ERROR);
        expect(result.json).toMatchObject({
          schemaVersion: 1,
          outcome: "NETWORK_ERROR",
        });
        expect(JSON.stringify(result)).not.toContain(deviceToken);
        expect(
          await readFile(paths(home).credentialsFile, "utf8"),
        ).not.toContain(deviceToken);
      } finally {
        cloud.stop();
      }
    },
    timeout,
  );
});
