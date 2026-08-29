import { parse, stringify } from "yaml";
import { z } from "zod";

export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type SkillId = Brand<string, "SkillId">;
export type RevisionId = Brand<string, "RevisionId">;

const skillIdPattern = /^sk_[A-Za-z0-9]+$/;
const nonEmptyString = z.string().trim().min(1);

/** Validates an externally supplied stable skill identifier. */
export function skillId(value: string): SkillId {
  if (!skillIdPattern.test(value)) {
    throw new DomainValidationError(
      "INVALID_SKILL_ID",
      "A skill ID must have the form sk_<opaque identifier>.",
    );
  }

  return value as SkillId;
}

export function revisionId(value: string): RevisionId {
  if (value.trim().length === 0) {
    throw new DomainValidationError(
      "INVALID_REVISION_ID",
      "A revision ID cannot be empty.",
    );
  }

  return value as RevisionId;
}

export type DomainErrorCode =
  | "AUTH_REQUIRED"
  | "CONFLICT"
  | "DEVICE_ERROR"
  | "INVALID_REVISION_ID"
  | "INVALID_SKILL_ID"
  | "NETWORK_ERROR"
  | "VALIDATION_ERROR";

export class DomainValidationError extends Error {
  readonly name = "DomainValidationError";

  constructor(
    readonly code: Extract<
      DomainErrorCode,
      "INVALID_REVISION_ID" | "INVALID_SKILL_ID" | "VALIDATION_ERROR"
    >,
    message: string,
  ) {
    super(message);
  }
}

export type DomainError = Readonly<{
  code: DomainErrorCode;
  message: string;
}>;

export type Result<T> =
  | Readonly<{ kind: "success"; value: T }>
  | Readonly<{ kind: "partial"; value: T; errors: readonly DomainError[] }>
  | Readonly<{ kind: "failure"; error: DomainError }>;

export type AgentTargets = "all" | readonly string[];
export type ResolutionStatus = "PENDING_RESOLUTION" | "RESOLVED";

export type ManifestSkill = Readonly<{
  id: SkillId;
  source: string;
  skill: string;
  ref: string;
  targets: AgentTargets;
  resolutionStatus: ResolutionStatus;
}>;

export type Manifest = Readonly<{
  version: 1;
  skills: readonly ManifestSkill[];
}>;

export type LockedSkill = Readonly<{
  id: SkillId;
  source: string;
  skill: string;
  ref: string;
  repository: string;
  revision: string;
  path: string;
  contentHash: string;
}>;

export type Lockfile = Readonly<{
  version: 1;
  skills: readonly LockedSkill[];
}>;

export type DesiredState = Readonly<{
  manifest: Manifest;
  lockfile: Lockfile;
}>;

export type StateMode = "cloud" | "git";

const targetsSchema = z.union([
  z.literal("all"),
  z
    .array(nonEmptyString)
    .min(1)
    .transform((targets) => [...new Set(targets)]),
]);

const manifestSkillSchema = z
  .object({
    id: nonEmptyString,
    source: nonEmptyString,
    skill: nonEmptyString,
    ref: nonEmptyString,
    targets: targetsSchema,
    resolutionStatus: z
      .enum(["PENDING_RESOLUTION", "RESOLVED"])
      .default("RESOLVED"),
  })
  .strict();

const manifestSchema = z
  .object({
    version: z.literal(1),
    skills: z.array(manifestSkillSchema),
  })
  .strict();

const lockedSkillSchema = z
  .object({
    id: nonEmptyString,
    source: nonEmptyString,
    skill: nonEmptyString,
    ref: nonEmptyString,
    repository: nonEmptyString,
    revision: nonEmptyString,
    path: nonEmptyString,
    contentHash: nonEmptyString,
  })
  .strict();

const lockfileSchema = z
  .object({
    version: z.literal(1),
    skills: z.array(lockedSkillSchema),
  })
  .strict();

function validationError(message: string): DomainValidationError {
  return new DomainValidationError("VALIDATION_ERROR", message);
}

