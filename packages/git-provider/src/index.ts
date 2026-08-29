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
  type PushDesiredStateInput,
  parseManifest,
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

  async pull(): Promise<Result<DesiredStateEnvelope>> {
    try {
      await this.preflight();
      const cache = await this.cache();
      await this.sync(cache);
      return { kind: "success", value: await this.readState(cache) };
    } catch (error) {
      return { kind: "failure", error: gitError(error) };
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
      await this.command(cache, ["push", "origin", "HEAD"]);
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

  private async readState(cache: string): Promise<DesiredStateEnvelope> {
    const state = validateDesiredState(
      {
        manifest: parseManifest(
          await readFile(join(cache, manifestFile), "utf8"),
        ),
        lockfile: JSON.parse(await readFile(join(cache, lockfileFile), "utf8")),
      },
      "git",
    );
    return { revisionId: revisionId(await this.revision(cache)), state };
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
