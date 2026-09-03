import { homedir } from "node:os";

import type { Command } from "commander";
import type { CliIo } from "./cli";
import { type CliOutcome, jsonEnvelope } from "./cli-contracts";
import { cloudOriginFrom } from "./cloud-auth";
import {
  CONFIG_KEYS,
  type ConfigKey,
  ConfigStore,
  SETTABLE_CONFIG_KEYS,
} from "./config";
import { resolvePlatformPaths } from "./platform";

export class ConfigError extends Error {
  readonly name = "ConfigError";

  constructor(
    message: string,
    readonly outcome: CliOutcome = "INVALID_CONFIG",
  ) {
    super(message);
  }
}

export function registerConfigCommand(program: Command, io: CliIo): void {
  const config = program
    .command("config")
    .description("manage local configuration")
    .action(async () => {
      await listConfig(program, io);
    });
  config.command("list").action(async () => {
    await listConfig(program, io);
  });
  config.command("get <key>").action(async (key: string) => {
    const typed = assertKnownKey(key);
    const value = await store().get(typed);
    write(
      io,
      program,
      { outcome: "SUCCESS", key: typed, value },
      formatValue(value),
    );
  });
  config
    .command("set <key> <value>")
    .action(async (key: string, value: string) => {
      const typed = assertSettableKey(key);
      if (typed === "telemetry") {
        if (!["true", "false"].includes(value)) {
          throw new ConfigError("config set telemetry requires true or false.");
        }
        const next = value === "true";
        await store().set("telemetry", next);
        write(
          io,
          program,
          { outcome: "SUCCESS", key, value: next },
          `Set ${key}.\n`,
        );
        return;
      }
      let origin: string;
      try {
        origin = cloudOriginFrom(value);
      } catch (error) {
        throw new ConfigError(
          error instanceof Error ? error.message : "Cloud origin is invalid.",
        );
      }
      await store().set("origin", origin);
      write(
        io,
        program,
        { outcome: "SUCCESS", key, value: origin },
        `Set ${key}.\n`,
      );
    });
}

async function listConfig(program: Command, io: CliIo): Promise<void> {
  const value = await store().list();
  write(
    io,
    program,
    { outcome: "SUCCESS", config: value },
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function store(): ConfigStore {
  return new ConfigStore(
    resolvePlatformPaths({
      homeDir: homedir(),
      platform: process.platform as "darwin" | "linux" | "win32",
      env: process.env,
    }),
  );
}

function assertKnownKey(key: string): ConfigKey {
  if ((CONFIG_KEYS as readonly string[]).includes(key)) return key as ConfigKey;
  throw new ConfigError(
    `Unknown config key: ${key}. Known keys: ${CONFIG_KEYS.join(", ")}.`,
  );
}

function assertSettableKey(key: string): ConfigKey {
  assertKnownKey(key);
  if ((SETTABLE_CONFIG_KEYS as readonly string[]).includes(key)) {
    return key as ConfigKey;
  }
  throw new ConfigError(
    `Config key ${key} is read-only from the CLI. Set telemetry or origin with corotum config set.`,
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return `${String(value)}\n`;
  if (typeof value === "object") return `${JSON.stringify(value, null, 2)}\n`;
  return `${String(value)}\n`;
}

function write(
  io: CliIo,
  program: Command,
  payload: Record<string, unknown>,
  human: string,
): void {
  if (program.opts<{ json?: boolean }>().json)
    io.writeOutput(`${JSON.stringify(jsonEnvelope(payload))}\n`);
  else io.writeOutput(human);
}
