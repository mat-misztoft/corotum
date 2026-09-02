import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLI_VERSION,
  type CliIo,
  createCli,
  isNonInteractive,
  runCli,
} from "./cli";
import { CLI_SCHEMA_VERSION, ExitCode } from "./cli-contracts";
import { resolvePlatformPaths } from "./platform";
import { CliTelemetry } from "./telemetry";

const roots: string[] = [];
const cli = join(import.meta.dir, "index.ts");
const timeout = 30_000;
const ansi = /\x1b\[/;
const banner = ",-----.";
const welcomePhrases = [
  "Detected agents",
  "Keep your agent skills in sync.",
  "Get started",
];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function fixtureIo(stdinIsTTY: boolean | undefined = true): {
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
        throw new Error("non-interactive path must not prompt");
      },
    },
    output,
    errors,
  };
}

function throwingTelemetry(): CliTelemetry {
  return new CliTelemetry(
    {
      load: async () => {
        throw new Error("help/version must not load config");
      },
      set: async () => {
        throw new Error("help/version must not write config");
      },
    },
    {
      confirm: async () => {
        throw new Error("help/version must not prompt for telemetry");
      },
    },
    { emit: async () => undefined },
    { version: CLI_VERSION, os: "linux", architecture: "x64" },
  );
}

function commandHelpArgv(): readonly (readonly string[])[] {
  const io = fixtureIo().io;
  const program = createCli(io);
  const argv: (readonly string[])[] = [["--help"], ["--version"], ["-h"], ["-V"]];
  for (const command of program.commands) {
    argv.push([command.name(), "--help"]);
    for (const subcommand of command.commands) {
      argv.push([command.name(), subcommand.name(), "--help"]);
    }
  }
  return argv;
}

function parseJson(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function assertJsonPurity(body: string): Record<string, unknown> {
  expect(body).not.toMatch(ansi);
  expect(body).not.toContain(banner);
  for (const phrase of welcomePhrases) {
    expect(body).not.toContain(phrase);
  }
  expect(body).not.toMatch(/[✓●○›]/);
  const parsed = parseJson(body);
  expect(parsed.schemaVersion).toBe(CLI_SCHEMA_VERSION);
  return parsed;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertNoCorotumState(home: string): Promise<void> {
  const paths = resolvePlatformPaths({
    homeDir: home,
    platform: process.platform as "darwin" | "linux" | "win32",
    env: cliEnv(home),
  });
  expect(await pathExists(paths.configFile)).toBe(false);
  expect(await pathExists(paths.credentialsFile)).toBe(false);
  expect(await pathExists(join(paths.stateDir, "state.json"))).toBe(false);
  expect(await pathExists(join(home, ".agents"))).toBe(false);
}

function cliEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("XDG_")) env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_RUNTIME_DIR: join(home, ".local", "runtime"),
    GIT_TERMINAL_PROMPT: "0",
    FORCE_COLOR: "0",
  };
}

