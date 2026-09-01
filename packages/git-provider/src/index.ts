import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  type DesiredState,
  type DesiredStateEnvelope,
  type DispositionLedger,
  parseDispositionLedger,
  parseV2Lockfile,
  parseV2Manifest,
  serializeDispositionLedger,
  serializeV2Lockfile,
  serializeV2Manifest,
  type V2DesiredState,
  type V2LockedSkill,
  validateV2DesiredState,
  type DesiredStateMergeConflict,
  mergeDesiredStates,
  type PushDesiredStateInput,
  parseManifest,
  parseRevisionTransition,
  type Result,
  type RevisionTransition,
  revisionId,
  type StateProvider,
  serializeLockfile,
  serializeManifest,
  serializeRevisionTransition,
  validateDesiredState,
} from "../../core/src/index";
import { createArtifactArchive, type ArtifactArchive } from "../../skills-adapter/src/artifact-archive";
import { scanNormalizedContent } from "../../skills-adapter/src/normalized-content";
import {
  type GitCommandRunner,
  normalizeGitSource,
  runSystemGit,
} from "../../skills-adapter/src/git-source";

const manifestFile = "toolmirror.yaml";
const lockfileFile = "toolmirror.lock";
const transitionFile = "toolmirror.transition.json";
const pendingPushSuffix = ".pending-push.json";
const v2PendingPushSuffix = ".v2-pending-push.json";
const v2ManifestFile = "corotum.yaml";
const v2LockfileFile = "corotum.lock";
const v2TransitionsFile = "corotum.transitions.json";
const artifactsDirectory = "artifacts";

export type PendingPushResolution =
  | "keep-remote"
  | "apply-local"
  | "resolve-later";

export type PendingPushStatus =
  | Readonly<{ kind: "none" | "resolved" }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{
      kind: "conflict";
      conflicts: readonly DesiredStateMergeConflict[];
    }>;

type PendingPush = Readonly<{ baseRevision: string }>;

export class GitStorageMigrationError extends Error {
  readonly name = "GitStorageMigrationError";
}

/**
 * Relocates the complete Corotum-owned Git cache only after proving the
 * configured source clone and desired-state files survived the copy. Config
 * persistence is deliberately last, so callers never point at partial state.
 */
export class GitStorageMigrator {
  constructor(
    private readonly runGit: GitCommandRunner = runSystemGit,
    private readonly copyDirectory: (
      source: string,
      destination: string,
    ) => Promise<void> = (source, destination) =>
      cp(source, destination, { errorOnExist: true, recursive: true }),
  ) {}