function normalizeTargets(targets: AgentTargets): AgentTargets {
  return targets === "all" ? targets : [...new Set(targets)].sort();
}

function compareSkills(
  left: { source: string; skill: string; id: SkillId },
  right: { source: string; skill: string; id: SkillId },
): number {
  const leftKey = [left.source, left.skill, left.id].join("\0");
  const rightKey = [right.source, right.skill, right.id].join("\0");
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function sortManifestSkills(skills: readonly ManifestSkill[]): ManifestSkill[] {
  return [...skills].sort(compareSkills);
}

function sortLockedSkills(skills: readonly LockedSkill[]): LockedSkill[] {
  return [...skills].sort(compareSkills);
}

function assertUniqueSkills(
  skills: readonly { id: SkillId; source: string; skill: string }[],
  kind: "manifest" | "lockfile",
): void {
  const ids = new Set<string>();
  const identities = new Set<string>();

  for (const skill of skills) {
    if (ids.has(skill.id)) {
      throw validationError(`${kind} contains duplicate skill ID ${skill.id}.`);
    }
    ids.add(skill.id);

    const identity = `${skill.source}\0${skill.skill}`;
    if (identities.has(identity)) {
      throw validationError(
        `${kind} contains duplicate source + skill ${skill.source} + ${skill.skill}.`,
      );
    }
    identities.add(identity);
  }
}

function toManifest(input: unknown): Manifest {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success)
    throw validationError("Invalid toolmirror.yaml manifest.");

  const skills = parsed.data.skills.map((skill) => ({
    ...skill,
    id: skillId(skill.id),
    targets: normalizeTargets(skill.targets),
  }));
  assertUniqueSkills(skills, "manifest");

  return { version: 1, skills: sortManifestSkills(skills) };
}

function toLockfile(input: unknown): Lockfile {
  const parsed = lockfileSchema.safeParse(input);
  if (!parsed.success)
    throw validationError("Invalid toolmirror.lock lockfile.");

  const skills = parsed.data.skills.map((skill) => ({
    ...skill,
    id: skillId(skill.id),
  }));
  assertUniqueSkills(skills, "lockfile");

  return { version: 1, skills: sortLockedSkills(skills) };
}

/** Parses and validates a toolmirror.yaml manifest without filesystem access. */
export function parseManifest(source: string): Manifest {
  try {
    return toManifest(parse(source, { maxAliasCount: 0 }));
  } catch (error) {
    if (error instanceof DomainValidationError) throw error;
    throw validationError("Invalid toolmirror.yaml manifest.");
  }
}

/** Produces canonical, byte-stable YAML for semantically equivalent manifests. */
export function serializeManifest(manifest: Manifest): string {
  const normalized = toManifest(manifest);
  return stringify({
    version: normalized.version,
    skills: normalized.skills.map((skill) => ({
      id: skill.id,
      source: skill.source,
      skill: skill.skill,
      ref: skill.ref,
      targets: skill.targets,
      ...(skill.resolutionStatus === "PENDING_RESOLUTION"
        ? { resolutionStatus: skill.resolutionStatus }
        : {}),
    })),
  });
}

/** Parses and validates a deterministic JSON toolmirror.lock lockfile. */
export function parseLockfile(source: string): Lockfile {
  try {
    return toLockfile(JSON.parse(source));
  } catch (error) {
    if (error instanceof DomainValidationError) throw error;
    throw validationError("Invalid toolmirror.lock lockfile.");
  }
}

/** Produces canonical, byte-stable JSON without timestamps. */
export function serializeLockfile(lockfile: Lockfile): string {
  const normalized = toLockfile(lockfile);
  return `${JSON.stringify(
    {
      version: normalized.version,
      skills: normalized.skills.map((skill) => ({
        id: skill.id,
        source: skill.source,
        skill: skill.skill,
        ref: skill.ref,
        repository: skill.repository,
        revision: skill.revision,
        path: skill.path,
        contentHash: skill.contentHash,
      })),
    },
    null,
    2,
  )}\n`;
}

/**
 * Validates lock coverage. Only Cloud desired state may omit a lock entry, and
 * then only for a skill explicitly awaiting device-side resolution.
 */
