import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import { skillId } from "../../../packages/core/src/index";
import { V2SaaSProvider } from "../../../packages/saas-provider/src/index";
import { CLI_VERSION, type CliIo, isNonInteractive } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import {
  CloudAuthError,
  CloudAuthService,
  defaultCloudDevice,
  resolveCloudOrigin,
} from "./cloud-auth";
import { ConfigStore, CredentialsStore } from "./config";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { confirmOption } from "./prompts";

const emptyState = {
  manifest: { version: 2 as const, skills: [] },
  lockfile: { version: 2 as const, skills: [] },
};

export function registerResetCommand(program: Command, io: CliIo): void {
  program
    .command("reset")
    .description("delete Cloud desired-state skills and unlink this device")
    .option("--yes", "do not prompt")
    .action(async (options: { yes?: boolean }) => {
      const json = program.opts<{ json?: boolean }>().json === true;
      const nonInteractive = isNonInteractive(program.opts(), io.stdinIsTTY);
      if (!options.yes) {
        if (nonInteractive) {
          throw new CloudAuthError(
            "corotum reset requires --yes when not on a TTY.",
            "GENERAL_ERROR",
          );
        }
        const ok = await confirmOption(
          "Delete all Cloud skills and unlink this device? Local skill files stay.",
          false,
        );
        if (!ok) {
          write(
            io,
            json,
            { outcome: "SUCCESS", cancelled: true },
            "Cancelled.\n",
          );
          return;
        }
      }

      const paths = resolvePlatformPaths({
        homeDir:
          process.env.HOME?.trim() ||
          process.env.USERPROFILE?.trim() ||
          homedir(),
        platform: process.platform as "darwin" | "linux" | "win32",
        env: process.env,
      });
      const release = await new MutationLock(
        join(paths.stateDir, "process.lock"),
      ).acquire();
      try {
        const config = new ConfigStore(paths);
        const credentials = new CredentialsStore(paths);
        const loaded = await config.load();
        const token = (await credentials.load()).cloudDeviceToken;
        let cloudCleared = false;
        let deviceRevoked = false;

        if (token && loaded.workspaceId) {
          const origin = resolveCloudOrigin(undefined, loaded.origin);
          const cloud = new V2SaaSProvider({
            origin,
            deviceToken: token,
            workspaceId: loaded.workspaceId,
            cliVersion: CLI_VERSION,
          });
          const current = await cloud.pull();
          await cloud.push({
            state: emptyState,
            ledger: { version: 2, activeDispositions: {} },
            baseRevision: current.revisionId,
            transition: {
              type: "REMOVE",
              skillId: skillId("sk_clear"),
              metadata: { origin: "reset" },
            },
          });
          cloudCleared = true;
          const auth = new CloudAuthService({
            origin,
            config,
            credentials,
            device: defaultCloudDevice(CLI_VERSION),
          });
          deviceRevoked = (await auth.logout()).revoked;
        }

        await rm(paths.configFile, { force: true });
        await rm(paths.credentialsFile, { force: true });
        await rm(paths.stateDir, { force: true, recursive: true });

        write(
          io,
          json,
          { outcome: "SUCCESS", cloudCleared, deviceRevoked },
          cloudCleared
            ? "Deleted Cloud skills and unlinked this device.\n"
            : "Cleared local Corotum config. No Cloud credentials were present.\n",
        );
      } finally {
        await release();
      }
    });
}

function write(
  io: CliIo,
  json: boolean,
  payload: Record<string, unknown>,
  human: string,
): void {
  if (json) io.writeOutput(`${JSON.stringify(jsonEnvelope(payload))}\n`);
  else io.writeOutput(human);
}
