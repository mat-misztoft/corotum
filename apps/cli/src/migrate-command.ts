import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import { GitStateProvider } from "../../../packages/git-provider/src/index";
import { SaaSProvider } from "../../../packages/saas-provider/src/index";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import { cloudAuthContext } from "./cloud-auth-command";
import { DEFAULT_CLOUD_ORIGIN } from "./cloud-auth";
import { ConfigStore, CredentialsStore, effectiveStoragePaths } from "./config";
import { MigrationService, type MigrationStrategy } from "./migrate";
import { MutationLock } from "./mutation-lock";

export function registerMigrateCommand(program: Command, io: CliIo): void {
  program
    .command("migrate <destination> [repository]")
    .description("move desired state between Corotum Git Sync and Cloud")
    .option("--strategy <replace|merge|cancel>", "destination-state handling")
    .option("--origin <url>", "Cloud origin", DEFAULT_CLOUD_ORIGIN)
    .action(async (destination: string, repository: string | undefined, options: { strategy?: MigrationStrategy; origin: string }) => {
      if (destination !== "cloud" && destination !== "git")
        throw new Error("Migration destination must be cloud or git.");
      if (destination === "git" && !repository)
        throw new Error("Usage: corotum migrate git <repository>.");
      if (destination === "cloud" && repository)
        throw new Error("Usage: corotum migrate cloud.");
      const { paths, origin } = cloudAuthContext(program, io, options.origin);
      const release = await new MutationLock(join(paths.stateDir, "process.lock")).acquire();
      try {
        const configStore = new ConfigStore(paths);
        const config = await configStore.load();
        if (!config.mode) throw new Error("Run corotum init before migrating.");
        if (config.mode === destination) throw new Error(`Corotum is already using ${destination === "cloud" ? "Cloud" : "Git Sync"}.`);
        const strategy = options.strategy;
        if (!strategy)
          throw new Error("Choose --strategy replace, merge, or cancel; destination state is never changed implicitly.");
        const storage = effectiveStoragePaths(config, paths);
        const cloudProvider = async () => {
          const credentials = await new CredentialsStore(paths).load();
          if (!credentials.cloudDeviceToken || !config.workspaceId)
            throw new Error("Run corotum login before migrating to or from Cloud.");
          return new SaaSProvider({ origin, deviceToken: credentials.cloudDeviceToken, workspaceId: config.workspaceId });
        };
        const source = config.mode === "git"
          ? new GitStateProvider(storage.gitStoragePath, config.gitRepository as string)
          : await cloudProvider();
        const target = destination === "git"
          ? new GitStateProvider(storage.gitStoragePath, repository as string)
          : await cloudProvider();
        const result = await new MigrationService(source, target).migrate(strategy);
        if (result.kind === "refused") throw new Error(result.reason);
        if (result.kind === "conflict") {
          write(io, program, { outcome: "CONFLICT", status: "CONFLICT", skills: result.skills }, `Migration conflict: ${result.skills.join(", ")}. Both providers are unchanged.\n`);
          return;
        }
        if (result.kind === "cancelled") {
          write(io, program, { outcome: "SUCCESS", status: "CANCELLED" }, "Migration cancelled. Both providers are unchanged.\n");
          return;
        }
        if (destination === "git") await configStore.set("gitRepository", repository as string);
        await configStore.set("mode", destination);
        write(io, program, { outcome: "SUCCESS", status: "MIGRATED", revision: result.revision, strategy: result.strategy }, `Migrated desired state to ${destination === "cloud" ? "Corotum Cloud" : "Git Sync"}.\n`);
      } finally {
        await release();
      }
    });
}

function write(io: CliIo, program: Command, payload: Record<string, unknown>, human: string) {
  if (program.opts<{ json?: boolean }>().json) io.writeOutput(`${JSON.stringify(jsonEnvelope(payload))}\n`);
  else io.writeOutput(human);
}
