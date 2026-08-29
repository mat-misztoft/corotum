import { homedir } from "node:os";

import type { Command } from "commander";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import { type ConfigKey, ConfigStore } from "./config";
import { resolvePlatformPaths } from "./platform";

export function registerConfigCommand(program: Command, io: CliIo): void {
  const config = program
    .command("config")
    .description("manage local configuration");
  config.command("list").action(async () => {
    const value = await store().list();
    write(
      io,
      program,
      { outcome: "SUCCESS", config: value },
      `${JSON.stringify(value, null, 2)}\n`,
    );
  });
  config.command("get <key>").action(async (key: string) => {
    assertKey(key);
    const value = await store().get(key);
    write(
      io,
      program,
      { outcome: "SUCCESS", key, value },
      `${String(value)}\n`,
    );
  });
  config
    .command("set <key> <value>")
    .action(async (key: string, value: string) => {
      assertKey(key);
      if (key !== "telemetry" || !["true", "false"].includes(value)) {
        throw new Error(
          "Only config set telemetry <true|false> is currently supported.",
        );
      }
      await store().set("telemetry", value === "true");
      write(
        io,
        program,
        { outcome: "SUCCESS", key, value: value === "true" },
        `Set ${key}.\n`,
      );
    });
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

function assertKey(key: string): asserts key is ConfigKey {
  if (key !== "telemetry")
    throw new Error(`Unknown or unsupported config key: ${key}.`);
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
