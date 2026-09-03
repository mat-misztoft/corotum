import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { hashSkillDirectory } from "../../../packages/skills-adapter/src/canonical-store";
import { normalizeGitSource } from "../../../packages/skills-adapter/src/git-source";

export type InitProvenance = Readonly<{
  status: "source-known" | "source-unknown";
  reason?: "invalid-lockfile" | "missing-provenance" | "nonmatching-provenance";
  source?: string;
  sourceType?: string;
  sourceUrl?: string;
  skillPath?: string;
  skillFolderHash?: string;
}>;

export type DiscoveredInitCandidate = Readonly<{
  contentHash: string;
  name: string;
  normalizedName: string;
  path: string;
  provenance: InitProvenance;
}>;

type LockEntry = Readonly<{
  name: string;
  source?: unknown;
  sourceType?: unknown;
  sourceUrl?: unknown;
  skillPath?: unknown;
  skillFolderHash?: unknown;
}>;

type ValidLockEntry = Readonly<{
  name: string;
  source: string;
  sourceType: string;
  sourceUrl: string;
  skillPath: string;
  skillFolderHash: string;
}>;

type Locks = Readonly<{ entries: readonly LockEntry[]; invalid: boolean }>;

/**
 * Reads the shared Agent Skills directory without treating it as managed state.
 * A lock record is provenance only: it never establishes ownership or proves
 * that the current directory matches a recorded hash.
 */
export async function discoverInitProvenance(
  homeDir: string,
): Promise<readonly DiscoveredInitCandidate[]> {
  const root = join(homeDir, ".agents", "skills");
  const entries = await readDirectories(root);
  const locks = await readLocks(join(homeDir, ".agents", ".skill-lock.json"));
  return Promise.all(
    entries.map(async (entry) => ({
      name: entry.name,
      normalizedName: normalizeCandidateName(entry.name),
      path: join(root, entry.name),
      contentHash: await hashSkillDirectory(join(root, entry.name)),
      provenance: provenanceFor(entry.name, locks),
    })),
  );
}

async function readDirectories(root: string) {
  try {
    return (await readdir(root, { encoding: "utf8", withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

async function readLocks(path: string): Promise<Locks> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) return { entries: [], invalid: true };
    const records =
      "skills" in parsed && isRecord(parsed.skills) ? parsed.skills : parsed;
    return {
      entries: Object.entries(records).flatMap(([name, value]) =>
        isRecord(value) ? [{ name, ...value }] : [],
      ),
      invalid: false,
    };
  } catch (error) {
    return { entries: [], invalid: !isNotFound(error) };
  }
}

function provenanceFor(name: string, locks: Locks): InitProvenance {
  const matches = locks.entries.filter((entry) => {
    if (!hasRequiredFields(entry)) return false;
    return (
      normalizeCandidateName(entry.name) === normalizeCandidateName(name) &&
      !!skillDirectoryPath(entry.skillPath)
    );
  });
  if (matches.length === 0) {
    return {
      status: "source-unknown",
      reason: locks.invalid ? "invalid-lockfile" : "missing-provenance",
    };
  }
  if (matches.length !== 1)
    return { status: "source-unknown", reason: "nonmatching-provenance" };

  const [entry] = matches;
  if (!hasRequiredFields(entry))
    return { status: "source-unknown", reason: "missing-provenance" };
  const skillPath = skillDirectoryPath(entry.skillPath);
  if (!skillPath) {
    return { status: "source-unknown", reason: "nonmatching-provenance" };
  }
  try {
    const sourceUrl = normalizeGitSource(entry.sourceUrl);
    return {
      status: "source-known",
      source: entry.source,
      sourceType: entry.sourceType,
      sourceUrl,
      skillPath,
      skillFolderHash: entry.skillFolderHash,
    };
  } catch {
    return { status: "source-unknown", reason: "nonmatching-provenance" };
  }
}

function hasRequiredFields(entry: LockEntry): entry is ValidLockEntry {
  return [
    entry.source,
    entry.sourceType,
    entry.sourceUrl,
    entry.skillPath,
    entry.skillFolderHash,
  ].every((value) => typeof value === "string" && value.trim().length > 0);
}

function skillDirectoryPath(path: string): string | null {
  const normalized = normalizeSkillPath(path);
  if (!normalized) return null;
  if (posix.basename(normalized).toLowerCase() === "skill.md") {
    const directory = posix.dirname(normalized);
    return directory === "." ? null : directory;
  }
  return normalized;
}

function normalizeSkillPath(path: string): string | null {
  const normalized = posix
    .normalize(path.replaceAll("\\", "/"))
    .replace(/^\.\//, "");
  return normalized === "." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
    ? null
    : normalized;
}

function normalizeCandidateName(name: string): string {
  return name.normalize("NFC").trim().toLocaleLowerCase("en-US");
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
