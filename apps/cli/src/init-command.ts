import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import type { Command } from "commander";
import {
  type AgentId,
  builtInAgentAdapters,
  detectAgents,
  localAgentFileSystem,
} from "../../../packages/agent-targets/src/index";
import { GitStateProvider } from "../../../packages/git-provider/src/index";
import { SaaSProvider } from "../../../packages/saas-provider/src/index";
import {
  CanonicalSkillStore,
  hashSkillDirectory,
} from "../../../packages/skills-adapter/src/canonical-store";
import { GitSkillMaterializer } from "../../../packages/skills-adapter/src/git-source";
import type { CliIo } from "./cli";
import { DEFAULT_CLOUD_ORIGIN } from "./cloud-auth";
import { cloudAuthContext } from "./cloud-auth-command";
import { ConfigStore, CredentialsStore, effectiveStoragePaths } from "./config";
import {
  coalesceInitCandidates,
  divergentCandidates,
  InitService,
} from "./init";
import { CloudInitService } from "./init-cloud";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { LocalReconcileExecutor } from "./reconcile-executor";

export function registerInitCommand(program: Command, io: CliIo): void {
  program
    .command("init <repository|cloud>")
    .description(
      "initialize Git Sync or ToolMirror Cloud and safely adopt selected local skills",
    )
    .requiredOption(
      "--source <repository>",
      "Git source for the local skills being adopted",
    )
    .option("--skill <name...>", "adopt only these discovered skill names")
    .option("--origin <url>", "Cloud origin")
    .action(
      async (
        repository: string,
        options: { source: string; skill?: string[]; origin?: string },
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
              `ToolMirror is already configured for ${cloud ? "Git" : "Cloud"} Sync.`,
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

          const candidates = await discoverCandidates(
            homeDir,
            enabledAgentIds,
            options.source,
          );
          const filtered = options.skill?.length
            ? candidates.filter((candidate) =>
                options.skill?.includes(candidate.name),
              )
            : candidates;
          const nonInteractive =
            program.opts<{ nonInteractive?: boolean }>().nonInteractive ===
              true || !io.stdinIsTTY;
          const selected = await selectInitCandidates(filtered, nonInteractive);
          const storage = effectiveStoragePaths(config, paths);
          const materializer = new GitSkillMaterializer();
          const executor = new LocalReconcileExecutor(
            new LocalOperationalStateStore(join(paths.stateDir, "state.json")),
            new CanonicalSkillStore(storage.skillsStoragePath),
            materializer,
          );
          const initialization = {
            candidates,
            selected,
            nonInteractive,
            execution: {
              enabledAgentIds,
              homeDir,
              state: (await new LocalOperationalStateStore(
                join(paths.stateDir, "state.json"),
              ).load()) ?? {
                schemaVersion: 1 as const,
                lastAppliedRevision: null,
                skills: {},
              },
            },
          };
          const resolver = {
            resolve: ({
              id,
              source,
              skill,
            }: {
              id: Parameters<GitSkillMaterializer["resolve"]>[0]["id"];
              source: string;
              skill: string;
            }) => materializer.resolve({ id, source, skill, ref: "HEAD" }),
          };
          const result = cloud
            ? await initializeCloud(
                program,
                io,
                paths,
                configStore,
                options.origin,
                resolver,
                executor,
                initialization,
              )
            : await new InitService(
                new GitStateProvider(storage.gitStoragePath, repository),
                resolver,
                executor,
              ).initialize(initialization);
          if (result.kind === "refused" || result.kind === "selection-required")
            throw new Error(
              result.kind === "refused"
                ? result.reason
                : "Divergent local skills require an explicit interactive selection.",
            );
          await configStore.set("agents", {
            ...config.agents,
            ...Object.fromEntries(
              enabledAgentIds.map((id) => [id, { enabled: true }]),
            ),
          });
          if (cloud) {
            await configStore.set("mode", "cloud");
            io.writeOutput(
              `Initialized ToolMirror Cloud at revision ${result.revision}.\n`,
            );
          } else {
            await configStore.set("gitRepository", repository);
            await configStore.set("mode", "git");
            io.writeOutput(
              `Initialized Git Sync at revision ${result.revision}.\n`,
            );
          }
        } finally {
          await release();
        }
      },
    );
}

async function initializeCloud(
  program: Command,
  io: CliIo,
  paths: ReturnType<typeof resolvePlatformPaths>,
  config: ConfigStore,
  originOption: string | undefined,
  resolver: ConstructorParameters<typeof InitService>[1],
  executor: ConstructorParameters<typeof InitService>[2],
  input: Parameters<InitService["initialize"]>[0],
) {
  const { origin, service } = cloudAuthContext(
    program,
    io,
    originOption ?? DEFAULT_CLOUD_ORIGIN,
  );
  return new CloudInitService({
    config,
    credentials: new CredentialsStore(paths),
    auth: service,
    provider: ({ deviceToken, workspaceId }) =>
      new SaaSProvider({ origin, deviceToken, workspaceId }),
    resolver,
    executor,
  }).initialize(input);
}

async function confirm(question: string): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return !/^(n|no)$/i.test((await prompt.question(question)).trim());
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
  ) => Promise<number> = selectCanonicalCopy,
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
    if (choice >= 0 && choice < choices.length) selected.push(choices[choice]);
  }
  return selected;
}

async function selectCanonicalCopy(
  name: string,
  copies: readonly {
    agentId: AgentId;
    contentHash: string;
    name: string;
    path: string;
    source: string;
  }[],
): Promise<number> {
  const choices = coalesceInitCandidates(copies);
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const lines = choices
      .map(
        (choice, index) =>
          `${index + 1}) ${choice.contentHash} (${choice.targets.join(", ")})`,
      )
      .join("\n");
    const answer = (
      await prompt.question(
        `Choose the canonical copy for ${name}:\n${lines}\n[1-${choices.length}, or Enter to leave unmanaged] `,
      )
    ).trim();
    if (answer === "") return -1;
    const choice = Number.parseInt(answer, 10) - 1;
    return Number.isInteger(choice) ? choice : -1;
  } finally {
    prompt.close();
  }
}

async function discoverCandidates(
  homeDir: string,
  agentIds: readonly AgentId[],
  source: string,
) {
  const candidates = [] as {
    agentId: AgentId;
    contentHash: string;
    name: string;
    path: string;
    source: string;
  }[];
  for (const agentId of agentIds) {
    const adapter = builtInAgentAdapters.find((item) => item.id === agentId);
    if (!adapter) continue;
    for (const directory of adapter.globalSkillPaths(homeDir)) {
      try {
        const entries = await readdir(directory, {
          encoding: "utf8",
          withFileTypes: true,
        });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const path = join(directory, entry.name);
          candidates.push({
            agentId,
            name: entry.name,
            path,
            source,
            contentHash: await hashSkillDirectory(path),
          });
        }
      } catch {}
    }
  }
  return candidates;
}
