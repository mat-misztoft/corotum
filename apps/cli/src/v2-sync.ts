import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  type AgentAdapter,
  type AgentId,
  builtInAgentAdapters,
} from "../../../packages/agent-targets/src/index";
import { applicableAgentIds } from "../../../packages/agent-targets/src/targets";
import {
  type ActualSkillState,
  type ActualState,
  type ActualTargetState,
  type DispositionLedger,
  planV2Reconcile,
  type SkillId,
  type V2DesiredState,
  type V2ReconcileOperation,
  type V2ReconcilePlan,
} from "../../../packages/core/src/index";
import { MaterializationError } from "../../../packages/skills-adapter/src/exact-materializer";
import { scanNormalizedContent } from "../../../packages/skills-adapter/src/normalized-content";
import {
  expectedV2Hash,
  type LocalOperationalState,
  type LocalOperationalStateStore,
  recoverV2LocalOperationalState,
} from "./local-state";
import { V2LocalApplyError, type V2LocalApplier } from "./v2-local-applier";
import type {
  LifecycleRecoveryStore,
  V2LifecycleRecoveryMarker,
} from "./v2-lifecycle";

export type V2SyncEnvelope = Readonly<{
  revisionId: string;
  state: V2DesiredState;
  ledger: DispositionLedger;
}>;

export type V2SyncProviderPort = Readonly<{
  pull: () => Promise<V2SyncEnvelope>;
  pullReadOnly?: () => Promise<V2SyncEnvelope>;
  peekPendingPush?: () => Promise<boolean>;
}>;

export type V2SyncOperationResult = Readonly<{
  kind: V2ReconcileOperation["kind"];
  skillId: SkillId;
  status: "SUCCESS" | "ERROR" | "LOCAL_CONFLICT" | "DRIFTED" | "AUTH_REQUIRED";
  error?: string;
}>;

export type V2SyncSnapshot = Readonly<{
  desired: V2SyncEnvelope;
  actual: ActualState;
  plan: V2ReconcilePlan;
}>;

export type V2SyncReportHook = (input: Readonly<{
  state: LocalOperationalState;
  snapshot: V2SyncSnapshot;
  kind: "synced" | "partial";
  operations: readonly V2SyncOperationResult[];
}>) => Promise<void>;

export type V2InspectResult =
  | Readonly<{
      kind: "ready";
      snapshot: V2SyncSnapshot;
      state: LocalOperationalState;
      pendingPush: boolean;
      recovery: V2LifecycleRecoveryMarker | null;
    }>
  | Readonly<{ kind: "refused"; reason: string; pendingPush?: boolean }>;

export type V2SyncResult =
  | Readonly<{
      kind: "synced" | "partial";
      snapshot: V2SyncSnapshot;
      state: LocalOperationalState;
      operations: readonly V2SyncOperationResult[];
      pendingPush: boolean;
      recovery: V2LifecycleRecoveryMarker | null;
      reportError?: string;
    }>
  | Readonly<{
      kind: "pending-push";
      reason: string;
      snapshot?: V2SyncSnapshot;
      recovery: V2LifecycleRecoveryMarker | null;
    }>
  | Readonly<{ kind: "refused"; reason: string; pendingPush?: boolean }>;

/**
 * Pulls the configured v2 snapshot, recovers local ownership, plans against
 * named canonical and target scans, then applies only safe operations.
 */
export class V2SyncService {
  constructor(
    private readonly provider: V2SyncProviderPort,
    private readonly applier: Pick<
      V2LocalApplier,
      "apply" | "applyRemove" | "applyUnmanage" | "applyRestore"
    >,
    private readonly stateStore: LocalOperationalStateStore,
    private readonly options: Readonly<{
      skillsStoragePath: string;
      homeDir: string;
      enabledAgentIds: readonly AgentId[];
      recovery?: LifecycleRecoveryStore;
      reporter?: V2SyncReportHook;
    }>,
  ) {}

