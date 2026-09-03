import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DispositionLedger,
  TombstoneDisposition,
  V2DesiredState,
  V2LockedSkill,
} from "../../../packages/core/src/index";
import { validateV2DesiredState } from "../../../packages/core/src/index";
import { gitTreeHash } from "../../../packages/git-provider/src/index";
import {
  type ArtifactArchive,
  stageArtifactArchive,
} from "../../../packages/skills-adapter/src/artifact-archive";

export type V2GitArtifactReader = Readonly<{
  readArtifact: (lock: V2LockedSkill) => Promise<ArtifactArchive>;
}>;

export type V2CloudMigrationTarget = Readonly<{
  pull: () => Promise<
    Readonly<{
      revisionId: string | null;
      state: V2DesiredState;
      ledger: DispositionLedger;
    }>
  >;
  push: (
    input: Readonly<{
      state: V2DesiredState;
      ledger: DispositionLedger;
      baseRevision: string | null;
      artifacts: Readonly<Record<string, Uint8Array>>;
    }>,
  ) => Promise<Readonly<{ revisionId: string | null }>>;
}>;

export type V2CloudArtifactReader = Readonly<{
  downloadArtifact: (lock: V2LockedSkill) => Promise<Uint8Array>;
}>;

export type V2MigrationMerge =
  | Readonly<{
      kind: "merged";
      state: V2DesiredState;
      ledger: DispositionLedger;
    }>
  | Readonly<{ kind: "conflict"; skills: readonly string[] }>;

/** Unions identical or independent v2 records; IDs, normalized names and tombstones are exclusive. */
export function mergeV2MigrationSnapshots(
  source: Readonly<{ state: V2DesiredState; ledger: DispositionLedger }>,
  destination: Readonly<{ state: V2DesiredState; ledger: DispositionLedger }>,
): V2MigrationMerge {
  const conflicts = new Set<string>();
  const destinationById = new Map(
    destination.state.manifest.skills.map((skill) => [skill.id, skill]),
  );
  const destinationByName = new Map(
    destination.state.manifest.skills.map((skill) => [
      migrationName(skill.name),
      skill,
    ]),
  );
  const sourceById = new Map(
    source.state.manifest.skills.map((skill) => [skill.id, skill]),
  );
  const sourceByName = new Map(
    source.state.manifest.skills.map((skill) => [
      migrationName(skill.name),
      skill,
    ]),
  );
  const tombstones = [
    ...Object.values(source.ledger.activeDispositions),
    ...Object.values(destination.ledger.activeDispositions),
  ];
  const tombstoneById = new Map<string, TombstoneDisposition>();
  const tombstoneByName = new Map<string, TombstoneDisposition>();
  for (const tombstone of tombstones) {
    const prior =
      tombstoneById.get(tombstone.skillId) ??
      tombstoneByName.get(migrationName(tombstone.name));
    if (prior && !same(prior, tombstone)) {
      conflicts.add(tombstone.name);
      continue;
    }
    tombstoneById.set(tombstone.skillId, tombstone);
    tombstoneByName.set(migrationName(tombstone.name), tombstone);
  }
  for (const skill of [
    ...source.state.manifest.skills,
    ...destination.state.manifest.skills,
  ]) {
    const otherById = (
      sourceById.get(skill.id) === skill ? destinationById : sourceById
    ).get(skill.id);
    const otherByName = (
      sourceByName.get(migrationName(skill.name)) === skill
        ? destinationByName
        : sourceByName
    ).get(migrationName(skill.name));
    if (
      (otherById &&
        !sameSkill(source.state, destination.state, skill.id, otherById.id)) ||
      (otherByName &&
        !sameSkill(source.state, destination.state, skill.id, otherByName.id))
    )
      conflicts.add(skill.name);
    const tombstone =
      tombstoneById.get(skill.id) ??
      tombstoneByName.get(migrationName(skill.name));
    if (tombstone) conflicts.add(skill.name);
  }
  if (conflicts.size > 0)
    return { kind: "conflict", skills: [...conflicts].sort() };
  const manifest = [...destination.state.manifest.skills];
  const locks = [...destination.state.lockfile.skills];
  for (const skill of source.state.manifest.skills)
    if (!destinationById.has(skill.id)) {
      manifest.push(skill);
      const lock = source.state.lockfile.skills.find(
        (candidate) => candidate.id === skill.id,
      );
      if (lock) locks.push(lock);
    }
  return {
    kind: "merged",
    state: validateV2DesiredState({
      manifest: { version: 2, skills: manifest },
      lockfile: { version: 2, skills: locks },
    }),
    ledger: {
      version: 2,
      activeDispositions: Object.fromEntries(tombstoneById),
    },
  };
}

