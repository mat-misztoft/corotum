import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import {
  type AgentId,
  detectAgents,
  localAgentFileSystem,
} from "../../../packages/agent-targets/src/index";
import { V2SaaSProvider } from "../../../packages/saas-provider/src/index";
import { CanonicalSkillStore } from "../../../packages/skills-adapter/src/canonical-store";
import { createCliV2GitStateProvider } from "./artifact-consent";
import { CLI_VERSION, type CliIo, isNonInteractive } from "./cli";
import { jsonEnvelope } from "./cli-contracts";
import {
  CloudAuthError,
  resolveCloudOrigin,
} from "./cloud-auth";
import {
  CloudSyncReportService,
  deviceSyncAggregateFrom,
  deviceTargetReportsFrom,
} from "./cloud-sync-report";
import {
  ConfigStore,
  type CorotumConfig,
  CredentialsStore,
  effectiveStoragePaths,
} from "./config";
import { classifyCloudInspectError } from "./init-cloud";
import {
  assertGitAvailable,
  notInitializedError,
  withGitCliErrors,
} from "./init-errors";
import { LocalOperationalStateStore } from "./local-state";
import { MutationLock } from "./mutation-lock";
import { resolvePlatformPaths } from "./platform";
import { confirmOption, withSpinner } from "./prompts";
import { LifecycleRecoveryStore } from "./v2-lifecycle";
import { V2LocalApplier } from "./v2-local-applier";
import {
  type V2InspectResult,
  type V2SyncEnvelope,
  type V2SyncProviderPort,
  type V2SyncReportHook,
  type V2SyncResult,
  V2SyncService,
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
  await withGitCliErrors(async () => {
  const runtime = await createRuntime(program, io, false);
  const result = await busy(
    program,
    io,
    kind === "STATUS" ? "Inspecting skills…" : "Computing diff…",
    kind === "STATUS" ? "Inspected skills" : "Computed diff",
    () => runtime.service.inspect(),
  );
  const payload: Record<string, unknown> = {
    ...v2SyncStatusPayload(result),
    command: kind,
    mode: runtime.mode,
  };
  if (result.kind === "refused" && payload.status !== "PENDING_PUSH") {
    throw new Error(result.reason);
  }
  write(io, program, payload, humanInspectResult(kind, result, payload.status));
  });
}

async function syncCommand(program: Command, io: CliIo): Promise<void> {
  await withGitCliErrors(async () => {
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
    let config = await configStore.load();
    const agents = await scanAgents(
      config.agents,
      homeDir,
      isNonInteractive(program.opts(), io.stdinIsTTY),
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
    const result = await busy(
      program,
      io,
      "Syncing skills…",
      "Finished sync",
      () => runtime.service.sync(),
    );
    const payload: Record<string, unknown> = {
      ...v2SyncStatusPayload(result),
      command: "SYNC",
      mode: runtime.mode,
      agents,
    };
    if (result.kind === "refused" && payload.status !== "PENDING_PUSH") {
      throw new Error(result.reason);
    }
    write(io, program, payload, humanSyncResult(result, payload.status));
  } finally {
    await release();
  }
  });
}