  async inspect(): Promise<V2InspectResult> {
    const pendingPush = (await this.provider.peekPendingPush?.()) === true;
    try {
      const desired = await (this.provider.pullReadOnly?.() ??
        this.provider.pull());
      const recovered = await this.operationalState(desired);
      const actual = await discoverV2ActualState({
        desired: desired.state,
        state: recovered,
        skillsStoragePath: this.options.skillsStoragePath,
        homeDir: this.options.homeDir,
        enabledAgentIds: this.options.enabledAgentIds,
      });
      return {
        kind: "ready",
        snapshot: {
          desired,
          actual,
          plan: planV2Reconcile(desired.state, actual, desired.ledger),
        },
        state: recovered,
        pendingPush,
        recovery: (await this.options.recovery?.load()) ?? null,
      };
    } catch (error) {
      if (isTypedCloudFailure(error)) throw error;
      return {
        kind: "refused",
        reason: error instanceof Error ? error.message : "Inspect failed.",
        pendingPush,
      };
    }
  }

  async sync(): Promise<V2SyncResult> {
    const pendingPush = (await this.provider.peekPendingPush?.()) === true;
    const recovery = (await this.options.recovery?.load()) ?? null;
    let desired: V2SyncEnvelope;
    try {
      desired = await this.provider.pull();
    } catch (error) {
      if (isTypedCloudFailure(error)) throw error;
      const reason =
        error instanceof Error ? error.message : "Desired state pull failed.";
      if (pendingPush || /waiting to be pushed/i.test(reason)) {
        return { kind: "pending-push", reason, recovery };
      }
      return { kind: "refused", reason, pendingPush };
    }

    const recovered = await this.operationalState(desired);
    const actual = await discoverV2ActualState({
      desired: desired.state,
      state: recovered,
      skillsStoragePath: this.options.skillsStoragePath,
      homeDir: this.options.homeDir,
      enabledAgentIds: this.options.enabledAgentIds,
    });
    const plan = planV2Reconcile(desired.state, actual, desired.ledger);
    const operations: V2SyncOperationResult[] = [];

    for (const operation of plan.operations) {
      operations.push(await this.applyOperation(operation, desired));
    }

    const persisted =
      (await this.stateStore.load()) ?? recovered;
    const verifiedActual = await discoverV2ActualState({
      desired: desired.state,
      state: persisted,
      skillsStoragePath: this.options.skillsStoragePath,
      homeDir: this.options.homeDir,
      enabledAgentIds: this.options.enabledAgentIds,
    });
    const verifiedPlan = planV2Reconcile(
      desired.state,
      verifiedActual,
      desired.ledger,
    );
    const blocking = verifiedPlan.classifications.some((item) =>
      ["DRIFTED", "LOCAL_CONFLICT", "PENDING_RESOLUTION", "MISSING"].includes(
        item.classification,
      ),
    );
    const failedOp = operations.some((operation) => operation.status !== "SUCCESS");
    const synced =
      !failedOp && !blocking && verifiedPlan.operations.length === 0;
    const nextState: LocalOperationalState = {
      ...persisted,
      schemaVersion: 2,
      lastAppliedRevision: synced
        ? (desired.revisionId as never)
        : persisted.lastAppliedRevision,
    };
    await this.stateStore.save(nextState);
    if (
      recovery &&
      !nextState.skills[recovery.skillId] &&
      !desired.state.manifest.skills.some((skill) => skill.id === recovery.skillId)
    ) {
      await this.options.recovery?.clear();
    }

    const snapshot = {
      desired,
      actual: verifiedActual,
      plan: verifiedPlan,
    };
    const kind = synced ? "synced" : "partial";
    let reportError: string | undefined;
    try {
      await this.options.reporter?.({ state: nextState, snapshot, kind, operations });
    } catch (error) {
      reportError =
        error instanceof Error ? error.message : "Cloud sync report failed.";
    }
    return {
      kind,
      snapshot,
      state: nextState,
      operations,
      pendingPush: false,
      recovery: synced ? null : recovery,
      reportError,
    };
  }

  private async operationalState(
    desired: V2SyncEnvelope,
  ): Promise<LocalOperationalState> {
    const loaded = await this.stateStore.load();
    if (loaded) return loaded;
    const recovered = await recoverV2LocalOperationalState({
      desired: desired.state,
      lastAppliedRevision: null,
      skillsStoragePath: this.options.skillsStoragePath,
      homeDir: this.options.homeDir,
      enabledAgentIds: this.options.enabledAgentIds,
      previousState: await this.stateStore.loadRetainedRecoveryEvidence(),
    });
    await this.stateStore.save({
      ...recovered,
      lastAppliedRevision: null,
    });
    return { ...recovered, lastAppliedRevision: null };
  }

