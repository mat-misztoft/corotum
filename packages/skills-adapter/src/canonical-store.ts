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
}

/** Owns one local managed copy per stable skill ID. */
export class CanonicalSkillStore {
  constructor(private readonly root: string) {}

  pathFor(id: SkillId): string {
    try {
      return join(this.root, skillId(id as string));
    } catch {
      throw new CanonicalStoreError("Invalid stable skill ID.");
    }
  }

  /**
   * Verifies a complete staged copy before atomically replacing the managed copy.
   * The prior copy is restored if the final replacement cannot be completed.
   */
  async replaceFromDirectory(
    id: SkillId,
    source: string,
    expectedContentHash: string,
  ): Promise<string> {
    const destination = this.pathFor(id);
    const staging = join(
      this.root,
      `.${basename(destination)}.${crypto.randomUUID()}.staging`,
    );
    const backup = join(
      this.root,
      `.${basename(destination)}.${crypto.randomUUID()}.backup`,
    );

    await mkdir(this.root, { recursive: true });
    try {
      await cp(source, staging, { errorOnExist: true, recursive: true });
      const actualContentHash = await hashSkillDirectory(staging);
      if (actualContentHash !== expectedContentHash) {
        throw new CanonicalStoreError(
          "Skill content does not match its expected hash.",
        );
      }
      await replaceDirectory(staging, destination, backup);
      return actualContentHash;
    } finally {
      await rm(staging, { force: true, recursive: true });
    }
  }

  async remove(id: SkillId): Promise<void> {
    await rm(this.pathFor(id), { force: true, recursive: true });
  }
}

/** Produces a deterministic hash of a skill directory's paths and file bytes. */
export async function hashSkillDirectory(directory: string): Promise<string> {
  const files = await filesIn(directory);
  const hasher = new Bun.CryptoHasher("sha256");

  for (const file of files) {
    const path = relative(directory, file).replaceAll("\\", "/");
    const metadata = await lstat(file);
    if (!metadata.isFile()) {
      throw new CanonicalStoreError(
        "Skill directories may contain only files and directories.",
      );
    }
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
    if (entry.isDirectory()) {
      files.push(...(await filesIn(path)));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new CanonicalStoreError(
        "Skill directories may contain only files and directories.",
      );
    }
  }
  return files;
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