export function validateDesiredState(
  input: DesiredState,
  mode: StateMode,
): DesiredState {
  const manifest = toManifest(input.manifest);
  const lockfile = toLockfile(input.lockfile);
  const locksById = new Map(lockfile.skills.map((skill) => [skill.id, skill]));

  for (const skill of manifest.skills) {
    const lock = locksById.get(skill.id);
    if (!lock) {
      if (mode === "cloud" && skill.resolutionStatus === "PENDING_RESOLUTION") {
        continue;
      }
      throw validationError(
        `Missing lock entry for ${skill.id}; only Cloud PENDING_RESOLUTION skills may be unlocked.`,
      );
    }

    if (
      lock.source !== skill.source ||
      lock.skill !== skill.skill ||
      lock.ref !== skill.ref
    ) {
      throw validationError(
        `Lock entry for ${skill.id} does not match its manifest skill.`,
      );
    }
  }

  for (const lock of lockfile.skills) {
    if (!manifest.skills.some((skill) => skill.id === lock.id)) {
      throw validationError(`Lock entry ${lock.id} has no manifest skill.`);
    }
  }

  return { manifest, lockfile };
}

export type ActualState = Readonly<{
  skills: Readonly<Record<SkillId, ActualSkillState>>;
}>;

export type ActualSkillState = Readonly<{
  contentHash: string | null;
  managed: boolean;
}>;

export type DesiredStateEnvelope = Readonly<{
  revisionId: RevisionId;
  revisionSequence?: number;
  state: DesiredState;
}>;

export type PushDesiredStateInput = Readonly<{
  state: DesiredState;
  baseRevision: RevisionId | null;
  idempotencyKey?: string;
}>;

export type RevisionTransitionType =
  | "ADD"
  | "REMOVE"
  | "UNMANAGE"
  | "UPDATE"
  | "SET_REF"
  | "ADOPT";

/**
 * Compact operation data retained with a revision snapshot. Providers use it
 * to preserve remove versus unmanage behavior for devices that were offline.
 */
export type RevisionTransition = Readonly<{
  type: RevisionTransitionType;
  skillId: SkillId;
  metadata: Readonly<Record<string, string>>;
}>;

const revisionTransitionSchema = z
  .object({
    type: z.enum(["ADD", "REMOVE", "UNMANAGE", "UPDATE", "SET_REF", "ADOPT"]),
    skillId: nonEmptyString,
    metadata: z.record(nonEmptyString, z.string()).default({}),
  })
  .strict();

function sortMetadata(
  metadata: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

/** Parses stored revision transition metadata without provider dependencies. */
export function parseRevisionTransition(source: string): RevisionTransition {
  try {
    const parsed = revisionTransitionSchema.safeParse(JSON.parse(source));
    if (!parsed.success) throw validationError("Invalid revision transition.");
    return {
      type: parsed.data.type,
      skillId: skillId(parsed.data.skillId),
      metadata: sortMetadata(parsed.data.metadata),
    };
  } catch (error) {
    if (error instanceof DomainValidationError) throw error;
    throw validationError("Invalid revision transition.");
  }
}

/** Produces deterministic JSON for provider revision metadata. */
export function serializeRevisionTransition(
  transition: RevisionTransition,
): string {
  const normalized = parseRevisionTransition(JSON.stringify(transition));
  return `${JSON.stringify({
    type: normalized.type,
    skillId: normalized.skillId,
    metadata: normalized.metadata,
  })}\n`;
}

export type OfflineSkillDisposition =
  | "MANAGED"
  | "REMOVE"
  | "UNMANAGE"
  | "UNKNOWN";

/**
 * The newest desired snapshot is authoritative. Transition metadata only
 * decides how to handle a skill absent from that snapshot.
 */
export function offlineSkillDisposition(
  latest: DesiredState,
  transitions: readonly RevisionTransition[],
  skillId: SkillId,
): OfflineSkillDisposition {
  if (latest.manifest.skills.some((skill) => skill.id === skillId)) {
    return "MANAGED";
  }

  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const transition = transitions[index];
    if (transition.skillId !== skillId) continue;
    if (transition.type === "REMOVE") return "REMOVE";
    if (transition.type === "UNMANAGE") return "UNMANAGE";
  }

  return "UNKNOWN";
}

