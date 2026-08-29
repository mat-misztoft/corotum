import {
  type ActualState,
  type DesiredState,
  type DesiredStateEnvelope,
  type LockedSkill,
  planReconcile,
  type RevisionTransition,
  type SkillId,
  type StateProvider,
  skillId,
} from "../../../packages/core/src/index";
import type { LocalOperationalState } from "./local-state";
import type {
  ExecuteReconcileInput,
  LocalReconcileExecutor,
} from "./reconcile-executor";

export type AddStateProvider = StateProvider &
  Readonly<{
    push: (
      input: {
        state: DesiredState;
        baseRevision: DesiredStateEnvelope["revisionId"] | null;
      },
      transition: RevisionTransition,
    ) => ReturnType<StateProvider["push"]>;
  }>;

export type AddResolver = Readonly<{
  resolve: (input: {
    id: SkillId;
    source: string;
    skill: string;
    ref: string;
    path: string;
  }) => Promise<Omit<LockedSkill, "id" | "source" | "skill" | "ref">>;
}>;

export type AddCandidate = Readonly<{ name: string; path: string }>;

export type AddResult =
  | Readonly<{
      kind: "added";
      skillId: SkillId;
      revision: DesiredStateEnvelope["revisionId"];
    }>
  | Readonly<{ kind: "duplicate"; skillId: SkillId }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** Adds a fully resolved Git skill before using the shared reconcile executor. */
export class AddService {
  constructor(
    private readonly provider: AddStateProvider,
    private readonly resolver: AddResolver,
    private readonly executor: Pick<LocalReconcileExecutor, "execute">,
  ) {}

  async add(input: {
    source: string;
    candidate: AddCandidate;
    ref: string;
    execution: Omit<
      ExecuteReconcileInput,
      "desired" | "plan" | "revision" | "state"
    > & { state: LocalOperationalState };
  }): Promise<AddResult> {
    // Pull retries PENDING_PUSH before any local resolver or state mutation.
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

    const duplicate = current.value.state.manifest.skills.find(
      (skill) =>
        skill.source === input.source && skill.skill === input.candidate.name,
    );
    if (duplicate) return { kind: "duplicate", skillId: duplicate.id };

    const id = skillId(`sk_${crypto.randomUUID().replaceAll("-", "")}`);
    let resolved: Omit<LockedSkill, "id" | "source" | "skill" | "ref">;
    try {
      resolved = await this.resolver.resolve({
        id,
        source: input.source,
        skill: input.candidate.name,
        ref: input.ref,
        path: input.candidate.path,
      });
    } catch (error) {
      return {
        kind: "refused",
        reason:
          error instanceof Error
            ? error.message
            : "Skill source could not be resolved.",
      };
    }

    const lock: LockedSkill = {
      id,
      source: input.source,
      skill: input.candidate.name,
      ref: input.ref,
      ...resolved,
    };
    const desired: DesiredState = {
      manifest: {
        version: 1,
        skills: [
          ...current.value.state.manifest.skills,
          {
            id,
            source: input.source,
            skill: input.candidate.name,
            ref: input.ref,
            targets: "all",
            resolutionStatus: "RESOLVED",
          },
        ],
      },
      lockfile: {
        version: 1,
        skills: [...current.value.state.lockfile.skills, lock],
      },
    };
    const pushed = await this.provider.push(
      { state: desired, baseRevision: current.value.revisionId },
      { type: "ADD", skillId: id, metadata: {} },
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
      state: input.execution.state,
      desired,
      revision: pushed.value.revisionId,
      plan: planReconcile(desired, actualState(input.execution.state)),
    });
    if (
      execution.operations.some((operation) => operation.status === "ERROR")
    ) {
      return {
        kind: "refused",
        reason:
          "Desired state was saved, but local reconciliation did not complete.",
      };
    }
    return { kind: "added", skillId: id, revision: pushed.value.revisionId };
  }
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
