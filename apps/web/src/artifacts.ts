import { skillId as parseSkillId } from "../../../packages/core/src/index";
import {
  type CloudDesiredState,
  isV2CloudState,
  loadCurrentDesiredState,
} from "./revisions";
import type { TokenDatabase } from "./tokens";
import type { WorkspaceDatabase } from "./workspaces";

const HASH = /^sha256:[a-f0-9]{64}$/;
const BLOCK = 512;
const MAX_ENTRIES = 10_000;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_PATH_BYTES = 240;
const encoder = new TextEncoder();

export type ArtifactDescriptor = Readonly<{
  kind: "r2-tar-zst";
  contentHash: `sha256:${string}`;
  integrityHash: `sha256:${string}`;
  locator: string;
  sizeBytes: number;
}>;

export type ArtifactTransfer = Readonly<{
  skillId: string;
  artifact: ArtifactDescriptor;
}>;

export type ArtifactBucket = {
  put(key: string, value: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list(
    prefix: string,
  ): Promise<{ keys: readonly string[]; truncated: boolean }>;
  delete(key: string): Promise<void>;
};

export class ArtifactTransferError extends Error {
  readonly name = "ArtifactTransferError";
  constructor(
    readonly code:
      | "ARTIFACT_UNAVAILABLE"
      | "CONTENT_HASH_MISMATCH"
      | "VALIDATION_ERROR",
    message: string,
  ) {
    super(message);
  }
}

export class ArtifactGcAmbiguousError extends Error {
  readonly name = "ArtifactGcAmbiguousError";
  constructor(message = "Artifact garbage collection is ambiguous.") {
    super(message);
  }
}

export class ArtifactMetadataError extends Error {
  readonly name = "ArtifactMetadataError";
  constructor() {
    super("Artifact metadata could not be recorded.");
  }
}

/** Workspace-scoped R2 key; integrity hash is the transport digest, including the sha256: prefix. */
export function cloudArtifactLocator(
  workspaceId: string,
  skillId: string,
  integrityHash: string,
): string {
  return `workspaces/${workspaceId}/artifacts/${skillId}/${integrityHash}.tar.zst`;
}

type R2ObjectStore = {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  list(options: { prefix: string; cursor?: string; limit: number }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(key: string): Promise<unknown>;
};

export function r2ArtifactBucket(r2: R2ObjectStore): ArtifactBucket {
  return {
    async put(key, value) {
      await r2.put(key, value);
    },
    async get(key) {
      const object = await r2.get(key);
      if (!object) return null;
      return new Uint8Array(await object.arrayBuffer());
    },
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await r2.list({ prefix, cursor, limit: 1000 });
        for (const object of page.objects) keys.push(object.key);
        if (!page.truncated) return { keys, truncated: false };
        if (!page.cursor) return { keys, truncated: true };
        cursor = page.cursor;
      } while (cursor);
      return { keys, truncated: false };
    },
    async delete(key) {
      await r2.delete(key);
    },
  };
}

