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
  | "ARTIFACT_UNAVAILABLE"
  | "AUTH_REQUIRED"
  | "CONFLICT"
  | "CONTENT_HASH_MISMATCH"
  | "DEVICE_ERROR"
  | "DRIFTED"
  | "INVALID_REVISION_ID"
  | "INVALID_SKILL_ID"
  | "LOCAL_CONFLICT"
  | "NETWORK_ERROR"
  | "SOURCE_UNAVAILABLE"
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

export type SourceMetadata = Readonly<{
  repository: string;
  path: string;
  ref: string;
}>;

export type SourceLock = SourceMetadata &
  Readonly<{ revision: string; contentHash: `sha256:${string}` }>;

export type ArtifactMetadata = Readonly<{
  kind: "git-tree" | "r2-tar-zst";
  contentHash: `sha256:${string}`;
  integrityHash: `sha256:${string}`;
  locator: string;
  sizeBytes: number;
}>;

export type V2ManifestSkill = Readonly<{
  id: SkillId;
  name: string;
  targets: AgentTargets;
  source?: SourceMetadata | null;
  resolutionStatus: ResolutionStatus;
}>;

export type V2LockedSkill = Readonly<{
  id: SkillId;
  name: string;
  source?: SourceLock;
  materialization:
    | Readonly<{ kind: "source"; contentHash: `sha256:${string}` }>
    | Readonly<{ kind: "artifact"; artifact: ArtifactMetadata }>;
}>;

export type V2DesiredState = Readonly<{
  manifest: Readonly<{ version: 2; skills: readonly V2ManifestSkill[] }>;
  lockfile: Readonly<{ version: 2; skills: readonly V2LockedSkill[] }>;
}>;

export type TombstoneDisposition = Readonly<{
  skillId: SkillId;
  name: string;
  disposition: "REMOVE" | "UNMANAGE";
  effectiveSequence: number;
}>;

export type DispositionLedger = Readonly<{
  version: 2;
  activeDispositions: Readonly<Record<SkillId, TombstoneDisposition>>;
}>;

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const immutableGitRevisionSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const segmentSchema = z.string().trim().min(1).refine(
  (value) => !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..",
  "A skill name must be one path segment.",
);
const sourceMetadataSchema = z.object({ repository: nonEmptyString, path: nonEmptyString, ref: nonEmptyString }).strict();
const artifactMetadataSchema = z.object({
  kind: z.enum(["git-tree", "r2-tar-zst"]),
  contentHash: sha256Schema,
  integrityHash: sha256Schema,
  locator: nonEmptyString,
  sizeBytes: z.number().int().nonnegative(),
}).strict();
const v2ManifestSchema = z.object({
  version: z.literal(2),
  skills: z.array(z.object({ id: nonEmptyString, name: segmentSchema, targets: targetsSchema, source: sourceMetadataSchema.nullable().optional(), resolutionStatus: z.enum(["PENDING_RESOLUTION", "RESOLVED"]).default("RESOLVED") }).strict()),
}).strict();
const v2LockfileSchema = z.object({
  version: z.literal(2),
  skills: z.array(z.object({
    id: nonEmptyString,
    name: segmentSchema,
    source: sourceMetadataSchema.extend({ revision: immutableGitRevisionSchema, contentHash: sha256Schema }).strict().optional(),
    materialization: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("source"), contentHash: sha256Schema }).strict(),
      z.object({ kind: z.literal("artifact"), artifact: artifactMetadataSchema }).strict(),
    ]),
  }).strict()),
}).strict();

function normalizedName(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase("en-US");
}

function v2ValidationError(message: string): never {
  throw validationError(message);
}

