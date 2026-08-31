import type { AgentId } from "../../../packages/agent-targets/src/index";
import {
  type DesiredState,
  type DesiredStateEnvelope,
  type LockedSkill,
  planReconcile,
  type RevisionTransition,
  type SkillId,
  skillId,
  type StateProvider,
} from "../../../packages/core/src/index";
import { type LocalOperationalState } from "./local-state";
import { type ExecuteReconcileInput, type LocalReconcileExecutor } from "./reconcile-executor";

export type InitCandidate = Readonly<{
  agentId: AgentId;
  contentHash: string;
  name: string;
  path: string;
  source?: string;
}>;

export type InitSelection = Readonly<{
  source: string;
  name: string;
  contentHash: string;
  targets: readonly AgentId[];
}>;

/** Git needs a durable transition alongside every desired-state mutation. */
export type InitStateProvider = StateProvider & Readonly<{
  push: (
    input: { state: DesiredState; baseRevision: DesiredStateEnvelope["revisionId"] | null },
    transition: RevisionTransition,
  ) => ReturnType<StateProvider["push"]>;
}>;

/** Git can create its first commit in a remote repository with no HEAD. */
export type BootstrapInitStateProvider = InitStateProvider & Readonly<{
  bootstrap: (state: DesiredState) => ReturnType<StateProvider["push"]>;
}>;

export type InitResolver = Readonly<{
  resolve: (input: { id: SkillId; source: string; skill: string }) => Promise<Omit<LockedSkill, "id" | "source" | "skill" | "ref">>;
}>;

export type InitResult =
  | Readonly<{ kind: "initialized"; revision: DesiredStateEnvelope["revisionId"]; skillIds: readonly SkillId[] }>
  | Readonly<{ kind: "partial"; revision: DesiredStateEnvelope["revisionId"]; skillIds: readonly SkillId[]; reason: string }>
  | Readonly<{ kind: "selection-required"; candidates: readonly InitCandidate[] }>
  | Readonly<{ kind: "refused"; reason: string }>;

/**
 * Groups only source-known, byte-identical local copies. The CLI chooses among
 * divergent copies before this service is called; no-TTY callers must leave
 * them unselected rather than receiving an arbitrary canonical copy.
 */
