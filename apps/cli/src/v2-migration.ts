import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DispositionLedger,
  V2DesiredState,
  V2LockedSkill,
} from "../../../packages/core/src/index";
import { gitTreeHash } from "../../../packages/git-provider/src/index";
import {
  stageArtifactArchive,
  type ArtifactArchive,
} from "../../../packages/skills-adapter/src/artifact-archive";

export type V2GitArtifactReader = Readonly<{
  readArtifact: (lock: V2LockedSkill) => Promise<ArtifactArchive>;
}>;

export type V2CloudMigrationTarget = Readonly<{
  pull: () => Promise<Readonly<{ revisionId: string | null; state: V2DesiredState; ledger: DispositionLedger }>>;
  push: (input: Readonly<{
    state: V2DesiredState;
    ledger: DispositionLedger;
    baseRevision: string | null;
    artifacts: Readonly<Record<string, Uint8Array>>;
  }>) => Promise<Readonly<{ revisionId: string | null }>>;
}>;

export type V2CloudArtifactReader = Readonly<{
  downloadArtifact: (lock: V2LockedSkill) => Promise<Uint8Array>;
}>;

export type V2GitMigrationTarget = Readonly<{
  pull: () => Promise<Readonly<{ revisionId: string; state: V2DesiredState; ledger: DispositionLedger }>>;
  push: (input: Readonly<{
    state: V2DesiredState;
    ledger: DispositionLedger;
    baseRevision: string;
    artifacts: Readonly<Record<string, string>>;
  }>) => Promise<Readonly<{ revisionId: string }>>;
}>;

/**
 * Prepares a Git v2 snapshot for Cloud without resolving sources or changing
 * IDs, dispositions, or source provenance. Only artifact trees cross R2.
 */
export async function migrateV2GitToCloud(input: Readonly<{
  source: Readonly<{ state: V2DesiredState; ledger: DispositionLedger }>;
  artifacts: V2GitArtifactReader;
  destination: V2CloudMigrationTarget;
  workspaceId: string;
}>): Promise<string | null> {
  const destination = await input.destination.pull();
  const archives: Record<string, ArtifactArchive> = {};
  for (const lock of input.source.state.lockfile.skills) {
    if (lock.materialization.kind !== "artifact") continue;
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
export async function migrateV2CloudToGit(input: Readonly<{
  source: Readonly<{ state: V2DesiredState; ledger: DispositionLedger }>;
  artifacts: V2CloudArtifactReader;
  destination: V2GitMigrationTarget;
}>): Promise<string> {
  const destination = await input.destination.pull();
  const root = await mkdtemp(join(tmpdir(), "corotum-cloud-to-git-"));
  try {
    const trees: Record<string, string> = {};
    const integrityHashes: Record<string, `sha256:${string}`> = {};
    for (const lock of input.source.state.lockfile.skills) {
      if (lock.materialization.kind !== "artifact") continue;
      const artifact = lock.materialization.artifact;
      const tree = await stageArtifactArchive(
        await input.artifacts.downloadArtifact(lock),
        root,
        artifact,
      );
      trees[lock.id] = tree;
      integrityHashes[lock.id] = await gitTreeHash(tree);
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
        const archive = archives[lock.id];
        if (!archive) throw new Error(`Artifact ${lock.id} was not archived.`);
        if (archive.contentHash !== lock.materialization.artifact.contentHash) {
          throw new Error(`Artifact ${lock.id} content hash does not match its Git lock.`);
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
        if (!integrityHash) throw new Error(`Artifact ${lock.id} was not extracted.`);
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
