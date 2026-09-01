import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import { builtInAgentAdapters } from "../../../packages/agent-targets/src/index";
import {
  parseDispositionLedger,
  parseLockfile,
  parseManifest,
  parseRevisionTransition,
  parseV2Lockfile,
  parseV2Manifest,
  serializeDispositionLedger,
  serializeV2Lockfile,
  serializeV2Manifest,
  skillId,
  validateV2DesiredState,
  type SkillId,
  type V2DesiredState,
} from "../../../packages/core/src/index";
import { hashSkillDirectory } from "../../../packages/skills-adapter/src/canonical-store";
import { defaultConfig, type CorotumConfig } from "./config";
import type { LocalOperationalState, LocalTargetState } from "./local-state";
import type { CorotumPaths } from "./platform";

export const LEGACY_MIGRATION_MARKER = "legacy-migration.json";

export class LegacyMigrationError extends Error {
  readonly name = "LegacyMigrationError";
  constructor(
    message: string,
    readonly code: "LOCAL_CONFLICT" | "VALIDATION_ERROR" = "VALIDATION_ERROR",
  ) {
    super(message);
  }
}

export type LegacyConflict = Readonly<{
  path: string;
  code: "LOCAL_CONFLICT";
  message: string;
}>;

export type LegacyStagedSkill = Readonly<{
  skillId: SkillId;
  name: string;
  from: string;
  to: string;
  contentHash: string;
  targets: readonly LocalTargetState[];
}>;

export type LegacyCopiedFile = Readonly<{ from: string; to: string }>;

export type LegacyMigrationMarker = Readonly<{
  schemaVersion: 1;
  status: "copied" | "state-updated" | "cleaned";
  legacy: Readonly<{
    configDir: string;
    dataDir: string;
    stateDir: string;
    skillsDir: string;
    gitDir: string;
  }>;
  current: Readonly<{
    configDir: string;
    dataDir: string;
    stateDir: string;
    skillsDir: string;
    gitDir: string;
  }>;
  backups: readonly string[];
  skills: readonly LegacyStagedSkill[];
  files: readonly LegacyCopiedFile[];
  conflicts: readonly LegacyConflict[];
}>;

export type LegacyDiscovery = Readonly<{
  roots: readonly string[];
  files: readonly string[];
  skillDirs: readonly string[];
}>;

export type LegacyMigrationResult = Readonly<{
  marker: LegacyMigrationMarker;
  conflicts: readonly LegacyConflict[];
}>;

export type LegacyMigrationHooks = Readonly<{
  copyDirectory?: (source: string, destination: string) => Promise<void>;
  afterCopy?: () => Promise<void>;
  afterState?: () => Promise<void>;
}>;

type DesiredLock = Readonly<{
  id: SkillId;
  name: string;
  contentHash: string;
}>;

/** Copies ToolMirror roots into Corotum names without deleting the source. */
export class LegacyMigrator {
  constructor(private readonly hooks: LegacyMigrationHooks = {}) {}

  async discover(input: {
    current: CorotumPaths;
    legacy: CorotumPaths;
  }): Promise<LegacyDiscovery> {
    const roots = unique(
      (
        await Promise.all(
          [
            input.legacy.configDir,
            input.legacy.dataDir,
            input.legacy.stateDir,
            input.legacy.skillsDir,
            join(input.legacy.dataDir, "skills"),
            join(input.current.dataDir, "skills"),
          ].map(async (path) => ((await exists(path)) ? path : null)),
        )
      ).filter((path): path is string => path !== null),
    );
    const skillDirs: string[] = [];
    for (const root of unique([
      input.legacy.skillsDir,
      join(input.legacy.dataDir, "skills"),
      join(input.current.dataDir, "skills"),
      await skillsStoragePath(input.legacy.configFile),
    ])) {
      skillDirs.push(...(await listSkillIdDirs(root)));
    }
    const files: string[] = [];
    for (const gitDir of unique([input.legacy.gitDir, input.current.gitDir])) {
      files.push(...(await listLegacyGitFiles(gitDir)));
    }
    for (const file of [
      input.legacy.configFile,
      input.legacy.credentialsFile,
      join(input.legacy.stateDir, "state.json"),
    ]) {
      if (await exists(file)) files.push(file);
    }
    return { roots, files: unique(files), skillDirs: unique(skillDirs) };
  }

