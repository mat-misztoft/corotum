import {
  type ArtifactMetadata,
  type DispositionLedger,
  type SkillId,
  type SourceLock,
  type SourceMetadata,
  type V2DesiredState,
  type V2LockedSkill,
  skillId,
  validateV2DesiredState,
} from "../../../packages/core/src/index";

/** The small v2 provider boundary deliberately keeps command mutations out of
 * the legacy StateProvider contract. Git and Cloud adapters supply this shape. */
export type V2MutationProvider = Readonly<{
  pull: () => Promise<Readonly<{ revisionId: string; state: V2DesiredState; ledger: DispositionLedger }>>;
  push: (input: Readonly<{ state: V2DesiredState; ledger: DispositionLedger; baseRevision: string; artifacts?: Readonly<Record<string, string>> }>) => Promise<Readonly<{ revisionId: string; state: V2DesiredState; ledger: DispositionLedger }>>;
}>;

export type V2SourceResolver = Readonly<{
  resolve: (source: SourceMetadata) => Promise<SourceLock>;
}>;

export type V2LocalApplier = Readonly<{
  apply: (input: Readonly<{ state: V2DesiredState; revisionId: string; skillIds: readonly SkillId[] }>) => Promise<void>;
}>;

export type V2MutationResult =
  | Readonly<{ kind: "success"; skillId: SkillId; revision: string }>
  | Readonly<{ kind: "persisted-not-applied"; skillId: SkillId; revision: string; reason: string }>
  | Readonly<{ kind: "duplicate"; skillId: SkillId }>
  | Readonly<{ kind: "source-unavailable"; skillId: SkillId; reason: string }>
  | Readonly<{ kind: "refused"; reason: string }>;

/**
 * Source/artifact-aware mutation core. It resolves immutable source content
 * before publishing intent, and only applies the exact newly-persisted lock.
 * A failed apply is intentionally recoverable: the persisted revision remains
 * available to ordinary reconciliation, while old local content is untouched
 * until the applier has staged and verified its replacement.
 */
export class V2MutationService {
  constructor(
    private readonly provider: V2MutationProvider,
    private readonly resolver: V2SourceResolver,
    private readonly applier?: V2LocalApplier,
  ) {}

  async add(input: Readonly<{ name: string; source: SourceMetadata; targets?: V2DesiredState["manifest"]["skills"][number]["targets"] }>): Promise<V2MutationResult> {
    const current = await this.provider.pull();
    const duplicate = current.state.manifest.skills.find((skill) =>
      skill.name === input.name || (skill.source?.repository === input.source.repository && skill.source.path === input.source.path),
    );
    if (duplicate) return { kind: "duplicate", skillId: duplicate.id };
    const id = skillId(`sk_${crypto.randomUUID().replaceAll("-", "")}`);
    let source: SourceLock;
    try { source = await this.resolver.resolve(input.source); }
    catch (error) { return refused(error); }
    const lock: V2LockedSkill = { id, name: input.name, source, materialization: { kind: "source", contentHash: source.contentHash } };
    return this.persistAndApply(current, {
      manifest: { version: 2, skills: [...current.state.manifest.skills, { id, name: input.name, targets: input.targets ?? "all", source: input.source, resolutionStatus: "RESOLVED" }] },
      lockfile: { version: 2, skills: [...current.state.lockfile.skills, lock] },
    }, [id]);
  }

  /** Explicit adoption can retain update provenance while publishing local exact content as an artifact. */
  async adoptArtifact(input: Readonly<{ name: string; artifactDirectory: string; contentHash: ArtifactMetadata["contentHash"]; integrityHash: ArtifactMetadata["integrityHash"]; sizeBytes: number; source?: SourceMetadata; targets: V2DesiredState["manifest"]["skills"][number]["targets"] }>): Promise<V2MutationResult> {
    const current = await this.provider.pull();
    if (current.state.manifest.skills.some((skill) => skill.name === input.name)) return { kind: "refused", reason: "A managed skill already uses this name." };
    const id = skillId(`sk_${crypto.randomUUID().replaceAll("-", "")}`);
    const artifact: ArtifactMetadata = {
      kind: "git-tree",
      contentHash: input.contentHash,
      integrityHash: input.integrityHash,
      locator: `artifacts/${id}/${input.integrityHash.slice("sha256:".length)}`,
      sizeBytes: input.sizeBytes,
    };
    const lock: V2LockedSkill = { id, name: input.name, materialization: { kind: "artifact", artifact } };
    return this.persistAndApply(current, {
      manifest: { version: 2, skills: [...current.state.manifest.skills, { id, name: input.name, targets: input.targets, source: input.source, resolutionStatus: "RESOLVED" }] },
      lockfile: { version: 2, skills: [...current.state.lockfile.skills, lock] },
    }, [id], { [id]: input.artifactDirectory });
  }

  async setRef(nameOrId: string, ref: string): Promise<V2MutationResult> {
    if (!ref.trim()) return { kind: "refused", reason: "A ref cannot be empty." };
    const current = await this.provider.pull();
    const skill = select(current.state, nameOrId);
    if (!skill) return { kind: "refused", reason: "Managed skill was not found or is ambiguous." };
    if (!skill.source) return { kind: "source-unavailable", skillId: skill.id, reason: "This artifact-backed skill has no source metadata." };
    let source: SourceLock;
    try { source = await this.resolver.resolve({ ...skill.source, ref }); }
    catch (error) { return refused(error); }
    return this.replaceSourceLock(current, skill.id, { ...skill.source, ref }, source);
  }

