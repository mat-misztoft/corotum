import {
  type DesiredState,
  type DesiredStateEnvelope,
  type ManifestSkill,
  type RevisionTransition,
  type StateProvider,
  validateDesiredState,
} from "../../../packages/core/src/index";

export type MigrationStrategy = "replace" | "merge" | "cancel";

type MigrationProvider = StateProvider & {
  push: (
    input: Parameters<StateProvider["push"]>[0],
    transition: RevisionTransition,
  ) => ReturnType<StateProvider["push"]>;
  bootstrap?: (state: DesiredState) => ReturnType<StateProvider["push"]>;
};

export type MigrationResult =
  | Readonly<{
      kind: "migrated";
      revision: string;
      strategy: "replace" | "merge";
    }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "conflict"; skills: readonly string[] }>
  | Readonly<{ kind: "refused"; reason: string }>;

/**
 * Copies desired state between providers without changing the source. Existing
 * destination state is never replaced or merged unless the caller explicitly
 * supplies that choice; merge only unions independent skill identities.
 */
export class MigrationService {
  constructor(
    private readonly source: StateProvider,
    private readonly destination: MigrationProvider,
  ) {}

  async migrate(strategy: MigrationStrategy): Promise<MigrationResult> {
    if (strategy === "cancel") return { kind: "cancelled" };
    const source = await this.source.pull();
    if (source.kind !== "success")
      return { kind: "refused", reason: failureMessage(source) };

    const destination = await this.destination.pull();
    const destinationState =
      destination.kind === "success" ? destination.value.state : emptyState();
    const state =
      strategy === "replace"
        ? { state: source.value.state }
        : mergeDestination(destinationState, source.value.state);
    if ("conflicts" in state)
      return { kind: "conflict", skills: state.conflicts };

    const transition = migrationTransition(state.state);
    if (!transition)
      return {
        kind: "refused",
        reason: "Cannot migrate an empty desired state.",
      };
    if (destination.kind === "failure" && destination.error.code === "CONFLICT")
      return { kind: "refused", reason: destination.error.message };
    const result =
      destination.kind === "success"
        ? await this.destination.push(
            { state: state.state, baseRevision: destination.value.revisionId },
            transition,
          )
        : typeof this.destination.bootstrap === "function"
          ? await this.destination.bootstrap(state.state)
          : {
              kind: "failure" as const,
              error: {
                code: "NETWORK_ERROR" as const,
                message: failureMessage(destination),
              },
            };
    if (result.kind !== "success")
      return { kind: "refused", reason: failureMessage(result) };
    return { kind: "migrated", revision: result.value.revisionId, strategy };
  }
}

function emptyState(): DesiredState {
  return {
    manifest: { version: 1, skills: [] },
    lockfile: { version: 1, skills: [] },
  };
}

function migrationTransition(state: DesiredState): RevisionTransition | null {
  const skill = state.manifest.skills[0];
  return skill
    ? { type: "ADOPT", skillId: skill.id, metadata: { migration: "provider" } }
    : null;
}

function mergeDestination(
  destination: DesiredState,
  source: DesiredState,
):
  | Readonly<{ state: DesiredState }>
  | Readonly<{ conflicts: readonly string[] }> {
  const destinationById = new Map(
    destination.manifest.skills.map((skill) => [skill.id, skill]),
  );
  const destinationByIdentity = new Map(
    destination.manifest.skills.map((skill) => [identity(skill), skill]),
  );
  const conflicts = new Set<string>();
  for (const skill of source.manifest.skills) {
    const sameId = destinationById.get(skill.id);
    const sameIdentity = destinationByIdentity.get(identity(skill));
    if (
      (sameId && !sameSkill(sameId, skill)) ||
      (sameIdentity && !sameSkill(sameIdentity, skill))
    ) {
      conflicts.add(skill.skill);
    }
  }
  if (conflicts.size > 0) return { conflicts: [...conflicts].sort() };

  const manifest = [...destination.manifest.skills];
  const locks = [...destination.lockfile.skills];
  for (const skill of source.manifest.skills) {
    if (destinationById.has(skill.id)) continue;
    manifest.push(skill);
    const lock = source.lockfile.skills.find(
      (candidate) => candidate.id === skill.id,
    );
    if (lock) locks.push(lock);
  }
  return {
    state: validateDesiredState(
      {
        manifest: { version: 1, skills: manifest },
        lockfile: { version: 1, skills: locks },
      },
      "cloud",
    ),
  };
}

function identity(skill: ManifestSkill): string {
  return `${skill.source}\0${skill.skill}`;
}

function sameSkill(left: ManifestSkill, right: ManifestSkill): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function failureMessage(
  result: Exclude<
    Awaited<ReturnType<StateProvider["pull"]>>,
    { kind: "success" }
  >,
): string {
  return result.kind === "failure"
    ? result.error.message
    : "Desired state is incomplete.";
}