  async migrate(input: {
    homeDir: string;
    current: CorotumPaths;
    legacy: CorotumPaths;
  }): Promise<LegacyMigrationResult> {
    const markerPath = join(input.current.stateDir, LEGACY_MIGRATION_MARKER);
    const existing = await readMarker(markerPath);
    if (existing?.status === "state-updated" || existing?.status === "cleaned") {
      return { marker: existing, conflicts: existing.conflicts };
    }

    const discovery = await this.discover(input);
    const locks = await loadDesiredLocks(unique([input.legacy.gitDir, input.current.gitDir]));
    const previousState = await readState(join(input.legacy.stateDir, "state.json"));
    const conflicts: LegacyConflict[] = [];
    const staged: LegacyStagedSkill[] = existing?.status === "copied" ? [...existing.skills] : [];
    const files: LegacyCopiedFile[] = existing?.status === "copied" ? [...existing.files] : [];
    const backups = new Set<string>(existing?.backups ?? []);

    const byId = new Map(staged.map((skill) => [skill.skillId, skill]));
    const claimedNames = new Map(staged.map((skill) => [normalizeName(skill.name), skill]));

    for (const directory of discovery.skillDirs) {
      const id = basename(directory);
      const lock = locks.find((candidate) => candidate.id === id);
      if (!lock) {
        conflicts.push({
          path: directory,
          code: "LOCAL_CONFLICT",
          message: "Unmanaged or unlocked legacy skill directory was left untouched.",
        });
        continue;
      }
      let hash: string;
      try {
        hash = await hashSkillDirectory(directory);
      } catch {
        conflicts.push({
          path: directory,
          code: "LOCAL_CONFLICT",
          message: "Legacy skill directory is not valid canonical content.",
        });
        continue;
      }
      if (hash !== lock.contentHash) {
        conflicts.push({
          path: directory,
          code: "LOCAL_CONFLICT",
          message: "Legacy skill hash does not match the locked desired state.",
        });
        continue;
      }
      const destination = join(input.current.skillsDir, lock.name);
      const prior = claimedNames.get(normalizeName(lock.name));
      if (prior && prior.from !== directory) {
        conflicts.push({
          path: directory,
          code: "LOCAL_CONFLICT",
          message: "Multiple legacy skill directories map to the same desired name.",
        });
        continue;
      }
      if (await exists(destination)) {
        try {
          if ((await hashSkillDirectory(destination)) !== hash) {
            conflicts.push({
              path: destination,
              code: "LOCAL_CONFLICT",
              message: "Named canonical destination already exists with different content.",
            });
            continue;
          }
        } catch {
          conflicts.push({
            path: destination,
            code: "LOCAL_CONFLICT",
            message: "Named canonical destination is ambiguous.",
          });
          continue;
        }
      } else {
        await this.stageDirectory(directory, destination);
        if ((await hashSkillDirectory(destination)) !== hash) {
          await rm(destination, { force: true, recursive: true });
          throw new LegacyMigrationError("Staged named skill does not match its locked hash.");
        }
      }
      const targets = await retarget(
        input.homeDir,
        directory,
        destination,
        lock.name,
        hash,
        previousState?.skills[lock.id]?.targets ?? {},
      );
      for (const conflict of targets.conflicts) conflicts.push(conflict);
      const skill: LegacyStagedSkill = {
        skillId: lock.id,
        name: lock.name,
        from: directory,
        to: destination,
        contentHash: hash,
        targets: targets.targets,
      };
      byId.set(lock.id, skill);
      claimedNames.set(normalizeName(lock.name), skill);
      backups.add(directory);
    }

    const copiedSkills = [...byId.values()];
    const platformCopies = await this.copyPlatformTrees(input, backups, files);
    conflicts.push(...platformCopies.conflicts);

    const copiedMarker: LegacyMigrationMarker = {
      schemaVersion: 1,
      status: "copied",
      legacy: rootsOf(input.legacy),
      current: rootsOf(input.current),
      backups: [...backups].sort(),
      skills: copiedSkills,
      files,
      conflicts,
    };
    await writeMarker(markerPath, copiedMarker);
    await this.hooks.afterCopy?.();

    await this.writeCurrentState(input, copiedSkills, previousState);
    await this.hooks.afterState?.();

    const marker: LegacyMigrationMarker = { ...copiedMarker, status: "state-updated" };
    await writeMarker(markerPath, marker);
    return { marker, conflicts };
  }