  async migrate(input: {
    from: string;
    to: string;
    source: string;
    persist: () => Promise<void>;
  }): Promise<void> {
    const from = resolve(input.from);
    const to = resolve(input.to);
    if (from === to) return;
    if (contains(from, to) || contains(to, from)) {
      throw new GitStorageMigrationError(
        "The new Git storage path cannot contain the current path or be contained by it.",
      );
    }
    const source = normalizeGitSource(input.source);
    const oldCache = join(from, sourceKey(source));
    if (!(await exists(oldCache))) {
      throw new GitStorageMigrationError(
        "The Corotum-owned Git cache must exist before it can be moved.",
      );
    }
    if (await exists(to)) {
      throw new GitStorageMigrationError(
        "The new Git storage path already exists.",
      );
    }

    const staging = `${to}.${crypto.randomUUID()}.staging`;
    const backup = `${from}.${crypto.randomUUID()}.backup`;
    let oldMoved = false;
    let newInstalled = false;
    let persisted = false;
    try {
      await mkdir(dirname(staging), { recursive: true });
      await this.copyDirectory(from, staging);
      await this.verify(oldCache, join(staging, sourceKey(source)), source);

      await rename(from, backup);
      oldMoved = true;
      await rename(staging, to);
      newInstalled = true;
      await input.persist();
      persisted = true;
      await rm(backup, { force: true, recursive: true });
    } catch (error) {
      if (!persisted) {
        const rollbackErrors: unknown[] = [];
        if (newInstalled) {
          try {
            await rm(to, { force: true, recursive: true });
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (oldMoved) {
          try {
            await rename(backup, from);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            "Git storage migration failed and could not fully roll back.",
          );
        }
      }
      throw error;
    } finally {
      await rm(staging, { force: true, recursive: true });
    }
  }

  private async verify(
    oldCache: string,
    newCache: string,
    source: string,
  ): Promise<void> {
    const [oldSnapshot, newSnapshot] = await Promise.all([
      this.snapshot(oldCache),
      this.snapshot(newCache),
    ]);
    if (
      oldSnapshot.revision !== newSnapshot.revision ||
      oldSnapshot.origin !== source ||
      oldSnapshot.origin !== newSnapshot.origin ||
      oldSnapshot.manifest !== newSnapshot.manifest ||
      oldSnapshot.lockfile !== newSnapshot.lockfile ||
      oldSnapshot.transition !== newSnapshot.transition
    ) {
      throw new GitStorageMigrationError(
        "The copied Git cache does not match the current desired state.",
      );
    }
  }

  private async snapshot(cache: string): Promise<{
    revision: string;
    origin: string;
    manifest: string;
    lockfile: string;
    transition: string;
  }> {
    await this.command(cache, ["fsck", "--no-dangling"]);
    const [revision, origin, manifest, lockfile, transition] =
      await Promise.all([
        this.output(cache, ["rev-parse", "HEAD"]),
        this.output(cache, ["remote", "get-url", "origin"]),
        readFile(join(cache, manifestFile), "utf8"),
        readFile(join(cache, lockfileFile), "utf8"),
        readFile(join(cache, transitionFile), "utf8"),
      ]);
    return { revision, origin, manifest, lockfile, transition };
  }

  private async output(
    cache: string,
    args: readonly string[],
  ): Promise<string> {
    const result = await this.command(cache, args);
    return new TextDecoder().decode(result.stdout).trim();
  }

  private async command(
    cache: string,
    args: readonly string[],
  ): Promise<
    Readonly<{ exitCode: number; stderr: string; stdout: Uint8Array }>
  > {
    const result = await this.runGit({ args, cwd: cache });
    if (result.exitCode !== 0)
      throw new GitStorageMigrationError(
        result.stderr.trim() || "Git cache integrity verification failed.",
      );
    return result;
  }
}

/** A Corotum-owned Git clone that stores desired-state snapshots. */
export class GitStateProvider implements StateProvider {
  constructor(
    private readonly storagePath: string,
    private readonly source: string,
    private readonly runGit: GitCommandRunner = runSystemGit,
  ) {}

  /**
   * Seeds an entirely empty remote with the initial desired state. There is no
   * prior transition to replay, so the first commit intentionally has no
   * transition file; later mutations always carry one.
   */
  async bootstrap(state: DesiredState): Promise<Result<DesiredStateEnvelope>> {
    try {
      await this.preflight();
      const cache = await this.cache();
      if (await this.hasHead(cache)) {
        return { kind: "failure", error: { code: "CONFLICT", message: "Corotum is already initialized for this Git repository." } };
      }
      if (await this.readPending()) {
        return { kind: "failure", error: { code: "CONFLICT", message: "Resolve the previous PENDING_PUSH before changing desired state." } };
      }
      const validated = validateDesiredState(state, "git");
      await Promise.all([
        writeFile(join(cache, manifestFile), serializeManifest(validated.manifest)),
        writeFile(join(cache, lockfileFile), serializeLockfile(validated.lockfile)),
      ]);
      await this.command(cache, ["add", "--", manifestFile, lockfileFile]);
      await this.command(cache, ["-c", "user.name=Corotum", "-c", "user.email=toolmirror@users.noreply.github.com", "commit", "--no-gpg-sign", "-m", "corotum: initialize"]);
      try {
        await this.command(cache, ["push", "-u", "origin", "HEAD"]);
      } catch {
        // An empty remote has no base commit. The empty marker tells retry that
        // it can safely retry the initial push rather than merge snapshots.
        await this.writePending({ baseRevision: "" });
        return { kind: "failure", error: { code: "CONFLICT", message: "Desired state was committed locally and is waiting to be pushed." } };
      }
      return { kind: "success", value: await this.readState(cache) };
    } catch (error) {
      return { kind: "failure", error: gitError(error) };
    }
  }

  async pull(): Promise<Result<DesiredStateEnvelope>> {
    return this.pullInternal(true);
  }

  /** Reads the current local desired state without retrying a pending mutation. */
  async pullReadOnly(): Promise<Result<DesiredStateEnvelope>> {
    return this.pullInternal(false);
  }

  private async pullInternal(
    retryPending: boolean,
  ): Promise<Result<DesiredStateEnvelope>> {
    try {
      await this.preflight();
      const cache = await this.cache();
      if (!retryPending) {
        // The updater contacts each skill source itself. Reading this committed
        // local snapshot avoids turning an unresolved PENDING_PUSH into a
        // write/rebase attempt and keeps update --check safely available.
        return { kind: "success", value: await this.readState(cache) };
      }
      const pending = await this.retryPendingPush(cache);
      if (pending.kind === "pending" || pending.kind === "conflict") {
        return {
          kind: "failure",
          error: {
            code: "CONFLICT",
            message: "A previous desired-state change is waiting to be pushed.",
          },
        };
      }
      await this.sync(cache);
      return { kind: "success", value: await this.readState(cache) };
    } catch (error) {
      return { kind: "failure", error: gitError(error) };
    }
  }

  /**
   * Retries a persisted desired-state push. On a remote collision callers can
   * explicitly keep remote state, reapply local state, or leave it pending.
   */
  async resolvePendingPush(
    resolution: PendingPushResolution = "resolve-later",
  ): Promise<PendingPushStatus> {
    try {
      await this.preflight();
      return await this.retryPendingPush(await this.cache(), resolution);
    } catch (error) {
      throw new Error(gitError(error).message, { cause: error });
    }
  }

  /**
   * Writes one fully locked snapshot and its transition before creating a Git
   * commit. A transition is required so offline devices retain remove versus
   * unmanage semantics.
   */
  async push(
    input: PushDesiredStateInput,
    transition?: RevisionTransition,
  ): Promise<Result<DesiredStateEnvelope>> {
    try {
      await this.preflight();
      const state = validateDesiredState(input.state, "git");
      if (!transition)
        throw new Error("A Git state mutation needs a transition.");

      const cache = await this.cache();
      const pending = await this.retryPendingPush(cache);
      if (pending.kind === "pending" || pending.kind === "conflict") {
        return {
          kind: "failure",
          error: {
            code: "CONFLICT",
            message:
              "Resolve the previous PENDING_PUSH before changing desired state.",
          },
        };
      }
      await this.sync(cache);
      const current = await this.revision(cache);
      if (input.baseRevision !== current) {
        return {
          kind: "failure",
          error: {
            code: "CONFLICT",
            message: "Git desired state has changed.",
          },
        };
      }

      await this.writeState(cache, state, transition);
      const changed = await this.changed(cache);
      if (!changed)
        return { kind: "success", value: await this.readState(cache) };

      await this.command(cache, [
        "-c",
        "user.name=Corotum",
        "-c",
        "user.email=toolmirror@users.noreply.github.com",
        "commit",
        "--no-gpg-sign",
        "-m",
        `corotum: ${transition.type.toLowerCase()} ${transition.skillId}`,
      ]);
      try {
        await this.command(cache, ["push", "origin", "HEAD"]);
      } catch {
        await this.writePending({ baseRevision: current });
        return {
          kind: "failure",
          error: {
            code: "CONFLICT",
            message:
              "Desired state was committed locally and is waiting to be pushed.",
          },
        };
      }
      await this.clearPending();
      return { kind: "success", value: await this.readState(cache) };
    } catch (error) {
      return { kind: "failure", error: gitError(error) };
    }
  }

  private async preflight(): Promise<void> {
    await this.command(undefined, ["--version"]);
  }

  private async cache(): Promise<string> {
    const source = normalizeGitSource(this.source);
    const cache = join(this.storagePath, sourceKey(source));

    if (!(await exists(cache))) {
      await mkdir(this.storagePath, { recursive: true, mode: 0o700 });
      await this.command(undefined, ["clone", "--quiet", source, cache]);
      return cache;
    }

    await this.command(cache, ["rev-parse", "--is-inside-work-tree"]);
    const origin = await this.output(cache, ["remote", "get-url", "origin"]);
    if (origin !== source)
      throw new Error(
        "Corotum Git cache source does not match its configured remote.",
      );
    return cache;
  }

  private async sync(cache: string): Promise<void> {
    await this.command(cache, ["fetch", "--quiet", "origin"]);
    await this.command(cache, ["merge", "--ff-only", "@{upstream}"]);
  }

  private pendingPath(): string {
    return join(
      this.storagePath,
      `${sourceKey(normalizeGitSource(this.source))}${pendingPushSuffix}`,
    );
  }

  private async retryPendingPush(
    cache: string,
    resolution?: PendingPushResolution,
  ): Promise<PendingPushStatus> {
    const pending = await this.readPending();
    if (!pending) return { kind: "none" };
    if (pending.baseRevision === "") {
      try {
        await this.command(cache, ["push", "-u", "origin", "HEAD"]);
        await this.clearPending();
        return { kind: "resolved" };
      } catch {
        return { kind: "pending" };
      }
    }

    await this.command(cache, ["fetch", "--quiet", "origin"]);
    const [head, upstream] = await Promise.all([
      this.revision(cache),
      this.output(cache, ["rev-parse", "@{upstream}"]),
    ]);
    const localContainsRemote = await this.isAncestor(cache, upstream, head);
    if (localContainsRemote) {
      try {
        await this.command(cache, ["push", "origin", "HEAD"]);
        await this.clearPending();
        return { kind: "resolved" };
      } catch {
        return { kind: "pending" };
      }
    }

    const base = await this.readStateAt(cache, pending.baseRevision);
    const remote = await this.readStateAt(cache, upstream);
    const local = await this.readStateAt(cache, head);
    const merged = mergeDesiredStates(
      base.state,
      remote.state,
      local.state,
      "git",
    );
    if (merged.kind === "conflict") {
      if (!resolution || resolution === "resolve-later") {
        return { kind: "conflict", conflicts: merged.conflicts };
      }
      await this.replacePendingCommit(
        cache,
        upstream,
        resolution === "keep-remote" ? remote.state : local.state,
        resolution === "keep-remote" ? undefined : "apply local pending state",
      );
    } else {
      await this.replacePendingCommit(
        cache,
        upstream,
        merged.state,
        "replay pending state",
      );
    }

    try {
      await this.command(cache, ["push", "origin", "HEAD"]);
      await this.clearPending();
      return { kind: "resolved" };
    } catch {
      return { kind: "pending" };
    }
  }

  private async replacePendingCommit(
    cache: string,
    upstream: string,
    state: DesiredState,
    message?: string,
  ): Promise<void> {
    const transition = await this.transitionAt(cache, "HEAD");
    // Reset moves the current branch to the remote snapshot without trying to
    // force-update the branch while it is checked out.
    await this.command(cache, ["reset", "--hard", upstream]);
    if (!message) return;
    await this.writeState(cache, state, transition);
    await this.command(cache, [
      "-c",
      "user.name=Corotum",
      "-c",
      "user.email=toolmirror@users.noreply.github.com",
      "commit",
      "--no-gpg-sign",
      "-m",
      `corotum: ${message}`,
    ]);
  }

  private async readState(cache: string): Promise<DesiredStateEnvelope> {
    const revision = await this.revision(cache);
    return {
      revisionId: revisionId(revision),
      state: (await this.readStateAt(cache, revision)).state,
    };
  }

  private async readStateAt(
    cache: string,
    revision: string,
  ): Promise<DesiredStateEnvelope> {
    const [manifest, lockfile] = await Promise.all([
      this.show(cache, revision, manifestFile),
      this.show(cache, revision, lockfileFile),
    ]);
    return {
      revisionId: revisionId(revision),
      state: validateDesiredState(
        { manifest: parseManifest(manifest), lockfile: JSON.parse(lockfile) },
        "git",
      ),
    };
  }

  private async transitionAt(
    cache: string,
    revision: string,
  ): Promise<RevisionTransition> {
    return parseRevisionTransition(
      await this.show(cache, revision, transitionFile),
    );
  }

  private async show(
    cache: string,
    revision: string,
    file: string,
  ): Promise<string> {
    return this.output(cache, ["show", `${revision}:${file}`]);
  }

  private async isAncestor(
    cache: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    const result = await this.runGit({
      args: ["merge-base", "--is-ancestor", ancestor, descendant],
      cwd: cache,
    });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(result.stderr.trim() || "Git could not compare revisions.");
  }

  private async readPending(): Promise<PendingPush | null> {
    try {
      return JSON.parse(
        await readFile(this.pendingPath(), "utf8"),
      ) as PendingPush;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return null;
      throw new Error("Corotum PENDING_PUSH state is invalid.");
    }
  }

  private async writePending(pending: PendingPush): Promise<void> {
    await writeFile(this.pendingPath(), `${JSON.stringify(pending)}\n`, {
      mode: 0o600,
    });
  }

  private async clearPending(): Promise<void> {
    await rm(this.pendingPath(), { force: true });
  }

  private async writeState(
    cache: string,
    state: DesiredState,
    transition: RevisionTransition,
  ): Promise<void> {
    await Promise.all([
      writeFile(join(cache, manifestFile), serializeManifest(state.manifest)),
      writeFile(join(cache, lockfileFile), serializeLockfile(state.lockfile)),
      writeFile(
        join(cache, transitionFile),
        serializeRevisionTransition(transition),
      ),
    ]);
    await this.command(cache, [
      "add",
      "--",
      manifestFile,
      lockfileFile,
      transitionFile,
    ]);
  }

  private async changed(cache: string): Promise<boolean> {
    const result = await this.runGit({
      args: ["diff", "--cached", "--quiet"],
      cwd: cache,
    });
    if (result.exitCode === 0) return false;
    if (result.exitCode === 1) return true;
    throw new Error(
      result.stderr.trim() || "Git could not inspect the desired-state change.",
    );
  }

  private async hasHead(cache: string): Promise<boolean> {
    const result = await this.runGit({ args: ["rev-parse", "--verify", "HEAD"], cwd: cache });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 128 || result.exitCode === 1) return false;
    throw new Error(result.stderr.trim() || "Git could not inspect the desired-state repository.");
  }

  private async revision(cache: string): Promise<string> {
    return this.output(cache, ["rev-parse", "HEAD"]);
  }

  private async output(
    cache: string,
    args: readonly string[],
  ): Promise<string> {
    const result = await this.command(cache, args);
    return new TextDecoder().decode(result.stdout).trim();
  }

  private async command(
    cwd: string | undefined,
    args: readonly string[],
  ): Promise<
    Readonly<{ exitCode: number; stderr: string; stdout: Uint8Array }>
  > {
    const result = await this.runGit({ args, cwd });
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || "Git command failed.");
    return result;
  }
}

