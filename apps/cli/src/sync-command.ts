import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import type { Command } from "commander";
import {
  type AgentId,
  detectAgents,
  localAgentFileSystem,
} from "../../../packages/agent-targets/src/index";
import { GitStateProvider } from "../../../packages/git-provider/src/index";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import { GitSkillMaterializer } from "../../../packages/skills-adapter/src/git-source";
import type { CliIo } from "./cli";
import { isNonInteractive } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import { ConfigStore, effectiveStoragePaths } from "./config";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { LocalReconcileExecutor } from "./reconcile-executor";
import { type DetectedAgentStatus, SyncService } from "./sync";

/** Registers exact-lock sync plus read-only local status and diff commands. */
export function registerSyncCommands(program: Command, io: CliIo): void {
  program
    .command("status")
    .description("show local skill reconciliation status")
    .action(() => inspectCommand("STATUS", program, io));
  program
    .command("diff")
    .description("show the exact-lock reconciliation plan")
    .action(() => inspectCommand("DIFF", program, io));
  program
    .command("sync")
    .description("reconcile local skills to the exact locked state")
    .action(() => syncCommand(program, io));
}

async function inspectCommand(
  kind: "STATUS" | "DIFF",
  program: Command,
  io: CliIo,
): Promise<void> {
  const context = await createContext();
  const config = await context.configStore.load();
  assertGitConfig(config.mode, config.gitRepository);
  const state = (await context.stateStore.load()) ?? emptyState();
  const result = await context.service(config).inspect(state);
  if (result.kind === "refused") throw new Error(result.reason);
  if (kind === "STATUS") {
    const payload = {
      outcome: "SUCCESS",
      status: kind,
      revision: result.snapshot.desired.revisionId,
      skills: result.snapshot.plan.classifications,
    };
    write(io, program, payload, `${payload.skills.length} skills inspected.\n`);
    return;
  }
  const payload = {
    outcome: "SUCCESS",
    status: kind,
    revision: result.snapshot.desired.revisionId,
    classifications: result.snapshot.plan.classifications,
    operations: result.snapshot.plan.operations,
  };
  write(
    io,
    program,
    payload,
    `${payload.operations.length} operations planned.\n`,
  );
}

async function syncCommand(program: Command, io: CliIo): Promise<void> {
  const context = await createContext();
  const release = await new MutationLock(
    join(context.paths.stateDir, "process.lock"),
  ).acquire();
  try {
    let config = await context.configStore.load();
    assertGitConfig(config.mode, config.gitRepository);
    const agents = await scanAgents(
      config.agents,
      context.homeDir,
      isNonInteractive(program.opts(), io.stdinIsTTY),
      io,
    );
    const newlyEnabled = agents.filter(
      (agent) =>
        agent.status === "ENABLED" && !config.agents[agent.id]?.enabled,
    );
    if (newlyEnabled.length > 0) {
      await context.configStore.set("agents", {
        ...config.agents,
        ...Object.fromEntries(
          newlyEnabled.map((agent) => [agent.id, { enabled: true }]),
        ),
      });
      config = await context.configStore.load();
    }
    const state = (await context.stateStore.load()) ?? emptyState();
    const result = await context.service(config).sync({
      execution: {
        state,
        enabledAgentIds: Object.entries(config.agents)
          .filter(([, value]) => value.enabled)
          .map(([id]) => id) as AgentId[],
        homeDir: context.homeDir,
      },
    });
    if (result.kind === "refused") throw new Error(result.reason);
    write(
      io,
      program,
      {
        outcome: result.kind === "partial" ? "PARTIAL_SUCCESS" : "SUCCESS",
        status: result.kind === "partial" ? "PARTIAL" : "SYNCED",
        revision: result.snapshot.desired.revisionId,
        agents,
        operations: result.execution.operations,
        classifications: result.snapshot.plan.classifications,
      },
      `${result.kind === "partial" ? "Partial" : "Synced"} at revision ${result.snapshot.desired.revisionId}.\n`,
    );
  } finally {
    await release();
  }
}

function createContext() {
  const homeDir = homedir();
  const paths = resolvePlatformPaths({
    homeDir,
    platform: process.platform as "darwin" | "linux" | "win32",
    env: process.env,
  });
  const configStore = new ConfigStore(paths);
  const stateStore = new LocalOperationalStateStore(
    join(paths.stateDir, "state.json"),
  );
  return {
    homeDir,
    paths,
    configStore,
    stateStore,
    service: (config: Awaited<ReturnType<ConfigStore["load"]>>) => {
      const storage = effectiveStoragePaths(config, paths);
      const materializer = new GitSkillMaterializer();
      return new SyncService(
        new GitStateProvider(
          storage.gitStoragePath,
          config.gitRepository ?? "",
        ),
        new LocalReconcileExecutor(
          stateStore,
          new CanonicalSkillStore(storage.skillsStoragePath),
          materializer,
        ),
      );
    },
  };
}

async function scanAgents(
  configured: Record<string, { enabled: boolean }>,
  homeDir: string,
  nonInteractive: boolean,
  io: CliIo,
): Promise<readonly DetectedAgentStatus[]> {
  const fresh = (await detectAgents(homeDir, localAgentFileSystem)).filter(
    (agent) => configured[agent.id] === undefined,
  );
  if (fresh.length === 0) return [];
  const enable =
    !nonInteractive &&
    (await confirm(
      io,
      `Enable newly detected agents (${fresh.map((agent) => agent.id).join(", ")})? [Y/n] `,
    ));
  return detectedAgentStatuses(fresh, enable);
}

/** Converts fresh detection into explicit output without enabling by default. */
export function detectedAgentStatuses(
  detected: readonly { id: AgentId }[],
  enable: boolean,
): readonly DetectedAgentStatus[] {
  return detected.map((agent) => ({
    id: agent.id,
    status: enable ? "ENABLED" : "DETECTED_DISABLED",
  }));
}

async function confirm(io: CliIo, question: string): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: { write: io.writeError } as never,
  });
  try {
    return !/^(n|no)$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

function emptyState() {
  return { schemaVersion: 1 as const, lastAppliedRevision: null, skills: {} };
}
function assertGitConfig(
  mode: string | null,
  repository: string | null,
): asserts repository is string {
  if (mode !== "git" || !repository)
    throw new Error("Run corotum init before using Git Sync.");
}
function write(
  io: CliIo,
  program: Command,
  payload: Record<string, unknown>,
  human: string,
): void {
  if (program.opts<{ json?: boolean }>().json)
    io.writeOutput(`${JSON.stringify(jsonEnvelope(payload))}\n`);
  else io.writeOutput(human);
}
