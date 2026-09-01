import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import type { Command } from "commander";
import {
  type AgentId,
  detectAgents,
  localAgentFileSystem,
} from "../../../packages/agent-targets/src/index";
import { V2SaaSProvider } from "../../../packages/saas-provider/src/index";
import { createArtifactArchive } from "../../../packages/skills-adapter/src/artifact-archive";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import { GitSkillMaterializer } from "../../../packages/skills-adapter/src/git-source";
import { createCliV2GitStateProvider } from "./artifact-consent";
import type { CliIo } from "./cli";
import { DEFAULT_CLOUD_ORIGIN } from "./cloud-auth";
import { cloudAuthContext } from "./cloud-auth-command";
import { ConfigStore, CredentialsStore, effectiveStoragePaths } from "./config";
import {
  adoptArtifactChoices,
  decideInitAdoptions,
  type InitAdoptionChoice,
  type InitAdoptionPrompt,
} from "./init-adoption";
import { CloudInitService } from "./init-cloud";
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
  coalesceInitCandidates,
  divergentCandidates,
} from "./init";

export function registerInitCommand(program: Command, io: CliIo): void {
  program
    .command("init <repository|cloud>")
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
        repository: string,
        options: {
          skill?: string[];
          replace?: string[];
          keep?: string[];
          adoptArtifact?: string[];
          origin?: string;
        },
      ) => {
        const homeDir = homedir();
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
          const cloud = repository === "cloud";
          if (config.mode && config.mode !== (cloud ? "cloud" : "git")) {
            throw new Error(
              `Corotum is already configured for ${cloud ? "Git" : "Cloud"} Sync.`,
            );
          }

          const detected = await detectAgents(homeDir, localAgentFileSystem);
          let enabledAgentIds = detected
            .map((agent) => agent.id)
            .filter((id) => config.agents[id]?.enabled === true) as AgentId[];
          if (
            enabledAgentIds.length === 0 &&
            detected.length > 0 &&
            io.stdinIsTTY
          ) {
            const names = detected.map((agent) => agent.id).join(", ");
            if (await confirm(`Enable detected agents (${names})? [Y/n] `)) {
              enabledAgentIds = detected.map((agent) => agent.id);
            }
          }
          if (enabledAgentIds.length === 0) {
            throw new Error(
              "No detected agents are enabled. Non-interactive init never enables agents automatically.",
            );
          }

          const discovered = await discoverInitProvenance(homeDir);
          const filtered = options.skill?.length
            ? discovered.filter((candidate) => options.skill?.includes(candidate.name))
            : discovered;
          const nonInteractive =
            program.opts<{ nonInteractive?: boolean }>().nonInteractive === true ||
            !io.stdinIsTTY;
          const outcomes = await decideInitAdoptions({
            candidates: filtered,
            nonInteractive,
            choices: [
              ...namedChoices(options.replace, "replace"),
              ...namedChoices(options.keep, "keep"),
              ...adoptArtifactChoices(options.adoptArtifact ?? []),
            ],
            prompt: nonInteractive ? undefined : adoptionPrompt(io),
            materializer: new GitSkillMaterializer(),
          });

          const storage = effectiveStoragePaths(config, paths);
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
              await configStore.set("gitRepository", repository);
              await configStore.set("mode", "git");
            }
          };

          const cloudConnection = cloud
            ? await connectCloud(program, io, paths, configStore, options.origin)
            : null;
          const result = cloudConnection
            ? await new InitTransactionService({
                provider: cloudConnection.provider,
                recovery: new InitRecoveryStore(join(paths.stateDir, "init-transaction.json")),
                persistConfig,
                backend: {
                  kind: "cloud",
                  workspaceId: cloudConnection.workspaceId,
                },
                stateStore,
                canonicalStore: new CanonicalSkillStore(storage.skillsStoragePath),
                enabledAgentIds,
                homeDir,
              }).run({ outcomes })
            : await new InitTransactionService({
                provider: gitProvider(
                  createCliV2GitStateProvider({
                    storagePath: storage.gitStoragePath,
                    source: repository,
                    options: program.opts(),
                    io,
                  }),
                ),
                recovery: new InitRecoveryStore(join(paths.stateDir, "init-transaction.json")),
                persistConfig,
                backend: { kind: "git" },
                stateStore,
                canonicalStore: new CanonicalSkillStore(storage.skillsStoragePath),
                enabledAgentIds,
                homeDir,
                gitRepository: repository,
                gitStoragePath: storage.gitStoragePath,
              }).run({ outcomes });

          if (result.kind === "refused") throw new Error(result.reason);
          const unmanaged = result.outcomes.filter((outcome) => outcome.kind === "unmanaged");
          if (result.kind === "partial") {
            io.writeError(`${result.reason}\n`);
          }
          for (const outcome of unmanaged) {
            io.writeError(`${outcome.name}: ${outcome.reason}\n`);
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
): Promise<{ provider: InitV2Provider; workspaceId: string }> {
  const { origin, service } = cloudAuthContext(
    program,
    io,
    originOption ?? DEFAULT_CLOUD_ORIGIN,
  );
  const connected = await new CloudInitService({
    config,
    credentials: new CredentialsStore(paths),
    auth: service,
    provider: ({ deviceToken, workspaceId }) =>
      new V2SaaSProvider({ origin, deviceToken, workspaceId }),
  }).connect();
  return {
    workspaceId: connected.workspaceId,
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
        for (const [id, directory] of Object.entries(input.artifacts)) {
          artifacts[id] = (await createArtifactArchive(directory)).bytes;
        }
        const snapshot = await connected.provider.push({
          state: input.state,
          ledger: input.ledger,
          baseRevision: input.baseRevision,
          artifacts,
          transitions: input.ledger.audit ?? [],
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
    chooseModified: async (name) => {
      const answer = await confirmChoice(
        `Local skill ${name} differs from upstream. [R]eplace latest, [K]eep local, [D]o not manage? `,
      );
      if (/^k/i.test(answer)) return "keep";
      if (/^d/i.test(answer)) return "do-not-manage";
      return "replace";
    },
    chooseUnavailable: async (name, code) => {
      const answer = await confirmChoice(
        `${name} source is ${code === "AUTH_REQUIRED" ? "private" : "unavailable"}. [K]eep local as artifact, [D]o not manage? `,
      );
      return /^k/i.test(answer) ? "keep" : "do-not-manage";
    },
    chooseUnknown: async (name) => {
      const answer = await confirmChoice(
        `${name} has no trusted source. [A]dopt as artifact, [D]o not manage? `,
      );
      return /^a/i.test(answer) ? "adopt-artifact" : "do-not-manage";
    },
    chooseDuplicate: async (name, candidates) => {
      const lines = candidates
        .map((candidate, index) => `${index + 1}) ${candidate.path}`)
        .join("\n");
      const answer = (
        await confirmChoice(
          `Choose one ${name} candidate:\n${lines}\n[1-${candidates.length}, or Enter to leave unmanaged] `,
        )
      ).trim();
      if (answer === "") return "do-not-manage";
      const choice = Number.parseInt(answer, 10) - 1;
      return Number.isInteger(choice) && choice >= 0 && choice < candidates.length
        ? candidates[choice]!.name
        : "do-not-manage";
    },
  };
}

async function confirm(question: string): Promise<boolean> {
  return !/^(n|no)$/i.test((await confirmChoice(question)).trim());
}

async function confirmChoice(question: string): Promise<string> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
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