export type V2GitStateEnvelope = Readonly<{
  revisionId: string;
  state: V2DesiredState;
  ledger: DispositionLedger;
}>;

export type V2PendingPushStatus =
  | Readonly<{ kind: "none" | "resolved" | "pending" }>
  | Readonly<{ kind: "conflict"; skillIds: readonly string[] }>;

type V2PendingPush = Readonly<{ baseRevision: string }>;

/** Called before the first worktree mutation that would publish artifact content. */
export type V2ArtifactWriteConsent = (
  changedSkillIds: readonly string[],
) => Promise<void>;

/** A caller must explicitly authorize any Git commit containing local artifacts. */
export class V2ArtifactConsentRequiredError extends Error {
  constructor() {
    super("Git artifact publishing requires explicit consent before local content is committed.");
    this.name = "V2ArtifactConsentRequiredError";
  }
}

/**
 * Git-backed v2 desired state.  It deliberately has no compatibility fallback:
 * callers either read the complete Corotum v2 snapshot or use the dedicated
 * legacy migration before entering this provider.
 */
export class V2GitStateProvider {
  constructor(
    private readonly storagePath: string,
    private readonly source: string,
    private readonly runGit: GitCommandRunner = runSystemGit,
    private readonly confirmArtifactWrite?: V2ArtifactWriteConsent,
  ) {}

