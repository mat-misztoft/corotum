import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import {
  type AgentId,
  builtInAgentAdapters,
  detectAgents,
  localAgentFileSystem,
} from "../../../packages/agent-targets/src/index";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import {
  type AgentStatus,
  agentStatuses,
  enabledAgentIdsFrom,
  formatAgentStatuses,
  parseAgentId,
} from "./agents";
import { createCliV2GitStateProvider } from "./artifact-consent";
import type { CliIo } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import {
  ConfigStore,
  type CorotumConfig,
  effectiveStoragePaths,
} from "./config";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { V2LocalApplier } from "./v2-local-applier";

/** Registers optional local agent detection and per-device exposure commands. */
export function registerAgentsCommand(program: Command, io: CliIo): void {
  const agents = program
    .command("agents")
    .description("list, scan, enable, or disable optional local agents");
  agents.action(async () => {
    const snapshot = await listAgents();
    write(
      io,
      program,
      {
        outcome: "SUCCESS",
        command: "AGENTS",
        agents: snapshot,
      },
      formatAgentStatuses(snapshot),
    );
  });
  agents
    .command("scan")
    .description("detect installed agents without enabling them")
    .action(async () => {
      const snapshot = await listAgents();
      write(
        io,
        program,
        {
          outcome: "SUCCESS",
          command: "AGENTS_SCAN",
          agents: snapshot,
        },
        formatAgentStatuses(snapshot),
      );
    });
  agents
    .command("enable <agent>")
    .description("enable local exposure for one agent on this device")
    .action(async (agentInput: string) => {
      const result = await mutateAgent(
        program,
        io,
        parseAgentId(agentInput),
        true,
      );
      const name = displayName(result.agentId);
      write(
        io,
        program,
        {
          outcome: "SUCCESS",
          command: "AGENTS_ENABLE",
          agent: result.agentId,
          enabled: true,
          exposed: result.changed,
        },
        `Enabled ${name} (${result.agentId}) on this device.\n`,
      );
    });
  agents
    .command("disable <agent>")
    .description(
      "remove local exposure for one agent without deleting global skills",
    )
    .action(async (agentInput: string) => {
      const result = await mutateAgent(
        program,
        io,
        parseAgentId(agentInput),
        false,
      );
      const name = displayName(result.agentId);
      write(
        io,
        program,
        {
          outcome: "SUCCESS",
          command: "AGENTS_DISABLE",
          agent: result.agentId,
          enabled: false,
          removed: result.changed,
        },
        `Disabled ${name} (${result.agentId}) on this device. Global skills were not deleted.\n`,
      );
    });
}

async function listAgents(): Promise<readonly AgentStatus[]> {
  const homeDir = homedir();
  const paths = resolvePlatformPaths({
    homeDir,
    platform: process.platform as "darwin" | "linux" | "win32",
    env: process.env,
  });
  const [detected, config] = await Promise.all([
    detectAgents(homeDir, localAgentFileSystem),
    new ConfigStore(paths).load(),
  ]);
  return agentStatuses(
    detected.map((agent) => agent.id),
    config.agents,
  );
}

async function mutateAgent(
  program: Command,
  io: CliIo,
  agentId: AgentId,
  enable: boolean,
): Promise<Readonly<{ agentId: AgentId; changed: number }>> {
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
    const nextAgents = {
      ...config.agents,
      [agentId]: { enabled: enable },
    };
    const enabledAgentIds = enable
      ? Array.from(new Set([...enabledAgentIdsFrom(config.agents), agentId]))
      : enabledAgentIdsFrom(nextAgents);
    const changed = await applyExposure(program, io, {
      config: { ...config, agents: nextAgents },
      enabledAgentIds,
      homeDir,
      paths,
      disableAgentId: enable ? undefined : agentId,
    });
    await configStore.set("agents", nextAgents);
    return { agentId, changed };
  } finally {
    await release();
  }
}

async function applyExposure(
  program: Command,
  io: CliIo,
  input: Readonly<{
    config: CorotumConfig;
    enabledAgentIds: readonly AgentId[];
    homeDir: string;
    paths: ReturnType<typeof resolvePlatformPaths>;
    disableAgentId?: AgentId;
  }>,
): Promise<number> {
  if (input.config.mode !== "git" && input.config.mode !== "cloud") return 0;
  const storage = effectiveStoragePaths(input.config, input.paths);
  const applier = new V2LocalApplier(
    new LocalOperationalStateStore(join(input.paths.stateDir, "state.json")),
    new CanonicalSkillStore(storage.skillsStoragePath),
    {
      storagePath: storage.gitStoragePath,
      repository: input.config.gitRepository ?? "cloud",
      enabledAgentIds: input.enabledAgentIds,
      homeDir: input.homeDir,
    },
  );
  if (input.disableAgentId) {
    return (await applier.applyDisableAgent(input.disableAgentId)).filter(
      (outcome) => outcome.status === "EXPOSED",
    ).length;
  }
  const desired =
    input.config.mode === "git" && input.config.gitRepository
      ? (
          await createCliV2GitStateProvider({
            storagePath: storage.gitStoragePath,
            source: input.config.gitRepository,
            options: program.opts(),
            io,
          }).pullReadOnly()
        ).state
      : undefined;
  return (await applier.applyEnableAgent(desired)).filter(
    (outcome) => outcome.status === "EXPOSED",
  ).length;
}

function displayName(id: AgentId): string {
  return builtInAgentAdapters.find((agent) => agent.id === id)?.name ?? id;
}

function write(
  io: CliIo,
  program: Command,
  payload: Record<string, unknown>,
  human: string,
): void {
  if (program.opts<{ json?: boolean }>().json) {
    io.writeOutput(`${JSON.stringify(jsonEnvelope(payload))}\n`);
    return;
  }
  io.writeOutput(human);
}
