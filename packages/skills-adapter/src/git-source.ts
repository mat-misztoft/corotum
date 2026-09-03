import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { LockedSkill } from "../../core/src/index";
import { ArtifactArchiveError, validatedTarFiles } from "./artifact-archive";
import { hashSkillDirectory } from "./canonical-store";
import { scanNormalizedContent } from "./normalized-content";

export type GitSourceErrorCode =
  | "AUTH_REQUIRED"
  | "CREDENTIALS_IN_URL"
  | "HASH_MISMATCH"
  | "INVALID_SOURCE"
  | "SOURCE_UNAVAILABLE";

export class GitSourceError extends Error {
  readonly name = "GitSourceError";

  constructor(
    readonly code: GitSourceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type GitCommand = Readonly<{
  args: readonly string[];
  cwd?: string;
}>;

export type GitCommandRunner = (
  command: GitCommand,
) => Promise<
  Readonly<{ exitCode: number; stderr: string; stdout: Uint8Array }>
>;

export type ResolveGitSkillInput = Readonly<{
  id: LockedSkill["id"];
  source: string;
  skill: string;
  ref: string;
  path?: string;
}>;

/** Immutable Git input shared with the v2 exact-content pipeline. */
export type LockedGitSource = Readonly<{
  repository: string;
  path: string;
  revision: string;
  contentHash: string;
}>;

export type ResolvedGitSkill = Readonly<{
  repository: string;
  revision: string;
  path: string;
  contentHash: string;
}>;

export type DiscoveredGitSkill = Readonly<{ name: string; path: string }>;

/** Rejects HTTP(S) URLs with user info before any Git process can be started. */
export function assertSafeGitSource(source: string): void {
  if (source.trim().length === 0) {
    throw new GitSourceError("INVALID_SOURCE", "A Git source is required.");
  }

  if (/^https?:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      if (url.username || url.password) {
        throw new GitSourceError(
          "CREDENTIALS_IN_URL",
          "Git source URLs must not contain credentials.",
        );
      }
    } catch (error) {
      if (error instanceof GitSourceError) throw error;
      throw new GitSourceError("INVALID_SOURCE", "Invalid Git source URL.");
    }
  }
}

/** Expands the documented GitHub shorthand while leaving standard Git remotes intact. */
export function normalizeGitSource(source: string): string {
  assertSafeGitSource(source);
  const trimmed = source.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}.git`;
  }
  return trimmed;
}

/** Bun-backed system Git runner. Credentials remain exclusively under Git's control. */
export const runSystemGit: GitCommandRunner = async ({ args, cwd }) => {
  const child = Bun.spawn(["git", "-c", "http.timeout=45", ...args], {
    cwd,
    stdin: "ignore",
    stderr: "pipe",
    stdout: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND:
        process.env.GIT_SSH_COMMAND ??
        "ssh -o BatchMode=yes -o ConnectTimeout=10",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
};

/** Reads the remote default branch name so init can lock an immutable SHA instead of HEAD. */
export async function resolveGitDefaultRef(
  sourceInput: string,
  runGit: GitCommandRunner = runSystemGit,
): Promise<string> {
  const source = normalizeGitSource(sourceInput);
  const result = await runGit({
    args: ["ls-remote", "--symref", source, "HEAD"],
  });
  if (result.exitCode !== 0) throw await gitFailure(result.stderr, source);
  const match = new TextDecoder()
    .decode(result.stdout)
    .match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  if (!match) {
    throw new GitSourceError(
      "SOURCE_UNAVAILABLE",
      "Could not determine the source default branch.",
    );
  }
  return match[1];
}

/** Resolves and materializes exact Git content using only system Git and local temporary state. */
export class GitSkillMaterializer {
  constructor(private readonly runGit: GitCommandRunner = runSystemGit) {}

  /** Lists global Agent Skills by their SKILL.md directory at an exact ref. */
  async discover(
    sourceInput: string,
    ref: string,
  ): Promise<readonly DiscoveredGitSkill[]> {
    const source = normalizeGitSource(sourceInput);
    const checkout = await this.clone(source);
    try {
      const revision = await this.commit(checkout, ref);
      const result = await this.runGit({
        args: ["ls-tree", "-r", "--name-only", revision],
        cwd: checkout,
      });
      if (result.exitCode !== 0) throw await gitFailure(result.stderr);
      const paths = new TextDecoder()
        .decode(result.stdout)
        .split("\n")
        .filter((path) => path.endsWith("/SKILL.md"))
        .map((path) => path.slice(0, -"/SKILL.md".length));
      return paths
        .map((path) => ({ name: path.split("/").at(-1) as string, path }))
        .sort((left, right) => left.path.localeCompare(right.path));
    } finally {
      await rm(checkout, { force: true, recursive: true });
    }
  }

  async resolve(input: ResolveGitSkillInput): Promise<ResolvedGitSkill> {
    return this.resolveWithHash(input, hashSkillDirectory);
  }

  /** Resolves follow-ref content using the sanitized normalized hash. */
  async resolveNormalized(
    input: ResolveGitSkillInput,
  ): Promise<ResolvedGitSkill> {
    return this.resolveWithHash(
      input,
      async (directory) => (await scanNormalizedContent(directory)).contentHash,
    );
  }

  /** One shallow clone per source, then exact hashes for each skill path. */
  async resolveNormalizedGroup(
    sourceInput: string,
    ref: string,
    items: readonly Pick<ResolveGitSkillInput, "skill" | "path">[],
  ): Promise<readonly (ResolvedGitSkill | GitSourceError)[]> {
    const source = normalizeGitSource(sourceInput);
    const checkout = await this.cloneShallow(source, ref);
    try {
      const revision = await this.revParse(checkout, "HEAD");
      const contentHash = async (directory: string) =>
        (await scanNormalizedContent(directory)).contentHash;
      const resolved: (ResolvedGitSkill | GitSourceError)[] = [];
      for (const item of items) {
        try {
          const path = normalizeSkillPath(item.path ?? item.skill);
          await this.assertDirectory(checkout, revision, path);
          const archive = await this.archive(checkout, revision, path);
          resolved.push({
            repository: source,
            revision,
            path,
            contentHash: await this.hashArchive(archive, path, contentHash),
          });
        } catch (error) {
          resolved.push(
            error instanceof GitSourceError
              ? error
              : new GitSourceError(
                  "SOURCE_UNAVAILABLE",
                  error instanceof Error
                    ? error.message
                    : "Git could not access the requested source.",
                ),
          );
        }
      }
      return resolved;
    } finally {
      await rm(checkout, { force: true, recursive: true });
    }
  }

  /** Writes only verified locked content, replacing the destination atomically. */
  async materialize(lock: LockedSkill, destination: string): Promise<void> {
    return this.materializeSource(lock, destination, hashSkillDirectory);
  }

  /** Materializes an immutable v2 source lock without consulting its follow ref. */
  async materializeLockedSource(
    lock: LockedGitSource,
    destination: string,
  ): Promise<void> {
    return this.materializeSource(
      lock,
      destination,
      async (directory) => (await scanNormalizedContent(directory)).contentHash,
    );
  }

  private async resolveWithHash(
    input: ResolveGitSkillInput,
    contentHash: (directory: string) => Promise<string>,
  ): Promise<ResolvedGitSkill> {
    const source = normalizeGitSource(input.source);
    const path = normalizeSkillPath(input.path ?? input.skill);
    const checkout = await this.clone(source);

    try {
      const revision = await this.commit(checkout, input.ref);
      await this.assertDirectory(checkout, revision, path);
      const archive = await this.archive(checkout, revision, path);
      return {
        repository: source,
        revision,
        path,
        contentHash: await this.hashArchive(archive, path, contentHash),
      };
    } finally {
      await rm(checkout, { force: true, recursive: true });
    }
  }

  private async materializeSource(
    lock: LockedGitSource,
    destination: string,
    contentHash: (directory: string) => Promise<string>,
  ): Promise<void> {
    const source = normalizeGitSource(lock.repository);
    const path = normalizeSkillPath(lock.path);
    const checkout = await this.clone(source);
    const staging = `${destination}.${crypto.randomUUID()}.staging`;

    try {
      const revision = await this.commit(checkout, lock.revision);
      if (revision !== lock.revision) {
        throw new GitSourceError(
          "SOURCE_UNAVAILABLE",
          "The locked Git revision is unavailable from this source.",
        );
      }
      const archive = await this.archive(checkout, revision, path);
      await mkdir(staging, { recursive: true });
      await this.extract(archive, staging, path);
      if ((await contentHash(staging)) !== lock.contentHash) {
        throw new GitSourceError(
          "HASH_MISMATCH",
          "Locked skill content does not match its expected hash.",
        );
      }
      await mkdir(dirname(destination), { recursive: true });
      await publishDirectory(staging, destination);
    } catch (error) {
      await rm(staging, { force: true, recursive: true });
      throw error;
    } finally {
      await rm(checkout, { force: true, recursive: true });
    }
  }

  private async clone(source: string): Promise<string> {
    const checkout = await mkdtemp(join(tmpdir(), "corotum-git-"));
    const result = await this.runGit({
      args: ["clone", "--quiet", "--no-checkout", source, checkout],
    });
    if (result.exitCode !== 0) {
      await rm(checkout, { force: true, recursive: true });
      throw await gitFailure(result.stderr, source);
    }
    return checkout;
  }

  private async cloneShallow(source: string, ref: string): Promise<string> {
    const checkout = await mkdtemp(join(tmpdir(), "corotum-git-"));
    const result = await this.runGit({
      args: [
        "clone",
        "--quiet",
        "--no-checkout",
        "--depth",
        "1",
        "--single-branch",
        "--branch",
        ref,
        source,
        checkout,
      ],
    });
    if (result.exitCode !== 0) {
      await rm(checkout, { force: true, recursive: true });
      throw await gitFailure(result.stderr, source);
    }
    return checkout;
  }

  private async commit(checkout: string, ref: string): Promise<string> {
    const fetched = await this.runGit({
      args: ["fetch", "--quiet", "origin", ref],
      cwd: checkout,
    });
    if (fetched.exitCode !== 0) throw await gitFailure(fetched.stderr);
    return this.revParse(checkout, `${ref}^{commit}`);
  }

  private async revParse(checkout: string, rev: string): Promise<string> {
    const result = await this.runGit({
      args: ["rev-parse", "--verify", rev],
      cwd: checkout,
    });
    if (result.exitCode !== 0) throw await gitFailure(result.stderr);
    return new TextDecoder().decode(result.stdout).trim();
  }

  private async assertDirectory(
    checkout: string,
    revision: string,
    path: string,
  ): Promise<void> {
    const result = await this.runGit({
      args: ["cat-file", "-t", `${revision}:${path}`],
      cwd: checkout,
    });
    if (
      result.exitCode !== 0 ||
      new TextDecoder().decode(result.stdout).trim() !== "tree"
    ) {
      throw new GitSourceError(
        "SOURCE_UNAVAILABLE",
        "Skill path is not a directory at the locked revision.",
      );
    }
  }

  private async archive(
    checkout: string,
    revision: string,
    path: string,
  ): Promise<Uint8Array> {
    const output = join(checkout, `.corotum-${crypto.randomUUID()}.tar`);
    const result = await this.runGit({
      args: ["archive", "--format=tar", "-o", output, revision, path],
      cwd: checkout,
    });
    try {
      if (result.exitCode !== 0) throw await gitFailure(result.stderr);
      return new Uint8Array(await readFile(output));
    } finally {
      await rm(output, { force: true });
    }
  }

  private async hashArchive(
    archive: Uint8Array,
    path: string,
    contentHash: (directory: string) => Promise<string> = hashSkillDirectory,
  ): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), "corotum-git-hash-"));
    try {
      await this.extract(archive, temporary, path);
      return await contentHash(temporary);
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  }

  private async extract(
    archive: Uint8Array,
    destination: string,
    path: string,
  ): Promise<void> {
    const prefix = `${path.replace(/\/+$/, "")}/`;
    try {
      for (const file of validatedTarFiles(archive)) {
        if (file.path !== path && !file.path.startsWith(prefix)) {
          throw new GitSourceError(
            "SOURCE_UNAVAILABLE",
            "Locked Git archive contained a path outside the skill directory.",
          );
        }
        const relative = file.path.startsWith(prefix)
          ? file.path.slice(prefix.length)
          : "";
        if (!relative) continue;
        const target = join(destination, ...relative.split("/"));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, { mode: 0o644 });
      }
    } catch (error) {
      if (error instanceof GitSourceError) throw error;
      throw new GitSourceError(
        "SOURCE_UNAVAILABLE",
        error instanceof ArtifactArchiveError
          ? error.message
          : "Could not extract locked skill content.",
      );
    }
  }
}

function normalizeSkillPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new GitSourceError(
      "INVALID_SOURCE",
      "Skill path must be a relative repository directory.",
    );
  }
  return normalized;
}

async function publishDirectory(
  staging: string,
  destination: string,
): Promise<void> {
  const backup = `${destination}.${crypto.randomUUID()}.backup`;
  let moved = false;
  try {
    await rename(destination, backup);
    moved = true;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    await rename(staging, destination);
  } catch (error) {
    if (moved) await rename(backup, destination).catch(() => undefined);
    throw error;
  }
  if (moved) await rm(backup, { force: true, recursive: true });
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function gitFailure(
  stderr: string,
  source?: string,
): Promise<GitSourceError> {
  const message = stderr.trim() || "Git could not access the requested source.";
  if (
    /authentication|authorization|permission denied|could not read username|terminal prompts disabled/i.test(
      message,
    )
  ) {
    return new GitSourceError(
      "AUTH_REQUIRED",
      "Git authentication is required to access this source.",
    );
  }
  if (source && (await localSourceIsUnreadable(source))) {
    return new GitSourceError(
      "AUTH_REQUIRED",
      "Git authentication is required to access this source.",
    );
  }
  return new GitSourceError("SOURCE_UNAVAILABLE", message);
}

async function localSourceIsUnreadable(source: string): Promise<boolean> {
  const path = source.startsWith("file:") ? new URL(source).pathname : source;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false;
  try {
    await access(path, constants.R_OK);
    return false;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EACCES"
    );
  }
}
