import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import {
  V2CloudProviderError,
  V2SaaSProvider,
} from "../../../packages/saas-provider/src/index";
import { createCliV2GitStateProvider } from "./artifact-consent";
import { CLI_VERSION, type CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import { CloudAuthError } from "./cloud-auth";
import { cloudAuthContext } from "./cloud-auth-command";
import { ConfigStore, CredentialsStore, effectiveStoragePaths } from "./config";
import {
  hostedSubscriptionInitError,
  isHostedSubscriptionRequired,
} from "./init-cloud";
import {
  assertGitAvailable,
  InitError,
  notInitializedError,
  withGitCliErrors,
} from "./init-errors";
import { LegacyMigrator } from "./legacy-migration";
import { type MigrationStrategy } from "./migrate";
import { MutationLock } from "./mutation-lock";
import { resolveLegacyPlatformPaths, resolvePlatformPaths } from "./platform";
import {
  mergeV2MigrationSnapshots,
  migrateV2CloudToGit,
  migrateV2GitToCloud,
  type V2GitMigrationTarget,
} from "./v2-migration";

const STRATEGIES = new Set<MigrationStrategy>(["replace", "merge", "cancel"]);

export function registerMigrateCommand(program: Command, io: CliIo): void {
  program
    .command("migrate <destination> [repository]")
    .description(
      "move desired state between Corotum Git Sync and Cloud, or migrate legacy ToolMirror state",
    )
    .option("--strategy <replace|merge|cancel>", "destination-state handling")
    .option("--origin <url>", "Cloud origin")
    .action(
      async (
        destination: string,
        repository: string | undefined,
        options: { strategy?: string; origin?: string },
      ) => {
        await withGitCliErrors(async () => {
          if (destination === "legacy" || destination === "legacy-cleanup") {
            await runLegacyMigration(program, io, destination);
            return;
          }
          if (destination !== "cloud" && destination !== "git") {
            throw new InitError(
              "Migration destination must be cloud, git, legacy, or legacy-cleanup.",
              "INVALID_ARGUMENT",
            );
          }
          if (destination === "git" && !repository?.trim()) {
            throw new InitError(
              "A Git repository URL is required. Run `corotum migrate git <git-url> --strategy replace|merge|cancel`.",
              "REPOSITORY_REQUIRED",
            );
          }
          if (destination === "cloud" && repository) {
            throw new InitError(
              "Corotum Cloud migrate does not take a Git repository argument. Run `corotum migrate cloud --strategy replace|merge|cancel`.",
              "INVALID_ARGUMENT",
            );
          }
          const { paths, origin } = await cloudAuthContext(
            program,
            io,
            options.origin,
          );
          const release = await new MutationLock(
            join(paths.stateDir, "process.lock"),
          ).acquire();
          try {
            const configStore = new ConfigStore(paths);
            const config = await configStore.load();
            if (!config.mode) throw notInitializedError("migrating");
            if (config.mode === destination) {
              throw new InitError(
                `Corotum is already using ${destination === "cloud" ? "Cloud" : "Git Sync"}.`,
                "ALREADY_INITIALIZED",
              );
            }
            const strategy = parseStrategy(options.strategy);
            if (strategy === "cancel") {
              write(
                io,
                program,
                { outcome: "SUCCESS", status: "CANCELLED" },
                "Migration cancelled. Both providers are unchanged.\n",
              );
              return;
            }
            const credentials = await new CredentialsStore(paths).load();
            if (!credentials.cloudDeviceToken || !config.workspaceId) {
              throw new CloudAuthError(
                "Run corotum login before migrating to or from Cloud.",
                "AUTH_REQUIRED",
              );
            }
            if (destination === "git" || config.mode === "git") {
              await assertGitAvailable();
            }
            if (config.mode === "git" && !config.gitRepository) {
              throw notInitializedError("migrating");
            }
            const storage = effectiveStoragePaths(config, paths);
            const cloud = new V2SaaSProvider({
              origin,
              deviceToken: credentials.cloudDeviceToken,
              workspaceId: config.workspaceId,
              cliVersion: CLI_VERSION,
            });
            const git = createCliV2GitStateProvider({
              storagePath: storage.gitStoragePath,
              source:
                destination === "git"
                  ? (repository as string)
                  : (config.gitRepository as string),
              options: program.opts(),
              io,
            });
            const gitDestination: V2GitMigrationTarget = {
              pull: () => git.pullAllowEmpty(),
              readArtifact: (lock) => git.readArtifact(lock),
              push: (input) => git.push(input),
            };
            try {
              const source = await (config.mode === "git" ? git : cloud).pull();
              const existing = await (destination === "git"
                ? gitDestination
                : cloud
              ).pull();
              const merged =
                strategy === "merge"
                  ? mergeV2MigrationSnapshots(source, existing)
                  : {
                      kind: "merged" as const,
                      state: source.state,
                      ledger: source.ledger,
                    };
              if (merged.kind === "conflict") {
                write(
                  io,
                  program,
                  {
                    outcome: "CONFLICT",
                    status: "CONFLICT",
                    skills: merged.skills,
                  },
                  `Migration conflict: ${merged.skills.join(", ")}. Both providers are unchanged.\n`,
                );
                return;
              }
              const revision =
                config.mode === "git"
                  ? await migrateV2GitToCloud({
                      source: merged,
                      artifacts: git,
                      destination: cloud,
                      workspaceId: config.workspaceId,
                    })
                  : await migrateV2CloudToGit({
                      source: merged,
                      artifacts: cloud,
                      destination: gitDestination,
                    });
              if (destination === "git") {
                await configStore.set("gitRepository", repository as string);
              }
              await configStore.set("mode", destination);
              write(
                io,
                program,
                {
                  outcome: "SUCCESS",
                  status: "MIGRATED",
                  revision,
                  strategy,
                },
                `Migrated desired state to ${destination === "cloud" ? "Corotum Cloud" : "Git Sync"}.\n`,
              );
            } catch (error) {
              throw classifyMigrateCloudError(error);
            }
          } finally {
            await release();
          }
        });
      },
    );
}

function parseStrategy(value: string | undefined): MigrationStrategy {
  if (!value || !STRATEGIES.has(value as MigrationStrategy)) {
    throw new InitError(
      "Choose --strategy replace, merge, or cancel; destination state is never changed implicitly.",
      "INVALID_ARGUMENT",
    );
  }
  return value as MigrationStrategy;
}

function classifyMigrateCloudError(error: unknown): never {
  if (
    error instanceof V2CloudProviderError &&
    error.code === "AUTH_REQUIRED"
  ) {
    throw new CloudAuthError(
      "Cloud device authentication failed. Run corotum login.",
      "AUTH_REQUIRED",
    );
  }
  if (isHostedSubscriptionRequired(error)) {
    throw hostedSubscriptionInitError();
  }
  throw error;
}

async function runLegacyMigration(
  program: Command,
  io: CliIo,
  destination: "legacy" | "legacy-cleanup",
): Promise<void> {
  const homeDir = homedir();
  const platform = process.platform as "darwin" | "linux" | "win32";
  const current = resolvePlatformPaths({
    homeDir,
    platform,
    env: process.env,
  });
  const legacy = resolveLegacyPlatformPaths({
    homeDir,
    platform,
    env: process.env,
  });
  const release = await new MutationLock(
    join(current.stateDir, "process.lock"),
  ).acquire();
  try {
    const migrator = new LegacyMigrator();
    if (destination === "legacy-cleanup") {
      const marker = await migrator.cleanup({ current });
      write(
        io,
        program,
        { outcome: "SUCCESS", status: marker.status },
        "Removed verified legacy ToolMirror backup files.\n",
      );
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

function write(
  io: CliIo,
  program: Command,
  payload: Record<string, unknown>,
  human: string,
) {
  if (program.opts<{ json?: boolean }>().json) {
    io.writeOutput(`${JSON.stringify(jsonEnvelope(payload))}\n`);
  } else io.writeOutput(human);
}