async function createRuntime(
  program: Command,
  io: CliIo,
  forSync: boolean,
  loaded?: CorotumConfig,
): Promise<Readonly<{ service: V2SyncService; mode: "git" | "cloud" }>> {
  const homeDir = processHomeDir();
  const paths = resolvePlatformPaths({
    homeDir,
    platform: process.platform as "darwin" | "linux" | "win32",
    env: process.env,
  });
  const config = loaded ?? (await new ConfigStore(paths).load());
  const origin = resolveCloudOrigin(undefined, config.origin);
  if (config.mode !== "git" && config.mode !== "cloud") {
    throw notInitializedError("using status, diff, or sync");
  }
  if (config.mode === "git") await assertGitAvailable();
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
  const provider = await createProvider(
    program,
    io,
    config,
    storage,
    paths,
    origin,
  );
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
      ? async (input: Parameters<V2SyncReportHook>[0]) => {
          const credentials = new CredentialsStore(paths);
          const aggregate = deviceSyncAggregateFrom({
            kind: input.kind,
            execution: { operations: input.operations },
            snapshot: input.snapshot,
          });
          const targets = deviceTargetReportsFrom({
            operations: input.operations,
            actual: input.snapshot.actual,
          });
          await new CloudSyncReportService({
            origin,
            deviceId: config.deviceId as string,
            credentials,
            cliVersion: CLI_VERSION,
          }).report({
            lastAppliedRevision: input.state.lastAppliedRevision,
            appliedRevisionId: input.state.lastAppliedRevision,
            aggregate:
              aggregate.status === "SYNCED" && !input.state.lastAppliedRevision
                ? { status: "PARTIALLY_SYNCED" }
                : aggregate,
            ...(targets.length > 0 ? { targets } : {}),
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
  origin: string,
): Promise<
  Readonly<{
    mode: "git" | "cloud";
    port: V2SyncProviderPort;
    cloud?: V2SaaSProvider;
  }>
> {
  if (config.mode === "git") {
    if (!config.gitRepository) {
      throw notInitializedError("using Git Sync");
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
    throw new CloudAuthError(
      "Run corotum login before using Cloud status, diff, or sync.",
      "AUTH_REQUIRED",
    );
  }
  const cloud = new V2SaaSProvider({
    origin,
    deviceToken: credentials.cloudDeviceToken,
    workspaceId: config.workspaceId,
    cliVersion: CLI_VERSION,
  });
  const asEnvelope = async (): Promise<V2SyncEnvelope> => {
    try {
      const pulled = await cloud.pull();
      return {
        revisionId: pulled.revisionId ?? "",
        state: pulled.state,
        ledger: pulled.ledger,
      };
    } catch (error) {
      throw classifyCloudInspectError(error);
    }
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
): Promise<readonly DetectedAgentStatus[]> {
  const fresh = (await detectAgents(homeDir, localAgentFileSystem)).filter(
    (agent) => configured[agent.id] === undefined,
  );
  if (fresh.length === 0) return [];
  const enable =
    !nonInteractive &&
    (await confirmOption(
      `Enable newly detected agents (${fresh.map((agent) => agent.id).join(", ")})?`,
      true,
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

function busy<T>(
  program: Command,
  io: CliIo,
  message: string,
  done: string,
  work: () => Promise<T>,
): Promise<T> {
  if (
    program.opts<{ json?: boolean }>().json === true ||
    isNonInteractive(program.opts(), io.stdinIsTTY)
  ) {
    return work();
  }
  return withSpinner(message, work, done);
}

function skillNames(
  result: Extract<V2InspectResult, { kind: "ready" }> | Extract<V2SyncResult, { kind: "synced" | "partial" }>,
): Map<string, string> {
  return new Map(
    result.snapshot.desired.state.manifest.skills.map((skill) => [
      skill.id,
      skill.name,
    ]),
  );
}

function blockerLines(
  result: Extract<V2InspectResult, { kind: "ready" }> | Extract<V2SyncResult, { kind: "synced" | "partial" }>,
): string[] {
  const names = skillNames(result);
  const grouped = new Map<string, string[]>();
  for (const item of result.snapshot.plan.classifications) {
    if (
      !["DRIFTED", "LOCAL_CONFLICT", "PENDING_RESOLUTION", "MISSING"].includes(
        item.classification,
      )
    ) {
      continue;
    }
    const name = names.get(item.skillId) ?? item.skillId;
    const bucket = grouped.get(item.classification) ?? [];
    if (!bucket.includes(name)) bucket.push(name);
    grouped.set(item.classification, bucket);
  }
  const lines: string[] = [];
  for (const [label, bucket] of grouped) {
    lines.push(`${label} (${bucket.length})`);
    for (const name of bucket) lines.push(`  ${name}`);
  }
  return lines;
}

function humanInspectResult(
  kind: "STATUS" | "DIFF",
  result: V2InspectResult,
  status: unknown,
): string {
  if (result.kind !== "ready") {
    return `${String(status)}: ${"reason" in result ? result.reason : ""}\n`;
  }
  const blockers = blockerLines(result);
  if (kind === "DIFF") {
    const names = skillNames(result);
    const ops = result.snapshot.plan.operations.map((operation) => {
      const skillId =
        operation.kind === "INSTALL" || operation.kind === "REPAIR_TARGET"
          ? operation.skill.id
          : operation.skillId;
      return `${operation.kind} ${names.get(skillId) ?? skillId}`;
    });
    return [`${ops.length} operations planned.`, ...ops, ...blockers].join("\n") + "\n";
  }
  const lines = [
    `${String(status)} at revision ${result.snapshot.desired.revisionId}.`,
    ...blockers,
  ];
  if (blockers.some((line) => line.startsWith("DRIFTED"))) {
    lines.push(
      "Local files differ from the Cloud lock. Sync does not overwrite them.",
      "Restore one skill: corotum restore <name>",
    );
  }
  if (blockers.length === 0) lines.push("Local skills match the lock.");
  return `${lines.join("\n")}\n`;
}

function humanSyncResult(
  result: V2SyncResult,
  status: unknown,
): string {
  if (result.kind === "synced") {
    return `Synced at revision ${result.snapshot.desired.revisionId}.\n`;
  }
  if (result.kind !== "partial") {
    return `${String(status)}: ${"reason" in result ? result.reason : ""}\n`;
  }
  const names = skillNames(result);
  const failed = result.operations
    .filter((operation) => operation.status !== "SUCCESS")
    .map(
      (operation) =>
        `${names.get(operation.skillId) ?? operation.skillId}: ${operation.status}${operation.error ? ` (${operation.error})` : ""}`,
    );
  const lines = [
    `Partial at revision ${result.snapshot.desired.revisionId}.`,
    ...blockerLines(result),
    ...failed,
  ];
  if (blockerLines(result).some((line) => line.startsWith("DRIFTED"))) {
    lines.push(
      "Sync does not overwrite drifted files. Restore one skill with corotum restore <name>.",
    );
  }
  return `${lines.join("\n")}\n`;
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

function processHomeDir(): string {
  return (
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    homedir()
  );
}

export type DetectedAgentStatus = Readonly<{
  id: AgentId;
  status: "ENABLED" | "DETECTED_DISABLED";
}>;
