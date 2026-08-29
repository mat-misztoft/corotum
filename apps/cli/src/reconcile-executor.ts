import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "../../../packages/agent-targets/src/index";
import {
  AgentTargetManager,
  type TargetOutcome,
} from "../../../packages/agent-targets/src/targets";
import type {
  DesiredState,
  LockedSkill,
  ReconcilePlan,
  RevisionId,
  SkillId,
} from "../../../packages/core/src/index";
import {
  type CanonicalSkillStore,
  hashSkillDirectory,
} from "../../../packages/skills-adapter/src/canonical-store";
import { GitSkillMaterializer } from "../../../packages/skills-adapter/src/git-source";
import {
  type LocalOperationalState,
  type LocalOperationalStateStore,
  type LocalSkillState,
  managedTargetsFromState,
} from "./local-state";

export type ReconcileOperationResult = Readonly<{
  kind: "INSTALL" | "REMOVE" | "UNMANAGE";
  skillId: SkillId;
  status: "SUCCESS" | "ERROR";
  targetOutcomes: readonly TargetOutcome[];
  error?: string;
}>;

export type ReconcileExecutionResult = Readonly<{
  state: LocalOperationalState;
  operations: readonly ReconcileOperationResult[];
}>;

export type ExecuteReconcileInput = Readonly<{
  plan: ReconcilePlan;
  desired: DesiredState;
  revision: RevisionId | null;
  state: LocalOperationalState;
  enabledAgentIds: readonly AgentId[];
  homeDir: string;
}>;

/**
 * Applies a portable core plan using local-only adapters. Each skill operation
 * is isolated so a failed source or target never prevents unrelated skills from
 * being reconciled. State is persisted only after the canonical copy and its
 * recorded target ownership have been verified.
 */
export class LocalReconcileExecutor {
  constructor(
    private readonly stateStore: LocalOperationalStateStore,
    private readonly canonicalStore: CanonicalSkillStore,
    private readonly materializer: GitSkillMaterializer = new GitSkillMaterializer(),
    private readonly targets: AgentTargetManager = new AgentTargetManager(),
  ) {}

  async execute(
    input: ExecuteReconcileInput,
  ): Promise<ReconcileExecutionResult> {
    const skills = { ...input.state.skills } as Record<
      SkillId,
      LocalSkillState
    >;
    let ownership = managedTargetsFromState(input.state);
    const operations: ReconcileOperationResult[] = [];

    for (const operation of input.plan.operations) {
      const skillId =
        operation.kind === "INSTALL" ? operation.skill.id : operation.skillId;
      try {
        if (operation.kind === "INSTALL") {
          const result = await this.install(operation.skill, input, ownership);
          ownership = result.ownership;
          skills[skillId] = result.skill;
          operations.push({
            kind: operation.kind,
            skillId,
            status: hasTargetErrors(result.outcomes) ? "ERROR" : "SUCCESS",
            targetOutcomes: result.outcomes,
            error: firstTargetError(result.outcomes),
          });
        } else if (operation.kind === "REMOVE") {
          const result = await this.targets.remove(skillId, ownership);
          ownership = result.ownership;
          if (hasTargetErrors(result.outcomes)) {
            skills[skillId] = this.withOwnership(
              skills[skillId],
              ownership,
              skillId,
            );
            operations.push({
              kind: operation.kind,
              skillId,
              status: "ERROR",
              targetOutcomes: result.outcomes,
              error: firstTargetError(result.outcomes),
            });
          } else {
            await this.canonicalStore.remove(skillId);
            delete skills[skillId];
            operations.push({
              kind: operation.kind,
              skillId,
              status: "SUCCESS",
              targetOutcomes: result.outcomes,
            });
          }
        } else {
          const result = await this.targets.unmanage(skillId, ownership);
          ownership = result.ownership;
          if (hasTargetErrors(result.outcomes)) {
            skills[skillId] = this.withOwnership(
              skills[skillId],
              ownership,
              skillId,
            );
            operations.push({
              kind: operation.kind,
              skillId,
              status: "ERROR",
              targetOutcomes: result.outcomes,
              error: firstTargetError(result.outcomes),
            });
          } else {
            await this.canonicalStore.remove(skillId);
            delete skills[skillId];
            operations.push({
              kind: operation.kind,
              skillId,
              status: "SUCCESS",
              targetOutcomes: result.outcomes,
            });
          }
        }
      } catch (error) {
        operations.push({
          kind: operation.kind,
          skillId,
          status: "ERROR",
          targetOutcomes: [],
          error:
            error instanceof Error
              ? error.message
              : "Reconcile operation failed.",
        });
      }
    }

    const state: LocalOperationalState = {
      schemaVersion: 1,
      lastAppliedRevision: operations.every(
        (operation) => operation.status === "SUCCESS",
      )
        ? input.revision
        : input.state.lastAppliedRevision,
      skills,
    };
    await this.stateStore.save(state);
    return { state, operations };
  }

  private async install(
    lock: LockedSkill,
    input: ExecuteReconcileInput,
    ownership: ReturnType<typeof managedTargetsFromState>,
  ): Promise<
    Readonly<{
      skill: LocalSkillState;
      ownership: ReturnType<typeof managedTargetsFromState>;
      outcomes: readonly TargetOutcome[];
    }>
  > {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "toolmirror-reconcile-"),
    );
    const temporarySkill = join(temporaryRoot, "skill");
    try {
      await this.materializer.materialize(lock, temporarySkill);
      await this.canonicalStore.replaceFromDirectory(
        lock.id,
        temporarySkill,
        lock.contentHash,
      );
      const canonicalPath = this.canonicalStore.pathFor(lock.id);
      if ((await hashSkillDirectory(canonicalPath)) !== lock.contentHash) {
        throw new Error(
          "Canonical skill content did not match the lock after installation.",
        );
      }
      const manifest = input.desired.manifest.skills.find(
        (skill) => skill.id === lock.id,
      );
      if (!manifest)
        throw new Error("Locked skill is absent from desired state.");
      const exposed = await this.targets.expose({
        skillId: lock.id,
        skillName: lock.skill,
        canonicalPath,
        targets: manifest.targets,
        enabledAgentIds: input.enabledAgentIds,
        homeDir: input.homeDir,
        ownership,
      });
      return {
        ownership: exposed.ownership,
        outcomes: exposed.outcomes,
        skill: {
          canonicalPath,
          contentHash: lock.contentHash,
          targets: Object.fromEntries(
            exposed.ownership
              .filter((target) => target.skillId === lock.id)
              .map((target) => [
                `${target.agentId}\0${target.path}`,
                {
                  agentId: target.agentId,
                  mode: target.mode,
                  path: target.path,
                },
              ]),
          ),
        },
      };
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }

  private withOwnership(
    skill: LocalSkillState | undefined,
    ownership: ReturnType<typeof managedTargetsFromState>,
    skillId: SkillId,
  ): LocalSkillState {
    if (!skill) throw new Error("Managed skill state is missing.");
    return {
      ...skill,
      targets: Object.fromEntries(
        ownership
          .filter((target) => target.skillId === skillId)
          .map((target) => [
            `${target.agentId}\0${target.path}`,
            { agentId: target.agentId, mode: target.mode, path: target.path },
          ]),
      ),
    };
  }
}

function hasTargetErrors(outcomes: readonly TargetOutcome[]): boolean {
  return outcomes.some((outcome) => outcome.status === "ERROR");
}

function firstTargetError(
  outcomes: readonly TargetOutcome[],
): string | undefined {
  return outcomes.find((outcome) => outcome.status === "ERROR")?.error;
}
