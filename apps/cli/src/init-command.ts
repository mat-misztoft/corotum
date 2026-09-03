import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import {
  type AgentId,
  detectAgents,
  localAgentFileSystem,
} from "../../../packages/agent-targets/src/index";
import { V2SaaSProvider } from "../../../packages/saas-provider/src/index";
import { createArtifactArchive } from "../../../packages/skills-adapter/src/artifact-archive";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import {
  GitSkillMaterializer,
  runSystemGit,
} from "../../../packages/skills-adapter/src/git-source";
import { createCliV2GitStateProvider } from "./artifact-consent";
import { formatCorotumBanner } from "./banner";
import { CLI_VERSION, type CliIo } from "./cli";
import { CloudAuthError, resolveCloudOrigin } from "./cloud-auth";
import { CloudSyncReportService } from "./cloud-sync-report";
import { cloudAuthContext } from "./cloud-auth-command";
import { ConfigStore, CredentialsStore, effectiveStoragePaths } from "./config";
import {
  coalesceInitCandidates,
  divergentCandidates,
} from "./init";
import {
  adoptArtifactChoices,
  classifyInitCandidates,
  decideInitAdoptions,
  type InitAdoptionChoice,
  type InitAdoptionPrompt,
} from "./init-adoption";
import {
  CloudInitService,
  hostedSubscriptionInitError,
  isHostedSubscriptionRequired,
} from "./init-cloud";
import {
  assertGitAvailable,
  InitError,
  resolveInitProvider,
  throwGitInitError,
} from "./init-errors";
import { discoverInitProvenance } from "./init-provenance";
import {
  InitRecoveryStore,
  InitTransactionService,
  type InitV2Provider,
} from "./init-transaction";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import {
  confirmOption,
  explain,
  selectManyGate,
  selectModifiedGate,
  selectOption,
  textOption,
  withProgress,
  withSpinner,
} from "./prompts";