  async cleanup(input: { current: CorotumPaths }): Promise<LegacyMigrationMarker> {
    const markerPath = join(input.current.stateDir, LEGACY_MIGRATION_MARKER);
    const extras = await extraMarkers(input.current.stateDir, markerPath);
    if (extras.length > 0) {
      throw new LegacyMigrationError(
        "Legacy cleanup refused: recovery evidence is ambiguous.",
        "LOCAL_CONFLICT",
      );
    }
    const marker = await readMarker(markerPath);
    if (!marker) {
      throw new LegacyMigrationError(
        "Legacy cleanup refused: migration recovery evidence is missing.",
        "LOCAL_CONFLICT",
      );
    }
    if (marker.status === "copied") {
      throw new LegacyMigrationError(
        "Legacy cleanup refused: v2 state has not been updated.",
        "LOCAL_CONFLICT",
      );
    }
    if (marker.status === "cleaned") {
      await this.deleteBackups(marker.backups);
      return marker;
    }
    await this.verifyMigrated(marker);
    await this.deleteBackups(marker.backups);
    const cleaned: LegacyMigrationMarker = { ...marker, status: "cleaned" };
    await writeMarker(markerPath, cleaned);
    return cleaned;
  }

  private async stageDirectory(source: string, destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    const staging = `${destination}.${crypto.randomUUID()}.staging`;
    try {
      await this.copy(source, staging);
      await rename(staging, destination);
    } finally {
      await rm(staging, { force: true, recursive: true });
    }
  }

  private async copyPlatformTrees(
    input: { current: CorotumPaths; legacy: CorotumPaths },
    backups: Set<string>,
    files: LegacyCopiedFile[],
  ): Promise<{ conflicts: LegacyConflict[] }> {
    const conflicts: LegacyConflict[] = [];
    const pairs: Array<readonly [string, string]> = [
      [input.legacy.configFile, input.current.configFile],
      [input.legacy.credentialsFile, input.current.credentialsFile],
      [join(input.legacy.stateDir, "state.json"), join(input.current.stateDir, "state.json")],
    ];
    for (const [from, to] of pairs) {
      if (!(await exists(from)) || from === to) continue;
      await copyFileAtomic(from, to);
      files.push({ from, to });
      backups.add(from);
    }
    const gitDirs = unique(
      input.legacy.gitDir !== input.current.gitDir && (await exists(input.legacy.gitDir))
        ? [input.current.gitDir]
        : [input.legacy.gitDir, input.current.gitDir],
    );
    if (input.legacy.gitDir !== input.current.gitDir && (await exists(input.legacy.gitDir))) {
      await mkdir(input.current.gitDir, { recursive: true });
      for (const cache of await listDirectories(input.legacy.gitDir)) {
        const destination = join(input.current.gitDir, basename(cache));
        if (!(await exists(destination))) await this.stageDirectory(cache, destination);
        backups.add(cache);
        for (const name of ["toolmirror.yaml", "toolmirror.lock", "toolmirror.transition.json"]) {
          const file = join(cache, name);
          if (await exists(file)) backups.add(file);
        }
      }
    }
    for (const gitDir of gitDirs) {
      for (const cache of await listDirectories(gitDir)) {
        const imported = await importGitFiles(cache);
        conflicts.push(...imported.conflicts);
        files.push(...imported.files);
        for (const file of imported.files) {
          if (file.from === input.legacy.gitDir || file.from.startsWith(`${input.legacy.gitDir}${sep}`)) backups.add(file.from);
        }
      }
    }
    return { conflicts };
  }