async function spawnCli(
  home: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: join(import.meta.dir, "../../.."),
    env: cliEnv(home),
    stderr: "pipe",
    stdout: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

describe("CLI help and version side effects", () => {
  test("every help and version path is side-effect free", async () => {
    for (const argv of commandHelpArgv()) {
      const { io, output, errors } = fixtureIo(true);
      expect(await runCli(argv, io, throwingTelemetry())).toBe(ExitCode.SUCCESS);
      expect(errors).toEqual([]);
      const body = output.join("");
      expect(body.length).toBeGreaterThan(0);
      expect(body).not.toContain(banner);
      expect(body).not.toMatch(ansi);
      if (argv.includes("--version") || argv.includes("-V")) {
        expect(body).toBe(`corotum ${CLI_VERSION}\n`);
      } else {
        expect(body).toContain("Usage:");
      }
    }
  });

  test("JSON help and version stay envelope-only", async () => {
    for (const argv of [
      ["--json", "--help"],
      ["--json", "--version"],
      ["--json", "init", "--help"],
      ["--json", "login", "--help"],
      ["init", "--json", "--help"],
    ] as const) {
      const { io, output, errors } = fixtureIo(true);
      expect(await runCli(argv, io, throwingTelemetry())).toBe(ExitCode.SUCCESS);
      expect(errors).toEqual([]);
      expect(assertJsonPurity(output.join(""))).toEqual({
        schemaVersion: 1,
        outcome: "SUCCESS",
      });
    }
  });
});

describe("JSON purity and schemaVersion", () => {
  test("default --json is not the welcome screen", async () => {
    const { io, output, errors } = fixtureIo(true);
    expect(await runCli(["--json"], io, throwingTelemetry())).toBe(
      ExitCode.SUCCESS,
    );
    expect(errors).toEqual([]);
    expect(assertJsonPurity(output.join(""))).toEqual({
      schemaVersion: 1,
      outcome: "SUCCESS",
    });
  });

  test("JSON parse errors and missing input include schemaVersion", async () => {
    const unknown = fixtureIo();
    expect(await runCli(["--json", "--unknown"], unknown.io)).toBe(
      ExitCode.GENERAL_ERROR,
    );
    expect(unknown.errors).toEqual([]);
    expect(assertJsonPurity(unknown.output.join(""))).toMatchObject({
      schemaVersion: 1,
      outcome: "GENERAL_ERROR",
    });

    for (const argv of [
      ["--json", "--non-interactive", "add"],
      ["--json", "--non-interactive", "adopt"],
      ["--json", "--non-interactive", "remove"],
      ["--json", "--non-interactive", "unmanage"],
      ["--json", "--non-interactive", "restore"],
      ["--json", "--non-interactive", "set-ref"],
      ["--json", "--non-interactive", "set-ref", "notes"],
      ["--json", "--non-interactive", "agents", "enable"],
      ["--json", "--non-interactive", "agents", "disable"],
      ["--json", "--non-interactive", "config", "get"],
      ["--json", "--non-interactive", "config", "set"],
      ["--json", "--non-interactive", "config", "set", "telemetry"],
      ["--json", "--non-interactive", "migrate"],
    ] as const) {
      const { io, output, errors } = fixtureIo(true);
      const code = await runCli(argv, io);
      expect(code).toBe(ExitCode.GENERAL_ERROR);
      expect(errors).toEqual([]);
      const parsed = assertJsonPurity(output.join(""));
      expect(parsed.outcome).toBe("GENERAL_ERROR");
      expect(String(parsed.error)).toMatch(/required|missing|argument/i);
    }
  });
});

describe("exit codes and non-interactive input", () => {
  test("honors documented exit codes", () => {
    expect(ExitCode).toEqual({
      SUCCESS: 0,
      GENERAL_ERROR: 1,
      PARTIAL_SUCCESS: 2,
      CONFLICT: 3,
      AUTH_REQUIRED: 4,
      INVALID_CONFIG: 5,
      NETWORK_ERROR: 6,
    });
  });

  test("TTY remains interactive unless --non-interactive is set", () => {
    expect(isNonInteractive({ nonInteractive: false }, true)).toBe(false);
    expect(isNonInteractive({ nonInteractive: true }, true)).toBe(true);
    expect(isNonInteractive({ nonInteractive: false }, false)).toBe(true);
  });

  test("non-interactive missing required arguments never wait", async () => {
    const { io, output, errors } = fixtureIo(true);
    expect(await runCli(["--non-interactive", "add"], io)).toBe(
      ExitCode.GENERAL_ERROR,
    );
    expect(output.join("") + errors.join("")).toMatch(/required|missing|argument/i);
  });
});

describe("real CLI help/version and missing init provider", () => {
  test(
    "help and version do not create config or other files",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "corotum-shell-help-"));
      roots.push(home);
      for (const args of [
        ["--help"],
        ["--version"],
        ["init", "--help"],
        ["login", "--help"],
        ["agents", "--help"],
        ["--json", "--help"],
      ] as const) {
        const result = await spawnCli(home, args);
        expect(result.code).toBe(0);
        expect(result.stdout).not.toMatch(ansi);
        expect(result.stdout).not.toContain(banner);
        if (args.includes("--json")) {
          assertJsonPurity(result.stdout);
        }
      }
      await assertNoCorotumState(home);
    },
    timeout,
  );

  test(
    "non-interactive init without provider is an actionable JSON error",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "corotum-shell-init-"));
      roots.push(home);
      const result = await spawnCli(home, [
        "--json",
        "--non-interactive",
        "init",
      ]);
      expect(result.code).toBe(ExitCode.INVALID_CONFIG);
      const parsed = assertJsonPurity(result.stdout);
      expect(parsed.outcome).toBe("INVALID_CONFIG");
      expect(String(parsed.error)).toContain("repository");
      expect(String(parsed.error)).toContain("cloud");
      await assertNoCorotumState(home);
    },
    timeout,
  );
});