  private async applyOperation(
    operation: V2ReconcileOperation,
    desired: V2SyncEnvelope,
  ): Promise<V2SyncOperationResult> {
    const skillId =
      operation.kind === "INSTALL" || operation.kind === "REPAIR_TARGET"
        ? operation.skill.id
        : operation.skillId;
    try {
      if (operation.kind === "INSTALL") {
        await this.applier.apply({
          state: desired.state,
          revisionId: desired.revisionId,
          skillIds: [operation.skill.id],
          advanceRevision: false,
        });
      } else if (operation.kind === "REMOVE") {
        const next = await this.applier.applyRemove(skillId);
        await this.stateStore.save(next);
      } else if (operation.kind === "UNMANAGE") {
        const next = await this.applier.applyUnmanage(skillId);
        await this.stateStore.save(next);
      } else {
        const next = await this.applier.applyRestore({
          state: desired.state,
          skillId,
        });
        await this.stateStore.save(next);
      }
      return { kind: operation.kind, skillId, status: "SUCCESS" };
    } catch (error) {
      if (error instanceof MaterializationError && error.code === "AUTH_REQUIRED") {
        return {
          kind: operation.kind,
          skillId,
          status: "AUTH_REQUIRED",
          error: error.message,
        };
      }
      if (error instanceof V2LocalApplyError) {
        return {
          kind: operation.kind,
          skillId,
          status: error.code === "ERROR" ? "ERROR" : error.code,
          error: error.message,
        };
      }
      return {
        kind: operation.kind,
        skillId,
        status: "ERROR",
        error:
          error instanceof Error ? error.message : "Reconcile operation failed.",
      };
    }
  }
}

export async function discoverV2ActualState(
  input: Readonly<{
    desired: V2DesiredState;
    state: LocalOperationalState;
    skillsStoragePath: string;
    homeDir: string;
    enabledAgentIds: readonly AgentId[];
  }>,
  adapters: readonly AgentAdapter[] = builtInAgentAdapters,
): Promise<ActualState> {
  const skills: Record<SkillId, ActualSkillState> = {} as Record<
    SkillId,
    ActualSkillState
  >;

  for (const lock of input.desired.lockfile.skills) {
    const recorded = input.state.skills[lock.id];
    const canonicalPath = recorded?.canonicalPath ??
      join(input.skillsStoragePath, lock.name);
    const contentHash = await scanHash(canonicalPath);
    const managed = recorded !== undefined;
    const targets = await collectTargets({
      skillId: lock.id,
      name: lock.name,
      canonicalPath,
      recorded,
      desired: input.desired,
      homeDir: input.homeDir,
      enabledAgentIds: input.enabledAgentIds,
      adapters,
    });
    skills[lock.id] = {
      contentHash,
      expectedContentHash: recorded?.contentHash ?? expectedV2Hash(lock),
      managed,
      targets,
    };
  }

  for (const [id, recorded] of Object.entries(input.state.skills) as [
    SkillId,
    (typeof input.state.skills)[SkillId],
  ][]) {
    if (skills[id]) continue;
    const contentHash = await scanHash(recorded.canonicalPath);
    const targets = await collectTargets({
      skillId: id,
      name: recorded.name,
      canonicalPath: recorded.canonicalPath,
      recorded,
      desired: input.desired,
      homeDir: input.homeDir,
      enabledAgentIds: input.enabledAgentIds,
      adapters,
    });
    skills[id] = {
      contentHash,
      expectedContentHash: recorded.contentHash,
      managed: true,
      targets,
    };
  }

  return { skills };
}

