import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_VERSION, type CliIo, runCli } from "./cli";
import { ExitCode } from "./cli-contracts";
import { resolvePlatformPaths } from "./platform";
import { CliTelemetry } from "./telemetry";
import {
  collectWelcomeSnapshot,
  configFileExists,
  formatWelcomeScreen,
  gitAvailable,
  type WelcomeDeps,
  type WelcomeSnapshot,
} from "./welcome";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function tempHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "corotum-welcome-"));
  roots.push(path);
  return path;
}

function linuxEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_RUNTIME_DIR: join(home, ".local", "runtime"),
  };
}

function fixtureDeps(overrides: Partial<WelcomeDeps> = {}): WelcomeDeps {
  return {
    version: CLI_VERSION,
    platform: "darwin",
    arch: "arm64",
    homeDir: "/unused",
    gitAvailable: async () => true,
    detectAgentIds: async () => [],
    configExists: async () => false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<WelcomeSnapshot> = {}): WelcomeSnapshot {
  return {
    version: CLI_VERSION,
    gitAvailable: true,
    osLabel: "macOS arm64",
    homeConfigured: true,
    agents: [
      { id: "codex", name: "Codex", detected: true },
      { id: "claude-code", name: "Claude Code", detected: true },
      { id: "pi", name: "Pi", detected: true },
      { id: "gemini-cli", name: "Gemini CLI", detected: false },
    ],
    ...overrides,
  };
}

function fixtureIo(): { io: CliIo; output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      stdinIsTTY: true,
      writeError: (message) => errors.push(message),
      writeOutput: (message) => output.push(message),
    },
    output,
    errors,
  };
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .sort();
}

describe("welcome screen formatting", () => {
  test("renders banner, version, environment, agents, sync modes, and getting started", () => {
    const screen = formatWelcomeScreen(snapshot());
    expect(screen).toContain(",-----.");
    expect(screen).toContain(`v${CLI_VERSION}`);
    expect(screen).toContain("Keep your agent skills in sync.");
    expect(screen).toContain(
      "One desired state across every machine and AI agent.",
    );
    expect(screen).toContain("  ✓ Git available");
    expect(screen).toContain("  ✓ macOS arm64");
    expect(screen).toContain("  ✓ Corotum home ready");
    expect(screen).toContain("  ● Codex");
    expect(screen).toContain("  ● Pi");
    expect(screen).toContain("  ● Claude Code");
    expect(screen).toContain("  ○ Gemini CLI");
    expect(screen).toContain(
      "Git Sync       Free, backed by your Git repository",
    );
    expect(screen).toContain(
      "Corotum Cloud  Hosted sync across all your devices",
    );
    expect(screen).toContain("› corotum init        Configure this device");
    expect(screen).toContain("› corotum status      Show local sync state");
    expect(screen).toContain("› corotum --help      View all commands");
    expect(screen).toContain("https://corotum.com");
    expect(screen).not.toContain("\x1b");
  });

  test("shows Git unavailable and unconfigured home", () => {
    const screen = formatWelcomeScreen(
      snapshot({ gitAvailable: false, homeConfigured: false }),
    );
    expect(screen).toContain("  ✗ Git unavailable");
    expect(screen).not.toContain("  ✓ Git available");
    expect(screen).toContain("  ○ Corotum home not configured");
    expect(screen).not.toContain("  ✓ Corotum home ready");
  });

  test("shows zero agents as undetected without implying agents are required", () => {
    const screen = formatWelcomeScreen(
      snapshot({
        agents: [
          { id: "codex", name: "Codex", detected: false },
          { id: "pi", name: "Pi", detected: false },
        ],
      }),
    );
    expect(screen).toContain("Detected agents");
    expect(screen).toContain("  ○ Codex");
    expect(screen).toContain("  ○ Pi");
    expect(screen).not.toContain("  ●");
    expect(screen).not.toMatch(/agent is required|install an agent/i);
  });

  test("uses the same version source as corotum --version", () => {
    expect(formatWelcomeScreen(snapshot({ version: "9.9.9" }))).toContain(
      "v9.9.9",
    );
    expect(formatWelcomeScreen(snapshot())).toContain(`v${CLI_VERSION}`);
  });
});