export function coalesceInitCandidates(
  candidates: readonly InitCandidate[],
): readonly InitSelection[] {
  const groups = new Map<string, InitCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.source) continue;
    const key = `${candidate.source}\0${candidate.name}\0${candidate.contentHash}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  return [...groups.values()].map((group) => ({
    source: group[0].source as string,
    name: group[0].name,
    contentHash: group[0].contentHash,
    targets: [...new Set(group.map((candidate) => candidate.agentId))].sort() as AgentId[],
  }));
}

export function divergentCandidates(candidates: readonly InitCandidate[]): readonly InitCandidate[] {
  const hashesByName = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    hashesByName.set(candidate.name, new Set([...(hashesByName.get(candidate.name) ?? []), candidate.contentHash]));
  }
  return candidates.filter((candidate) => (hashesByName.get(candidate.name)?.size ?? 0) > 1);
}

export class InitService {
  constructor(
    private readonly provider: InitStateProvider,
    private readonly resolver: InitResolver,
    private readonly executor: Pick<LocalReconcileExecutor, "execute">,
  ) {}

  async initialize(input: {
    candidates: readonly InitCandidate[];
    selected: readonly InitSelection[];
    nonInteractive: boolean;
    execution: Omit<ExecuteReconcileInput, "desired" | "plan" | "revision" | "state"> & { state: LocalOperationalState };
  }): Promise<InitResult> {
    const invalidSelection = validateSelections(input.candidates, input.selected);
    if (invalidSelection) return { kind: "refused", reason: invalidSelection };

    const divergent = divergentCandidates(input.candidates);
    if (input.nonInteractive && divergent.length > 0) {
      return { kind: "refused", reason: "Divergent local skills require an interactive canonical-copy selection." };
    }
    if (!input.nonInteractive && divergent.length > 0 && !hasExplicitDivergentChoices(divergent, input.selected)) {
      return { kind: "selection-required", candidates: divergent };
    }
    if (input.selected.length === 0) {
      return { kind: "refused", reason: "No source-resolved skills were selected for adoption." };
    }

    // A pull is deliberately first: GitStateProvider retries PENDING_PUSH and
    // returns CONFLICT before a mutation can touch selected local targets.
    const current = await this.provider.pull();
    if (current.kind === "success" && current.value.state.manifest.skills.length > 0) {
      return { kind: "refused", reason: "Corotum is already initialized for this Git repository." };
    }
    if (current.kind !== "success" && !isBootstrapProvider(this.provider)) {
      return { kind: "refused", reason: current.kind === "failure" ? current.error.message : "Initial desired state could not be loaded completely." };
    }

    const locks: LockedSkill[] = [];
    for (const [index, selected] of input.selected.entries()) {
      const id = skillId(`sk_${crypto.randomUUID().replaceAll("-", "")}`);
      const resolved = await this.resolver.resolve({ id, source: selected.source, skill: selected.name });
      if (resolved.contentHash !== selected.contentHash) {
        return { kind: "refused", reason: `Repository content for ${selected.name} differs from the selected local copy.` };
      }
      locks.push({ id, source: selected.source, skill: selected.name, ref: "HEAD", ...resolved });
    }
    const state: DesiredState = {
      manifest: { version: 1, skills: locks.map((lock, index) => ({ id: lock.id, source: lock.source, skill: lock.skill, ref: lock.ref, targets: input.selected[index].targets, resolutionStatus: "RESOLVED" })) },
      lockfile: { version: 1, skills: locks },
    };
    const transition: RevisionTransition = { type: "ADOPT", skillId: locks[0].id, metadata: {} };
    const pushed = current.kind === "success"
      ? await this.provider.push({ state, baseRevision: current.value.revisionId }, transition)
      : await (this.provider as BootstrapInitStateProvider).bootstrap(state);
    if (pushed.kind !== "success") {
      return { kind: "refused", reason: pushed.kind === "failure" ? pushed.error.message : "Initial desired state could not be saved completely." };
    }

    // Recorded ownership is limited to explicitly selected paths. This lets the
    // executor replace those approved copies while preserving every unselected
    // or source-unknown local directory.
    const stagedState: LocalOperationalState = {
      ...input.execution.state,
      skills: Object.fromEntries(locks.map((lock, index) => [lock.id, {
        name: lock.skill,
        canonicalPath: "pending-init",
        contentHash: lock.contentHash,
        targets: Object.fromEntries(input.candidates
          .filter((candidate) => isSelectedCandidate(candidate, input.selected[index]))
          .map((candidate) => [`${candidate.agentId}\0${candidate.path}`, {
            agentId: candidate.agentId,
            mode: "copy" as const,
            path: candidate.path,
            expectedHash: candidate.contentHash,
          }])),
      }])),
    };
    const actual = { skills: {} } as const;
    const execution = await this.executor.execute({ ...input.execution, state: stagedState, desired: state, revision: pushed.value.revisionId, plan: planReconcile(state, actual) });
    const skillIds = locks.map((lock) => lock.id);
    if (execution.operations.some((operation) => operation.status === "ERROR")) {
      return { kind: "partial", revision: pushed.value.revisionId, skillIds, reason: "Desired state was saved, but one or more local skill targets could not be adopted." };
    }
    return { kind: "initialized", revision: pushed.value.revisionId, skillIds };
  }
}

function isSelectedCandidate(candidate: InitCandidate, selection: InitSelection): boolean {
  return candidate.source === selection.source && candidate.name === selection.name && candidate.contentHash === selection.contentHash && selection.targets.includes(candidate.agentId);
}

function validateSelections(candidates: readonly InitCandidate[], selections: readonly InitSelection[]): string | null {
  const identities = new Set<string>();
  for (const selection of selections) {
    const identity = `${selection.source}\0${selection.name}`;
    if (identities.has(identity)) return `Skill ${selection.name} was selected more than once.`;
    identities.add(identity);
    if (selection.targets.length === 0 || !candidates.some((candidate) => isSelectedCandidate(candidate, selection))) {
      return `Selection for ${selection.name} does not match a source-resolved local skill.`;
    }
    if (selection.targets.some((agentId) => !candidates.some((candidate) => isSelectedCandidate(candidate, { ...selection, targets: [agentId] })))) {
      return `Selection for ${selection.name} includes an unverified agent target.`;
    }
  }
  return null;
}

function isBootstrapProvider(provider: InitStateProvider): provider is BootstrapInitStateProvider {
  return "bootstrap" in provider && typeof provider.bootstrap === "function";
}

function hasExplicitDivergentChoices(divergent: readonly InitCandidate[], selections: readonly InitSelection[]): boolean {
  const names = new Set(divergent.map((candidate) => candidate.name));
  return [...names].every((name) => selections.filter((selection) => selection.name === name).length === 1);
}