export function registerInitCommand(program: Command, io: CliIo): void {
  program
    .command("init [provider] [repository]")
    .description(
      "initialize Git Sync or Corotum Cloud and safely adopt selected local skills",
    )
    .option("--skill <name...>", "only consider these discovered skill names")
    .option("--replace <name...>", "non-interactive source-backed replace for these skills")
    .option("--keep <name...>", "non-interactive keep-local artifact adoption for these skills")
    .option(
      "--adopt-artifact <name...>",
      "non-interactive artifact adoption for unknown-provenance skills",
    )
    .option("--origin <url>", "Cloud origin")
    .action(
      async (
        provider: string | undefined,
        repository: string | undefined,
        options: {
          skill?: string[];
          replace?: string[];
          keep?: string[];
          adoptArtifact?: string[];
          origin?: string;
        },
      ) => {
        const homeDir = processHomeDir();
        const paths = resolvePlatformPaths({
          homeDir,
          platform: process.platform as "darwin" | "linux" | "win32",
          env: process.env,
        });
        const release = await new MutationLock(
          join(paths.stateDir, "process.lock"),
        ).acquire();
        try {
          const configStore = new ConfigStore(paths);
          const config = await configStore.load();
          const opts = program.opts<{ json?: boolean; nonInteractive?: boolean }>();
          const nonInteractive =
            opts.nonInteractive === true || io.stdinIsTTY !== true;
          if (config.mode) {
            throw new InitError(
              `Corotum is already configured for ${config.mode === "cloud" ? "Cloud" : "Git"} Sync.`,
              "ALREADY_INITIALIZED",
            );
          }
          const storage = effectiveStoragePaths(config, paths);
          const recovery = new InitRecoveryStore(
            join(paths.stateDir, "init-transaction.json"),
          );
          const marker = await recovery.load();
          if (!opts.json && !nonInteractive) {
            io.writeOutput(formatCorotumBanner(CLI_VERSION));
          }

          let cloud = false;
          let gitRepository: string | undefined;
          let enabledAgentIds: AgentId[] = [];
          let outcomes: Awaited<ReturnType<typeof decideInitAdoptions>> = [];
          const progress = { update(_message: string) {} };
          let cloudConnection: Awaited<ReturnType<typeof connectCloud>> | null =
            null;

          if (marker?.backend === "git") {
            if (!nonInteractive) {
              explain(
                "Resuming init",
                "A previous init committed desired state locally but the Git push did not finish. Skipping skill selection and retrying that push.",
              );
            }
            gitRepository =
              marker.gitRepository ??
              (await gitOriginFromCache(storage.gitStoragePath));
            if (!gitRepository) {
              throw new InitError(
                "Cannot resume init without the Git repository URL. Re-run corotum init repository <git-url>.",
                "REPOSITORY_REQUIRED",
              );
            }
            enabledAgentIds = (marker.enabledAgentIds ?? []) as AgentId[];
            await assertGitAvailable();
          } else if (
            marker?.backend === "cloud" &&
            (marker.phase === "desired-persisted" ||
              marker.phase === "locally-verified")
          ) {
            if (!nonInteractive) {
              explain(
                "Resuming init",
                "Desired state is already saved to Cloud. Skipping skill selection and retrying local apply.",
              );
            }
            cloud = true;
            enabledAgentIds = (marker.enabledAgentIds ?? []) as AgentId[];
          } else {
          const selection = await resolveInitProvider({
            provider,
            repository,
            nonInteractive,
            chooseProvider: () =>
              selectOption("How do you want to sync?", [
                { value: "git", label: "Git Sync" },
                { value: "cloud", label: "Corotum Cloud" },
              ]),
            askRepository: () => textOption("Git repository URL"),
          });
          cloud = selection.kind === "cloud";
          gitRepository = selection.kind === "git" ? selection.repository : undefined;
          if (cloud) {
            cloudConnection = await connectCloud(
              program,
              io,
              paths,
              configStore,
              options.origin,
              nonInteractive,
              progress,
            );
          }

          const detected = await detectAgents(homeDir, localAgentFileSystem);
          enabledAgentIds = detected
            .map((agent) => agent.id)
            .filter((id) => config.agents[id]?.enabled === true) as AgentId[];
          if (
            enabledAgentIds.length === 0 &&
            detected.length > 0 &&
            !nonInteractive
          ) {
            const names = detected.map((agent) => agent.id).join(", ");
            if (await confirmOption(`Enable detected agents (${names})?`, true)) {
              enabledAgentIds = detected.map((agent) => agent.id);
            }
          }

          const materializer = new GitSkillMaterializer();
          const discovered = await discoverInitProvenance(homeDir);
          let filtered = options.skill?.length
            ? discovered.filter((candidate) => options.skill?.includes(candidate.name))
            : discovered;
          if (!opts.json && !nonInteractive && !options.skill?.length && filtered.length > 0) {
            const selected = new Set(
              await selectManyGate(
                "Local skills found",
                filtered.map((candidate) => candidate.name),
                {
                  detail:
                    "These folders are in ~/.agents/skills. Checking fetches each recorded Git source and compares it with your files, then asks what to adopt. That uses the network and can take a minute. Skip leaves everything on disk, unmanaged.",
                  all: "Check all against upstream",
                  allHint: "fetch Git remotes",
                  none: "Skip all",
                  noneHint: "don't manage any of them",
                  choose: "Choose which to check…",
                  chooseHint: "pick a subset first",
                },
                "all",
              ),
            );
            filtered = filtered.filter((candidate) => selected.has(candidate.name));
          }
          const classified =
            opts.json || nonInteractive
              ? await classifyInitCandidates(filtered, { materializer })
              : await withProgress(filtered.length, (advance) =>
                  classifyInitCandidates(filtered, {
                    materializer,
                    onProgress: advance,
                  }),
                );
          outcomes = await decideInitAdoptions({
            candidates: filtered,
            classified,
            nonInteractive,
            choices: [
              ...namedChoices(options.replace, "replace"),
              ...namedChoices(options.keep, "keep"),
              ...adoptArtifactChoices(options.adoptArtifact ?? []),
            ],
            prompt: nonInteractive ? undefined : adoptionPrompt(io),
            materializer,
          });
          }

          const stateStore = new LocalOperationalStateStore(
            join(paths.stateDir, "state.json"),
          );
          const persistConfig = async () => {
            await configStore.set("agents", {
              ...config.agents,
              ...Object.fromEntries(
                enabledAgentIds.map((id) => [id, { enabled: true }]),
              ),
            });
            if (cloud) {
              await configStore.set("mode", "cloud");
            } else {
              await configStore.set("gitRepository", gitRepository);
              await configStore.set("mode", "git");
            }
          };

          if (cloud && !cloudConnection) {
            cloudConnection = await connectCloud(
              program,
              io,
              paths,
              configStore,
              options.origin,
              nonInteractive,
              progress,
            );
          }
          if (!cloud) await assertGitAvailable();
          const persistDesiredState = () =>
            cloudConnection
              ? new InitTransactionService({
                  provider: cloudConnection.provider,
                  recovery,
                  persistConfig,
                  backend: {
                    kind: "cloud",
                    workspaceId: cloudConnection.workspaceId,
                  },
                  stateStore,
                  canonicalStore: new CanonicalSkillStore(storage.skillsStoragePath),
                  enabledAgentIds,
                  homeDir,
                  downloadArtifact: (lock) =>
                    cloudConnection.downloadArtifact(lock),
                  onProgress: (message) => progress.update(message),
                }).run({ outcomes })
              : new InitTransactionService({
                  provider: gitProvider(
                    createCliV2GitStateProvider({
                      storagePath: storage.gitStoragePath,
                      source: gitRepository as string,
                      options: program.opts(),
                      io,
                    }),
                  ),
                  recovery,
                  persistConfig,
                  backend: { kind: "git" },
                  stateStore,
                  canonicalStore: new CanonicalSkillStore(storage.skillsStoragePath),
                  enabledAgentIds,
                  homeDir,
                  gitRepository,
                  gitStoragePath: storage.gitStoragePath,
                  onProgress: (message) => progress.update(message),
                }).run({ outcomes });
          let result;
          try {
            const resumingCloud =
              cloud &&
              (marker?.phase === "desired-persisted" ||
                marker?.phase === "locally-verified");
            result =
              opts.json || nonInteractive
                ? await persistDesiredState()
                : await withSpinner(
                    cloud
                      ? resumingCloud
                        ? "Applying Cloud skills locally"
                        : "Saving desired state to Cloud"
                      : "Pushing desired state to Git",
                    async (setMessage) => {
                      progress.update = setMessage;
                      return persistDesiredState();
                    },
                    cloud
                      ? resumingCloud
                        ? "Applied Cloud skills locally"
                        : "Saved desired state to Cloud"
                      : "Pushed desired state to Git",
                  );
          } catch (error) {
            if (isHostedSubscriptionRequired(error)) throw hostedSubscriptionInitError();
            throwGitInitError(error);
          }

          if (result.kind === "refused") {
            if (/already initialized|already configured/i.test(result.reason)) {
              throw new InitError(result.reason, "ALREADY_INITIALIZED");
            }
            if (isHostedSubscriptionRequired(result.reason)) {
              throw hostedSubscriptionInitError();
            }
            throwGitInitError(new Error(result.reason));
          }
          const unmanaged = result.outcomes.filter((outcome) => outcome.kind === "unmanaged");
          if (result.kind === "partial") {
            io.writeError(`${result.reason}\n`);
          }
          for (const outcome of unmanaged) {
            io.writeError(`${outcome.name}: ${outcome.reason}\n`);
          }
          if (cloud && result.kind === "initialized") {
            const paired = await configStore.load();
            if (paired.deviceId) {
              try {
                await new CloudSyncReportService({
                  origin: resolveCloudOrigin(options.origin, paired.origin),
                  deviceId: paired.deviceId,
                  credentials: new CredentialsStore(paths),
                  cliVersion: CLI_VERSION,
                }).report({
                  lastAppliedRevision: result.revision,
                  appliedRevisionId: result.revision,
                  aggregate: { status: "SYNCED" },
                });
              } catch {
                io.writeError(
                  "Initialized, but the dashboard sync report did not complete. Run corotum sync.\n",
                );
              }
            }
          }
          io.writeOutput(
            cloud
              ? `Initialized Corotum Cloud at revision ${result.revision}.\n`
              : `Initialized Git Sync at revision ${result.revision}.\n`,
          );
          if (result.kind === "partial") {
            throw new Error(result.reason);
          }
        } finally {
          await release();
        }
      },
    );
}