function sameSkill(
  left: V2DesiredState,
  right: V2DesiredState,
  leftId: string,
  rightId: string,
): boolean {
  const leftManifest = left.manifest.skills.find(
    (skill) => skill.id === leftId,
  );
  const rightManifest = right.manifest.skills.find(
    (skill) => skill.id === rightId,
  );
  const leftLock = left.lockfile.skills.find((skill) => skill.id === leftId);
  const rightLock = right.lockfile.skills.find((skill) => skill.id === rightId);
  return same(leftManifest, rightManifest) && same(leftLock, rightLock);
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function migrationName(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase("en-US");
}

export type V2GitMigrationTarget = V2GitArtifactReader &
  Readonly<{
    pull: () => Promise<
      Readonly<{
        revisionId: string;
        state: V2DesiredState;
        ledger: DispositionLedger;
      }>
    >;
    push: (
      input: Readonly<{
        state: V2DesiredState;
        ledger: DispositionLedger;
        baseRevision: string;
        artifacts: Readonly<Record<string, string>>;
      }>,
    ) => Promise<Readonly<{ revisionId: string }>>;
  }>;

/**
 * Prepares a Git v2 snapshot for Cloud without resolving sources or changing
 * IDs, dispositions, or source provenance. Only artifact trees cross R2.
 */
export async function migrateV2GitToCloud(
  input: Readonly<{
    source: Readonly<{ state: V2DesiredState; ledger: DispositionLedger }>;
    artifacts: V2GitArtifactReader;
    destination: V2CloudMigrationTarget;
    workspaceId: string;
  }>,
): Promise<string | null> {
  const destination = await input.destination.pull();
  const archives: Record<string, ArtifactArchive> = {};
  for (const lock of input.source.state.lockfile.skills) {
    if (lock.materialization.kind !== "artifact") continue;
    if (lock.materialization.artifact.kind !== "git-tree") continue;
    archives[lock.id] = await input.artifacts.readArtifact(lock);
  }
  const artifacts = Object.fromEntries(
    Object.entries(archives).map(([id, archive]) => [id, archive.bytes]),
  );
  const state = cloudState(input.source.state, input.workspaceId, archives);
  const pushed = await input.destination.push({
    state,
    ledger: input.source.ledger,
    baseRevision: destination.revisionId,
    artifacts,
  });
  return pushed.revisionId;
}

/**
 * Downloads every Cloud artifact into an unpublished staging tree, verifies its
 * archive and content hashes, then commits the converted Git snapshot once.
 * A failed download or verification cannot modify the Git destination.
 */
export async function migrateV2CloudToGit(
  input: Readonly<{
    source: Readonly<{ state: V2DesiredState; ledger: DispositionLedger }>;
    artifacts: V2CloudArtifactReader;
    destination: V2GitMigrationTarget;
  }>,
): Promise<string> {
  const destination = await input.destination.pull();
  const root = await mkdtemp(join(tmpdir(), "corotum-cloud-to-git-"));
  try {
    const trees: Record<string, string> = {};
    const integrityHashes: Record<string, `sha256:${string}`> = {};
    for (const lock of input.source.state.lockfile.skills) {
      if (lock.materialization.kind !== "artifact") continue;
      const artifact = lock.materialization.artifact;
      const archive =
        artifact.kind === "git-tree"
          ? await input.destination.readArtifact(lock)
          : {
              bytes: await input.artifacts.downloadArtifact(lock),
              ...artifact,
            };
      const tree = await stageArtifactArchive(archive.bytes, root, archive);
      const integrityHash = await gitTreeHash(tree);
      if (
        artifact.kind === "git-tree" &&
        integrityHash !== artifact.integrityHash
      )
        throw new Error(
          `Artifact ${lock.id} tree integrity does not match its Git lock.`,
        );
      trees[lock.id] = tree;
      integrityHashes[lock.id] = integrityHash;
    }
    const pushed = await input.destination.push({
      state: gitState(input.source.state, integrityHashes),
      ledger: input.source.ledger,
      baseRevision: destination.revisionId,
      artifacts: trees,
    });
    return pushed.revisionId;
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

export function cloudState(
  state: V2DesiredState,
  workspaceId: string,
  archives: Readonly<Record<string, ArtifactArchive>>,
): V2DesiredState {
  return {
    manifest: state.manifest,
    lockfile: {
      version: 2,
      skills: state.lockfile.skills.map((lock) => {
        if (lock.materialization.kind !== "artifact") return lock;
        if (lock.materialization.artifact.kind === "r2-tar-zst") return lock;
        const archive = archives[lock.id];
        if (!archive) throw new Error(`Artifact ${lock.id} was not archived.`);
        if (archive.contentHash !== lock.materialization.artifact.contentHash) {
          throw new Error(
            `Artifact ${lock.id} content hash does not match its Git lock.`,
          );
        }
        return {
          ...lock,
          materialization: {
            kind: "artifact" as const,
            artifact: {
              kind: "r2-tar-zst" as const,
              contentHash: archive.contentHash,
              integrityHash: archive.integrityHash,
              sizeBytes: archive.sizeBytes,
              locator: `workspaces/${workspaceId}/artifacts/${lock.id}/${archive.integrityHash}.tar.zst`,
            },
          },
        };
      }),
    },
  };
}

/** Converts Cloud artifact descriptors to their verified Git-tree equivalents. */
export function gitState(
  state: V2DesiredState,
  integrityHashes: Readonly<Record<string, `sha256:${string}`>>,
): V2DesiredState {
  return {
    manifest: state.manifest,
    lockfile: {
      version: 2,
      skills: state.lockfile.skills.map((lock) => {
        if (lock.materialization.kind !== "artifact") return lock;
        const integrityHash = integrityHashes[lock.id];
        if (!integrityHash)
          throw new Error(`Artifact ${lock.id} was not extracted.`);
        return {
          ...lock,
          materialization: {
            kind: "artifact" as const,
            artifact: {
              ...lock.materialization.artifact,
              kind: "git-tree" as const,
              integrityHash,
              locator: `artifacts/${lock.id}/${integrityHash.slice("sha256:".length)}`,
            },
          },
        };
      }),
    },
  };
}
