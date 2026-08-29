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

/** Portable contract implemented by Git and Cloud state providers. */
export interface StateProvider {
  pull(): Promise<Result<DesiredStateEnvelope>>;
  push(input: PushDesiredStateInput): Promise<Result<DesiredStateEnvelope>>;
}