  private async writeCurrentState(
    input: { current: CorotumPaths; legacy: CorotumPaths },
    skills: readonly LegacyStagedSkill[],
    previousState: LocalOperationalState | null,
  ): Promise<void> {
    const config = await readConfig(input.current.configFile);
    const nextConfig: CorotumConfig = {
      ...config,
      skillsStoragePath:
        !config.skillsStoragePath ||
        config.skillsStoragePath === input.legacy.skillsDir ||
        config.skillsStoragePath === join(input.legacy.dataDir, "skills") ||
        config.skillsStoragePath === join(input.current.dataDir, "skills")
          ? input.current.skillsDir
          : config.skillsStoragePath,
    };
    await writeJson(input.current.configFile, nextConfig);
    const record: LocalOperationalState = {
      schemaVersion: 2,
      lastAppliedRevision: previousState?.lastAppliedRevision ?? null,
      skills: {
        ...(previousState?.skills ?? {}),
        ...Object.fromEntries(
          skills.map((skill) => [
            skill.skillId,
            {
              name: skill.name,
              canonicalPath: skill.to,
              contentHash: skill.contentHash,
              ownership: "verified" as const,
              targets: Object.fromEntries(
                skill.targets.map((target) => [`${target.agentId}\0${target.path}`, target]),
              ),
            },
          ]),
        ),
      } as LocalOperationalState["skills"],
    };
    await writeJson(join(input.current.stateDir, "state.json"), record);
  }

  private async verifyMigrated(marker: LegacyMigrationMarker): Promise<void> {
    if (!(await exists(join(marker.current.stateDir, "state.json")))) {
      throw new LegacyMigrationError(
        "Legacy cleanup refused: v2 state is missing.",
        "LOCAL_CONFLICT",
      );
    }
    for (const skill of marker.skills) {
      if (!(await exists(skill.to)) || (await hashSkillDirectory(skill.to)) !== skill.contentHash) {
        throw new LegacyMigrationError(
          `Legacy cleanup refused: named canonical hash for ${skill.name} does not match.`,
          "LOCAL_CONFLICT",
        );
      }
      for (const target of skill.targets) {
        if (!(await targetMatches(target, skill.to))) {
          throw new LegacyMigrationError(
            `Legacy cleanup refused: recorded target ${target.path} is not verified.`,
            "LOCAL_CONFLICT",
          );
        }
      }
    }
  }

  private async deleteBackups(backups: readonly string[]): Promise<void> {
    for (const path of [...backups].sort((left, right) => right.length - left.length)) {
      await rm(path, { force: true, recursive: true });
    }
  }

  private async copy(source: string, destination: string): Promise<void> {
    const copy = this.hooks.copyDirectory;
    if (copy) {
      await copy(source, destination);
      return;
    }
    await cp(source, destination, { errorOnExist: true, recursive: true });
  }
}

async function importGitFiles(
  cache: string,
): Promise<{ files: LegacyCopiedFile[]; conflicts: LegacyConflict[] }> {
  const files: LegacyCopiedFile[] = [];
  const conflicts: LegacyConflict[] = [];
  const v1Manifest = join(cache, "toolmirror.yaml");
  const v1Lock = join(cache, "toolmirror.lock");
  const v1Transition = join(cache, "toolmirror.transition.json");
  const v2Manifest = join(cache, "corotum.yaml");
  const v2Lock = join(cache, "corotum.lock");
  const v2Transitions = join(cache, "corotum.transitions.json");

  const converted = await convertGitSnapshot(v1Manifest, v1Lock, v2Manifest, v2Lock);
  if (converted.kind === "conflict") {
    conflicts.push(converted.conflict);
  } else if (converted.kind === "written") {
    files.push(...converted.files);
  }

  if ((await exists(v1Transition)) && !(await exists(v2Transitions))) {
    const ledger = await ledgerFromTransition(v1Transition, converted.kind === "written" ? converted.state : null);
    if (ledger) {
      await writeText(v2Transitions, serializeDispositionLedger(ledger));
      files.push({ from: v1Transition, to: v2Transitions });
    } else if (!(await exists(v2Transitions))) {
      conflicts.push({
        path: v1Transition,
        code: "LOCAL_CONFLICT",
        message: "Current transition file is not a valid recoverable v2 ledger.",
      });
    }
  }
  return { files, conflicts };
}

