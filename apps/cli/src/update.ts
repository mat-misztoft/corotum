import type {
  DesiredState,
  DesiredStateEnvelope,
  LockedSkill,
  RevisionTransition,
  SkillId,
  StateProvider,
} from "../../../packages/core/src/index";
import { GitSourceError } from "../../../packages/skills-adapter/src/git-source";
import type { LocalOperationalState } from "./local-state";
import type {
  ExecuteReconcileInput,
  LocalReconcileExecutor,
} from "./reconcile-executor";

export type UpdateStateProvider = StateProvider &
  Readonly<{
    pullReadOnly?: () => ReturnType<StateProvider["pull"]>;
    push: (
      input: {
        state: DesiredState;
        baseRevision: DesiredStateEnvelope["revisionId"] | null;
      },
      transition: RevisionTransition,
    ) => ReturnType<StateProvider["push"]>;
  }>;

export type UpdateResolver = Readonly<{
  resolve: (input: {
    id: SkillId;
    source: string;
    skill: string;
    ref: string;
    path: string;
  }) => Promise<Omit<LockedSkill, "id" | "source" | "skill" | "ref">>;
}>;

export type UpdateCheckStatus =
  | "UP_TO_DATE"
  | "UPDATE_AVAILABLE"
  | "UNKNOWN"
  | "AUTH_REQUIRED"
  | "CHECK_FAILED";

export type UpdateCheck = Readonly<{
  skillId: SkillId;
  skill: string;
  status: UpdateCheckStatus;
}>;

export type UpdateCheckResult =
  | readonly UpdateCheck[]
  | Readonly<{ kind: "refused"; reason: string }>;

export type UpdateResult =
  | Readonly<{ kind: "updated"; skills: readonly SkillId[]; revision: string }>
  | Readonly<{ kind: "up-to-date"; checks: readonly UpdateCheck[] }>
  | Readonly<{
      kind: "partial";
      checks: readonly UpdateCheck[];
      skills: readonly SkillId[];
      revision?: string;
    }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** Checks refs read-only, or advances selected lock entries and reconciles them. */
export class UpdateService {
  constructor(
    private readonly provider: UpdateStateProvider,
    private readonly resolver: UpdateResolver,
    private readonly executor: Pick<LocalReconcileExecutor, "execute">,
  ) {}

  async check(name?: string): Promise<UpdateCheckResult> {
    const current = await (this.provider.pullReadOnly?.() ??
      this.provider.pull());
    if (current.kind !== "success") return checkRefused(current);
    const selected = selectSkills(current.value.state, name);
    if (selected.kind === "refused") return selected;
    return (await this.resolveChecks(current.value.state, selected.skills))
      .checks;
  }

  async update(input: {
    name?: string;
    execution: Omit<
      ExecuteReconcileInput,
      "desired" | "plan" | "revision" | "state"
    > & { state: LocalOperationalState };
  }): Promise<UpdateResult> {
    const current = await this.provider.pull();
    if (current.kind !== "success") return refused(current);
    const selected = selectSkills(current.value.state, input.name);
    if (selected.kind === "refused") return selected;

    const resolved = await this.resolveChecks(
      current.value.state,
      selected.skills,
    );
    const { checks } = resolved;
    const changed = checks.filter(
      (check) => check.status === "UPDATE_AVAILABLE",
    );
    if (changed.length === 0) {
      return checks.some(
        (check) => !["UP_TO_DATE", "UNKNOWN"].includes(check.status),
      )
        ? { kind: "partial", checks, skills: [] }
        : { kind: "up-to-date", checks };
    }

    const locks = new Map(
      current.value.state.lockfile.skills.map((lock) => [lock.id, lock]),
    );
    for (const [id, lock] of resolved.locks) locks.set(id, lock);
    const changedLocks = changed
      .map((check) => resolved.locks.get(check.skillId))
      .filter((lock): lock is LockedSkill => lock !== undefined);
    const desired: DesiredState = {
      manifest: current.value.state.manifest,
      lockfile: { version: 1, skills: [...locks.values()] },
    };
    const pushed = await this.provider.push(
      { state: desired, baseRevision: current.value.revisionId },
      {
        type: "UPDATE",
        skillId: changed[0].skillId,
        metadata: { skillIds: changed.map((check) => check.skillId).join(",") },
      },
    );
    if (pushed.kind !== "success") return refused(pushed);

    const execution = await this.executor.execute({
      ...input.execution,
      state: input.execution.state,
      desired,
      revision: pushed.value.revisionId,
      // An explicit update deliberately installs only freshly resolved locks.
      plan: {
        classifications: [],
        operations: changedLocks.map((skill) => ({ kind: "INSTALL", skill })),
      },
    });
    const partial =
      checks.some(
        (check) =>
          check.status !== "UPDATE_AVAILABLE" && check.status !== "UP_TO_DATE",
      ) ||
      execution.operations.some((operation) => operation.status === "ERROR");
    return partial
      ? {
          kind: "partial",
          checks,
          skills: changed.map((check) => check.skillId),
          revision: pushed.value.revisionId,
        }
      : {
          kind: "updated",
          skills: changed.map((check) => check.skillId),
          revision: pushed.value.revisionId,
        };
  }

