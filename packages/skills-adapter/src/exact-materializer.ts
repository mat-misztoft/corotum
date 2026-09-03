import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { DomainErrorCode, V2LockedSkill } from "../../core/src/index";
import { ArtifactArchiveError, stageArtifactArchive } from "./artifact-archive";
import { CanonicalStoreError } from "./canonical-store";
import { GitSkillMaterializer, GitSourceError } from "./git-source";
import { scanNormalizedContent } from "./normalized-content";

export type MaterializationErrorCode = Extract<
  DomainErrorCode,
  | "AUTH_REQUIRED"
  | "SOURCE_UNAVAILABLE"
  | "ARTIFACT_UNAVAILABLE"
  | "CONTENT_HASH_MISMATCH"
  | "LOCAL_CONFLICT"
  | "DRIFTED"
  | "NETWORK_ERROR"
>;

/** A stable, transport-independent failure reported by the local installer. */
export class MaterializationError extends Error {
  readonly name = "MaterializationError";
  constructor(readonly code: MaterializationErrorCode, message: string) {
    super(message);
  }
}

export type ArtifactReader = (
  locator: string,
) => Promise<Uint8Array>;

/** Resolves a git-tree artifact locator to an existing sanitized directory. */
export type ArtifactTreeResolver = (locator: string) => Promise<string>;

export type VerifiedStagingDirectory = Readonly<{
  directory: string;
  contentHash: `sha256:${string}`;
  cleanup: () => Promise<void>;
}>;

/**
 * Acquires one exact v2 lock into an unpublished, hash-verified directory.
 * Callers own publication, so every failed acquisition leaves local installs intact.
 */
export class ExactContentMaterializer {
  constructor(
    private readonly git: GitSkillMaterializer = new GitSkillMaterializer(),
    private readonly readArtifact: ArtifactReader = async (locator) =>
      new Uint8Array(await readFile(locator)),
    private readonly resolveArtifactTree: ArtifactTreeResolver = async (locator) => locator,
  ) {}

  async stage(lock: V2LockedSkill): Promise<VerifiedStagingDirectory> {
    const root = await mkdtemp(join(tmpdir(), "corotum-materialize-"));
    const directory = join(root, "skill");
    try {
      if (lock.materialization.kind === "source") {
        if (!lock.source) throw new MaterializationError("SOURCE_UNAVAILABLE", "Source materialization has no immutable source lock.");
        await this.git.materializeLockedSource(lock.source, directory);
      } else if (lock.materialization.artifact.kind === "git-tree") {
        const tree = await this.resolveArtifactTree(lock.materialization.artifact.locator);
        const metadata = await lstat(tree).catch(() => null);
        if (metadata?.isDirectory()) {
          await stageGitTree(tree, directory);
        } else {
          let bytes: Uint8Array;
          try { bytes = await this.readArtifact(lock.materialization.artifact.locator); }
          catch (error) { throw mapMaterializationError(error, "artifact"); }
          const staging = await stageArtifactArchive(bytes, root, lock.materialization.artifact);
          await rename(staging, directory);
        }
      } else {
        let bytes: Uint8Array;
        try { bytes = await this.readArtifact(lock.materialization.artifact.locator); }
        catch (error) { throw mapMaterializationError(error, "artifact"); }
        const staging = await stageArtifactArchive(bytes, root, lock.materialization.artifact);
        await rename(staging, directory);
      }
      const expected = lock.materialization.kind === "source"
        ? lock.materialization.contentHash
        : lock.materialization.artifact.contentHash;
      if (lock.materialization.kind === "source") {
        const scanned = await scanNormalizedContent(directory);
        if (scanned.contentHash !== expected) {
          throw new MaterializationError("CONTENT_HASH_MISMATCH", "Selected content does not match the locked content hash.");
        }
        return { directory, contentHash: scanned.contentHash, cleanup: () => rm(root, { force: true, recursive: true }) };
      }
      return { directory, contentHash: expected, cleanup: () => rm(root, { force: true, recursive: true }) };
    } catch (error) {
      await rm(root, { force: true, recursive: true });
      throw mapMaterializationError(error, lock.materialization.kind);
    }
  }
}

async function stageGitTree(source: string, destination: string): Promise<void> {
  const scanned = await scanNormalizedContent(source);
  await mkdir(destination, { recursive: true });
  for (const file of scanned.files) {
    const target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, { mode: 0o600 });
  }
}

/** Maps adapter and filesystem failures without exposing transport internals. */
export function mapMaterializationError(
  error: unknown,
  transport: "source" | "artifact" = "source",
): MaterializationError {
  if (error instanceof MaterializationError) return error;
  if (error instanceof GitSourceError) {
    const code = error.code === "AUTH_REQUIRED" ? "AUTH_REQUIRED"
      : error.code === "HASH_MISMATCH" ? "CONTENT_HASH_MISMATCH"
      : "SOURCE_UNAVAILABLE";
    return new MaterializationError(code, error.message);
  }
  if (error instanceof ArtifactArchiveError) return new MaterializationError(error.code, error.message);
  if (error instanceof CanonicalStoreError) {
    return new MaterializationError(error.code === "LOCAL_CONFLICT" ? "LOCAL_CONFLICT" : "SOURCE_UNAVAILABLE", error.message);
  }
  const candidate = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code : undefined;
  if (candidate === "DRIFTED" || candidate === "LOCAL_CONFLICT" || candidate === "NETWORK_ERROR") {
    return new MaterializationError(candidate, error instanceof Error ? error.message : String(candidate));
  }
  if (candidate === "ENOENT" && transport === "artifact") {
    return new MaterializationError("ARTIFACT_UNAVAILABLE", "Artifact is unavailable.");
  }
  return new MaterializationError(
    transport === "artifact" ? "ARTIFACT_UNAVAILABLE" : "SOURCE_UNAVAILABLE",
    error instanceof Error ? error.message : "Exact content materialization failed.",
  );
}
