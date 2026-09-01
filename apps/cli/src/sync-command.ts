import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import type { Command } from "commander";
import {
  type AgentId,
  detectAgents,
  localAgentFileSystem,
} from "../../../packages/agent-targets/src/index";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import { V2SaaSProvider } from "../../../packages/saas-provider/src/index";
import { createCliV2GitStateProvider } from "./artifact-consent";
import type { CliIo } from "./cli";
import { isNonInteractive } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import {
  CloudSyncReportService,
  deviceSyncAggregateFrom,
} from "./cloud-sync-report";
import { DEFAULT_CLOUD_ORIGIN } from "./cloud-auth";
import {
  ConfigStore,
  CredentialsStore,
  effectiveStoragePaths,
  type CorotumConfig,
} from "./config";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { V2LocalApplier } from "./v2-local-applier";
import { LifecycleRecoveryStore } from "./v2-lifecycle";
import {
  V2SyncService,
  type V2SyncEnvelope,
  type V2SyncProviderPort,
  v2SyncStatusPayload,
} from "./v2-sync";

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
  const runtime = await createRuntime(program, io, false);
  const result = await runtime.service.inspect();
  const payload: Record<string, unknown> = {
    ...v2SyncStatusPayload(result),
    command: kind,
  };
  if (result.kind === "refused" && payload.status !== "PENDING_PUSH") {
    throw new Error(result.reason);
  }
  const human =
    result.kind === "ready"
      ? kind === "STATUS"
        ? `${result.snapshot.plan.classifications.length} skills inspected.\n`
        : `${result.snapshot.plan.operations.length} operations planned.\n`
      : `${String(payload.status)}: ${"reason" in result ? result.reason : ""}\n`;
  write(io, program, payload, human);
}

async function syncCommand(program: Command, io: CliIo): Promise<void> {
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
    let config = await configStore.load();
    const agents = await scanAgents(
      config.agents,
      homeDir,
      isNonInteractive(program.opts(), io.stdinIsTTY),
      io,
    );
    const newlyEnabled = agents.filter(
      (agent) =>
        agent.status === "ENABLED" && !config.agents[agent.id]?.enabled,
    );
    if (newlyEnabled.length > 0) {
      await configStore.set("agents", {
        ...config.agents,
        ...Object.fromEntries(
          newlyEnabled.map((agent) => [agent.id, { enabled: true }]),
        ),
      });
      config = await configStore.load();
    }
    const runtime = await createRuntime(program, io, true, config);
    const result = await runtime.service.sync();
    const payload: Record<string, unknown> = {
      ...v2SyncStatusPayload(result),
      command: "SYNC",
      agents,
    };
    if (result.kind === "refused" && payload.status !== "PENDING_PUSH") {
      throw new Error(result.reason);
    }
    const human =
      result.kind === "synced"
        ? `Synced at revision ${result.snapshot.desired.revisionId}.\n`
        : result.kind === "partial"
          ? `Partial at revision ${result.snapshot.desired.revisionId}.\n`
          : `${String(payload.status)}: ${"reason" in result ? result.reason : ""}\n`;
    write(io, program, payload, human);
  } finally {
    await release();
  }
}