describe("welcome snapshot collection", () => {
  test("records Git availability from the injected checker", async () => {
    await expect(
      collectWelcomeSnapshot(fixtureDeps({ gitAvailable: async () => true })),
    ).resolves.toMatchObject({ gitAvailable: true });
    await expect(
      collectWelcomeSnapshot(fixtureDeps({ gitAvailable: async () => false })),
    ).resolves.toMatchObject({ gitAvailable: false });
  });

  test("treats git --version failure as unavailable", async () => {
    expect(
      await gitAvailable(async () => {
        throw new Error("spawn git ENOENT");
      }),
    ).toBe(false);
    expect(
      await gitAvailable(async () => ({
        exitCode: 1,
        stderr: "missing",
        stdout: new Uint8Array(),
      })),
    ).toBe(false);
    expect(
      await gitAvailable(async () => ({
        exitCode: 0,
        stderr: "",
        stdout: new TextEncoder().encode("git version 2.0.0"),
      })),
    ).toBe(true);
  });

  test("marks detected agents without requiring any agent", async () => {
    const zero = await collectWelcomeSnapshot(fixtureDeps());
    expect(zero.agents.every((agent) => !agent.detected)).toBe(true);
    expect(zero.agents.map((agent) => agent.id)).toContain("codex");

    const detected = await collectWelcomeSnapshot(
      fixtureDeps({ detectAgentIds: async () => ["codex", "pi"] }),
    );
    expect(
      detected.agents.find((agent) => agent.id === "codex")?.detected,
    ).toBe(true);
    expect(detected.agents.find((agent) => agent.id === "pi")?.detected).toBe(
      true,
    );
    expect(
      detected.agents.find((agent) => agent.id === "gemini-cli")?.detected,
    ).toBe(false);
  });

  test("distinguishes configured and unconfigured Corotum home without writing", async () => {
    const home = await tempHome();
    const env = linuxEnv(home);
    const paths = resolvePlatformPaths({
      homeDir: home,
      platform: "linux",
      env,
    });
    const before = await listFiles(home);
    const unconfigured = await collectWelcomeSnapshot(
      fixtureDeps({
        platform: "linux",
        homeDir: home,
        env,
        configExists: configFileExists,
      }),
    );
    expect(unconfigured.homeConfigured).toBe(false);
    expect(await listFiles(home)).toEqual(before);

    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.configFile, "{}\n");
    const configured = await collectWelcomeSnapshot(
      fixtureDeps({
        platform: "linux",
        homeDir: home,
        env,
        configExists: configFileExists,
      }),
    );
    expect(configured.homeConfigured).toBe(true);
  });

  test("does not create config, skills, or other files", async () => {
    const home = await tempHome();
    const env = linuxEnv(home);
    expect(await listFiles(home)).toEqual([]);
    await collectWelcomeSnapshot(
      fixtureDeps({
        platform: "linux",
        homeDir: home,
        env,
        configExists: configFileExists,
      }),
    );
    expect(await listFiles(home)).toEqual([]);
  });
});

describe("default corotum command", () => {
  test("prints the read-only welcome screen", async () => {
    const { io, output, errors } = fixtureIo();
    expect(
      await runCli([], io, undefined, fixtureDeps({ version: CLI_VERSION })),
    ).toBe(ExitCode.SUCCESS);
    expect(errors).toEqual([]);
    const screen = output.join("");
    expect(screen).toContain(",-----.");
    expect(screen).toContain(`v${CLI_VERSION}`);
    expect(screen).toContain("  ✓ Git available");
    expect(screen).toContain("  ✓ macOS arm64");
    expect(screen).toContain("  ○ Corotum home not configured");
    expect(screen).toContain("  ○ Codex");
    expect(screen).toContain("Corotum Cloud");
    expect(screen).toContain("https://corotum.com");
  });

  test("keeps --json free of the welcome screen, banner, and ANSI", async () => {
    const { io, output, errors } = fixtureIo();
    expect(
      await runCli(
        ["--json"],
        io,
        undefined,
        fixtureDeps({ version: CLI_VERSION }),
      ),
    ).toBe(ExitCode.SUCCESS);
    expect(errors).toEqual([]);
    const body = output.join("");
    expect(JSON.parse(body)).toEqual({ schemaVersion: 1, outcome: "SUCCESS" });
    expect(body).not.toContain(",-----.");
    expect(body).not.toContain("Keep your agent skills in sync.");
    expect(body).not.toContain("Detected agents");
    expect(body).not.toContain("\x1b");
    expect(body).not.toMatch(/[✓●○›]/);
  });

  test("welcome version matches corotum --version", async () => {
    const welcome = fixtureIo();
    expect(await runCli([], welcome.io, undefined, fixtureDeps())).toBe(
      ExitCode.SUCCESS,
    );
    const version = fixtureIo();
    expect(await runCli(["--version"], version.io)).toBe(ExitCode.SUCCESS);
    expect(version.output.join("")).toBe(`corotum ${CLI_VERSION}\n`);
    expect(welcome.output.join("")).toContain(`v${CLI_VERSION}`);
  });

  test("does not prompt for telemetry or mutate config", async () => {
    const home = await tempHome();
    const env = linuxEnv(home);
    let prompts = 0;
    const telemetry = new CliTelemetry(
      {
        load: async () => {
          throw new Error("welcome must not load config");
        },
        set: async () => {
          throw new Error("welcome must not write config");
        },
      },
      {
        confirm: async () => {
          prompts += 1;
          return true;
        },
      },
      { emit: async () => undefined },
      { version: CLI_VERSION, os: "linux", architecture: "x64" },
    );
    const { io, errors } = fixtureIo();
    expect(
      await runCli(
        [],
        io,
        telemetry,
        fixtureDeps({
          platform: "linux",
          homeDir: home,
          env,
          configExists: configFileExists,
        }),
      ),
    ).toBe(ExitCode.SUCCESS);
    expect(errors).toEqual([]);
    expect(prompts).toBe(0);
    expect(await listFiles(home)).toEqual([]);
  });
});