  async pull(): Promise<V2GitStateEnvelope> {
    const cache = await this.cache();
    const pending = await this.retryPendingPush(cache);
    if (pending.kind === "pending" || pending.kind === "conflict") {
      throw new Error("A previous v2 desired-state change is waiting to be pushed.");
    }
    await this.command(cache, ["fetch", "--quiet", "origin"]);
    await this.command(cache, ["merge", "--ff-only", "@{upstream}"]);
    return this.read(cache);
  }

  /** Reads the committed snapshot without retrying PENDING_PUSH or fetching. */
  async pullReadOnly(): Promise<V2GitStateEnvelope> {
    return this.read(await this.cache());
  }

  /** True when a previous local commit still needs a successful push. */
  async peekPendingPush(): Promise<boolean> {
    try {
      return (await this.readV2Pending()) !== null;
    } catch {
      return true;
    }
  }

  /** Empty remotes have HEAD but no v2 snapshot; init uses that as the base. */
  async pullAllowEmpty(): Promise<V2GitStateEnvelope> {
    const cache = await this.cache();
    const pending = await this.retryPendingPush(cache);
    if (pending.kind === "pending" || pending.kind === "conflict") {
      throw new Error("A previous v2 desired-state change is waiting to be pushed.");
    }
    await this.command(cache, ["fetch", "--quiet", "origin"]);
    await this.command(cache, ["merge", "--ff-only", "@{upstream}"]);
    if (!(await exists(join(cache, v2ManifestFile)))) {
      return {
        revisionId: await this.revision(cache),
        state: { manifest: { version: 2, skills: [] }, lockfile: { version: 2, skills: [] } },
        ledger: { version: 2, activeDispositions: {} },
      };
    }
    return this.read(cache);
  }