/** Validates v2 source/artifact desired state without filesystem or provider access. */
export function validateV2DesiredState(input: V2DesiredState): V2DesiredState {
  const manifestResult = v2ManifestSchema.safeParse(input.manifest);
  const lockResult = v2LockfileSchema.safeParse(input.lockfile);
  if (!manifestResult.success || !lockResult.success) v2ValidationError("Invalid Corotum v2 desired state.");
  const manifest = manifestResult.data;
  const lockfile = lockResult.data;
  const ids = new Set<string>();
  const names = new Set<string>();
  const manifests = manifest.skills.map((skill) => {
    const id = skillId(skill.id);
    if (ids.has(id)) v2ValidationError(`manifest contains duplicate skill ID ${id}.`);
    ids.add(id);
    const name = normalizedName(skill.name);
    if (names.has(name)) v2ValidationError(`manifest contains duplicate normalized name ${skill.name}.`);
    names.add(name);
    return { ...skill, id, targets: normalizeTargets(skill.targets) } as V2ManifestSkill;
  });
  const manifestById = new Map(manifests.map((skill) => [skill.id, skill]));
  const lockIds = new Set<string>();
  const locks = lockfile.skills.map((lock) => {
    const id = skillId(lock.id);
    if (lockIds.has(id)) v2ValidationError(`lockfile contains duplicate skill ID ${id}.`);
    lockIds.add(id);
    const skill = manifestById.get(id);
    if (!skill) v2ValidationError(`Lock entry ${id} has no manifest skill.`);
    if (skill.name !== lock.name) v2ValidationError(`Lock entry for ${id} does not match its manifest name.`);
    if (lock.materialization.kind === "source") {
      if (!lock.source || lock.source.contentHash !== lock.materialization.contentHash) {
        v2ValidationError(`Source materialization for ${id} must match its source hash.`);
      }
      if (
        !skill.source ||
        skill.source.repository !== lock.source.repository ||
        skill.source.path !== lock.source.path ||
        skill.source.ref !== lock.source.ref
      ) {
        v2ValidationError(`Source materialization for ${id} must match its manifest source.`);
      }
    }
    if (lock.materialization.kind === "artifact" && lock.source) {
      v2ValidationError(`Artifact materialization for ${id} must not include a source lock.`);
    }
    return { ...lock, id } as V2LockedSkill;
  });
  for (const skill of manifests) {
    if (!lockIds.has(skill.id) && skill.resolutionStatus !== "PENDING_RESOLUTION") v2ValidationError(`Resolved skill ${skill.id} has no lock entry.`);
    if (lockIds.has(skill.id) && skill.resolutionStatus === "PENDING_RESOLUTION") v2ValidationError(`Pending skill ${skill.id} must not have a lock entry.`);
  }
  return {
    manifest: { version: 2, skills: manifests.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) },
    lockfile: { version: 2, skills: locks.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) },
  };
}

