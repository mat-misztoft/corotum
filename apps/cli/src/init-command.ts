import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { Command } from "commander";
import {
  builtInAgentAdapters,
  detectAgents,
  localAgentFileSystem,
  type AgentId,
} from "../../../packages/agent-targets/src/index";
import { GitStateProvider } from "../../../packages/git-provider/src/index";
import { CanonicalSkillStore, hashSkillDirectory } from "../../../packages/skills-adapter/src/canonical-store";
import { GitSkillMaterializer } from "../../../packages/skills-adapter/src/git-source";
import { ConfigStore, effectiveStoragePaths } from "./config";
import { coalesceInitCandidates, divergentCandidates, InitService } from "./init";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { LocalReconcileExecutor } from "./reconcile-executor";
import type { CliIo } from "./cli";

/** Registers the local-only Git initialization path. Cloud init is T049. */
export function registerInitCommand(program: Command, io: CliIo): void {
  program
    .command("init <repository>")
    .description("initialize Git Sync and safely adopt selected local skills")
    .requiredOption("--source <repository>", "Git source for the local skills being adopted")
    .option("--skill <name...>", "adopt only these discovered skill names")
    .action(async (repository: string, options: { source: string; skill?: string[] }) => {
      const homeDir = homedir();
      const paths = resolvePlatformPaths({ homeDir, platform: process.platform as "darwin" | "linux" | "win32", env: process.env });
      const release = await new MutationLock(join(paths.stateDir, "process.lock")).acquire();
      try {
      const configStore = new ConfigStore(paths);
      const config = await configStore.load();
      if (config.mode && config.mode !== "git") throw new Error("ToolMirror is already configured for Cloud Sync.");

      const detected = await detectAgents(homeDir, localAgentFileSystem);
      let enabledAgentIds = detected
        .map((agent) => agent.id)
        .filter((id) => config.agents[id]?.enabled === true) as AgentId[];
      if (enabledAgentIds.length === 0 && detected.length > 0 && io.stdinIsTTY) {
        const names = detected.map((agent) => agent.id).join(", ");
        if (await confirm(`Enable detected agents (${names})? [Y/n] `)) {
          enabledAgentIds = detected.map((agent) => agent.id);
        }
      }
      if (enabledAgentIds.length === 0) {
        throw new Error("No detected agents are enabled. Non-interactive init never enables agents automatically.");
      }

      const candidates = await discoverCandidates(homeDir, enabledAgentIds, options.source);
      const filtered = options.skill?.length
        ? candidates.filter((candidate) => options.skill?.includes(candidate.name))
        : candidates;
      const nonInteractive = program.opts<{ nonInteractive?: boolean }>().nonInteractive === true || !io.stdinIsTTY;
      const selected = await selectInitCandidates(filtered, nonInteractive);
      const storage = effectiveStoragePaths(config, paths);
      const materializer = new GitSkillMaterializer();
      const result = await new InitService(
        new GitStateProvider(storage.gitStoragePath, repository),
        { resolve: ({ id, source, skill }) => materializer.resolve({ id, source, skill, ref: "HEAD" }) },
        new LocalReconcileExecutor(new LocalOperationalStateStore(join(paths.stateDir, "state.json")), new CanonicalSkillStore(storage.skillsStoragePath), materializer),
      ).initialize({
        candidates,
        selected,
        nonInteractive,
        execution: {
          enabledAgentIds,
          homeDir,
          state: (await new LocalOperationalStateStore(join(paths.stateDir, "state.json")).load()) ?? { schemaVersion: 1, lastAppliedRevision: null, skills: {} },
        },
      });
      if (result.kind === "refused" || result.kind === "selection-required") throw new Error(result.kind === "refused" ? result.reason : "Divergent local skills require an explicit interactive selection.");
      await configStore.set("agents", { ...config.agents, ...Object.fromEntries(enabledAgentIds.map((id) => [id, { enabled: true }])) });
      await configStore.set("gitRepository", repository);
      await configStore.set("mode", "git");
      io.writeOutput(`Initialized Git Sync at revision ${result.revision}.\n`);
      } finally {
        await release();
      }
    });
}

async function confirm(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return !/^(n|no)$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

export async function selectInitCandidates(
  candidates: readonly { agentId: AgentId; contentHash: string; name: string; path: string; source: string }[],
  nonInteractive: boolean,
  select: (name: string, copies: readonly { agentId: AgentId; contentHash: string; name: string; path: string; source: string }[]) => Promise<number> = selectCanonicalCopy,
) {
  const grouped = coalesceInitCandidates(candidates);
  const divergentNames = new Set(divergentCandidates(candidates).map((candidate) => candidate.name));
  if (nonInteractive && divergentNames.size > 0) return grouped;

  const selected = grouped.filter((selection) => !divergentNames.has(selection.name));
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
  copies: readonly { agentId: AgentId; contentHash: string; name: string; path: string; source: string }[],
): Promise<number> {
  const choices = coalesceInitCandidates(copies);
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const lines = choices.map((choice, index) => `${index + 1}) ${choice.contentHash} (${choice.targets.join(", ")})`).join("\n");
    const answer = (await prompt.question(`Choose the canonical copy for ${name}:\n${lines}\n[1-${choices.length}, or Enter to leave unmanaged] `)).trim();
    if (answer === "") return -1;
    const choice = Number.parseInt(answer, 10) - 1;
    return Number.isInteger(choice) ? choice : -1;
  } finally {
    prompt.close();
  }
}

async function discoverCandidates(homeDir: string, agentIds: readonly AgentId[], source: string) {
  const candidates = [] as { agentId: AgentId; contentHash: string; name: string; path: string; source: string }[];
  for (const agentId of agentIds) {
    const adapter = builtInAgentAdapters.find((item) => item.id === agentId);
    if (!adapter) continue;
    for (const directory of adapter.globalSkillPaths(homeDir)) {
      try {
        const entries = await readdir(directory, { encoding: "utf8", withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const path = join(directory, entry.name);
          candidates.push({ agentId, name: entry.name, path, source, contentHash: await hashSkillDirectory(path) });
        }
      } catch {
        continue;
      }
    }
  }
  return candidates;
}