  async resolvePendingPush(): Promise<V2PendingPushStatus> {
    return this.retryPendingPush(await this.cache());
  }

  /** Exports a verified Git artifact tree as a deterministic Cloud archive. */
  async readArtifact(lock: V2LockedSkill): Promise<ArtifactArchive> {
    if (lock.materialization.kind !== "artifact") {
      throw new Error(`Source-backed skill ${lock.id} has no artifact.`);
    }
    const snapshot = await this.pull();
    const current = snapshot.state.lockfile.skills.find((skill) => skill.id === lock.id);
    if (current?.materialization.kind !== "artifact" ||
      current.materialization.artifact.integrityHash !== lock.materialization.artifact.integrityHash ||
      current.materialization.artifact.contentHash !== lock.materialization.artifact.contentHash) {
      throw new Error(`Artifact ${lock.id} does not match the verified Git state.`);
    }
    const archive = await createArtifactArchive(join(await this.cache(), this.artifactLocator(current)));
    if (archive.contentHash !== current.materialization.artifact.contentHash) {
      throw new Error(`Artifact ${lock.id} content hash does not match its Git lock.`);
    }
    return archive;
  }

  /** Atomically stages metadata and every artifact tree in one Git commit. */
  async push(input: Readonly<{
    state: V2DesiredState;
    ledger: DispositionLedger;
    baseRevision: string;
    /** Directories keyed by artifact skill ID; source locks must not be present. */
    artifacts?: Readonly<Record<string, string>>;
  }>): Promise<V2GitStateEnvelope> {
    const state = validateV2DesiredState(input.state);
    const cache = await this.cache();
    const pending = await this.retryPendingPush(cache);
    if (pending.kind === "pending" || pending.kind === "conflict") {
      throw new Error("Resolve the previous PENDING_PUSH before changing desired state.");
    }
    await this.command(cache, ["fetch", "--quiet", "origin"]);
    await this.command(cache, ["merge", "--ff-only", "@{upstream}"]);
    if ((await this.revision(cache)) !== input.baseRevision) {
      throw new Error("Git desired state has changed.");
    }
    const changedArtifacts = await this.changedArtifacts(cache, state);
    if (changedArtifacts.length > 0) {
      if (!this.confirmArtifactWrite) throw new V2ArtifactConsentRequiredError();
      await this.confirmArtifactWrite(changedArtifacts);
    }

    const staging = await mkdtemp(join(this.storagePath, ".corotum-v2-stage-"));
    let committed = false;
    let pendingRecorded = false;
    try {
      const artifacts = input.artifacts ?? {};
      await this.stageArtifacts(staging, state, artifacts);
      await writeFile(join(staging, v2ManifestFile), serializeV2Manifest(state.manifest));
      await writeFile(join(staging, v2LockfileFile), serializeV2Lockfile(state.lockfile));
      await writeFile(join(staging, v2TransitionsFile), serializeDispositionLedger(input.ledger));
      await this.verifyStaged(staging, state);

      await rename(join(staging, v2ManifestFile), join(cache, v2ManifestFile));
      await rename(join(staging, v2LockfileFile), join(cache, v2LockfileFile));
      await rename(join(staging, v2TransitionsFile), join(cache, v2TransitionsFile));
      await rm(join(cache, artifactsDirectory), { force: true, recursive: true });
      if (await exists(join(staging, artifactsDirectory))) await rename(join(staging, artifactsDirectory), join(cache, artifactsDirectory));
      await this.command(cache, ["add", "--", v2ManifestFile, v2LockfileFile, v2TransitionsFile]);
      // Stage removals separately: source locks intentionally have no tree.
      const trackedArtifacts = await this.runGit({ args: ["ls-files", "--error-unmatch", artifactsDirectory], cwd: cache });
      if (trackedArtifacts.exitCode === 0) await this.command(cache, ["add", "-u", "--", artifactsDirectory]);
      if (await exists(join(cache, artifactsDirectory))) await this.command(cache, ["add", "--", artifactsDirectory]);
      const changed = await this.runGit({ args: ["diff", "--cached", "--quiet"], cwd: cache });
      if (changed.exitCode === 1) {
        await this.command(cache, ["-c", "user.name=Corotum", "-c", "user.email=toolmirror@users.noreply.github.com", "commit", "--no-gpg-sign", "-m", "corotum: persist v2 desired state"]);
        committed = true;
        // Record PENDING_PUSH before attempting the network operation: a failed
        // push can never leave an untracked local desired-state commit.
        await this.writeV2Pending({ baseRevision: input.baseRevision });
        pendingRecorded = true;
        try {
          await this.command(cache, ["push", "origin", "HEAD"]);
        } catch {
          throw new Error("Desired state was committed locally and is waiting to be pushed.");
        }
      } else if (changed.exitCode !== 0) throw new Error(changed.stderr || "Git could not inspect staged state.");
      await this.clearV2Pending();
      return this.read(cache);
    } catch (error) {
      // Before the commit becomes durable, restore the Corotum-owned worktree
      // so a failed staged write cannot publish a partial artifact tree.
      if (!committed) await this.restoreWorktree(cache);
      // If recording the pending marker failed, discard our new local commit;
      // otherwise a later sync could not safely replay it.
      else if (!pendingRecorded) await this.command(cache, ["reset", "--hard", "HEAD^"]);
      throw error;
    } finally {
      await rm(staging, { force: true, recursive: true });
    }
  }

