import type {
  DispositionLedger,
  V2DesiredState,
  V2LockedSkill,
} from "../../../packages/core/src/index";
import type { ArtifactArchive } from "../../../packages/skills-adapter/src/artifact-archive";

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
