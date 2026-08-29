import type { AgentId } from "../../../packages/agent-targets/src/index";
import {
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

export type AdoptStateProvider = StateProvider &
  Readonly<{
    push: (
      input: {
        state: DesiredState;
        baseRevision: DesiredStateEnvelope["revisionId"] | null;
      },
      transition: RevisionTransition,
    ) => ReturnType<StateProvider["push"]>;
  }>;

export type LocalAdoptCandidate = Readonly<{
  agentId: AgentId;
  contentHash: string;
  name: string;
  path: string;
}>;

export type RepositoryAdoptCandidate = Readonly<{ name: string; path: string }>;

export type AdoptResult =
  | Readonly<{
      kind: "adopted";
      skillId: SkillId;
      revision: DesiredStateEnvelope["revisionId"];
    }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** Adopts one explicitly selected unmanaged local copy from locked Git content. */
export class AdoptService {
  constructor(
    private readonly provider: AdoptStateProvider,
    private readonly executor: Pick<LocalReconcileExecutor, "execute">,
  ) {}

  async adopt(input: {
    source: string;
    local: LocalAdoptCandidate;
    repository: RepositoryAdoptCandidate;
    ref: string;
    resolved: Omit<LockedSkill, "id" | "source" | "skill" | "ref">;
    replaceLocalMismatch: boolean;
    execution: Omit<
      ExecuteReconcileInput,
      "desired" | "plan" | "revision" | "state"
    > & { state: LocalOperationalState };
  }): Promise<AdoptResult> {
    // Pull first so an unresolved Git PENDING_PUSH blocks desired-state and
    // ownership mutation, even if the command's earlier preflight raced.
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
    if (
      current.value.state.manifest.skills.some(
        (skill) =>
          skill.source === input.source &&
          skill.skill === input.repository.name,
      )
    ) {
      return {
        kind: "refused",
        reason: "This source skill is already managed.",
      };
    }

    if (
      input.resolved.contentHash !== input.local.contentHash &&
      !input.replaceLocalMismatch
    ) {
      return {
        kind: "refused",
        reason:
          "Repository content differs from the local copy; explicit replacement approval is required.",
      };
    }

    const id = skillId(`sk_${crypto.randomUUID().replaceAll("-", "")}`);
    const lock: LockedSkill = {
      id,
      source: input.source,
      skill: input.repository.name,
      ref: input.ref,
      ...input.resolved,
    };
    const desired: DesiredState = {
      manifest: {
        version: 1,
        skills: [
          ...current.value.state.manifest.skills,
          {
            id,
            source: input.source,
            skill: input.repository.name,
            ref: input.ref,
            targets: [input.local.agentId],
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
      { type: "ADOPT", skillId: id, metadata: {} },
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

    // The explicitly approved unmanaged directory is the only staged ownership
    // that may be replaced by the executor. Every other local copy stays unmanaged.
    const stagedState: LocalOperationalState = {
      ...input.execution.state,
      skills: {
        ...input.execution.state.skills,
        [id]: {
          canonicalPath: "pending-adopt",
          contentHash: input.local.contentHash,
          targets: {
            [`${input.local.agentId}\0${input.local.path}`]: {
              agentId: input.local.agentId,
              mode: "copy",
              path: input.local.path,
            },
          },
        },
      },
    };
    const execution = await this.executor.execute({
      ...input.execution,
      state: stagedState,
      desired,
      revision: pushed.value.revisionId,
      plan: planReconcile(desired, { skills: {} }),
    });
    if (
      execution.operations.some((operation) => operation.status === "ERROR")
    ) {
      return {
        kind: "refused",
        reason: "Desired state was saved, but local adoption did not complete.",
      };
    }
    return { kind: "adopted", skillId: id, revision: pushed.value.revisionId };
  }
}