export type DesiredStateMergeConflict = Readonly<{
  skillId: SkillId;
  base: ManifestSkill | null;
  remote: ManifestSkill | null;
  local: ManifestSkill | null;
}>;

export type DesiredStateMergeResult =
  | Readonly<{ kind: "merged"; state: DesiredState }>
  | Readonly<{
      kind: "conflict";
      conflicts: readonly DesiredStateMergeConflict[];
    }>;

function skillEntries(state: DesiredState): Map<SkillId, string> {
  const locks = new Map(
    state.lockfile.skills.map((skill) => [skill.id, skill]),
  );
  return new Map(
    state.manifest.skills.map((skill) => [
      skill.id,
      JSON.stringify({ skill, lock: locks.get(skill.id) ?? null }),
    ]),
  );
}

function skillById(state: DesiredState, id: SkillId): ManifestSkill | null {
  return state.manifest.skills.find((skill) => skill.id === id) ?? null;
}

/**
 * Merges two edits made from the same desired-state snapshot. Different skill
 * IDs merge independently; competing edits to one skill remain explicit.
 */
export function mergeDesiredStates(
  base: DesiredState,
  remote: DesiredState,
  local: DesiredState,
  mode: StateMode,
): DesiredStateMergeResult {
  const normalizedBase = validateDesiredState(base, mode);
  const normalizedRemote = validateDesiredState(remote, mode);
  const normalizedLocal = validateDesiredState(local, mode);
  const baseEntries = skillEntries(normalizedBase);
  const remoteEntries = skillEntries(normalizedRemote);
  const localEntries = skillEntries(normalizedLocal);
  const ids = new Set<SkillId>([
    ...baseEntries.keys(),
    ...remoteEntries.keys(),
    ...localEntries.keys(),
  ]);
  const selected = new Map<SkillId, DesiredState>();
  const conflicts: DesiredStateMergeConflict[] = [];

  for (const id of ids) {
    const before = baseEntries.get(id);
    const remoteChange = remoteEntries.get(id);
    const localChange = localEntries.get(id);
    const remoteChanged = remoteChange !== before;
    const localChanged = localChange !== before;

    if (remoteChanged && localChanged && remoteChange !== localChange) {
      conflicts.push({
        skillId: id,
        base: skillById(normalizedBase, id),
        remote: skillById(normalizedRemote, id),
        local: skillById(normalizedLocal, id),
      });
      continue;
    }

    const chosen = localChanged ? localChange : remoteChange;
    if (chosen !== undefined) {
      selected.set(id, localChanged ? normalizedLocal : normalizedRemote);
    }
  }

  if (conflicts.length > 0) {
    return {
      kind: "conflict",
      conflicts: conflicts.sort((left, right) =>
        left.skillId < right.skillId
          ? -1
          : left.skillId > right.skillId
            ? 1
            : 0,
      ),
    };
  }

  const skills = [...selected]
    .map(([id, state]) => skillById(state, id))
    .filter((skill): skill is ManifestSkill => skill !== null);
  const locks = [...selected]
    .map(([id, state]) =>
      state.lockfile.skills.find((skill) => skill.id === id),
    )
    .filter((skill): skill is LockedSkill => skill !== undefined);

  return {
    kind: "merged",
    state: validateDesiredState(
      {
        manifest: { version: 1, skills },
        lockfile: { version: 1, skills: locks },
      },
      mode,
    ),
  };
}

/** Portable contract implemented by Git and Cloud state providers. */
export interface StateProvider {
  pull(): Promise<Result<DesiredStateEnvelope>>;
  push(input: PushDesiredStateInput): Promise<Result<DesiredStateEnvelope>>;
}