function processHomeDir(): string {
  return (
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    homedir()
  );
}

async function gitOriginFromCache(gitDir: string): Promise<string | undefined> {
  try {
    const names = await readdir(gitDir);
    for (const name of names) {
      if (name.endsWith(".json")) continue;
      const result = await runSystemGit({
        args: ["remote", "get-url", "origin"],
        cwd: join(gitDir, name),
      });
      if (result.exitCode === 0) {
        const origin = new TextDecoder().decode(result.stdout).trim();
        if (origin) return origin;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function namedChoices(
  names: readonly string[] | undefined,
  action: Exclude<InitAdoptionChoice["action"], "adopt-artifact">,
): readonly InitAdoptionChoice[] {
  return (names ?? []).map((name) => ({ name, action }));
}

function gitProvider(
  git: ReturnType<typeof createCliV2GitStateProvider>,
): InitV2Provider {
  return {
    pull: () => git.pullAllowEmpty(),
    push: (input) =>
      git.push({
        state: input.state,
        ledger: input.ledger,
        baseRevision: input.baseRevision ?? "",
        artifacts: input.artifacts,
      }),
  };
}

async function connectCloud(
  program: Command,
  io: CliIo,
  paths: ReturnType<typeof resolvePlatformPaths>,
  config: ConfigStore,
  originOption: string | undefined,
  nonInteractive: boolean,
  progress?: { update: (message: string) => void },
): Promise<{
  provider: InitV2Provider;
  workspaceId: string;
  downloadArtifact: V2SaaSProvider["downloadArtifact"];
}> {
  const { origin, service } = await cloudAuthContext(
    program,
    io,
    originOption,
  );
  const connected = await new CloudInitService({
    config,
    credentials: new CredentialsStore(paths),
    auth: {
      login: async () => {
        if (nonInteractive) {
          throw new CloudAuthError(
            "Cloud login requires an interactive terminal to display the pairing code. Re-run without --non-interactive.",
            "GENERAL_ERROR",
          );
        }
        return service.login();
      },
    },
    provider: ({ deviceToken, workspaceId }) =>
      new V2SaaSProvider({ origin, deviceToken, workspaceId }),
  }).connect();
  return {
    workspaceId: connected.workspaceId,
    downloadArtifact: (lock) => connected.provider.downloadArtifact(lock),
    provider: {
      pull: async () => {
        const snapshot = await connected.provider.pull();
        return {
          revisionId: snapshot.revisionId,
          state: snapshot.state,
          ledger: snapshot.ledger,
        };
      },
      push: async (input) => {
        const artifacts: Record<string, Uint8Array> = {};
        const directories = Object.entries(input.artifacts);
        let packed = 0;
        for (const [id, directory] of directories) {
          packed += 1;
          progress?.update(`Packing artifacts ${packed}/${directories.length}`);
          artifacts[id] = (await createArtifactArchive(directory)).bytes;
        }
        const snapshot = await connected.provider.push({
          state: input.state,
          ledger: input.ledger,
          baseRevision: input.baseRevision,
          artifacts,
          transitions: input.ledger.audit ?? [],
          onArtifactUpload: (done, total) =>
            progress?.update(`Uploading artifacts ${done}/${total}`),
        });
        if (!snapshot.revisionId) {
          throw new Error("Cloud did not return a revision.");
        }
        return {
          revisionId: snapshot.revisionId,
          state: snapshot.state,
          ledger: snapshot.ledger,
        };
      },
    },
  };
}

function adoptionPrompt(io: CliIo): InitAdoptionPrompt {
  return {
    notice: (message) => {
      io.writeError(`${message}\n`);
    },
    chooseModified: (names) => selectModifiedGate(names),
    chooseUnavailable: (names, code) =>
      selectManyGate(
        code === "AUTH_REQUIRED"
          ? "Private-source skills"
          : "Unavailable-source skills",
        names,
        {
          detail:
            code === "AUTH_REQUIRED"
              ? "These skills have a recorded Git source, but authentication failed. Keeping them stores your local files as artifacts and remembers the source for a later update. Skip leaves them unmanaged."
              : "These skills have a recorded Git source, but that path could not be read on the current default branch (moved, missing, or fetch failed). Keeping them stores your local files as artifacts and remembers the source. Skip leaves them unmanaged.",
          all: "Keep all as local artifacts",
          allHint: "sync local files, keep source metadata",
          none: "Skip all",
          noneHint: "don't manage them",
          choose: "Choose which to keep…",
          chooseHint: "pick a subset",
        },
      ),
    chooseUnknown: (names) =>
      selectManyGate("Skills with no trusted source", names, {
        detail:
          "These folders have no usable Git provenance. Adopting stores the exact local files as artifacts in Git or Cloud. Corotum will not invent an upstream. Skip leaves them unmanaged.",
        all: "Adopt all as artifacts",
        allHint: "store local files in sync",
        none: "Skip all",
        noneHint: "don't manage them",
        choose: "Choose which to adopt…",
        chooseHint: "pick a subset",
      }),
    chooseDuplicate: (name, candidates) =>
      selectOption(`Choose one ${name} candidate`, [
        ...candidates.map((candidate) => ({
          value: candidate.name,
          label: candidate.path,
        })),
        { value: "do-not-manage", label: "Do not manage" },
      ]),
  };
}

export async function selectInitCandidates(
  candidates: readonly {
    agentId: AgentId;
    contentHash: string;
    name: string;
    path: string;
    source: string;
  }[],
  nonInteractive: boolean,
  select: (
    name: string,
    copies: readonly {
      agentId: AgentId;
      contentHash: string;
      name: string;
      path: string;
      source: string;
    }[],
  ) => Promise<number> = async () => 0,
) {
  const grouped = coalesceInitCandidates(candidates);
  const divergentNames = new Set(
    divergentCandidates(candidates).map((candidate) => candidate.name),
  );
  if (nonInteractive && divergentNames.size > 0) return grouped;
  const selected = grouped.filter(
    (selection) => !divergentNames.has(selection.name),
  );
  for (const name of [...divergentNames].sort()) {
    const copies = candidates.filter((candidate) => candidate.name === name);
    const choices = coalesceInitCandidates(copies);
    const choice = await select(name, copies);
    if (choice >= 0 && choice < choices.length) selected.push(choices[choice]!);
  }
  return selected;
}
