import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import { V2SaaSProvider } from "../../../packages/saas-provider/src/index";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import { cloudAuthContext } from "./cloud-auth-command";
import { DEFAULT_CLOUD_ORIGIN } from "./cloud-auth";
import { ConfigStore, CredentialsStore, effectiveStoragePaths } from "./config";
import { createCliV2GitStateProvider } from "./artifact-consent";
import { LegacyMigrator } from "./legacy-migration";
import { type MigrationStrategy } from "./migrate";
import { resolveLegacyPlatformPaths, resolvePlatformPaths } from "./platform";
import { mergeV2MigrationSnapshots, migrateV2CloudToGit, migrateV2GitToCloud } from "./v2-migration";
import { MutationLock } from "./mutation-lock";
import { withGitCliErrors } from "./init-errors";

export function registerMigrateCommand(program: Command, io: CliIo): void {
  program
    .command("migrate <destination> [repository]")
    .description("move desired state between Corotum Git Sync and Cloud, or migrate legacy ToolMirror state")
    .option("--strategy <replace|merge|cancel>", "destination-state handling")
    .option("--origin <url>", "Cloud origin", DEFAULT_CLOUD_ORIGIN)
    .action(async (destination: string, repository: string | undefined, options: { strategy?: MigrationStrategy; origin: string }) => {
      await withGitCliErrors(async () => {
      if (destination === "legacy" || destination === "legacy-cleanup") {
        await runLegacyMigration(program, io, destination);
        return;
      }
      if (destination !== "cloud" && destination !== "git")
        throw new Error("Migration destination must be cloud, git, legacy, or legacy-cleanup.");
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
        if (strategy === "cancel") {
          write(io, program, { outcome: "SUCCESS", status: "CANCELLED" }, "Migration cancelled. Both providers are unchanged.\n");
          return;
        }
        const credentials = await new CredentialsStore(paths).load();
        if (!credentials.cloudDeviceToken || !config.workspaceId)
          throw new Error("Run corotum login before migrating to or from Cloud.");
        const cloud = new V2SaaSProvider({ origin, deviceToken: credentials.cloudDeviceToken, workspaceId: config.workspaceId });
        const git = createCliV2GitStateProvider({
          storagePath: storage.gitStoragePath,
          source: destination === "git" ? repository as string : config.gitRepository as string,
          options: program.opts(),
          io,
        });
        const source = await (config.mode === "git" ? git : cloud).pull();
        const existing = await (destination === "git" ? git : cloud).pull();
        const merged = strategy === "merge"
          ? mergeV2MigrationSnapshots(source, existing)
          : { kind: "merged" as const, state: source.state, ledger: source.ledger };
        if (merged.kind === "conflict") {
          write(io, program, { outcome: "CONFLICT", status: "CONFLICT", skills: merged.skills }, `Migration conflict: ${merged.skills.join(", ")}. Both providers are unchanged.\n`);
          return;
        }
        const revision = config.mode === "git"
          ? await migrateV2GitToCloud({
              source: merged, artifacts: git, destination: cloud, workspaceId: config.workspaceId,
            })
          : await migrateV2CloudToGit({
              source: merged, artifacts: cloud, destination: git,
            });
        if (destination === "git") await configStore.set("gitRepository", repository as string);
        await configStore.set("mode", destination);
        write(io, program, { outcome: "SUCCESS", status: "MIGRATED", revision, strategy }, `Migrated desired state to ${destination === "cloud" ? "Corotum Cloud" : "Git Sync"}.\n`);
      } finally {
        await release();
      }
      });
    });
}

async function runLegacyMigration(
  program: Command,
  io: CliIo,
  destination: "legacy" | "legacy-cleanup",
): Promise<void> {
  const homeDir = homedir();
  const platform = process.platform as "darwin" | "linux" | "win32";
  const current = resolvePlatformPaths({ homeDir, platform, env: process.env });
  const legacy = resolveLegacyPlatformPaths({ homeDir, platform, env: process.env });
  const release = await new MutationLock(join(current.stateDir, "process.lock")).acquire();
  try {
    const migrator = new LegacyMigrator();
    if (destination === "legacy-cleanup") {
      const marker = await migrator.cleanup({ current });
      write(io, program, { outcome: "SUCCESS", status: marker.status }, "Removed verified legacy ToolMirror backup files.\n");
      return;
    }
    const result = await migrator.migrate({ homeDir, current, legacy });
    const outcome = result.conflicts.length > 0 ? "CONFLICT" : "SUCCESS";
    write(
      io,
      program,
      {
        outcome,
        status: result.marker.status,
        conflicts: result.conflicts,
        skills: result.marker.skills.map((skill) => skill.name),
      },
      result.conflicts.length > 0
        ? `Migrated recoverable ToolMirror state with ${result.conflicts.length} LOCAL_CONFLICT report(s). Legacy files remain until corotum migrate legacy-cleanup.\n`
        : "Migrated recoverable ToolMirror state. Legacy files remain until corotum migrate legacy-cleanup.\n",
    );
  } finally {
    await release();
  }
}

function write(io: CliIo, program: Command, payload: Record<string, unknown>, human: string) {
  if (program.opts<{ json?: boolean }>().json) io.writeOutput(`${JSON.stringify(jsonEnvelope(payload))}\n`);
  else io.writeOutput(human);
}