export function v2SyncStatusPayload(
  result: V2InspectResult | V2SyncResult,
): Record<string, unknown> {
  if (result.kind === "refused") {
    return {
      outcome: result.pendingPush ? "CONFLICT" : "GENERAL_ERROR",
      status: result.pendingPush ? "PENDING_PUSH" : "ERROR",
      error: result.reason,
    };
  }
  if (result.kind === "pending-push") {
    return {
      outcome: "CONFLICT",
      status: "PENDING_PUSH",
      error: result.reason,
      recovery: result.recovery,
    };
  }
  const classifications = result.snapshot.plan.classifications;
  const drifted = classifications.some((item) => item.classification === "DRIFTED");
  const conflict = classifications.some(
    (item) => item.classification === "LOCAL_CONFLICT",
  );
  const operations =
    "operations" in result && Array.isArray(result.operations)
      ? result.operations
      : result.snapshot.plan.operations;
  const authRequired = operations.some(
    (item) => "status" in item && item.status === "AUTH_REQUIRED",
  );
  const recovery = result.recovery;
  const pendingPush = "pendingPush" in result && result.pendingPush;
  let status = "READY";
  let outcome: string = "SUCCESS";
  if (authRequired) {
    status = "AUTH_REQUIRED";
    outcome = "AUTH_REQUIRED";
  } else if ("kind" in result && result.kind === "synced") status = "SYNCED";
  else if ("kind" in result && result.kind === "partial") {
    status = conflict ? "LOCAL_CONFLICT" : drifted ? "DRIFTED" : "PARTIALLY_SYNCED";
    outcome = conflict ? "CONFLICT" : "PARTIAL_SUCCESS";
  } else if (pendingPush) {
    status = "PENDING_PUSH";
    outcome = "CONFLICT";
  } else if (recovery) {
    status = "RECOVERABLE";
    outcome = "PARTIAL_SUCCESS";
  } else if (conflict) {
    status = "LOCAL_CONFLICT";
    outcome = "CONFLICT";
  } else if (drifted) {
    status = "DRIFTED";
    outcome = "PARTIAL_SUCCESS";
  }
  return {
    outcome,
    status,
    revision: result.snapshot.desired.revisionId,
    appliedRevision:
      "state" in result ? result.state.lastAppliedRevision : undefined,
    pendingPush: pendingPush ?? false,
    recovery,
    classifications,
    operations,
    reportError: "reportError" in result ? result.reportError : undefined,
  };
}

async function collectTargets(input: Readonly<{
  skillId: SkillId;
  name: string;
  canonicalPath: string;
  recorded?: LocalOperationalState["skills"][SkillId];
  desired: V2DesiredState;
  homeDir: string;
  enabledAgentIds: readonly AgentId[];
  adapters: readonly AgentAdapter[];
}>): Promise<readonly ActualTargetState[]> {
  const seen = new Map<string, ActualTargetState>();
  if (input.recorded) {
    for (const target of Object.values(input.recorded.targets)) {
      seen.set(`${target.agentId}\0${target.path}`, {
        agentId: target.agentId,
        path: target.path,
        contentHash: await targetHash(target.path, input.canonicalPath, target.mode),
        expectedContentHash: target.expectedHash,
        managed: true,
      });
    }
  }
  const manifest = input.desired.manifest.skills.find(
    (skill) => skill.id === input.skillId,
  );
  if (manifest) {
    for (const agentId of applicableAgentIds(
      manifest.targets,
      input.enabledAgentIds,
    )) {
      const adapter = input.adapters.find((candidate) => candidate.id === agentId);
      if (!adapter) continue;
      for (const parent of adapter.globalSkillPaths(input.homeDir)) {
        const path = join(parent, input.name);
        const key = `${agentId}\0${path}`;
        if (seen.has(key)) continue;
        const hash = await scanHash(path);
        if (hash === null) continue;
        seen.set(key, {
          agentId,
          path,
          contentHash: hash,
          managed: false,
        });
      }
    }
  }
  return [...seen.values()].sort((left, right) =>
    `${left.agentId}\0${left.path}`.localeCompare(`${right.agentId}\0${right.path}`),
  );
}

async function targetHash(
  path: string,
  canonicalPath: string,
  mode: "symlink" | "copy",
): Promise<string | null> {
  try {
    if (mode === "symlink") {
      if (!(await lstat(path)).isSymbolicLink()) {
        return (await scanHash(path)) ?? "drifted:replaced-symlink";
      }
      if ((await realpath(path)) !== (await realpath(canonicalPath))) {
        return "drifted:symlink-target";
      }
      // Scan the canonical directory. Normalized hashing refuses symlink roots.
      return await scanHash(canonicalPath);
    }
    return await scanHash(path);
  } catch {
    return null;
  }
}

function isTypedCloudFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "CloudAuthError" || error.name === "CloudInitError")
  );
}

async function scanHash(path: string): Promise<string | null> {
  try {
    return (await scanNormalizedContent(path)).contentHash;
  } catch {
    try {
      await lstat(path);
      return "unreadable:local-content";
    } catch {
      return null;
    }
  }
}
