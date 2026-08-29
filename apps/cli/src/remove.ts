import {
  type ActualState,
  type DesiredState,
  type DesiredStateEnvelope,
  planReconcile,
  type RevisionTransition,
  type SkillId,
  type StateProvider,
} from "../../../packages/core/src/index";
import type { LocalOperationalState } from "./local-state";
import type {
  ExecuteReconcileInput,
  LocalReconcileExecutor,
} from "./reconcile-executor";

export type RemoveStateProvider = StateProvider &
  Readonly<{
    push: (
      input: {
        state: DesiredState;
        baseRevision: DesiredStateEnvelope["revisionId"] | null;
      },
      transition: RevisionTransition,
    ) => ReturnType<StateProvider["push"]>;
  }>;

export type UnmanageConflictChoice = "keep" | "replace";

export type RemoveResult =
  | Readonly<{ kind: "removed" | "unmanaged"; revision: string }>
  | Readonly<{ kind: "partial"; reason: string; revision: string }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** Changes desired state, then performs the matching local reconciliation. */
export class RemoveService {
  constructor(
    private readonly provider: RemoveStateProvider,
    private readonly executor: Pick<LocalReconcileExecutor, "execute">,
  ) {}

  async remove(input: {
    name: string;
    operation: "REMOVE" | "UNMANAGE";
    unmanageChoices?: Readonly<Record<string, UnmanageConflictChoice>>;
    execution: Omit<
      ExecuteReconcileInput,
      "desired" | "plan" | "revision" | "state"
    > & { state: LocalOperationalState };
  }): Promise<RemoveResult> {
    // Pull retries PENDING_PUSH before either a desired-state or ownership change.
    const current = await this.provider.pull();
    if (current.kind !== "success") {
      return {
        kind: "refused",
        reason:
          current.kind === "failure"
            ? current.error.message
            : "Desired state is incomplete.",
      };
    }

    const skill = current.value.state.manifest.skills.find(
      (candidate) =>
        candidate.id === input.name || candidate.skill === input.name,
    );
    if (!skill)
      return { kind: "refused", reason: "Managed skill was not found." };

    const desired = withoutSkill(current.value.state, skill.id);
    const stagedState =
      input.operation === "UNMANAGE"
        ? preserveConflictingTargets(
            input.execution.state,
            skill.id,
            input.unmanageChoices ?? {},
          )
        : input.execution.state;
    const pushed = await this.provider.push(
      { state: desired, baseRevision: current.value.revisionId },
      { type: input.operation, skillId: skill.id, metadata: {} },
    );
    if (pushed.kind !== "success") {
      return {
        kind: "refused",
        reason:
          pushed.kind === "failure"
            ? pushed.error.message
            : "Desired state could not be saved completely.",
      };
    }

    const execution = await this.executor.execute({
      ...input.execution,
      state: stagedState,
      desired,
      revision: pushed.value.revisionId,
      plan: planReconcile(desired, actualState(input.execution.state), [
        { type: input.operation, skillId: skill.id, metadata: {} },
      ]),
    });
    if (
      execution.operations.some((operation) => operation.status === "ERROR")
    ) {
      return {
        kind: "partial",
        revision: pushed.value.revisionId,
        reason:
          "Desired state was saved, but local reconciliation did not complete.",
      };
    }
    return {
      kind: input.operation === "REMOVE" ? "removed" : "unmanaged",
      revision: pushed.value.revisionId,
    };
  }
}

function withoutSkill(state: DesiredState, id: SkillId): DesiredState {
  return {
    manifest: {
      ...state.manifest,
      skills: state.manifest.skills.filter((skill) => skill.id !== id),
    },
    lockfile: {
      ...state.lockfile,
      skills: state.lockfile.skills.filter((skill) => skill.id !== id),
    },
  };
}

function preserveConflictingTargets(
  state: LocalOperationalState,
  id: SkillId,
  choices: Readonly<Record<string, UnmanageConflictChoice>>,
): LocalOperationalState {
  const skill = state.skills[id];
  if (!skill) return state;
  return {
    ...state,
    skills: {
      ...state.skills,
      [id]: {
        ...skill,
        targets: Object.fromEntries(
          Object.entries(skill.targets).filter(
            ([, target]) => choices[target.path] !== "keep",
          ),
        ),
      },
    },
  };
}

function actualState(state: LocalOperationalState): ActualState {
  return {
    skills: Object.fromEntries(
      Object.entries(state.skills).map(([id, skill]) => [
        id,
        { contentHash: skill.contentHash, managed: true },
      ]),
    ) as ActualState["skills"],
  };
}