async function convertGitSnapshot(
  v1Manifest: string,
  v1Lock: string,
  v2Manifest: string,
  v2Lock: string,
): Promise<
  | { kind: "none" }
  | { kind: "written"; files: LegacyCopiedFile[]; state: V2DesiredState }
  | { kind: "conflict"; conflict: LegacyConflict }
> {
  if (await exists(v2Manifest) && (await exists(v2Lock))) return { kind: "none" };
  if (await exists(v2Manifest) && (await exists(v1Lock)) && !(await exists(v2Lock))) {
    try {
      const manifest = parseV2Manifest(await readFile(v2Manifest, "utf8"));
      const lockfile = parseV2Lockfile(await readFile(v1Lock, "utf8"), manifest);
      const state = validateV2DesiredState({ manifest, lockfile });
      await writeText(v2Lock, serializeV2Lockfile(state.lockfile));
      return { kind: "written", files: [{ from: v1Lock, to: v2Lock }], state };
    } catch {
      return {
        kind: "conflict",
        conflict: {
          path: v1Lock,
          code: "LOCAL_CONFLICT",
          message: "Existing v2 lock could not be imported as corotum.lock.",
        },
      };
    }
  }
  if (!(await exists(v1Manifest)) && !(await exists(v1Lock))) return { kind: "none" };
  try {
    const state = v1ToV2(
      parseManifest(await readFile(v1Manifest, "utf8")),
      parseLockfile(await readFile(v1Lock, "utf8")),
    );
    await writeText(v2Manifest, serializeV2Manifest(state.manifest));
    await writeText(v2Lock, serializeV2Lockfile(state.lockfile));
    return {
      kind: "written",
      files: [
        { from: v1Manifest, to: v2Manifest },
        { from: v1Lock, to: v2Lock },
      ],
      state,
    };
  } catch {
    return {
      kind: "conflict",
      conflict: {
        path: v1Lock,
        code: "LOCAL_CONFLICT",
        message: "Legacy toolmirror.* desired state is not a valid v2 import.",
      },
    };
  }
}

function v1ToV2(
  manifest: ReturnType<typeof parseManifest>,
  lockfile: ReturnType<typeof parseLockfile>,
): V2DesiredState {
  const locks = new Map(lockfile.skills.map((skill) => [skill.id, skill]));
  return validateV2DesiredState({
    manifest: {
      version: 2,
      skills: manifest.skills.map((skill) => {
        const lock = locks.get(skill.id);
        return {
          id: skill.id,
          name: skill.skill,
          targets: skill.targets,
          source: lock
            ? { repository: lock.repository, path: lock.path, ref: skill.ref }
            : { repository: skill.source, path: skill.skill, ref: skill.ref },
          resolutionStatus: skill.resolutionStatus,
        };
      }),
    },
    lockfile: {
      version: 2,
      skills: lockfile.skills.map((lock) => {
        const contentHash = lock.contentHash as `sha256:${string}`;
        return {
          id: lock.id,
          name: lock.skill,
          source: {
            repository: lock.repository,
            path: lock.path,
            ref: lock.ref,
            revision: lock.revision,
            contentHash,
          },
          materialization: { kind: "source", contentHash },
        };
      }),
    },
  });
}

