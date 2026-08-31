import { lstat, readlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  type AgentId,
  applicableAgentIds,
  builtInAgentAdapters,
} from "../../../packages/agent-targets/src/index";
import type {
  DesiredState,
  LockedSkill,
  ReconcilePlan,
  SkillId,
  StateProvider,
} from "../../../packages/core/src/index";
import type { LocalOperationalState } from "./local-state";
import type {
  ExecuteReconcileInput,
  LocalReconcileExecutor,
  ReconcileExecutionResult,
} from "./reconcile-executor";

export type RestoreResult =
  | Readonly<{ kind: "restored"; skills: readonly SkillId[] }>
  | Readonly<{
      kind: "partial";
      skills: readonly SkillId[];
      execution: ReconcileExecutionResult;
    }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** Restores recorded managed skills from their immutable lock entries only. */
export class RestoreService {
  constructor(
    private readonly provider: Pick<StateProvider, "pull">,
    private readonly executor: Pick<LocalReconcileExecutor, "execute">,
    private readonly conflicts: typeof findRestoreConflicts = findRestoreConflicts,
  ) {}

  async restore(input: {
    name?: string;
    all: boolean;
    execution: Omit<
      ExecuteReconcileInput,
      "desired" | "plan" | "revision" | "state"
    > & { state: LocalOperationalState };
  }): Promise<RestoreResult> {
    if (input.all === Boolean(input.name)) {
      return {
        kind: "refused",
        reason: "Specify a skill to restore or use --all.",
      };
    }

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

    const locks = selectedLocks(current.value.state, input.name, input.all);
    if (locks.length === 0) {
      return {
        kind: "refused",
        reason: input.all
          ? "No resolved managed skills are available to restore."
          : "Managed skill was not found or has no locked revision.",
      };
    }

    const conflict = await this.conflicts({
      desired: current.value.state,
      locks,
      state: input.execution.state,
      enabledAgentIds: input.execution.enabledAgentIds,
      homeDir: input.execution.homeDir,
    });
    if (conflict) return { kind: "refused", reason: conflict };

    const execution = await this.executor.execute({
      ...input.execution,
      state: input.execution.state,
      desired: current.value.state,
      revision: current.value.revisionId,
      plan: {
        classifications: [],
        operations: locks.map((skill) => ({ kind: "INSTALL", skill })),
      } satisfies ReconcilePlan,
    });
    const skills = locks.map((skill) => skill.id);
    return execution.operations.some(
      (operation) => operation.status === "ERROR",
    )
      ? { kind: "partial", skills, execution }
      : { kind: "restored", skills };
  }
}

function selectedLocks(
  desired: DesiredState,
  name: string | undefined,
  all: boolean,
): readonly LockedSkill[] {
  const manifests = all
    ? desired.manifest.skills
    : desired.manifest.skills.filter(
        (skill) => skill.id === name || skill.skill === name,
      );
  const locks = new Map(
    desired.lockfile.skills.map((skill) => [skill.id, skill]),
  );
  return manifests
    .filter((skill) => skill.resolutionStatus === "RESOLVED")
    .map((skill) => locks.get(skill.id))
    .filter((skill): skill is LockedSkill => skill !== undefined);
}

/**
 * A path absent from Corotum's recorded ownership is never claimed during a
 * restore, even if it happens to share a skill name. Recorded copies are
 * explicitly repairable; a replaced symlink is an ownership conflict.
 */
export async function findRestoreConflicts(input: {
  desired: DesiredState;
  locks: readonly LockedSkill[];
  state: LocalOperationalState;
  enabledAgentIds: readonly AgentId[];
  homeDir: string;
}): Promise<string | undefined> {
  const ownedPaths = new Set(
    Object.values(input.state.skills).flatMap((skill) =>
      Object.values(skill.targets).map((target) => target.path),
    ),
  );

  for (const lock of input.locks) {
    const recorded = input.state.skills[lock.id];
    for (const target of Object.values(recorded?.targets ?? {})) {
      if (target.mode !== "symlink" || !(await exists(target.path))) continue;
      if (!(await pointsTo(target.path, recorded.canonicalPath))) {
        return `Managed target at ${target.path} was replaced; restore will not overwrite it.`;
      }
    }

    const manifest = input.desired.manifest.skills.find(
      (skill) => skill.id === lock.id,
    );
    if (!manifest) continue;
    for (const agentId of applicableAgentIds(
      manifest.targets,
      input.enabledAgentIds,
    )) {
      const adapter = builtInAgentAdapters.find((item) => item.id === agentId);
      if (!adapter) continue;
      for (const parent of adapter.globalSkillPaths(input.homeDir)) {
        const path = join(parent, lock.skill);
        if ((await exists(path)) && !ownedPaths.has(path)) {
          return `Unmanaged target exists at ${path}; restore will not overwrite it.`;
        }
      }
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function pointsTo(path: string, canonicalPath: string): Promise<boolean> {
  try {
    const target = await readlink(path);
    return resolve(dirname(path), target) === resolve(canonicalPath);
  } catch {
    return false;
  }
}