  /** Check performs resolution only; it never calls push or apply. */
  async check(nameOrId?: string): Promise<readonly Readonly<{ skillId: SkillId; name: string; status: "UP_TO_DATE" | "UPDATE_AVAILABLE" | "SOURCE_UNAVAILABLE" | "CHECK_FAILED" }>[]> {
    const current = await this.provider.pull();
    const selected = nameOrId ? [select(current.state, nameOrId)].filter(Boolean) : current.state.manifest.skills;
    return Promise.all(selected.map(async (skill) => {
      if (!skill!.source) return { skillId: skill!.id, name: skill!.name, status: "SOURCE_UNAVAILABLE" as const };
      const lock = current.state.lockfile.skills.find((entry) => entry.id === skill!.id);
      try {
        const next = await this.resolver.resolve(skill!.source!);
        return { skillId: skill!.id, name: skill!.name, status: lock?.materialization.kind === "source" && lock.source?.revision === next.revision && lock.source.contentHash === next.contentHash ? "UP_TO_DATE" as const : "UPDATE_AVAILABLE" as const };
      } catch { return { skillId: skill!.id, name: skill!.name, status: "CHECK_FAILED" as const }; }
    }));
  }

  async update(nameOrId?: string): Promise<readonly V2MutationResult[]> {
    const current = await this.provider.pull();
    const selected = nameOrId ? [select(current.state, nameOrId)].filter(Boolean) : current.state.manifest.skills;
    const results: V2MutationResult[] = [];
    let latest = current;
    for (const skill of selected) {
      if (!skill!.source) { results.push({ kind: "source-unavailable", skillId: skill!.id, reason: "This artifact-backed skill has no source metadata." }); continue; }
      try {
        const source = await this.resolver.resolve(skill!.source!);
        const old = latest.state.lockfile.skills.find((entry) => entry.id === skill!.id);
        if (old?.materialization.kind === "source" && old.source?.revision === source.revision && old.source.contentHash === source.contentHash) { results.push({ kind: "success", skillId: skill!.id, revision: latest.revisionId }); continue; }
        const result = await this.replaceSourceLock(latest, skill!.id, skill!.source!, source);
        results.push(result);
        // A saved state may fail to apply locally; reload it before the next push.
        if (result.kind === "success" || result.kind === "persisted-not-applied") {
          latest = await this.provider.pull();
        }
      } catch (error) { results.push(refused(error)); }
    }
    return results;
  }

  private async replaceSourceLock(current: Awaited<ReturnType<V2MutationProvider["pull"]>>, id: SkillId, metadata: SourceMetadata, source: SourceLock): Promise<V2MutationResult> {
    const manifest = current.state.manifest.skills.find((skill) => skill.id === id);
    const existing = current.state.lockfile.skills.find((lock) => lock.id === id);
    if (!manifest) return { kind: "refused", reason: "Managed skill was not found or is ambiguous." };
    if (!existing && manifest.resolutionStatus !== "PENDING_RESOLUTION") {
      return { kind: "refused", reason: "Managed skill has no current materialization." };
    }
    const lock: V2LockedSkill = { id, name: existing?.name ?? manifest.name, source, materialization: { kind: "source", contentHash: source.contentHash } };
    return this.persistAndApply(current, {
      manifest: { version: 2, skills: current.state.manifest.skills.map((skill) => skill.id === id ? { ...skill, source: metadata, resolutionStatus: "RESOLVED" } : skill) },
      lockfile: {
        version: 2,
        skills: existing
          ? current.state.lockfile.skills.map((entry) => entry.id === id ? lock : entry)
          : [...current.state.lockfile.skills, lock],
      },
    }, [id]);
  }

  private async persistAndApply(current: Awaited<ReturnType<V2MutationProvider["pull"]>>, state: V2DesiredState, ids: readonly SkillId[], artifacts?: Readonly<Record<string, string>>): Promise<V2MutationResult> {
    let persisted: Awaited<ReturnType<V2MutationProvider["push"]>>;
    try {
      // Validation occurs before any provider write; rejected intent cannot
      // produce a partial desired-state snapshot.
      persisted = await this.provider.push({ state: validateV2DesiredState(state), ledger: current.ledger, baseRevision: current.revisionId, artifacts });
    } catch (error) {
      return refused(error);
    }
    try {
      await this.applier?.apply({ state: persisted.state, revisionId: persisted.revisionId, skillIds: ids });
      return { kind: "success", skillId: ids[0]!, revision: persisted.revisionId };
    } catch (error) {
      // Publishing precedes local installation by design. Do not claim the
      // mutation was rolled back: ordinary reconciliation can apply this exact
      // persisted snapshot on retry without consulting HEAD.
      return {
        kind: "persisted-not-applied",
        skillId: ids[0]!,
        revision: persisted.revisionId,
        reason: error instanceof Error ? error.message : "Local application failed.",
      };
    }
  }
}

function select(state: V2DesiredState, nameOrId: string) {
  const matches = state.manifest.skills.filter((skill) => skill.id === nameOrId || skill.name === nameOrId);
  return matches.length === 1 ? matches[0] : undefined;
}
function refused(error: unknown): V2MutationResult { return { kind: "refused", reason: error instanceof Error ? error.message : "Desired state mutation failed." }; }
