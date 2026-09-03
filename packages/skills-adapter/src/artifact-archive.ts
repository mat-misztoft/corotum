import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { scanNormalizedContent } from "./normalized-content";

const BLOCK = 512;
const MAX_ENTRIES = 10_000;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_PATH_BYTES = 240;
const encoder = new TextEncoder();

export type ArtifactArchive = Readonly<{
  bytes: Uint8Array;
  contentHash: `sha256:${string}`;
  integrityHash: `sha256:${string}`;
  sizeBytes: number;
}>;

/** Archive input failures never publish or modify an installed destination. */
export class ArtifactArchiveError extends Error {
  readonly name = "ArtifactArchiveError";

  constructor(
    readonly code: "ARTIFACT_UNAVAILABLE" | "CONTENT_HASH_MISMATCH",
    message: string,
  ) {
    super(message);
  }
}

/** Creates a byte-stable USTAR payload compressed at a fixed Zstandard level. */
export async function createArtifactArchive(
  directory: string,
): Promise<ArtifactArchive> {
  const content = await scanNormalizedContent(directory);
  const blocks: Uint8Array[] = [];
  for (const file of content.files) {
    assertArchivePath(file.path);
    blocks.push(
      tarHeader(file.path, file.content.length),
      file.content,
      new Uint8Array(padding(file.content.length)),
    );
  }
  const tar = concat([...blocks, new Uint8Array(BLOCK * 2)]);
  const bytes = Bun.zstdCompressSync(tar, { level: 6 });
  return {
    bytes,
    contentHash: content.contentHash,
    integrityHash: sha256(bytes),
    sizeBytes: bytes.length,
  };
}

