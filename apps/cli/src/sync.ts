import { stat } from "node:fs/promises";

import type { AgentId } from "../../../packages/agent-targets/src/index";
import {
  type ActualState,
  type DesiredStateEnvelope,
  planReconcile,
  type ReconcilePlan,
  type StateProvider,
} from "../../../packages/core/src/index";
import { hashSkillDirectory } from "../../../packages/skills-adapter/src/canonical-store";
import type { LocalOperationalState } from "./local-state";
import type {
  ExecuteReconcileInput,
  LocalReconcileExecutor,
  ReconcileExecutionResult,
} from "./reconcile-executor";

export type SyncStateProvider = StateProvider &
  Readonly<{ pullReadOnly?: () => ReturnType<StateProvider["pull"]> }>;

export type SyncSnapshot = Readonly<{
  desired: DesiredStateEnvelope;
  actual: ActualState;
  plan: ReconcilePlan;
}>;

export type SyncResult =
  | Readonly<{
      kind: "synced" | "partial";
      snapshot: SyncSnapshot;
      execution: ReconcileExecutionResult;
    }>
  | Readonly<{ kind: "refused"; reason: string }>;

/**
 * Reads the local canonical store without inferring ownership from names or
 * targets. A missing or altered canonical directory is therefore reconciled,
 * while unmanaged directories remain untouched.
 */
export async function discoverActualState(
  state: LocalOperationalState,
): Promise<ActualState> {
  const entries = await Promise.all(
    Object.entries(state.skills).map(
      async ([id, skill]) =>
        [
          id,
          {
            contentHash: await localHash(skill.canonicalPath),
            managed: true,
          },
        ] as const,
    ),
  );
  return { skills: Object.fromEntries(entries) as ActualState["skills"] };
}

/** Pulls exact desired state, plans against local state, applies, then verifies. */
export class SyncService {
  constructor(
    private readonly provider: SyncStateProvider,
    private readonly executor: Pick<LocalReconcileExecutor, "execute">,
    private readonly discover: (
      state: LocalOperationalState,
    ) => Promise<ActualState> = discoverActualState,
  ) {}

  async inspect(
    state: LocalOperationalState,
  ): Promise<
    | Readonly<{ kind: "ready"; snapshot: SyncSnapshot }>
    | Readonly<{ kind: "refused"; reason: string }>
  > {
    const desired = await (this.provider.pullReadOnly?.() ??
      this.provider.pull());
    if (desired.kind !== "success")
      return { kind: "refused", reason: reasonFor(desired) };
    const actual = await this.discover(state);
    return {
      kind: "ready",
      snapshot: {
        desired: desired.value,
        actual,
        plan: planReconcile(desired.value.state, actual),
      },
    };
  }

  async sync(input: {
    execution: Omit<ExecuteReconcileInput, "desired" | "plan" | "revision"> & {
      state: LocalOperationalState;
    };
  }): Promise<SyncResult> {
    // pull() intentionally retries PENDING_PUSH before any local operation.
    const desired = await this.provider.pull();
    if (desired.kind !== "success")
      return { kind: "refused", reason: reasonFor(desired) };
    const actual = await this.discover(input.execution.state);
    const plan = planReconcile(desired.value.state, actual);
    const execution = await this.executor.execute({
      ...input.execution,
      desired: desired.value.state,
      revision: desired.value.revisionId,
      plan,
    });
    const verifiedActual = await this.discover(execution.state);
    const verifiedPlan = planReconcile(desired.value.state, verifiedActual);
    const snapshot = {
      desired: desired.value,
      actual: verifiedActual,
      plan: verifiedPlan,
    };
    const partial =
      execution.operations.some((operation) => operation.status === "ERROR") ||
      verifiedPlan.operations.length > 0 ||
      verifiedPlan.classifications.some(
        (item) => item.classification === "DRIFTED",
      );
    return { kind: partial ? "partial" : "synced", snapshot, execution };
  }
}

async function localHash(path: string): Promise<string | null> {
  try {
    if (!(await stat(path)).isDirectory()) return null;
    return await hashSkillDirectory(path);
  } catch {
    return null;
  }
}

function reasonFor(
  result: Exclude<
    Awaited<ReturnType<StateProvider["pull"]>>,
    { kind: "success" }
  >,
): string {
  return result.kind === "failure"
    ? result.error.message
    : (result.errors[0]?.message ?? "Desired state is incomplete.");
}

export type DetectedAgentStatus = Readonly<{
  id: AgentId;
  status: "ENABLED" | "DETECTED_DISABLED";
}>;
