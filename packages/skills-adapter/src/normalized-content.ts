import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export type NormalizedContentFile = Readonly<{
  path: string;
  content: Uint8Array;
}>;

export type NormalizedContent = Readonly<{
  files: readonly NormalizedContentFile[];
  contentHash: `sha256:${string}`;
}>;

/** A safe scan failure; messages name paths and rules but never file contents. */
export class ContentScanError extends Error {
  readonly name = "ContentScanError";

  constructor(
    readonly code:
      | "DENYLISTED_PATH"
      | "INVALID_IGNORE"
      | "INVALID_PATH"
      | "UNREADABLE_ENTRY"
      | "UNSAFE_ENTRY",
    message: string,
  ) {
    super(message);
  }
}

type IgnoreRule = Readonly<{ pattern: string; negated: boolean }>;

const ignoreFileName = ".corotumignore";
const denylist: readonly Readonly<{ pattern: string; matches: (path: string) => boolean }>[] = [
  { pattern: ".env", matches: (path) => basename(path) === ".env" },
  { pattern: ".env.*", matches: (path) => basename(path).startsWith(".env.") },
  { pattern: ".npmrc", matches: (path) => basename(path) === ".npmrc" },
  { pattern: ".netrc", matches: (path) => basename(path) === ".netrc" },
  { pattern: "*.pem", matches: (path) => basename(path).endsWith(".pem") },
  { pattern: "*.key", matches: (path) => basename(path).endsWith(".key") },
  { pattern: "*.p12", matches: (path) => basename(path).endsWith(".p12") },
  { pattern: "*.pfx", matches: (path) => basename(path).endsWith(".pfx") },
  { pattern: "*.secret", matches: (path) => basename(path).endsWith(".secret") },
  { pattern: "id_rsa", matches: (path) => basename(path) === "id_rsa" },
  { pattern: "id_dsa", matches: (path) => basename(path) === "id_dsa" },
  { pattern: "id_ecdsa", matches: (path) => basename(path) === "id_ecdsa" },
  { pattern: "id_ed25519", matches: (path) => basename(path) === "id_ed25519" },
  { pattern: "credentials", matches: (path) => basename(path) === "credentials" },
  { pattern: "credentials.*", matches: (path) => basename(path).startsWith("credentials.") },
  { pattern: "secrets", matches: (path) => basename(path) === "secrets" },
  { pattern: "secrets.*", matches: (path) => basename(path).startsWith("secrets.") },
];

/**
 * Selects a directory's regular files deterministically for artifact creation.
 *
 * `.corotumignore` is configuration, never payload. Rules are evaluated in
 * file order and the final matching rule wins; `!pattern` re-includes. Before
 * that evaluation every discovered entry is checked against the denylist, so
 * an ignore rule can never hide a potential secret.
 */
export async function scanNormalizedContent(directory: string): Promise<NormalizedContent> {
  const root = resolve(directory);
  const rootStat = await lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ContentScanError("INVALID_PATH", "Content root must be a real directory.");
  }

  const ignoreRules = await readIgnoreFile(root);
  const files = await enumerate(root, root);
  const selected: NormalizedContentFile[] = [];

  for (const file of files) {
    if (file.path !== ignoreFileName && !ignored(file.path, ignoreRules)) selected.push(file);
  }

  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of selected) {
    hasher.update(`${file.path}\0`);
    hasher.update(file.content);
    hasher.update("\0");
  }
  return { files: selected, contentHash: `sha256:${hasher.digest("hex")}` };
}