/** Validates an archive and returns an unpublished verified staging directory. */
export async function stageArtifactArchive(
  bytes: Uint8Array,
  stagingParent: string,
  expected: Readonly<{
    integrityHash: `sha256:${string}`;
    contentHash: `sha256:${string}`;
  }>,
): Promise<string> {
  if (sha256(bytes) !== expected.integrityHash)
    throw mismatch("Artifact integrity hash does not match.");
  let tar: Uint8Array;
  try {
    tar = Bun.zstdDecompressSync(bytes);
  } catch {
    throw unavailable("Artifact stream is corrupt or unavailable.");
  }
  const entries = parseTar(tar);
  if (hashTarEntries(entries) !== expected.contentHash) {
    throw mismatch("Extracted artifact content hash does not match.");
  }
  await mkdir(stagingParent, { recursive: true });
  const staging = await mkdtemp(join(stagingParent, ".corotum-artifact-"));
  try {
    for (const entry of entries) {
      const path = join(staging, ...entry.path.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entry.content, { mode: 0o644 });
    }
    return staging;
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
}

/** Validates the complete archive before publishing it atomically. */
export async function extractArtifactArchive(
  bytes: Uint8Array,
  destination: string,
  expected: Readonly<{
    integrityHash: `sha256:${string}`;
    contentHash: `sha256:${string}`;
  }>,
): Promise<void> {
  const staging = await stageArtifactArchive(
    bytes,
    dirname(destination),
    expected,
  );
  try {
    await publish(staging, destination);
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
}

type TarEntry = Readonly<{ path: string; content: Uint8Array }>;

/** Parses a raw TAR and returns only regular files with validated relative paths. */
export function validatedTarFiles(tar: Uint8Array): readonly TarEntry[] {
  return parseTar(tar);
}

function parseTar(input: Uint8Array): TarEntry[] {
  const tar = padTar(input);
  if (tar.length < BLOCK) throw unavailable("Artifact TAR is malformed.");
  const entries: TarEntry[] = [];
  const paths = new Set<string>();
  let offset = 0;
  let expanded = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.slice(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      return entries;
    }
    if (offset + BLOCK > tar.length || !validChecksum(header))
      throw unavailable("Artifact TAR header is invalid.");
    const type = String.fromCharCode(header[156]!);
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = readOctal(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_EXPANDED_BYTES)
      throw unavailable("Artifact TAR entry size is invalid.");
    const start = offset + BLOCK;
    const end = start + size;
    if (end > tar.length) throw unavailable("Artifact TAR is truncated.");
    offset = end + padding(size);
    if (type === "g" || type === "x") {
      expanded += size;
      if (expanded > MAX_EXPANDED_BYTES)
        throw unavailable("Artifact exceeds extraction limits.");
      continue;
    }
    if (type === "5") {
      if (size !== 0)
        throw unavailable("Artifact TAR directory entry has a payload.");
      assertArchivePath(path.replace(/\/+$/, ""));
      continue;
    }
    assertArchivePath(path);
    if (type !== "\0" && type !== "0")
      throw unavailable("Artifact TAR contains a non-regular entry.");
    if (paths.has(path))
      throw unavailable("Artifact TAR contains duplicate paths.");
    paths.add(path);
    expanded += size;
    if (entries.length >= MAX_ENTRIES || expanded > MAX_EXPANDED_BYTES)
      throw unavailable("Artifact exceeds extraction limits.");
    entries.push({ path, content: tar.slice(start, end) });
  }
  if (entries.length === 0) throw unavailable("Artifact TAR is malformed.");
  return entries;
}

function padTar(tar: Uint8Array): Uint8Array {
  const rem = tar.length % BLOCK;
  if (rem === 0) return tar;
  const padded = new Uint8Array(tar.length + (BLOCK - rem));
  padded.set(tar);
  return padded;
}

function tarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  writeString(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = 48;
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeOctal(
    header,
    148,
    8,
    header.reduce((sum, byte) => sum + byte, 0),
  );
  return header;
}

function assertArchivePath(path: string): void {
  const bytes = encoder.encode(path).length;
  if (
    !path ||
    bytes > MAX_PATH_BYTES ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw unavailable("Artifact contains an unsafe path.");
  }
}
function validChecksum(header: Uint8Array): boolean {
  const expected = readOctal(header, 148, 8);
  const actual = header.reduce(
    (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
    0,
  );
  return expected === actual;
}
function readOctal(bytes: Uint8Array, offset: number, length: number): number {
  const source = readString(bytes, offset, length).trim();
  return /^[0-7]*$/.test(source)
    ? Number.parseInt(source || "0", 8)
    : Number.NaN;
}
function writeOctal(
  bytes: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const text = value.toString(8).padStart(length - 1, "0");
  writeString(bytes, offset, length, text);
}
function readString(bytes: Uint8Array, offset: number, length: number): string {
  const end = bytes.slice(offset, offset + length).indexOf(0);
  return new TextDecoder().decode(
    bytes.slice(offset, offset + (end < 0 ? length : end)),
  );
}
function writeString(
  bytes: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const encoded = encoder.encode(value);
  if (encoded.length > length) throw unavailable("Artifact path is too long.");
  bytes.set(encoded, offset);
}
function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function hashTarEntries(entries: readonly TarEntry[]): `sha256:${string}` {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const entry of entries) {
    hasher.update(`${entry.path}\0`);
    hasher.update(entry.content);
    hasher.update("\0");
  }
  return `sha256:${hasher.digest("hex")}`;
}
function sha256(value: Uint8Array): `sha256:${string}` {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return `sha256:${hasher.digest("hex")}`;
}
async function publish(staging: string, destination: string): Promise<void> {
  const backup = `${destination}.${crypto.randomUUID()}.backup`;
  let moved = false;
  try {
    await rename(destination, backup);
    moved = true;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  try {
    await rename(staging, destination);
    if (moved) await rm(backup, { force: true, recursive: true });
  } catch (error) {
    if (moved) await rename(backup, destination).catch(() => undefined);
    throw error;
  }
}
function unavailable(message: string): ArtifactArchiveError {
  return new ArtifactArchiveError("ARTIFACT_UNAVAILABLE", message);
}
function mismatch(message: string): ArtifactArchiveError {
  return new ArtifactArchiveError("CONTENT_HASH_MISMATCH", message);
}