  private async changedArtifacts(
    cache: string,
    next: V2DesiredState,
  ): Promise<readonly string[]> {
    const previous = (await exists(join(cache, v2ManifestFile)))
      ? await this.read(cache).then((envelope) => envelope.state)
      : null;
    const priorById = new Map(
      previous?.lockfile.skills.flatMap((skill) =>
        skill.materialization.kind === "artifact"
          ? [[skill.id, skill.materialization.artifact.integrityHash]]
          : [],
      ),
    );
    return next.lockfile.skills
      .filter(
        (skill) =>
          skill.materialization.kind === "artifact" &&
          priorById.get(skill.id) !== skill.materialization.artifact.integrityHash,
      )
      .map((skill) => skill.id);
  }

  private async stageArtifacts(staging: string, state: V2DesiredState, supplied: Readonly<Record<string, string>>): Promise<void> {
    const expected = new Set<string>();
    for (const lock of state.lockfile.skills) {
      if (lock.materialization.kind === "source") {
        if (supplied[lock.id]) throw new Error(`Source-backed skill ${lock.id} must not have an artifact.`);
        continue;
      }
      expected.add(lock.id);
      const source = supplied[lock.id];
      if (!source) throw new Error(`Artifact-backed skill ${lock.id} is missing its artifact tree.`);
      const locator = this.artifactLocator(lock);
      const destination = join(staging, locator);
      const scanned = await scanNormalizedContent(source);
      if (scanned.contentHash !== lock.materialization.artifact.contentHash) throw new Error(`Artifact ${lock.id} content hash does not match.`);
      await mkdir(destination, { recursive: true });
      for (const file of scanned.files) {
        const target = join(destination, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, { mode: 0o600 });
      }
      if ((await gitTreeHash(destination)) !== lock.materialization.artifact.integrityHash) throw new Error(`Artifact ${lock.id} tree integrity does not match.`);
    }
    for (const id of Object.keys(supplied)) if (!expected.has(id)) throw new Error(`Artifact supplied for non-artifact skill ${id}.`);
  }

  private async verifyStaged(staging: string, expected: V2DesiredState): Promise<void> {
    const manifest = parseV2Manifest(await readFile(join(staging, v2ManifestFile), "utf8"));
    const lockfile = parseV2Lockfile(await readFile(join(staging, v2LockfileFile), "utf8"), manifest);
    validateV2DesiredState({ manifest, lockfile });
    await this.verifyArtifactTrees(staging, expected);
  }

  private artifactLocator(lock: V2DesiredState["lockfile"]["skills"][number]): string {
    if (lock.materialization.kind !== "artifact") throw new Error(`Skill ${lock.id} has no artifact.`);
    const locator = `${artifactsDirectory}/${lock.id}/${lock.materialization.artifact.integrityHash.slice("sha256:".length)}`;
    if (lock.materialization.artifact.locator !== locator) throw new Error(`Artifact ${lock.id} has an invalid Git locator.`);
    return locator;
  }

  private async verifyArtifactTrees(root: string, state: V2DesiredState): Promise<void> {
    for (const lock of state.lockfile.skills) if (lock.materialization.kind === "artifact") {
      const path = join(root, this.artifactLocator(lock));
      const scanned = await scanNormalizedContent(path);
      if (scanned.contentHash !== lock.materialization.artifact.contentHash || (await gitTreeHash(path)) !== lock.materialization.artifact.integrityHash) throw new Error(`Artifact ${lock.id} readback verification failed.`);
    }
  }

  private v2PendingPath(): string {
    return join(this.storagePath, `${sourceKey(normalizeGitSource(this.source))}${v2PendingPushSuffix}`);
  }