async function enumerate(root: string, directory: string): Promise<NormalizedContentFile[]> {
  const directoryPath = directory === root ? "content root" : safeRelativePath(root, directory);
  const directoryStat = await lstat(directory).catch(() => null);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) throw unsafe(directoryPath, "changed or symbolic directory");

  const entries = await readdir(directory, { withFileTypes: true }).catch(() => {
    throw unreadable(directoryPath);
  });
  const files: NormalizedContentFile[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(directory, entry.name);
    const path = safeRelativePath(root, absolute);
    const stat = await lstat(absolute).catch(() => {
      throw unreadable(path);
    });
    if (stat.isSymbolicLink()) throw unsafe(path, "symbolic link or reparse point");
    const denied = denylist.find(({ matches }) => matches(path));
    if (denied) throw new ContentScanError("DENYLISTED_PATH", `Denied path ${path} matches ${denied.pattern}.`);
    if (stat.isDirectory()) {
      files.push(...(await enumerate(root, absolute)));
    } else if (stat.isFile()) {
      const content = await readFile(absolute).catch(() => {
        throw unreadable(path);
      });
      const afterRead = await lstat(absolute).catch(() => {
        throw unreadable(path);
      });
      if (!afterRead.isFile() || afterRead.isSymbolicLink()) throw unsafe(path, "changed or symbolic entry");
      files.push({ path, content });
    } else {
      throw unsafe(path, "non-regular entry");
    }
  }
  return files;
}

async function readIgnoreFile(root: string): Promise<readonly IgnoreRule[]> {
  const path = join(root, ignoreFileName);
  const stat = await lstat(path).catch(() => null);
  if (!stat) return [];
  if (!stat.isFile() || stat.isSymbolicLink()) throw unsafe(ignoreFileName, "ignore file is not a regular file");
  const source = await readFile(path, "utf8").catch(() => {
    throw unreadable(ignoreFileName);
  });
  const afterRead = await lstat(path).catch(() => {
    throw unreadable(ignoreFileName);
  });
  if (!afterRead.isFile() || afterRead.isSymbolicLink()) throw unsafe(ignoreFileName, "changed or symbolic ignore file");
  if (source.trim().length === 0) throw new ContentScanError("INVALID_IGNORE", ".corotumignore must not be empty.");
  const rules: IgnoreRule[] = [];
  const seen = new Map<string, boolean>();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const pattern = (negated ? line.slice(1) : line).replaceAll("\\", "/");
    if (!validPattern(pattern)) throw new ContentScanError("INVALID_IGNORE", `Invalid .corotumignore pattern ${JSON.stringify(line)}.`);
    if (seen.get(pattern) === !negated) throw new ContentScanError("INVALID_IGNORE", `Conflicting .corotumignore pattern ${JSON.stringify(pattern)}.`);
    seen.set(pattern, negated);
    rules.push({ pattern, negated });
  }
  if (rules.length === 0) throw new ContentScanError("INVALID_IGNORE", ".corotumignore has no rules.");
  return rules;
}

function validPattern(pattern: string): boolean {
  return Boolean(pattern) && !pattern.startsWith("/") && !pattern.split("/").some((part) => part === ".." || part === ".") && !pattern.includes("\0");
}

function ignored(path: string, rules: readonly IgnoreRule[]): boolean {
  let selected = true;
  for (const rule of rules) if (matchesIgnore(path, rule.pattern)) selected = rule.negated;
  return !selected;
}

function matchesIgnore(path: string, pattern: string): boolean {
  const expression = pattern
    .split("**").map((part) => part.split("*").map(escapeRegex).join("[^/]*")).join(".*");
  const regex = new RegExp(`^${pattern.includes("/") ? "" : "(?:.*/)?"}${expression}$`);
  return regex.test(path);
}

function safeRelativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value.startsWith("../") || value === ".." || value.startsWith("/")) {
    throw new ContentScanError("INVALID_PATH", "Content entry has an unsafe relative path.");
  }
  return value;
}

function basename(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }
function escapeRegex(value: string): string { return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"); }
function unreadable(path: string): ContentScanError { return new ContentScanError("UNREADABLE_ENTRY", `Unreadable path ${path}.`); }
function unsafe(path: string, reason: string): ContentScanError { return new ContentScanError("UNSAFE_ENTRY", `Unsafe path ${path}: ${reason}.`); }
