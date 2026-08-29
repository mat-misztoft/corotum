import type {
  DesiredState,
  DesiredStateEnvelope,
  LockedSkill,
  RevisionTransition,
  SkillId,
  StateProvider,
} from "../../../packages/core/src/index";
import type { LocalOperationalState } from "./local-state";
import type {
  ExecuteReconcileInput,
  LocalReconcileExecutor,
} from "./reconcile-executor";

export type SetRefStateProvider = StateProvider &
  Readonly<{
    push: (
      input: {
        state: DesiredState;
        baseRevision: DesiredStateEnvelope["revisionId"] | null;
      },
      transition: RevisionTransition,
    ) => ReturnType<StateProvider["push"]>;
  }>;

export type SetRefResolver = Readonly<{
  resolve: (input: {
    id: SkillId;
    source: string;
    skill: string;
    ref: string;
    path: string;
  }) => Promise<Omit<LockedSkill, "id" | "source" | "skill" | "ref">>;
}>;

export type SetRefResult =
  | Readonly<{
      kind: "set";
      skillId: SkillId;
      revision: DesiredStateEnvelope["revisionId"];
    }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** Resolves a new ref before atomically updating its manifest and exact lock. */
export class SetRefService {
  constructor(
    private readonly provider: SetRefStateProvider,
    private readonly resolver: SetRefResolver,
    private readonly executor: Pick<LocalReconcileExecutor, "execute">,
  ) {}

  async setRef(input: {
    name: string;
    ref: string;
    execution: Omit<
      ExecuteReconcileInput,
      "desired" | "plan" | "revision" | "state"
    > & { state: LocalOperationalState };
  }): Promise<SetRefResult> {
    if (input.ref.trim().length === 0)
      return { kind: "refused", reason: "A ref cannot be empty." };

    // Pull retries PENDING_PUSH before any source resolution or state mutation.
    const current = await this.provider.pull();
    if (current.kind !== "success")
      return { kind: "refused", reason: refusalReason(current) };

    const selected = selectSkill(current.value.state, input.name);
    if (selected.kind === "refused") return selected;
    const previous = current.value.state.lockfile.skills.find(
      (lock) => lock.id === selected.skill.id,
    );
    if (!previous || selected.skill.resolutionStatus !== "RESOLVED") {
      return {
        kind: "refused",
        reason: "Managed skill does not have a resolved exact lock.",
      };
    }

    let resolved: Omit<LockedSkill, "id" | "source" | "skill" | "ref">;
    try {
      resolved = await this.resolver.resolve({ ...previous, ref: input.ref });
    } catch (error) {
      return {
        kind: "refused",
        reason:
          error instanceof Error
            ? error.message
            : "Skill source could not be resolved.",
      };
    }

    const lock: LockedSkill = { ...previous, ref: input.ref, ...resolved };
    const desired: DesiredState = {
      manifest: {
        version: 1,
        skills: current.value.state.manifest.skills.map((skill) =>
          skill.id === selected.skill.id ? { ...skill, ref: input.ref } : skill,
        ),
      },
      lockfile: {
        version: 1,
        skills: current.value.state.lockfile.skills.map((existing) =>
          existing.id === selected.skill.id ? lock : existing,
        ),
      },
    };
    const pushed = await this.provider.push(
      { state: desired, baseRevision: current.value.revisionId },
      {
        type: "SET_REF",
        skillId: selected.skill.id,
        metadata: { ref: input.ref },
      },
    );
    if (pushed.kind !== "success")
      return { kind: "refused", reason: refusalReason(pushed) };

    const execution = await this.executor.execute({
      ...input.execution,
      state: input.execution.state,
      desired,
      revision: pushed.value.revisionId,
      // set-ref is explicit: install the freshly resolved lock even if the
      // prior local content is otherwise classified as drifted.
      plan: {
        classifications: [],
        operations: [{ kind: "INSTALL", skill: lock }],
      },
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
    return {
      kind: "set",
      skillId: selected.skill.id,
      revision: pushed.value.revisionId,
    };
  }
}

function selectSkill(
  state: DesiredState,
  name: string,
):
  | Readonly<{
      kind: "selected";
      skill: DesiredState["manifest"]["skills"][number];
    }>
  | Readonly<{ kind: "refused"; reason: string }> {
  const skills = state.manifest.skills.filter(
    (skill) => skill.id === name || skill.skill === name,
  );
  if (skills.length === 0)
    return { kind: "refused", reason: "Managed skill was not found." };
  if (skills.length > 1)
    return {
      kind: "refused",
      reason: "Skill name is ambiguous; use its stable skill ID.",
    };
  return { kind: "selected", skill: skills[0] };
}

function refusalReason(result: {
  kind: "failure" | "partial";
  error?: { message: string };
  errors?: readonly { message: string }[];
}): string {
  return result.kind === "failure"
    ? (result.error?.message ?? "Desired state could not be read.")
    : (result.errors?.[0]?.message ?? "Desired state is incomplete.");
}