  private async readV2Pending(): Promise<V2PendingPush | null> {
    try { return JSON.parse(await readFile(this.v2PendingPath(), "utf8")) as V2PendingPush; }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
      throw new Error("Corotum v2 PENDING_PUSH state is invalid.");
    }
  }

  private async writeV2Pending(pending: V2PendingPush): Promise<void> {
    await writeFile(this.v2PendingPath(), `${JSON.stringify(pending)}\n`, { mode: 0o600 });
  }

  private async clearV2Pending(): Promise<void> { await rm(this.v2PendingPath(), { force: true }); }

  private async retryPendingPush(cache: string): Promise<V2PendingPushStatus> {
    const pending = await this.readV2Pending();
    if (!pending) return { kind: "none" };
    await this.command(cache, ["fetch", "--quiet", "origin"]);
    const head = await this.revision(cache);
    const upstream = await this.output(cache, ["rev-parse", "@{upstream}"]);
    if (await this.isAncestor(cache, upstream, head)) {
      try { await this.command(cache, ["push", "origin", "HEAD"]); await this.clearV2Pending(); return { kind: "resolved" }; }
      catch { return { kind: "pending" }; }
    }
    const [base, remote, local] = await Promise.all([this.readAt(cache, pending.baseRevision), this.readAt(cache, upstream), this.readAt(cache, head)]);
    const merged = mergeV2Snapshots(base, remote, local);
    if (merged.kind === "conflict") return merged;
    await this.command(cache, ["reset", "--hard", upstream]);
    await this.restoreMergedArtifacts(cache, upstream, head, merged.state);
    await this.writeSnapshot(cache, merged.state, merged.ledger);
    await this.command(cache, ["add", "-A", "--", v2ManifestFile, v2LockfileFile, v2TransitionsFile]);
    if (await this.gitPathExists(cache, "HEAD", artifactsDirectory)) {
      await this.command(cache, ["add", "-u", "--", artifactsDirectory]);
    }
    if (await exists(join(cache, artifactsDirectory))) {
      await this.command(cache, ["add", "--", artifactsDirectory]);
    }
    await this.command(cache, ["-c", "user.name=Corotum", "-c", "user.email=toolmirror@users.noreply.github.com", "commit", "--no-gpg-sign", "-m", "corotum: replay v2 pending state"]);
    try { await this.command(cache, ["push", "origin", "HEAD"]); await this.clearV2Pending(); return { kind: "resolved" }; }
    catch { return { kind: "pending" }; }
  }

  private async readAt(cache: string, revision: string): Promise<Omit<V2GitStateEnvelope, "revisionId">> {
    const manifest = parseV2Manifest(await this.show(cache, revision, v2ManifestFile));
    const lockfile = parseV2Lockfile(await this.show(cache, revision, v2LockfileFile), manifest);
    return { state: validateV2DesiredState({ manifest, lockfile }), ledger: parseDispositionLedger(await this.show(cache, revision, v2TransitionsFile)) };
  }

  private async writeSnapshot(cache: string, state: V2DesiredState, ledger: DispositionLedger): Promise<void> {
    await Promise.all([writeFile(join(cache, v2ManifestFile), serializeV2Manifest(state.manifest)), writeFile(join(cache, v2LockfileFile), serializeV2Lockfile(state.lockfile)), writeFile(join(cache, v2TransitionsFile), serializeDispositionLedger(ledger))]);
  }

  private async restoreMergedArtifacts(cache: string, remoteRevision: string, localRevision: string, state: V2DesiredState): Promise<void> {
    await rm(join(cache, artifactsDirectory), { force: true, recursive: true });
    for (const lock of state.lockfile.skills) if (lock.materialization.kind === "artifact") {
      const locator = this.artifactLocator(lock);
      const source = await this.gitPathExists(cache, remoteRevision, locator) ? remoteRevision : localRevision;
      if (!(await this.gitPathExists(cache, source, locator))) throw new Error(`Artifact ${lock.id} is missing from both pending snapshots.`);
      await this.command(cache, ["checkout", source, "--", locator]);
    }
    await this.verifyArtifactTrees(cache, state);
  }

  private async gitPathExists(cache: string, revision: string, path: string): Promise<boolean> {
    const result = await this.runGit({ args: ["cat-file", "-e", `${revision}:${path}`], cwd: cache });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1 || result.exitCode === 128) return false;
    throw new Error(result.stderr.trim() || "Git could not inspect an artifact.");
  }

  private async restoreWorktree(cache: string): Promise<void> {
    await this.command(cache, ["reset", "--hard", "HEAD"]);
    await this.command(cache, ["clean", "-fd", "--", v2ManifestFile, v2LockfileFile, v2TransitionsFile, artifactsDirectory]);
  }

  private async show(cache: string, revision: string, file: string): Promise<string> { return this.output(cache, ["show", `${revision}:${file}`]); }
  private async isAncestor(cache: string, ancestor: string, descendant: string): Promise<boolean> { const result = await this.runGit({ args: ["merge-base", "--is-ancestor", ancestor, descendant], cwd: cache }); if (result.exitCode === 0) return true; if (result.exitCode === 1) return false; throw new Error(result.stderr || "Git could not compare revisions."); }

  private async read(cache: string): Promise<V2GitStateEnvelope> {
    const revision = await this.revision(cache);
    const manifest = parseV2Manifest(await readFile(join(cache, v2ManifestFile), "utf8"));
    const lockfile = parseV2Lockfile(await readFile(join(cache, v2LockfileFile), "utf8"), manifest);
    const state = validateV2DesiredState({ manifest, lockfile });
    await this.verifyArtifactTrees(cache, state);
    return { revisionId: revision, state, ledger: parseDispositionLedger(await readFile(join(cache, v2TransitionsFile), "utf8")) };
  }

  private async cache(): Promise<string> {
    const source = normalizeGitSource(this.source); const cache = join(this.storagePath, sourceKey(source));
    if (!(await exists(cache))) { await mkdir(this.storagePath, { recursive: true, mode: 0o700 }); await this.command(undefined, ["clone", "--quiet", source, cache]); }
    return cache;
  }
  private async revision(cache: string): Promise<string> { return this.output(cache, ["rev-parse", "HEAD"]); }
  private async output(cwd: string, args: readonly string[]): Promise<string> { return new TextDecoder().decode((await this.command(cwd, args)).stdout).trim(); }
  private async command(cwd: string | undefined, args: readonly string[]): Promise<Readonly<{ exitCode: number; stderr: string; stdout: Uint8Array }>> { const result = await this.runGit({ args, cwd }); if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Git command failed."); return result; }
}