/** Parses a Corotum v2 manifest. */
export function parseV2Manifest(source: string): V2DesiredState["manifest"] {
  try {
    const manifest = v2ManifestSchema.parse(parse(source, { maxAliasCount: 0 }));
    const ids = new Set<string>();
    const names = new Set<string>();
    const skills = manifest.skills.map((skill) => {
      const id = skillId(skill.id);
      if (ids.has(id)) v2ValidationError(`manifest contains duplicate skill ID ${id}.`);
      ids.add(id);
      const name = normalizedName(skill.name);
      if (names.has(name)) v2ValidationError(`manifest contains duplicate normalized name ${skill.name}.`);
      names.add(name);
      return { ...skill, id, targets: normalizeTargets(skill.targets) } as V2ManifestSkill;
    });
    return { version: 2, skills: skills.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
  } catch { throw validationError("Invalid corotum.yaml manifest."); }
}

/** Produces deterministic v2 manifest YAML. */
export function serializeV2Manifest(manifest: V2DesiredState["manifest"]): string {
  const parsed = parseV2Manifest(stringify(manifest));
  return stringify({ version: 2, skills: parsed.skills });
}

/** Parses and validates a v2 lockfile together with its manifest. */
export function parseV2Lockfile(source: string, manifest: V2DesiredState["manifest"]): V2DesiredState["lockfile"] {
  try {
    const lockfile = v2LockfileSchema.parse(JSON.parse(source)) as unknown as V2DesiredState["lockfile"];
    return validateV2DesiredState({ manifest, lockfile }).lockfile;
  }
  catch { throw validationError("Invalid corotum.lock lockfile."); }
}

/** Produces deterministic v2 lockfile JSON. */
export function serializeV2Lockfile(lockfile: V2DesiredState["lockfile"]): string {
  const parsed = v2LockfileSchema.parse(lockfile);
  const ids = new Set<string>();
  for (const skill of parsed.skills) {
    const id = skillId(skill.id);
    if (ids.has(id)) v2ValidationError(`lockfile contains duplicate skill ID ${id}.`);
    ids.add(id);
    if (
      skill.materialization.kind === "source" &&
      (!skill.source || skill.source.contentHash !== skill.materialization.contentHash)
    ) {
      v2ValidationError(`Source materialization for ${id} must match its source hash.`);
    }
    if (skill.materialization.kind === "artifact" && skill.source) {
      v2ValidationError(`Artifact materialization for ${id} must not include a source lock.`);
    }
  }
  return `${JSON.stringify({ version: 2, skills: [...parsed.skills].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) }, null, 2)}\n`;
}

const dispositionLedgerSchema = z
  .object({
    version: z.literal(2),
    activeDispositions: z.record(
      nonEmptyString,
      z
        .object({
          skillId: nonEmptyString,
          name: segmentSchema,
          disposition: z.enum(["REMOVE", "UNMANAGE"]),
          effectiveSequence: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

function normalizeDispositionLedger(input: unknown): DispositionLedger {
  const parsed = dispositionLedgerSchema.safeParse(input);
  if (!parsed.success) v2ValidationError("Invalid disposition ledger.");

  const entries = Object.entries(parsed.data.activeDispositions)
    .map(([id, disposition]) => {
      const skillIdValue = skillId(id);
      if (skillIdValue !== disposition.skillId) {
        v2ValidationError("Invalid disposition ledger.");
      }
      return [skillIdValue, { ...disposition, skillId: skillIdValue }] as const;
    })
    .sort(([left], [right]) => left.localeCompare(right));

  return {
    version: 2,
    activeDispositions: Object.fromEntries(entries) as DispositionLedger["activeDispositions"],
  };
}

export function serializeDispositionLedger(ledger: DispositionLedger): string {
  const normalized = normalizeDispositionLedger(ledger);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function parseDispositionLedger(source: string): DispositionLedger {
  try {
    return normalizeDispositionLedger(JSON.parse(source));
  } catch {
    throw validationError("Invalid disposition ledger.");
  }
}

export type ActualState = Readonly<{
  skills: Readonly<Record<SkillId, ActualSkillState>>;
}>;

export type ActualTargetState = Readonly<{
  agentId: string;
  path: string;
  /** Null means a recorded managed target is absent. */
  contentHash: string | null;
  /** The hash recorded when this owned target was last verified. */
  expectedContentHash?: string;
  /** True only when durable local state proves Corotum owns this path. */
  managed: boolean;
}>;

export type ActualSkillState = Readonly<{
  contentHash: string | null;
  /** The hash recorded when this owned canonical copy was last verified. */
  expectedContentHash?: string;
  managed: boolean;
  /**
   * Optional to preserve the v1 ID/hash contract. v2 callers include every
   * observed target whose recorded ownership or name collision matters.
   */
  targets?: readonly ActualTargetState[];
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
  | "LOCAL_CONFLICT"
  | "UNMANAGED"
  | "MISSING"
  | "DRIFTED"
  | "REMOVE_CANDIDATE"
  | "UNMANAGE_CANDIDATE"
  | "PENDING_RESOLUTION";

export type ClassifiedSkill = Readonly<{
  skillId: SkillId;
  classification: ActualStateClassification;
  /** Present when the classification applies to one agent exposure. */
  target?: Readonly<{ agentId: string; path: string }>;
}>;

export type ReconcileOperation =
  | Readonly<{ kind: "INSTALL"; skill: LockedSkill }>
  | Readonly<{ kind: "REMOVE"; skillId: SkillId }>
  | Readonly<{ kind: "UNMANAGE"; skillId: SkillId }>;

export type ReconcilePlan = Readonly<{
  classifications: readonly ClassifiedSkill[];
  operations: readonly ReconcileOperation[];
}>;

/**
 * Classifies desired and local state without touching a filesystem. An actual
 * unowned skill and a modified owned skill intentionally produce no ordinary
 * sync operation: both require an explicit user decision or restore flow.
 * When an offline revision history is supplied, UNMANAGE transitions preserve
 * owned local content instead of scheduling its deletion.
 */
export function planReconcile(
  desired: DesiredState,
  actual: ActualState,
  transitions: readonly RevisionTransition[] = [],
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
      const disposition = offlineSkillDisposition(desired, transitions, id);
      const shouldUnmanage = local.managed && disposition === "UNMANAGE";

      classifications.push({
        skillId: id,
        classification: !local.managed
          ? "UNMANAGED"
          : shouldUnmanage
            ? "UNMANAGE_CANDIDATE"
            : "REMOVE_CANDIDATE",
      });
      if (local.managed) {
        operations.push({
          kind: shouldUnmanage ? "UNMANAGE" : "REMOVE",
          skillId: id,
        });
      }
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

/**
 * v2-only safe reconcile planning. The durable ledger, rather than a bounded
 * transition list, is authoritative for an absent locally-owned skill.
 */
export type V2ReconcileOperation =
  | Readonly<{ kind: "INSTALL"; skill: V2LockedSkill }>
  | Readonly<{ kind: "REMOVE" | "UNMANAGE"; skillId: SkillId }>
  /** Recreate a missing path only when durable state proves prior ownership. */
  | Readonly<{
      kind: "REPAIR_TARGET";
      skill: V2LockedSkill;
      target: Readonly<{ agentId: string; path: string }>;
    }>;

export type V2ReconcilePlan = Readonly<{
  classifications: readonly ClassifiedSkill[];
  operations: readonly V2ReconcileOperation[];
}>;

/**
 * Plans a v2 local apply without guessing ownership. An unowned exact copy is
 * the sole re-add case that may be claimed; every collision or changed copy is
 * a no-op conflict. Absent desired entries need an explicit ledger tombstone.
 */
export function planV2Reconcile(
  desiredInput: V2DesiredState,
  actual: ActualState,
  ledgerInput: DispositionLedger,
): V2ReconcilePlan {
  const desired = validateV2DesiredState(desiredInput);
  const ledger = normalizeDispositionLedger(ledgerInput);
  const locks = new Map(desired.lockfile.skills.map((skill) => [skill.id, skill]));
  const active = new Set(desired.manifest.skills.map((skill) => skill.id));
  const classifications: ClassifiedSkill[] = [];
  const operations: V2ReconcileOperation[] = [];

  for (const skill of desired.manifest.skills) {
    const local = actual.skills[skill.id];
    if (skill.resolutionStatus === "PENDING_RESOLUTION") {
      classifications.push({ skillId: skill.id, classification: "PENDING_RESOLUTION" });
      continue;
    }
    const lock = locks.get(skill.id);
    if (!lock) throw validationError(`Resolved skill ${skill.id} has no lock entry.`);
    const expectedHash = lock.materialization.kind === "source"
      ? lock.materialization.contentHash
      : lock.materialization.artifact.contentHash;
    let install = false;
    if (!local || local.contentHash === null) {
      classifications.push({ skillId: skill.id, classification: "MISSING" });
      install = true;
    } else if (local.managed && local.contentHash === expectedHash) {
      classifications.push({ skillId: skill.id, classification: "MANAGED_SYNCED" });
    } else if (!local.managed && local.contentHash === expectedHash) {
      classifications.push({ skillId: skill.id, classification: "UNMANAGED" });
      install = true;
    } else {
      classifications.push({ skillId: skill.id, classification: local.managed ? "DRIFTED" : "LOCAL_CONFLICT" });
    }

    // A target collision blocks even a canonical install: otherwise an executor
    // would discover the conflict too late, after replacing local content.
    let targetConflict = false;
    const repairs: V2ReconcileOperation[] = [];
    for (const target of [...(local?.targets ?? [])].sort((left, right) =>
      `${left.agentId}\0${left.path}`.localeCompare(`${right.agentId}\0${right.path}`),
    )) {
      const targetRef = { agentId: target.agentId, path: target.path };
      if (!target.managed) {
        targetConflict = true;
        classifications.push({ skillId: skill.id, classification: "LOCAL_CONFLICT", target: targetRef });
      } else if (target.contentHash === null) {
        classifications.push({ skillId: skill.id, classification: "MISSING", target: targetRef });
        if (local?.managed && local.contentHash === expectedHash) {
          repairs.push({ kind: "REPAIR_TARGET", skill: lock, target: targetRef });
        }
      } else if (target.contentHash !== expectedHash) {
        targetConflict = true;
        classifications.push({ skillId: skill.id, classification: "DRIFTED", target: targetRef });
      }
    }
    if (!targetConflict) {
      operations.push(...repairs);
      if (install) operations.push({ kind: "INSTALL", skill: lock });
    }
  }

  for (const [id, local] of Object.entries(actual.skills) as [SkillId, ActualSkillState][]) {
    if (active.has(id)) continue;
    if (!local.managed) {
      classifications.push({ skillId: id, classification: "UNMANAGED" });
      continue;
    }
    const disposition = ledger.activeDispositions[id]?.disposition;
    if (!disposition) {
      classifications.push({ skillId: id, classification: "LOCAL_CONFLICT" });
      continue;
    }
    // A tombstone never grants permission to alter a name collision or drift.
    // Missing targets are harmless: they are already absent.  Expected hashes
    // come from durable state, so a changed canonical or copy cannot be acted
    // on merely because an older revision recorded ownership.
    const expectedCanonicalHash = local.expectedContentHash;
    if (
      local.contentHash !== null &&
      expectedCanonicalHash !== undefined &&
      local.contentHash !== expectedCanonicalHash
    ) {
      classifications.push({ skillId: id, classification: "DRIFTED" });
      continue;
    }
    const unsafeTarget = (local.targets ?? []).find(
      (target) =>
        !target.managed ||
        (target.contentHash !== null &&
          target.expectedContentHash !== undefined &&
          target.contentHash !== target.expectedContentHash) ||
        (target.contentHash !== null &&
          target.expectedContentHash === undefined &&
          local.contentHash !== null &&
          target.contentHash !== local.contentHash),
    );
    if (unsafeTarget) {
      classifications.push({
        skillId: id,
        classification: unsafeTarget.managed ? "DRIFTED" : "LOCAL_CONFLICT",
        target: { agentId: unsafeTarget.agentId, path: unsafeTarget.path },
      });
      continue;
    }
    classifications.push({ skillId: id, classification: disposition === "REMOVE" ? "REMOVE_CANDIDATE" : "UNMANAGE_CANDIDATE" });
    operations.push({ kind: disposition, skillId: id });
  }

  const idOf = (operation: V2ReconcileOperation) =>
    operation.kind === "INSTALL" || operation.kind === "REPAIR_TARGET"
      ? operation.skill.id
      : operation.skillId;
  const targetKey = (target: { agentId: string; path: string } | undefined) =>
    target ? `${target.agentId}\0${target.path}` : "";
  classifications.sort((a, b) =>
    a.skillId.localeCompare(b.skillId) || targetKey(a.target).localeCompare(targetKey(b.target)),
  );
  operations.sort((a, b) =>
    idOf(a).localeCompare(idOf(b)) ||
    a.kind.localeCompare(b.kind) ||
    targetKey(a.kind === "REPAIR_TARGET" ? a.target : undefined).localeCompare(
      targetKey(b.kind === "REPAIR_TARGET" ? b.target : undefined),
    ),
  );
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