export type ActualStateClassification =
  | "MANAGED_SYNCED"
  | "UNMANAGED"
  | "MISSING"
  | "DRIFTED"
  | "REMOVE_CANDIDATE"
  | "PENDING_RESOLUTION";

export type ClassifiedSkill = Readonly<{
  skillId: SkillId;
  classification: ActualStateClassification;
}>;

export type ReconcileOperation =
  | Readonly<{ kind: "INSTALL"; skill: LockedSkill }>
  | Readonly<{ kind: "REMOVE"; skillId: SkillId }>;

export type ReconcilePlan = Readonly<{
  classifications: readonly ClassifiedSkill[];
  operations: readonly ReconcileOperation[];
}>;

/**
 * Classifies desired and local state without touching a filesystem. An actual
 * unowned skill and a modified owned skill intentionally produce no ordinary
 * sync operation: both require an explicit user decision or restore flow.
 */
export function planReconcile(
  desired: DesiredState,
  actual: ActualState,
): ReconcilePlan {
  const locksById = new Map(
    desired.lockfile.skills.map((skill) => [skill.id, skill]),
  );
  const manifestIds = new Set(desired.manifest.skills.map((skill) => skill.id));
  const classifications: ClassifiedSkill[] = [];
  const operations: ReconcileOperation[] = [];

  for (const skill of desired.manifest.skills) {
    const local = actual.skills[skill.id];
    const lock = locksById.get(skill.id);

    if (skill.resolutionStatus === "PENDING_RESOLUTION") {
      classifications.push({
        skillId: skill.id,
        classification: "PENDING_RESOLUTION",
      });
      continue;
    }

    if (!lock) {
      throw validationError(`Resolved skill ${skill.id} has no lock entry.`);
    }

    if (!local || local.contentHash === null) {
      classifications.push({ skillId: skill.id, classification: "MISSING" });
      operations.push({ kind: "INSTALL", skill: lock });
      continue;
    }

    if (!local.managed) {
      classifications.push({ skillId: skill.id, classification: "UNMANAGED" });
      continue;
    }

    classifications.push({
      skillId: skill.id,
      classification:
        local.contentHash === lock.contentHash ? "MANAGED_SYNCED" : "DRIFTED",
    });
  }

  for (const [id, local] of Object.entries(actual.skills) as [
    SkillId,
    ActualSkillState,
  ][]) {
    if (!manifestIds.has(id)) {
      classifications.push({
        skillId: id,
        classification: local.managed ? "REMOVE_CANDIDATE" : "UNMANAGED",
      });
      if (local.managed) operations.push({ kind: "REMOVE", skillId: id });
    }
  }

  const compareSkillIds = (left: SkillId, right: SkillId) =>
    left < right ? -1 : left > right ? 1 : 0;
  const bySkillId = <T extends { skillId: SkillId }>(left: T, right: T) =>
    compareSkillIds(left.skillId, right.skillId);
  classifications.sort(bySkillId);
  operations.sort((left, right) => {
    const leftId = left.kind === "INSTALL" ? left.skill.id : left.skillId;
    const rightId = right.kind === "INSTALL" ? right.skill.id : right.skillId;
    return (
      compareSkillIds(leftId, rightId) ||
      (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0)
    );
  });

  return { classifications, operations };
}

export type TargetOutcome =
  | "SUCCESS"
  | "CONFLICT"
  | "AUTH_REQUIRED"
  | "DEVICE_ERROR";

export type ReconcileOutcome =
  | "SUCCESS"
  | "PARTIAL_SUCCESS"
  | "CONFLICT"
  | "AUTH_REQUIRED"
  | "DEVICE_ERROR";

/** Aggregates target results without discarding an all-target failure cause. */
export function aggregateTargetOutcomes(
  outcomes: readonly TargetOutcome[],
): ReconcileOutcome {
  if (
    outcomes.length === 0 ||
    outcomes.every((outcome) => outcome === "SUCCESS")
  ) {
    return "SUCCESS";
  }

  const unique = new Set(outcomes);
  if (unique.size === 1) {
    for (const outcome of unique) return outcome;
  }
  return "PARTIAL_SUCCESS";
}