type V2Snapshot = Readonly<{ state: V2DesiredState; ledger: DispositionLedger }>;
type V2SnapshotMerge =
  | Readonly<{ kind: "merged"; state: V2DesiredState; ledger: DispositionLedger }>
  | Readonly<{ kind: "conflict"; skillIds: readonly string[] }>;
type DispositionEntry =
  DispositionLedger["activeDispositions"][keyof DispositionLedger["activeDispositions"]];

/** Replays independent desired-state changes without ever dropping a tombstone. */
function mergeV2Snapshots(base: V2Snapshot, remote: V2Snapshot, local: V2Snapshot): V2SnapshotMerge {
  const entries = (state: V2DesiredState) => new Map(state.manifest.skills.map((skill) => [skill.id, { manifest: skill, lock: state.lockfile.skills.find((lock) => lock.id === skill.id) }]));
  const before = entries(base.state); const theirs = entries(remote.state); const ours = entries(local.state);
  const ids = new Set([...before.keys(), ...theirs.keys(), ...ours.keys()]);
  const merged: { manifest: V2DesiredState["manifest"]["skills"][number]; lock?: V2DesiredState["lockfile"]["skills"][number] }[] = [];
  const conflicts: string[] = [];
  for (const id of ids) {
    const baseEntry = before.get(id); const remoteEntry = theirs.get(id); const localEntry = ours.get(id);
    const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    const remoteChanged = !same(baseEntry, remoteEntry); const localChanged = !same(baseEntry, localEntry);
    if (remoteChanged && localChanged && !same(remoteEntry, localEntry)) { conflicts.push(id); continue; }
    const selected = localChanged ? localEntry : remoteEntry;
    if (selected) merged.push(selected);
  }
  const ledger: Record<keyof DispositionLedger["activeDispositions"], DispositionEntry> = {
    ...remote.ledger.activeDispositions,
  };
  for (const [id, entry] of Object.entries(
    local.ledger.activeDispositions,
  ) as [keyof DispositionLedger["activeDispositions"], DispositionEntry][]) {
    const remoteEntry = remote.ledger.activeDispositions[id];
    if (remoteEntry && remoteEntry.disposition !== entry.disposition) { conflicts.push(id); continue; }
    ledger[id] = !remoteEntry || entry.effectiveSequence >= remoteEntry.effectiveSequence ? entry : remoteEntry;
  }
  if (conflicts.length > 0) return { kind: "conflict", skillIds: [...new Set(conflicts)].sort() };
  const activeIds = new Set(merged.map((entry) => entry.manifest.id));
  for (const id of Object.keys(ledger) as (keyof typeof ledger)[]) {
    if (activeIds.has(id)) delete ledger[id];
  }
  return {
    kind: "merged",
    state: validateV2DesiredState({ manifest: { version: 2, skills: merged.map((entry) => entry.manifest) }, lockfile: { version: 2, skills: merged.flatMap((entry) => entry.lock ? [entry.lock] : []) } }),
    ledger: parseDispositionLedger(JSON.stringify({ version: 2, activeDispositions: ledger })),
  };
}

/** Deterministic integrity hash for a sanitized plain Git artifact tree. */
export async function gitTreeHash(directory: string): Promise<`sha256:${string}`> {
  const scanned = await scanNormalizedContent(directory);
  const hasher = new Bun.CryptoHasher("sha256"); hasher.update("corotum-git-tree-v1\\0");
  for (const file of scanned.files) { hasher.update(file.path); hasher.update("\\0"); hasher.update(file.content); hasher.update("\\0"); }
  return `sha256:${hasher.digest("hex")}`;
}

function sourceKey(source: string): string {
  return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith(`..${sep}`) && path !== "..";
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
}

function gitError(error: unknown): {
  code: "AUTH_REQUIRED" | "NETWORK_ERROR" | "VALIDATION_ERROR";
  message: string;
} {
  const message =
    error instanceof Error ? error.message : "Git state operation failed.";
  if (
    /authentication|authorization|permission denied|could not read username|terminal prompts disabled/i.test(
      message,
    )
  ) {
    return {
      code: "AUTH_REQUIRED",
      message: "Git authentication is required.",
    };
  }
  if (
    /Git desired state has changed|needs a transition|cache source does not match/.test(
      message,
    )
  ) {
    return { code: "VALIDATION_ERROR", message };
  }
  return { code: "NETWORK_ERROR", message: "Git state operation failed." };
}
