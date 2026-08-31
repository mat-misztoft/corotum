import { homedir } from "node:os";

import type { Command } from "commander";

import { jsonEnvelope } from "./cli-contracts";
import { cliUpdate, createCliUpdateDeps } from "./cli-update";

/** Registers official CLI self-update and the read-only --check path. */
export function registerCliUpdateCommand(
  program: Command,
  io: Readonly<{ writeOutput: (message: string) => void }>,
  currentVersion: string,
): void {
  program
    .command("cli-update")
    .description("update the Corotum CLI from official release metadata")
    .option(
      "--check",
      "report release availability without modifying the executable",
    )
    .action(async (options: { check?: boolean }) => {
      const result = await cliUpdate(
        createCliUpdateDeps({
          currentVersion,
          homeDir: homedir(),
          env: process.env,
          platform: process.platform,
          arch: process.arch,
        }),
        { check: options.check === true },
      );
      if (program.opts<{ json?: boolean }>().json === true) {
        io.writeOutput(
          `${JSON.stringify(jsonEnvelope({ outcome: "SUCCESS", ...result }))}\n`,
        );
        return;
      }
      if (result.status === "UP_TO_DATE") {
        io.writeOutput("UP_TO_DATE\n");
        return;
      }
      io.writeOutput(`${result.status} ${result.latestVersion}\n`);
    });
}