export function memoryArtifactBucket(): ArtifactBucket & {
  objects: Map<string, Uint8Array>;
} {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key, value) {
      objects.set(key, value.slice());
    },
    async get(key) {
      const value = objects.get(key);
      return value ? value.slice() : null;
    },
    async list(prefix) {
      return {
        keys: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort(),
        truncated: false,
      };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

export function parseArtifactTransfer(value: unknown): ArtifactTransfer {
  if (!value || typeof value !== "object") {
    throw new ArtifactTransferError(
      "VALIDATION_ERROR",
      "An artifact-backed descriptor is required.",
    );
  }
  const payload = value as Record<string, unknown>;
  const artifactValue = payload.artifact;
  if (!artifactValue || typeof artifactValue !== "object") {
    throw new ArtifactTransferError(
      "VALIDATION_ERROR",
      "An artifact-backed descriptor is required.",
    );
  }
  const artifact = artifactValue as Record<string, unknown>;
  if (typeof payload.skillId !== "string" || !payload.skillId.trim()) {
    throw new ArtifactTransferError(
      "VALIDATION_ERROR",
      "An artifact-backed descriptor is required.",
    );
  }
  if (artifact.kind !== "r2-tar-zst") {
    throw new ArtifactTransferError(
      "VALIDATION_ERROR",
      "Cloud content artifacts must be r2-tar-zst.",
    );
  }
  if (
    typeof artifact.contentHash !== "string" ||
    !HASH.test(artifact.contentHash) ||
    typeof artifact.integrityHash !== "string" ||
    !HASH.test(artifact.integrityHash) ||
    typeof artifact.locator !== "string" ||
    !artifact.locator.trim() ||
    typeof artifact.sizeBytes !== "number" ||
    !Number.isInteger(artifact.sizeBytes) ||
    artifact.sizeBytes < 0
  ) {
    throw new ArtifactTransferError(
      "VALIDATION_ERROR",
      "An artifact-backed descriptor is required.",
    );
  }
  return {
    skillId: parseSkillId(payload.skillId.trim()),
    artifact: {
      kind: "r2-tar-zst",
      contentHash: artifact.contentHash as `sha256:${string}`,
      integrityHash: artifact.integrityHash as `sha256:${string}`,
      locator: artifact.locator.trim(),
      sizeBytes: artifact.sizeBytes,
    },
  };
}

export async function verifyArtifactArchive(
  bytes: Uint8Array,
  expected: Pick<
    ArtifactDescriptor,
    "contentHash" | "integrityHash" | "sizeBytes"
  >,
): Promise<void> {
  if (bytes.byteLength !== expected.sizeBytes) {
    throw new ArtifactTransferError(
      "CONTENT_HASH_MISMATCH",
      "Artifact size does not match.",
    );
  }
  if ((await sha256(bytes)) !== expected.integrityHash) {
    throw new ArtifactTransferError(
      "CONTENT_HASH_MISMATCH",
      "Artifact integrity hash does not match.",
    );
  }
  const tar = await decompressZstd(bytes);
  const files = parseTar(tar);
  if ((await contentHash(files)) !== expected.contentHash) {
    throw new ArtifactTransferError(
      "CONTENT_HASH_MISMATCH",
      "Extracted artifact content hash does not match.",
    );
  }
}

export async function putWorkspaceArtifact(
  db: TokenDatabase,
  bucket: ArtifactBucket,
  input: Readonly<{
    workspaceId: string;
    userId: string;
    transfer: ArtifactTransfer;
    bytes: Uint8Array;
  }>,
): Promise<ArtifactTransfer> {
  const { workspaceId, transfer, bytes } = input;
  const locator = cloudArtifactLocator(
    workspaceId,
    transfer.skillId,
    transfer.artifact.integrityHash,
  );
  if (transfer.artifact.locator !== locator) {
    throw new ArtifactTransferError(
      "VALIDATION_ERROR",
      "Artifact locator is not valid for this workspace.",
    );
  }
  await assertNotSourceBacked(db, input.userId, workspaceId, transfer.skillId);
  await verifyArtifactArchive(bytes, transfer.artifact);
  const existing = await bucket.get(locator);
  if (existing && !sameBytes(existing, bytes)) {
    throw new ArtifactTransferError(
      "VALIDATION_ERROR",
      "An artifact object already exists with different bytes.",
    );
  }
  if (!existing) await bucket.put(locator, bytes);
  try {
    await recordArtifactMetadata(db, workspaceId, transfer);
  } catch (error) {
    if (error instanceof ArtifactTransferError) throw error;
    throw new ArtifactMetadataError();
  }
  return {
    skillId: transfer.skillId,
    artifact: { ...transfer.artifact, locator },
  };
}

export async function getWorkspaceArtifact(
  bucket: ArtifactBucket,
  input: Readonly<{ workspaceId: string; transfer: ArtifactTransfer }>,
): Promise<Uint8Array> {
  const locator = cloudArtifactLocator(
    input.workspaceId,
    input.transfer.skillId,
    input.transfer.artifact.integrityHash,
  );
  if (input.transfer.artifact.locator !== locator) {
    throw new ArtifactTransferError(
      "VALIDATION_ERROR",
      "Artifact locator is not valid for this workspace.",
    );
  }
  const bytes = await bucket.get(locator);
  if (!bytes) {
    throw new ArtifactTransferError(
      "ARTIFACT_UNAVAILABLE",
      "Artifact object is missing.",
    );
  }
  await verifyArtifactArchive(bytes, input.transfer.artifact);
  return bytes;
}

export async function collectArtifactGcPlan(
  db: WorkspaceDatabase,
  bucket: ArtifactBucket,
  workspaceId: string,
): Promise<readonly ArtifactTransfer[]> {
  const workspace = await db
    .prepare(
      "SELECT current_revision_sequence AS sequence FROM workspaces WHERE id = ?",
    )
    .bind(workspaceId)
    .first<{ sequence: number }>();
  if (!workspace)
    throw new ArtifactGcAmbiguousError(
      "Workspace revision pointer is missing.",
    );
  const references = await db
    .prepare(
      `SELECT ra.skill_id AS skillId, ra.integrity_hash AS integrityHash, wr.revision_sequence AS sequence
       FROM workspace_revision_artifacts ra
       JOIN workspace_revisions wr ON wr.id = ra.revision_id AND wr.workspace_id = ra.workspace_id
       WHERE ra.workspace_id = ?`,
    )
    .bind(workspaceId)
    .all<{ skillId: string; integrityHash: string; sequence: number }>();
  const metadata = await db
    .prepare(
      `SELECT skill_id AS skillId, integrity_hash AS integrityHash, content_hash AS contentHash,
              locator, size_bytes AS sizeBytes
       FROM workspace_artifacts WHERE workspace_id = ?`,
    )
    .bind(workspaceId)
    .all<{
      skillId: string;
      integrityHash: string;
      contentHash: string;
      locator: string;
      sizeBytes: number;
    }>();
  const listed = await bucket.list(`workspaces/${workspaceId}/artifacts/`);
  if (listed.truncated)
    throw new ArtifactGcAmbiguousError(
      "Artifact object listing is incomplete.",
    );

  const referenceRows = references.results ?? [];
  const metadataRows = metadata.results ?? [];
  const retained = new Set<string>();
  const referenced = new Set<string>();
  const previous = workspace.sequence > 0 ? workspace.sequence - 1 : null;
  for (const row of referenceRows) {
    const id = artifactId(row.skillId, row.integrityHash);
    referenced.add(id);
    if (row.sequence === workspace.sequence || row.sequence === previous)
      retained.add(id);
  }

  const metadataById = new Map<string, (typeof metadataRows)[number]>();
  for (const row of metadataRows) {
    const expected = cloudArtifactLocator(
      workspaceId,
      row.skillId,
      row.integrityHash,
    );
    if (row.locator !== expected)
      throw new ArtifactGcAmbiguousError(
        "Artifact metadata locator does not match.",
      );
    metadataById.set(artifactId(row.skillId, row.integrityHash), row);
  }

  const r2Keys = new Set(listed.keys);
  for (const key of listed.keys) {
    if (!parseWorkspaceArtifactKey(workspaceId, key)) {
      throw new ArtifactGcAmbiguousError(
        "R2 contains a key outside the artifact contract.",
      );
    }
  }
  for (const id of retained) {
    const row = metadataById.get(id);
    if (!row || !r2Keys.has(row.locator)) {
      throw new ArtifactGcAmbiguousError(
        "A retained artifact object or metadata row is missing.",
      );
    }
  }

  const candidates: ArtifactTransfer[] = [];
  for (const id of referenced) {
    if (retained.has(id)) continue;
    const row = metadataById.get(id);
    if (
      !row ||
      !r2Keys.has(row.locator) ||
      !HASH.test(row.contentHash) ||
      !HASH.test(row.integrityHash)
    ) {
      throw new ArtifactGcAmbiguousError(
        "An unreferenced artifact cannot be deleted safely.",
      );
    }
    candidates.push({
      skillId: row.skillId,
      artifact: {
        kind: "r2-tar-zst",
        contentHash: row.contentHash as `sha256:${string}`,
        integrityHash: row.integrityHash as `sha256:${string}`,
        locator: row.locator,
        sizeBytes: row.sizeBytes,
      },
    });
  }
  return candidates;
}

/** Deletes only historically referenced artifacts that are neither current nor immediately previous. */
export async function garbageCollectWorkspaceArtifacts(
  db: TokenDatabase,
  bucket: ArtifactBucket,
  workspaceId: string,
): Promise<readonly ArtifactTransfer[]> {
  const candidates = await collectArtifactGcPlan(db, bucket, workspaceId);
  for (const candidate of candidates) {
    await bucket.delete(candidate.artifact.locator);
    const removed = await db
      .prepare(
        `DELETE FROM workspace_artifacts
         WHERE workspace_id = ? AND skill_id = ? AND integrity_hash = ?
           AND locator = ?
           AND NOT EXISTS (
             SELECT 1 FROM workspace_revision_artifacts ra
             JOIN workspace_revisions wr ON wr.id = ra.revision_id AND wr.workspace_id = ra.workspace_id
             JOIN workspaces w ON w.id = ra.workspace_id
             WHERE ra.workspace_id = workspace_artifacts.workspace_id
               AND ra.skill_id = workspace_artifacts.skill_id
               AND ra.integrity_hash = workspace_artifacts.integrity_hash
               AND wr.revision_sequence >= w.current_revision_sequence - 1
           )`,
      )
      .bind(
        workspaceId,
        candidate.skillId,
        candidate.artifact.integrityHash,
        candidate.artifact.locator,
      )
      .run();
    const changes =
      (removed as { meta?: { changes?: number } }).meta?.changes ?? 0;
    if (changes !== 1)
      throw new ArtifactGcAmbiguousError(
        "Artifact metadata delete did not match the plan.",
      );
  }
  return candidates;
}

async function assertNotSourceBacked(
  db: WorkspaceDatabase,
  userId: string,
  workspaceId: string,
  skillId: string,
): Promise<void> {
  const current = await loadCurrentDesiredState(db, userId, workspaceId);
  if (!current.id) return;
  if (isSourceBacked(current.state, skillId)) {
    throw new ArtifactTransferError(
      "VALIDATION_ERROR",
      "Source-backed locks cannot upload a Cloud content artifact.",
    );
  }
}

function isSourceBacked(state: CloudDesiredState, skillId: string): boolean {
  if (isV2CloudState(state)) {
    return state.lockfile.skills.some(
      (lock) => lock.id === skillId && lock.materialization.kind === "source",
    );
  }
  return state.lockfile.skills.some((lock) => lock.id === skillId);
}

async function recordArtifactMetadata(
  db: TokenDatabase,
  workspaceId: string,
  transfer: ArtifactTransfer,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO workspace_artifacts
        (workspace_id, skill_id, integrity_hash, kind, content_hash, locator, size_bytes, created_at)
       VALUES (?, ?, ?, 'r2-tar-zst', ?, ?, ?, ?)`,
    )
    .bind(
      workspaceId,
      transfer.skillId,
      transfer.artifact.integrityHash,
      transfer.artifact.contentHash,
      transfer.artifact.locator,
      transfer.artifact.sizeBytes,
      Date.now(),
    )
    .run();
}

function artifactId(skillId: string, integrityHash: string): string {
  return `${skillId}\0${integrityHash}`;
}

function parseWorkspaceArtifactKey(
  workspaceId: string,
  key: string,
): ArtifactTransfer | null {
  const prefix = `workspaces/${workspaceId}/artifacts/`;
  if (!key.startsWith(prefix) || !key.endsWith(".tar.zst")) return null;
  const rest = key.slice(prefix.length, -".tar.zst".length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const skill = rest.slice(0, slash);
  const integrityHash = rest.slice(slash + 1);
  if (rest.slice(slash + 1).includes("/") || !HASH.test(integrityHash))
    return null;
  try {
    parseSkillId(skill);
  } catch {
    return null;
  }
  return {
    skillId: skill,
    artifact: {
      kind: "r2-tar-zst",
      contentHash:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      integrityHash: integrityHash as `sha256:${string}`,
      locator: key,
      sizeBytes: 0,
    },
  };
}

function ownedBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes;
  }
  return bytes.slice();
}

async function decompressZstd(bytes: Uint8Array): Promise<Uint8Array> {
  const owned = ownedBytes(bytes);
  const bun = (
    globalThis as {
      Bun?: { zstdDecompressSync?: (value: Uint8Array) => Uint8Array };
    }
  ).Bun;
  if (typeof bun?.zstdDecompressSync === "function") {
    try {
      return bun.zstdDecompressSync(owned);
    } catch {
      // fall through — workerd may expose a stub that cannot decode
    }
  }
  try {
    const zlib = await import("node:zlib");
    if (typeof zlib.zstdDecompressSync === "function") {
      return new Uint8Array(zlib.zstdDecompressSync(owned));
    }
  } catch {
    // no node:zlib zstd in this runtime
  }
  try {
    const stream = new Blob([arrayBufferOf(owned)])
      .stream()
      .pipeThrough(new DecompressionStream("zstd" as CompressionFormat));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new ArtifactTransferError(
      "ARTIFACT_UNAVAILABLE",
      "Artifact stream is corrupt or unavailable.",
    );
  }
}

function parseTar(
  tar: Uint8Array,
): ReadonlyArray<Readonly<{ path: string; content: Uint8Array }>> {
  if (tar.length < BLOCK * 2 || tar.length % BLOCK !== 0) {
    throw new ArtifactTransferError(
      "ARTIFACT_UNAVAILABLE",
      "Artifact TAR is malformed.",
    );
  }
  const entries: Array<{ path: string; content: Uint8Array }> = [];
  const paths = new Set<string>();
  let offset = 0;
  let expanded = 0;
  while (offset < tar.length) {
    const header = tar.slice(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (!tar.slice(offset).every((byte) => byte === 0)) {
        throw new ArtifactTransferError(
          "ARTIFACT_UNAVAILABLE",
          "Artifact TAR has trailing data.",
        );
      }
      return entries;
    }
    if (offset + BLOCK > tar.length || !validChecksum(header)) {
      throw new ArtifactTransferError(
        "ARTIFACT_UNAVAILABLE",
        "Artifact TAR header is invalid.",
      );
    }
    const type = String.fromCharCode(header[156]!);
    if (type !== "\0" && type !== "0") {
      throw new ArtifactTransferError(
        "ARTIFACT_UNAVAILABLE",
        "Artifact TAR contains a non-regular entry.",
      );
    }
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    assertArchivePath(path);
    if (paths.has(path))
      throw new ArtifactTransferError(
        "ARTIFACT_UNAVAILABLE",
        "Artifact TAR contains duplicate paths.",
      );
    paths.add(path);
    const size = readOctal(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_EXPANDED_BYTES) {
      throw new ArtifactTransferError(
        "ARTIFACT_UNAVAILABLE",
        "Artifact TAR entry size is invalid.",
      );
    }
    expanded += size;
    if (entries.length >= MAX_ENTRIES || expanded > MAX_EXPANDED_BYTES) {
      throw new ArtifactTransferError(
        "ARTIFACT_UNAVAILABLE",
        "Artifact exceeds extraction limits.",
      );
    }
    const start = offset + BLOCK;
    const end = start + size;
    if (end > tar.length)
      throw new ArtifactTransferError(
        "ARTIFACT_UNAVAILABLE",
        "Artifact TAR is truncated.",
      );
    entries.push({ path, content: tar.slice(start, end) });
    offset = end + ((BLOCK - (size % BLOCK)) % BLOCK);
  }
  throw new ArtifactTransferError(
    "ARTIFACT_UNAVAILABLE",
    "Artifact TAR has no end marker.",
  );
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
    throw new ArtifactTransferError(
      "ARTIFACT_UNAVAILABLE",
      "Artifact contains an unsafe path.",
    );
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

function readString(bytes: Uint8Array, offset: number, length: number): string {
  const end = bytes.slice(offset, offset + length).indexOf(0);
  return new TextDecoder().decode(
    bytes.slice(offset, offset + (end < 0 ? length : end)),
  );
}

async function contentHash(
  files: ReadonlyArray<Readonly<{ path: string; content: Uint8Array }>>,
): Promise<`sha256:${string}`> {
  const parts: Uint8Array[] = [];
  for (const file of files) {
    parts.push(
      encoder.encode(`${file.path}\0`),
      file.content,
      encoder.encode("\0"),
    );
  }
  return sha256(concat(parts));
}

async function sha256(value: Uint8Array): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", arrayBufferOf(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
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

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1)
    diff |= left[index]! ^ right[index]!;
  return diff === 0;
}
