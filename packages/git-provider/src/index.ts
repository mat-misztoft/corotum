import {
  cp,
  mkdir,
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
import {
  type GitCommandRunner,
  normalizeGitSource,
  runSystemGit,
} from "../../skills-adapter/src/git-source";

const manifestFile = "toolmirror.yaml";
const lockfileFile = "toolmirror.lock";
const transitionFile = "toolmirror.transition.json";
const pendingPushSuffix = ".pending-push.json";

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
 * Relocates the complete ToolMirror-owned Git cache only after proving the
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
        "The ToolMirror-owned Git cache must exist before it can be moved.",
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

/** A ToolMirror-owned Git clone that stores desired-state snapshots. */
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
        return { kind: "failure", error: { code: "CONFLICT", message: "ToolMirror is already initialized for this Git repository." } };
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
      await this.command(cache, ["-c", "user.name=ToolMirror", "-c", "user.email=toolmirror@users.noreply.github.com", "commit", "--no-gpg-sign", "-m", "toolmirror: initialize"]);
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
        "user.name=ToolMirror",
        "-c",
        "user.email=toolmirror@users.noreply.github.com",
        "commit",
        "--no-gpg-sign",
        "-m",
        `toolmirror: ${transition.type.toLowerCase()} ${transition.skillId}`,
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
        "ToolMirror Git cache source does not match its configured remote.",
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
    const [branch, transition] = await Promise.all([
      this.output(cache, ["symbolic-ref", "--short", "HEAD"]),
      this.transitionAt(cache, "HEAD"),
    ]);
    await this.command(cache, ["checkout", "--quiet", "--detach", upstream]);
    await this.command(cache, ["branch", "-f", branch, upstream]);
    await this.command(cache, ["checkout", "--quiet", branch]);
    if (!message) return;
    await this.writeState(cache, state, transition);
    await this.command(cache, [
      "-c",
      "user.name=ToolMirror",
      "-c",
      "user.email=toolmirror@users.noreply.github.com",
      "commit",
      "--no-gpg-sign",
      "-m",
      `toolmirror: ${message}`,
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
      throw new Error("ToolMirror PENDING_PUSH state is invalid.");
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
