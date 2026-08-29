import { cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { skillId } from "../../../packages/core/src/index";
import { hashSkillDirectory } from "../../../packages/skills-adapter/src/canonical-store";

export class SkillsStorageMigrationError extends Error {
  readonly name = "SkillsStorageMigrationError";
}

export type SkillTargetMigrator = Readonly<{
  /**
   * Repoints managed target references and returns an operation that restores
   * them. An implementation must undo any partial work before it rejects.
   */
  migrate(from: string, to: string): Promise<() => Promise<void>>;
}>;

const noTargets: SkillTargetMigrator = {
  async migrate() {
    return async () => {};
  },
};

/** Moves canonical storage without exposing a partial store through config. */
export class SkillsStorageMigrator {
  constructor(
    private readonly targets: SkillTargetMigrator = noTargets,
    private readonly copyDirectory: (
      source: string,
      destination: string,
    ) => Promise<void> = (source, destination) =>
      cp(source, destination, { errorOnExist: true, recursive: true }),
  ) {}

  async migrate(input: {
    from: string;
    to: string;
    persist: () => Promise<void>;
  }): Promise<void> {
    const from = resolve(input.from);
    const to = resolve(input.to);
    if (from === to) return;
    if (contains(from, to) || contains(to, from)) {
      throw new SkillsStorageMigrationError(
        "The new skills storage path cannot contain the current path or be contained by it.",
      );
    }

    await assertMissing(to);
    await mkdir(dirname(to), { recursive: true });
    const staging = `${to}.${crypto.randomUUID()}.staging`;
    const backup = `${from}.${crypto.randomUUID()}.backup`;
    let sourceExists = false;
    let oldMoved = false;
    let newInstalled = false;
    let rollbackTargets: (() => Promise<void>) | undefined;
    let persisted = false;

    try {
      sourceExists = await exists(from);
      if (sourceExists) {
        await this.copyDirectory(from, staging);
        await verifySameCanonicalContent(from, staging);
      } else {
        await mkdir(staging);
      }

      if (sourceExists) {
        await rename(from, backup);
        oldMoved = true;
      }
      await rename(staging, to);
      newInstalled = true;

      rollbackTargets = await this.targets.migrate(from, to);
      await input.persist();
      persisted = true;

      if (oldMoved) await rm(backup, { force: true, recursive: true });
    } catch (error) {
      if (!persisted) {
        const rollbackErrors = await rollback(
          rollbackTargets,
          to,
          from,
          backup,
          oldMoved,
          newInstalled,
        );
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            "Skills storage migration failed and could not fully roll back.",
          );
        }
      }
      throw error;
    } finally {
      await rm(staging, { force: true, recursive: true });
    }
  }
}

async function verifySameCanonicalContent(
  source: string,
  candidate: string,
): Promise<void> {
  const sourceSkills = await canonicalHashes(source);
  const candidateSkills = await canonicalHashes(candidate);
  if (
    sourceSkills.size !== candidateSkills.size ||
    [...sourceSkills].some(([id, hash]) => candidateSkills.get(id) !== hash)
  ) {
    throw new SkillsStorageMigrationError(
      "The copied canonical skills do not match the current storage.",
    );
  }
}

async function canonicalHashes(root: string): Promise<Map<string, string>> {
  const entries = await readdir(root, { withFileTypes: true });
  const hashes = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      throw new SkillsStorageMigrationError(
        "Canonical storage may contain only skill directories during migration.",
      );
    }
    try {
      skillId(entry.name);
    } catch {
      throw new SkillsStorageMigrationError(
        "Canonical storage contains an invalid stable skill ID.",
      );
    }
    const directory = `${root}${sep}${entry.name}`;
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink()) {
      throw new SkillsStorageMigrationError(
        "Canonical storage may not contain symbolic links.",
      );
    }
    hashes.set(entry.name, await hashSkillDirectory(directory));
  }
  return hashes;
}

async function rollback(
  rollbackTargets: (() => Promise<void>) | undefined,
  to: string,
  from: string,
  backup: string,
  oldMoved: boolean,
  newInstalled: boolean,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (rollbackTargets) {
    try {
      await rollbackTargets();
    } catch (error) {
      errors.push(error);
    }
  }
  if (newInstalled) {
    try {
      await rm(to, { force: true, recursive: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (oldMoved) {
    try {
      await rename(backup, from);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function assertMissing(path: string): Promise<void> {
  if (await exists(path)) {
    throw new SkillsStorageMigrationError(
      "The new skills storage path already exists.",
    );
  }
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

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith(`..${sep}`) && path !== "..";
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