  private async resolveChecks(
    state: DesiredState,
    skills: readonly DesiredState["manifest"]["skills"][number][],
  ): Promise<{
    checks: readonly UpdateCheck[];
    locks: ReadonlyMap<SkillId, LockedSkill>;
  }> {
    const current = new Map(
      state.lockfile.skills.map((lock) => [lock.id, lock]),
    );
    const resolved = new Map<SkillId, LockedSkill>();
    const checks = await Promise.all(
      skills.map(async (skill) => {
        const lock = current.get(skill.id);
        if (!lock || skill.resolutionStatus !== "RESOLVED")
          return {
            skillId: skill.id,
            skill: skill.skill,
            status: "UNKNOWN" as const,
          };
        try {
          const next = await this.resolveLock(lock);
          resolved.set(skill.id, next);
          return {
            skillId: skill.id,
            skill: skill.skill,
            status:
              next.revision === lock.revision &&
              next.contentHash === lock.contentHash
                ? ("UP_TO_DATE" as const)
                : ("UPDATE_AVAILABLE" as const),
          };
        } catch (error) {
          return {
            skillId: skill.id,
            skill: skill.skill,
            status: statusFor(error),
          };
        }
      }),
    );
    return { checks, locks: resolved };
  }

  private async resolveLock(lock: LockedSkill): Promise<LockedSkill> {
    return { ...lock, ...(await this.resolver.resolve(lock)) };
  }
}

function selectSkills(
  state: DesiredState,
  name: string | undefined,
):
  | Readonly<{
      kind: "selected";
      skills: readonly DesiredState["manifest"]["skills"][number][];
    }>
  | Readonly<{ kind: "refused"; reason: string }> {
  const skills = name
    ? state.manifest.skills.filter(
        (skill) => skill.id === name || skill.skill === name,
      )
    : state.manifest.skills;
  if (skills.length === 0)
    return { kind: "refused", reason: "Managed skill was not found." };
  if (name && skills.length > 1)
    return {
      kind: "refused",
      reason: "Skill name is ambiguous; use its stable skill ID.",
    };
  return { kind: "selected", skills };
}

function statusFor(error: unknown): UpdateCheckStatus {
  return error instanceof GitSourceError && error.code === "AUTH_REQUIRED"
    ? "AUTH_REQUIRED"
    : "CHECK_FAILED";
}

function checkRefused(result: {
  kind: "failure" | "partial";
  error?: { message: string };
  errors?: readonly { message: string }[];
}): Extract<UpdateCheckResult, { kind: "refused" }> {
  return { kind: "refused", reason: refusalReason(result) };
}

function refused(result: {
  kind: "failure" | "partial";
  error?: { message: string };
  errors?: readonly { message: string }[];
}): UpdateResult {
  return { kind: "refused", reason: refusalReason(result) };
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
