import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { type SkillId, skillId } from "../../core/src/index";

export class CanonicalStoreError extends Error {
  readonly name = "CanonicalStoreError";

  constructor(
    message: string,
    readonly code: "LOCAL_CONFLICT" | "VALIDATION_ERROR" = "VALIDATION_ERROR",
  ) {
    super(message);
  }
}

/** Owns one local managed copy per skill name; stable IDs live in state metadata. */
export class CanonicalSkillStore {
  constructor(private readonly root: string) {}

  pathFor(name: string): string {
    assertSkillName(name);
    return join(this.root, name);
  }

  /**
   * Verifies staged bytes before atomically replacing a named canonical copy.
   * An existing directory is replaceable only with matching, recorded ownership.
   */
  async replaceFromDirectory(
    id: SkillId,
    name: string,
    source: string,
    expectedContentHash: string,
    existing?: Readonly<{
      skillId: SkillId;
      contentHash: string;
      allowDrift?: boolean;
    }>,
  ): Promise<string> {
    skillId(id as string);
    const destination = this.pathFor(name);
    const staging = join(
      this.root,
      `.${basename(destination)}.${crypto.randomUUID()}.staging`,
    );
    const backup = join(
      this.root,
      `.${basename(destination)}.${crypto.randomUUID()}.backup`,
    );

    await mkdir(this.root, { recursive: true });
    let replaced = false;
    try {
      if (await hasCaseCollision(this.root, name)) {
        throw new CanonicalStoreError(
          "A differently cased named canonical skill already exists.",
          "LOCAL_CONFLICT",
        );
      }
      if (await exists(destination)) {
        if (
          !existing ||
          existing.skillId !== id ||
          (!existing.allowDrift &&
            (await hashSkillDirectory(destination)) !== existing.contentHash)
        ) {
          throw new CanonicalStoreError(
            "Existing named canonical skill is not verified Corotum-owned content.",
            "LOCAL_CONFLICT",
          );
        }
      }
      await cp(source, staging, { errorOnExist: true, recursive: true });
      const actualContentHash = await hashSkillDirectory(staging);
      if (actualContentHash !== expectedContentHash) {
        throw new CanonicalStoreError(
          "Skill content does not match its expected hash.",
        );
      }
      await replaceDirectory(staging, destination, backup);
      replaced = true;
      return actualContentHash;
    } finally {
      await rm(staging, { force: true, recursive: true });
      if (replaced) await rm(backup, { force: true, recursive: true });
    }
  }

  async remove(
    id: SkillId,
    name: string,
    expectedContentHash: string,
  ): Promise<void> {
    skillId(id as string);
    const destination = this.pathFor(name);
    if (!(await exists(destination))) return;
    if ((await hashSkillDirectory(destination)) !== expectedContentHash) {
      throw new CanonicalStoreError(
        "Named canonical skill is not verified Corotum-owned content.",
        "LOCAL_CONFLICT",
      );
    }
    await rm(destination, { force: true, recursive: true });
  }
}

function assertSkillName(name: string): void {
  if (!name || basename(name) !== name || name === "." || name === "..") {
    throw new CanonicalStoreError("Skill names must be a single path segment.");
  }
}

/** Produces a deterministic hash of a skill directory's paths and file bytes. */
export async function hashSkillDirectory(directory: string): Promise<string> {
  const files = await filesIn(directory);
  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    const path = relative(directory, file).replaceAll("\\", "/");
    const metadata = await lstat(file);
    if (!metadata.isFile())
      throw new CanonicalStoreError(
        "Skill directories may contain only files and directories.",
      );
    hasher.update(`${path}\0`);
    hasher.update(await readFile(file));
    hasher.update("\0");
  }
  return `sha256:${hasher.digest("hex")}`;
}

async function filesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(path)));
    else if (entry.isFile()) files.push(path);
    else
      throw new CanonicalStoreError(
        "Skill directories may contain only files and directories.",
      );
  }
  return files;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function hasCaseCollision(root: string, name: string): Promise<boolean> {
  const normalized = name.toLocaleLowerCase("en-US");
  const entries = await readdir(root, { withFileTypes: true });
  return entries.some(
    (entry) =>
      entry.name !== name &&
      entry.name.toLocaleLowerCase("en-US") === normalized,
  );
}

async function replaceDirectory(
  staging: string,
  destination: string,
  backup: string,
): Promise<void> {
  let previousMoved = false;
  try {
    await rename(destination, backup);
    previousMoved = true;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    await rename(staging, destination);
  } catch (error) {
    if (previousMoved) await rename(backup, destination);
    throw error;
  }
  if (previousMoved) await rm(backup, { force: true, recursive: true });
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