async function ledgerFromTransition(
  path: string,
  state: V2DesiredState | null,
): Promise<ReturnType<typeof parseDispositionLedger> | null> {
  try {
    const transition = parseRevisionTransition(await readFile(path, "utf8"));
    if (transition.type !== "REMOVE" && transition.type !== "UNMANAGE") {
      return { version: 2, activeDispositions: {} };
    }
    const name =
      state?.manifest.skills.find((skill) => skill.id === transition.skillId)?.name ??
      transition.metadata.name ??
      transition.skillId;
    return {
      version: 2,
      activeDispositions: {
        [transition.skillId]: {
          skillId: transition.skillId,
          name,
          disposition: transition.type,
          effectiveSequence: 1,
        },
      },
    };
  } catch {
    return null;
  }
}

async function loadDesiredLocks(gitDirs: readonly string[]): Promise<DesiredLock[]> {
  const locks: DesiredLock[] = [];
  const seen = new Set<string>();
  for (const gitDir of gitDirs) {
    for (const cache of await listDirectories(gitDir)) {
      for (const lock of await locksFromCache(cache)) {
        if (seen.has(lock.id)) continue;
        seen.add(lock.id);
        locks.push(lock);
      }
    }
  }
  return locks;
}

async function locksFromCache(cache: string): Promise<DesiredLock[]> {
  const v2Manifest = join(cache, "corotum.yaml");
  const v2Lock = join(cache, "corotum.lock");
  const v1Lock = join(cache, "toolmirror.lock");
  const v1Manifest = join(cache, "toolmirror.yaml");
  try {
    if (await exists(v2Manifest)) {
      const manifest = parseV2Manifest(await readFile(v2Manifest, "utf8"));
      const lockSource = (await exists(v2Lock)) ? v2Lock : v1Lock;
      const lockfile = parseV2Lockfile(await readFile(lockSource, "utf8"), manifest);
      return lockfile.skills.map((lock) => ({
        id: lock.id,
        name: lock.name,
        contentHash:
          lock.materialization.kind === "source"
            ? lock.materialization.contentHash
            : lock.materialization.artifact.contentHash,
      }));
    }
    if ((await exists(v1Manifest)) && (await exists(v1Lock))) {
      const lockfile = parseLockfile(await readFile(v1Lock, "utf8"));
      return lockfile.skills.map((lock) => ({
        id: lock.id,
        name: lock.skill,
        contentHash: lock.contentHash,
      }));
    }
  } catch {
    return [];
  }
  return [];
}

async function retarget(
  homeDir: string,
  oldCanonical: string,
  newCanonical: string,
  name: string,
  expectedHash: string,
  recorded: Readonly<Record<string, LocalTargetState>>,
): Promise<{ targets: LocalTargetState[]; conflicts: LegacyConflict[] }> {
  const targets: LocalTargetState[] = [];
  const conflicts: LegacyConflict[] = [];
  const candidates = new Map<string, { agentId: LocalTargetState["agentId"]; path: string }>();
  for (const target of Object.values(recorded)) {
    candidates.set(target.path, { agentId: target.agentId, path: target.path });
  }
  for (const adapter of builtInAgentAdapters) {
    for (const parent of adapter.globalSkillPaths(homeDir)) {
      for (const path of [join(parent, name), join(parent, basename(oldCanonical))]) {
        candidates.set(path, { agentId: adapter.id, path });
      }
    }
  }
  for (const candidate of candidates.values()) {
    if (!(await exists(candidate.path))) continue;
    const result = await retargetOne(candidate.path, oldCanonical, newCanonical, expectedHash);
    if (result.kind === "conflict") {
      conflicts.push({
        path: candidate.path,
        code: "LOCAL_CONFLICT",
        message: result.message,
      });
      continue;
    }
    targets.push({
      agentId: candidate.agentId,
      mode: result.mode,
      path: candidate.path,
      expectedHash,
    });
  }
  return { targets, conflicts };
}

async function retargetOne(
  path: string,
  oldCanonical: string,
  newCanonical: string,
  expectedHash: string,
): Promise<
  | { kind: "ok"; mode: "symlink" | "copy" }
  | { kind: "conflict"; message: string }
> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      const current = await realpath(path).catch(async () => readlink(path));
      const oldReal = await realpath(oldCanonical).catch(() => oldCanonical);
      const newReal = await realpath(newCanonical).catch(() => newCanonical);
      if (current !== oldReal && current !== newReal) {
        return { kind: "conflict", message: "Symlink target is not the migrated canonical skill." };
      }
      if (current !== newReal) {
        const staging = `${path}.${crypto.randomUUID()}.staging`;
        await symlink(newCanonical, staging, "dir");
        await rename(staging, path);
      }
      return { kind: "ok", mode: "symlink" };
    }
    if ((await hashSkillDirectory(path)) !== expectedHash) {
      return { kind: "conflict", message: "Copy-fallback target does not match the locked hash." };
    }
    return { kind: "ok", mode: "copy" };
  } catch {
    return { kind: "conflict", message: "Agent target is ambiguous and was left untouched." };
  }
}

async function targetMatches(target: LocalTargetState, canonical: string): Promise<boolean> {
  try {
    if (target.mode === "symlink") {
      return (await realpath(target.path)) === (await realpath(canonical));
    }
    return (await hashSkillDirectory(target.path)) === target.expectedHash;
  } catch {
    return false;
  }
}

async function listSkillIdDirs(root: string | null): Promise<string[]> {
  if (!root || !(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      skillId(entry.name);
    } catch {
      continue;
    }
    dirs.push(join(root, entry.name));
  }
  return dirs;
}

async function listLegacyGitFiles(gitDir: string): Promise<string[]> {
  const files: string[] = [];
  for (const cache of await listDirectories(gitDir)) {
    for (const name of ["toolmirror.yaml", "toolmirror.lock", "toolmirror.transition.json"]) {
      const file = join(cache, name);
      if (await exists(file)) files.push(file);
    }
  }
  return files;
}

async function listDirectories(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

async function skillsStoragePath(configFile: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(configFile, "utf8")) as { skillsStoragePath?: string | null };
    return parsed.skillsStoragePath ?? null;
  } catch {
    return null;
  }
}

async function readConfig(file: string): Promise<CorotumConfig> {
  try {
    return { ...defaultConfig(), ...(JSON.parse(await readFile(file, "utf8")) as CorotumConfig) };
  } catch {
    return defaultConfig();
  }
}

async function readState(file: string): Promise<LocalOperationalState | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as LocalOperationalState;
  } catch {
    return null;
  }
}

async function readMarker(path: string): Promise<LegacyMigrationMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as LegacyMigrationMarker;
    if (parsed.schemaVersion !== 1 || !parsed.status || !parsed.current || !parsed.legacy) return null;
    return parsed;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new LegacyMigrationError(
      "Legacy cleanup refused: migration recovery evidence is corrupt.",
      "LOCAL_CONFLICT",
    );
  }
}

async function extraMarkers(stateDir: string, markerPath: string): Promise<string[]> {
  if (!(await exists(stateDir))) return [];
  const prefix = `${LEGACY_MIGRATION_MARKER}.`;
  const entries = await readdir(stateDir);
  return entries
    .map((name) => join(stateDir, name))
    .filter((path) => path !== markerPath && (basename(path) === LEGACY_MIGRATION_MARKER || basename(path).startsWith(prefix)));
}

async function writeMarker(path: string, marker: LegacyMigrationMarker): Promise<void> {
  await writeJson(path, marker);
}

async function copyFileAtomic(from: string, to: string): Promise<void> {
  if (from === to) return;
  await mkdir(dirname(to), { recursive: true });
  if (await exists(to)) return;
  const staging = `${to}.${crypto.randomUUID()}.tmp`;
  await cp(from, staging);
  await rename(staging, to);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, path);
}

function rootsOf(paths: CorotumPaths) {
  return {
    configDir: paths.configDir,
    dataDir: paths.dataDir,
    stateDir: paths.stateDir,
    skillsDir: paths.skillsDir,
    gitDir: paths.gitDir,
  };
}

function normalizeName(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase("en-US");
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