async function createRuntime(
  program: Command,
  io: CliIo,
  forSync: boolean,
  loaded?: CorotumConfig,
): Promise<Readonly<{ service: V2SyncService; mode: "git" | "cloud" }>> {
  const homeDir = homedir();
  const paths = resolvePlatformPaths({
    homeDir,
    platform: process.platform as "darwin" | "linux" | "win32",
    env: process.env,
  });
  const config = loaded ?? (await new ConfigStore(paths).load());
  if (config.mode !== "git" && config.mode !== "cloud") {
    throw new Error("Run corotum init before using status, diff, or sync.");
  }
  const storage = effectiveStoragePaths(config, paths);
  const enabledAgentIds = Object.entries(config.agents)
    .filter(([, value]) => value.enabled)
    .map(([id]) => id) as AgentId[];
  const stateStore = new LocalOperationalStateStore(
    join(paths.stateDir, "state.json"),
  );
  const recovery = new LifecycleRecoveryStore(
    join(paths.stateDir, "lifecycle-transaction.json"),
  );
  const provider = await createProvider(program, io, config, storage, paths);
  const applier = new V2LocalApplier(
    stateStore,
    new CanonicalSkillStore(storage.skillsStoragePath),
    {
      storagePath: storage.gitStoragePath,
      repository: config.gitRepository ?? "cloud",
      enabledAgentIds,
      homeDir,
      artifactReader:
        provider.mode === "cloud"
          ? async (locator) => {
              const snapshot = await provider.port.pullReadOnly?.() ??
                (await provider.port.pull());
              const lock = snapshot.state.lockfile.skills.find(
                (skill) =>
                  skill.materialization.kind === "artifact" &&
                  skill.materialization.artifact.locator === locator,
              );
              if (!lock || !provider.cloud) {
                throw new Error("Artifact locator is not in desired state.");
              }
              return provider.cloud.downloadArtifact(lock);
            }
          : undefined,
    },
  );
  const reporter =
    provider.mode === "cloud" && forSync && config.deviceId
      ? async (input: {
          state: { lastAppliedRevision: string | null };
          snapshot: {
            plan: { classifications: readonly { classification: string }[] };
          };
          kind: "synced" | "partial";
          operations: readonly { status: string; error?: string }[];
        }) => {
          const credentials = new CredentialsStore(paths);
          const aggregate = deviceSyncAggregateFrom({
            kind: input.kind,
            execution: { operations: input.operations },
            snapshot: input.snapshot,
          });
          await new CloudSyncReportService({
            origin: DEFAULT_CLOUD_ORIGIN,
            deviceId: config.deviceId as string,
            credentials,
          }).report({
            lastAppliedRevision: input.state.lastAppliedRevision,
            appliedRevisionId: input.state.lastAppliedRevision,
            aggregate:
              aggregate.status === "SYNCED" && !input.state.lastAppliedRevision
                ? { status: "PARTIALLY_SYNCED" }
                : aggregate,
          });
        }
      : undefined;
  return {
    mode: provider.mode,
    service: new V2SyncService(provider.port, applier, stateStore, {
      skillsStoragePath: storage.skillsStoragePath,
      homeDir,
      enabledAgentIds,
      recovery,
      reporter,
    }),
  };
}

async function createProvider(
  program: Command,
  io: CliIo,
  config: CorotumConfig,
  storage: ReturnType<typeof effectiveStoragePaths>,
  paths: ReturnType<typeof resolvePlatformPaths>,
): Promise<
  Readonly<{
    mode: "git" | "cloud";
    port: V2SyncProviderPort;
    cloud?: V2SaaSProvider;
  }>
> {
  if (config.mode === "git") {
    if (!config.gitRepository) {
      throw new Error("Run corotum init before using Git Sync.");
    }
    const git = createCliV2GitStateProvider({
      storagePath: storage.gitStoragePath,
      source: config.gitRepository,
      options: program.opts(),
      io,
    });
    return {
      mode: "git",
      port: {
        pull: () => git.pull(),
        pullReadOnly: () => git.pullReadOnly(),
        peekPendingPush: () => git.peekPendingPush(),
      },
    };
  }
  const credentials = await new CredentialsStore(paths).load();
  if (!credentials.cloudDeviceToken || !config.workspaceId) {
    throw new Error("Run corotum login before using Cloud sync.");
  }
  const cloud = new V2SaaSProvider({
    origin: DEFAULT_CLOUD_ORIGIN,
    deviceToken: credentials.cloudDeviceToken,
    workspaceId: config.workspaceId,
  });
  const asEnvelope = async (): Promise<V2SyncEnvelope> => {
    const pulled = await cloud.pull();
    return {
      revisionId: pulled.revisionId ?? "",
      state: pulled.state,
      ledger: pulled.ledger,
    };
  };
  return {
    mode: "cloud",
    cloud,
    port: {
      pull: asEnvelope,
      pullReadOnly: asEnvelope,
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

export type DetectedAgentStatus = Readonly<{
  id: AgentId;
  status: "ENABLED" | "DETECTED_DISABLED";
}>;
