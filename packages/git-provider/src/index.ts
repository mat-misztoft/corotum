import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
