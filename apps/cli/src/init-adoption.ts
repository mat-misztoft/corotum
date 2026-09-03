import { type SourceLock, skillId } from "../../../packages/core/src/index";
import {
  type GitCommandRunner,
  GitSkillMaterializer,
  GitSourceError,
  resolveGitDefaultRef,
} from "../../../packages/skills-adapter/src/git-source";
import {
  ContentScanError,
  scanNormalizedContent,
} from "../../../packages/skills-adapter/src/normalized-content";
import type { DiscoveredInitCandidate } from "./init-provenance";

const classifyId = skillId("sk_initclassify");
const immutableRevision = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sha256 = /^sha256:[a-f0-9]{64}$/;

export const SOURCE_REFRESH_NOTICE =
  "Source-backed skills will be verified and refreshed against their upstream, then locked to the resolved immutable revision.";

export type InitClassification =
  | "unchanged"
  | "modified"
  | "unavailable"
  | "auth-required"
  | "unknown";

export type InitUnmanagedOutcome =
  | "DO_NOT_MANAGE"
  | "UNSELECTED"
  | "SOURCE_UNAVAILABLE"
  | "AUTH_REQUIRED"
  | "DUPLICATE_NAME"
  | "SCAN_FAILED"
  | "INVALID_CHOICE";

export type InitAdoptionAction =
  | "replace"
  | "keep"
  | "adopt-artifact"
  | "do-not-manage";

export type InitAdoptionChoice = Readonly<{
  name: string;
  action: Exclude<InitAdoptionAction, "do-not-manage">;
}>;

export type RetainedInitSource = Readonly<{
  repository: string;
  path: string;
  ref?: string;
  revision?: string;
  contentHash?: SourceLock["contentHash"];
}>;

export type InitAdoptionPrompt = Readonly<{
  notice: (message: string) => void;
  chooseModified: (
    names: readonly string[],
  ) => Promise<ReadonlyMap<string, "replace" | "keep" | "do-not-manage">>;
  chooseUnavailable: (
    names: readonly string[],
    code: "SOURCE_UNAVAILABLE" | "AUTH_REQUIRED",
  ) => Promise<readonly string[]>;
  chooseUnknown: (names: readonly string[]) => Promise<readonly string[]>;
  chooseDuplicate: (
    name: string,
    candidates: readonly DiscoveredInitCandidate[],
  ) => Promise<string | "do-not-manage">;
}>;

export type ClassifiedInitCandidate = Readonly<{
  candidate: DiscoveredInitCandidate;
  classification: InitClassification;
  source?: RetainedInitSource;
  resolved?: SourceLock;
  localContentHash?: `sha256:${string}`;
  scanError?: string;
}>;

export type InitSkillOutcome =
  | Readonly<{
      kind: "source-backed";
      name: string;
      path: string;
      classification: "unchanged" | "modified";
      source: SourceLock;
      materialization: Readonly<{
        kind: "source";
        contentHash: SourceLock["contentHash"];
      }>;
      notice: typeof SOURCE_REFRESH_NOTICE;
    }>
  | Readonly<{
      kind: "artifact-backed";
      name: string;
      path: string;
      classification: "modified" | "unavailable" | "auth-required" | "unknown";
      outcome?: "SOURCE_UNAVAILABLE" | "AUTH_REQUIRED";
      source?: RetainedInitSource;
      localContentHash: `sha256:${string}`;
    }>
  | Readonly<{
      kind: "unmanaged";
      name: string;
      path: string;
      classification: InitClassification;
      outcome: InitUnmanagedOutcome;
      reason: string;
      source?: RetainedInitSource;
    }>;

export type DecideInitAdoptionsInput = Readonly<{
  candidates: readonly DiscoveredInitCandidate[];
  classified?: readonly ClassifiedInitCandidate[];
  nonInteractive: boolean;
  choices?: readonly InitAdoptionChoice[];
  prompt?: InitAdoptionPrompt;
  materializer?: GitSkillMaterializer;
  runGit?: GitCommandRunner;
}>;

/** Maps CLI `--adopt-artifact` values to exact non-interactive choices. */
export function adoptArtifactChoices(
  names: readonly string[],
): readonly InitAdoptionChoice[] {
  return names.map((name) => ({ name, action: "adopt-artifact" as const }));
}

export async function classifyInitCandidates(
  candidates: readonly DiscoveredInitCandidate[],
  deps: Pick<DecideInitAdoptionsInput, "materializer" | "runGit"> & {
    onProgress?: () => void;
  } = {},
): Promise<readonly ClassifiedInitCandidate[]> {
  const materializer =
    deps.materializer ?? new GitSkillMaterializer(deps.runGit);
  const classified: ClassifiedInitCandidate[] = [];
  const groups = new Map<string, number[]>();
  for (const [index, candidate] of candidates.entries()) {
    if (
      candidate.provenance.status !== "source-known" ||
      !candidate.provenance.sourceUrl ||
      !candidate.provenance.skillPath
    ) {
      classified[index] = await classifyOne(
        candidate,
        materializer,
        deps.runGit,
      );
      deps.onProgress?.();
      continue;
    }
    const group = groups.get(candidate.provenance.sourceUrl) ?? [];
    group.push(index);
    groups.set(candidate.provenance.sourceUrl, group);
  }
  await mapPool([...groups.entries()], 4, async ([source, indices]) => {
    await classifySourceGroup({
      source,
      indices,
      candidates,
      classified,
      materializer,
      runGit: deps.runGit,
      onProgress: deps.onProgress,
    });
  });
  return classified;
}

/**
 * Resolves each discovered skill independently and returns explicit per-skill
 * decisions. Local files are never moved or overwritten here.
 */
export async function decideInitAdoptions(
  input: DecideInitAdoptionsInput,
): Promise<readonly InitSkillOutcome[]> {
  const classified =
    input.classified ?? (await classifyInitCandidates(input.candidates, input));
  const choices = indexChoices(input.choices ?? []);
  const duplicateNames = duplicateNormalizedNames(input.candidates);
  const uniqueDuplicates = uniqueDuplicateSelections(
    input.candidates,
    duplicateNames,
    choices,
  );

  if (!input.nonInteractive && input.prompt) {
    for (const name of duplicateNames) {
      if (
        input.candidates.some(
          (candidate) =>
            candidate.normalizedName === name &&
            uniqueDuplicates.has(candidate.name),
        )
      ) {
        continue;
      }
      const group = input.candidates.filter(
        (candidate) => candidate.normalizedName === name,
      );
      const picked = await input.prompt.chooseDuplicate(name, group);
      if (picked !== "do-not-manage") uniqueDuplicates.add(picked);
    }
  }

  const prompted = await batchPromptedActions({
    classified,
    choices,
    duplicateNames,
    uniqueDuplicates,
    nonInteractive: input.nonInteractive,
    prompt: input.prompt,
  });

  let noticed = false;
  const outcomes: InitSkillOutcome[] = [];
  for (const entry of classified) {
    const outcome = await decideOne(entry, {
      nonInteractive: input.nonInteractive,
      prompt: input.prompt,
      choice: choices.get(entry.candidate.name),
      prompted: prompted.get(entry.candidate.name),
      duplicate: duplicateNames.has(entry.candidate.normalizedName),
      selectedDuplicate: uniqueDuplicates.has(entry.candidate.name),
    });
    if (
      outcome.kind === "source-backed" &&
      !input.nonInteractive &&
      input.prompt &&
      !noticed
    ) {
      input.prompt.notice(SOURCE_REFRESH_NOTICE);
      noticed = true;
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

async function classifySourceGroup(
  input: Readonly<{
    source: string;
    indices: readonly number[];
    candidates: readonly DiscoveredInitCandidate[];
    classified: ClassifiedInitCandidate[];
    materializer: GitSkillMaterializer;
    runGit?: GitCommandRunner;
    onProgress?: () => void;
  }>,
): Promise<void> {
  const members = input.indices.map((index) => input.candidates[index]!);
  const locals = await Promise.all(
    members.map((candidate) => scanLocal(candidate.path)),
  );
  try {
    const ref = await resolveGitDefaultRef(input.source, input.runGit);
    const resolved = await input.materializer.resolveNormalizedGroup(
      input.source,
      ref,
      members.map((candidate) => ({
        skill: candidate.name,
        path: candidate.provenance.skillPath,
      })),
    );
    for (const [offset, candidate] of members.entries()) {
      const local = locals[offset]!;
      const item = resolved[offset]!;
      const index = input.indices[offset]!;
      if (item instanceof GitSourceError) {
        input.classified[index] = classifiedFailure(candidate, local, item);
      } else {
        const source = toSourceLock(item, ref);
        input.classified[index] = {
          candidate,
          classification:
            local.hash && local.hash === source.contentHash
              ? "unchanged"
              : "modified",
          source,
          resolved: source,
          localContentHash: local.hash,
          scanError: local.error,
        };
      }
      input.onProgress?.();
    }
  } catch (error) {
    for (const [offset, candidate] of members.entries()) {
      input.classified[input.indices[offset]!] = classifiedFailure(
        candidate,
        locals[offset]!,
        error,
      );
      input.onProgress?.();
    }
  }
}

function classifiedFailure(
  candidate: DiscoveredInitCandidate,
  local: Readonly<{ hash?: `sha256:${string}`; error?: string }>,
  error: unknown,
): ClassifiedInitCandidate {
  return {
    candidate,
    classification: isAuthRequired(error) ? "auth-required" : "unavailable",
    source: {
      repository: candidate.provenance.sourceUrl!,
      path: candidate.provenance.skillPath!,
    },
    localContentHash: local.hash,
    scanError: local.error,
  };
}

async function classifyOne(
  candidate: DiscoveredInitCandidate,
  materializer: GitSkillMaterializer,
  runGit?: GitCommandRunner,
): Promise<ClassifiedInitCandidate> {
  const local = await scanLocal(candidate.path);
  if (
    candidate.provenance.status !== "source-known" ||
    !candidate.provenance.sourceUrl ||
    !candidate.provenance.skillPath
  ) {
    return {
      candidate,
      classification: "unknown",
      localContentHash: local.hash,
      scanError: local.error,
    };
  }

  const known: RetainedInitSource = {
    repository: candidate.provenance.sourceUrl,
    path: candidate.provenance.skillPath,
  };

  try {
    const ref = await resolveGitDefaultRef(
      candidate.provenance.sourceUrl,
      runGit,
    );
    const resolved = await materializer.resolveNormalized({
      id: classifyId,
      source: candidate.provenance.sourceUrl,
      skill: candidate.name,
      ref,
      path: candidate.provenance.skillPath,
    });
    const source = toSourceLock(resolved, ref);
    return {
      candidate,
      classification:
        local.hash && local.hash === source.contentHash
          ? "unchanged"
          : "modified",
      source,
      resolved: source,
      localContentHash: local.hash,
      scanError: local.error,
    };
  } catch (error) {
    return {
      candidate,
      classification: isAuthRequired(error) ? "auth-required" : "unavailable",
      source: known,
      localContentHash: local.hash,
      scanError: local.error,
    };
  }
}

async function batchPromptedActions(
  input: Readonly<{
    classified: readonly ClassifiedInitCandidate[];
    choices: Map<string, InitAdoptionChoice["action"] | "invalid">;
    duplicateNames: Set<string>;
    uniqueDuplicates: Set<string>;
    nonInteractive: boolean;
    prompt?: InitAdoptionPrompt;
  }>,
): Promise<Map<string, InitAdoptionAction>> {
  const prompted = new Map<string, InitAdoptionAction>();
  if (input.nonInteractive || !input.prompt) return prompted;
  const eligible = (entry: ClassifiedInitCandidate) =>
    !input.choices.get(entry.candidate.name) &&
    !(
      input.duplicateNames.has(entry.candidate.normalizedName) &&
      !input.uniqueDuplicates.has(entry.candidate.name)
    );

  const unknowns = input.classified.filter(
    (entry) => entry.classification === "unknown" && eligible(entry),
  );
  if (unknowns.length > 0) {
    const adopted = new Set(
      await input.prompt.chooseUnknown(
        unknowns.map((entry) => entry.candidate.name),
      ),
    );
    for (const entry of unknowns) {
      prompted.set(
        entry.candidate.name,
        adopted.has(entry.candidate.name) ? "adopt-artifact" : "do-not-manage",
      );
    }
  }

  for (const [classification, code] of [
    ["unavailable", "SOURCE_UNAVAILABLE"],
    ["auth-required", "AUTH_REQUIRED"],
  ] as const) {
    const group = input.classified.filter(
      (entry) => entry.classification === classification && eligible(entry),
    );
    if (group.length === 0) continue;
    const kept = new Set(
      await input.prompt.chooseUnavailable(
        group.map((entry) => entry.candidate.name),
        code,
      ),
    );
    for (const entry of group) {
      prompted.set(
        entry.candidate.name,
        kept.has(entry.candidate.name) ? "keep" : "do-not-manage",
      );
    }
  }

  const modified = input.classified.filter(
    (entry) => entry.classification === "modified" && eligible(entry),
  );
  if (modified.length > 0) {
    const decisions = await input.prompt.chooseModified(
      modified.map((entry) => entry.candidate.name),
    );
    for (const entry of modified) {
      prompted.set(
        entry.candidate.name,
        decisions.get(entry.candidate.name) ?? "do-not-manage",
      );
    }
  }
  return prompted;
}

async function decideOne(
  entry: ClassifiedInitCandidate,
  input: Readonly<{
    nonInteractive: boolean;
    prompt?: InitAdoptionPrompt;
    choice?: InitAdoptionChoice["action"] | "invalid";
    prompted?: InitAdoptionAction;
    duplicate: boolean;
    selectedDuplicate: boolean;
  }>,
): Promise<InitSkillOutcome> {
  if (input.choice === "invalid") {
    return unmanaged(
      entry,
      "INVALID_CHOICE",
      "Each skill accepts at most one exact choice.",
    );
  }
  if (input.duplicate && !input.selectedDuplicate) {
    return unmanaged(
      entry,
      "DUPLICATE_NAME",
      "Duplicate normalized names require one explicit candidate.",
    );
  }

  const action = await resolveAction(entry, input);
  if (action === "invalid") {
    return unmanaged(entry, "INVALID_CHOICE", invalidChoiceReason(entry));
  }
  if (action === "unselected") {
    return unmanaged(entry, unselectedCode(entry), unselectedReason(entry));
  }
  if (action === "do-not-manage") {
    return unmanaged(
      entry,
      "DO_NOT_MANAGE",
      "Local content was left unmanaged.",
    );
  }
  if (action === "replace") return sourceBacked(entry);
  return artifactBacked(entry, action);
}

async function resolveAction(
  entry: ClassifiedInitCandidate,
  input: Readonly<{
    nonInteractive: boolean;
    prompt?: InitAdoptionPrompt;
    choice?: InitAdoptionChoice["action"] | "invalid";
    prompted?: InitAdoptionAction;
    duplicate: boolean;
    selectedDuplicate: boolean;
  }>,
): Promise<InitAdoptionAction | "unselected" | "invalid"> {
  if (input.choice && input.choice !== "invalid")
    return validateChoice(entry, input.choice);
  if (input.prompted) return input.prompted;
  if (input.nonInteractive || !input.prompt) return "unselected";
  if (entry.classification === "unchanged") return "replace";
  return "unselected";
}

function validateChoice(
  entry: ClassifiedInitCandidate,
  action: InitAdoptionChoice["action"],
): InitAdoptionAction | "invalid" {
  if (
    action === "replace" &&
    entry.resolved &&
    (entry.classification === "unchanged" ||
      entry.classification === "modified")
  ) {
    return "replace";
  }
  if (
    action === "keep" &&
    (entry.classification === "modified" ||
      entry.classification === "unavailable" ||
      entry.classification === "auth-required")
  ) {
    return "keep";
  }
  if (action === "adopt-artifact" && entry.classification === "unknown")
    return "adopt-artifact";
  return "invalid";
}

function sourceBacked(entry: ClassifiedInitCandidate): InitSkillOutcome {
  if (
    !entry.resolved ||
    (entry.classification !== "unchanged" &&
      entry.classification !== "modified")
  ) {
    return unmanaged(
      entry,
      "INVALID_CHOICE",
      "A source-backed decision requires a resolved immutable revision.",
    );
  }
  return {
    kind: "source-backed",
    name: entry.candidate.name,
    path: entry.candidate.path,
    classification: entry.classification,
    source: entry.resolved,
    materialization: {
      kind: "source",
      contentHash: entry.resolved.contentHash,
    },
    notice: SOURCE_REFRESH_NOTICE,
  };
}

function artifactBacked(
  entry: ClassifiedInitCandidate,
  action: "keep" | "adopt-artifact",
): InitSkillOutcome {
  if (!entry.localContentHash) {
    return unmanaged(
      entry,
      "SCAN_FAILED",
      entry.scanError ??
        "Artifact adoption requires a successful denylist/ignore scan.",
    );
  }
  return {
    kind: "artifact-backed",
    name: entry.candidate.name,
    path: entry.candidate.path,
    classification:
      entry.classification === "unknown"
        ? "unknown"
        : entry.classification === "unchanged"
          ? "modified"
          : entry.classification,
    outcome:
      entry.classification === "unavailable"
        ? "SOURCE_UNAVAILABLE"
        : entry.classification === "auth-required"
          ? "AUTH_REQUIRED"
          : undefined,
    source: action === "adopt-artifact" ? undefined : entry.source,
    localContentHash: entry.localContentHash,
  };
}

function unmanaged(
  entry: ClassifiedInitCandidate,
  outcome: InitUnmanagedOutcome,
  reason: string,
): InitSkillOutcome {
  return {
    kind: "unmanaged",
    name: entry.candidate.name,
    path: entry.candidate.path,
    classification: entry.classification,
    outcome,
    reason,
    source: entry.classification === "unknown" ? undefined : entry.source,
  };
}

function unselectedCode(entry: ClassifiedInitCandidate): InitUnmanagedOutcome {
  if (entry.classification === "unavailable") return "SOURCE_UNAVAILABLE";
  if (entry.classification === "auth-required") return "AUTH_REQUIRED";
  return "UNSELECTED";
}

function unselectedReason(entry: ClassifiedInitCandidate): string {
  if (entry.classification === "unavailable") {
    return "Upstream source is unavailable; local content was not overwritten.";
  }
  if (entry.classification === "auth-required") {
    return "Private source requires authentication; local content was not overwritten.";
  }
  return "No exact non-interactive choice was supplied.";
}

function invalidChoiceReason(entry: ClassifiedInitCandidate): string {
  if (entry.classification === "unknown") {
    return "Unknown provenance requires --adopt-artifact <name>; no source is invented.";
  }
  return "The supplied choice does not match this skill's classification.";
}

function toSourceLock(
  resolved: {
    repository: string;
    path: string;
    revision: string;
    contentHash: string;
  },
  ref: string,
): SourceLock {
  if (
    ref === "HEAD" ||
    resolved.revision === "HEAD" ||
    !immutableRevision.test(resolved.revision)
  ) {
    throw new GitSourceError(
      "SOURCE_UNAVAILABLE",
      "Init must lock an immutable revision, not HEAD.",
    );
  }
  if (!sha256.test(resolved.contentHash)) {
    throw new GitSourceError(
      "SOURCE_UNAVAILABLE",
      "Resolved source content hash is invalid.",
    );
  }
  return {
    repository: resolved.repository,
    path: resolved.path,
    ref,
    revision: resolved.revision,
    contentHash: resolved.contentHash as SourceLock["contentHash"],
  };
}

async function scanLocal(
  path: string,
): Promise<Readonly<{ hash?: `sha256:${string}`; error?: string }>> {
  try {
    return { hash: (await scanNormalizedContent(path)).contentHash };
  } catch (error) {
    return {
      error:
        error instanceof ContentScanError
          ? error.message
          : "Artifact adoption requires a successful denylist/ignore scan.",
    };
  }
}

function duplicateNormalizedNames(
  candidates: readonly DiscoveredInitCandidate[],
): Set<string> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(
      candidate.normalizedName,
      (counts.get(candidate.normalizedName) ?? 0) + 1,
    );
  }
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name),
  );
}

function uniqueDuplicateSelections(
  candidates: readonly DiscoveredInitCandidate[],
  duplicateNames: Set<string>,
  choices: Map<string, InitAdoptionChoice["action"] | "invalid">,
): Set<string> {
  const allowed = new Set<string>();
  for (const name of duplicateNames) {
    const selected = candidates.filter(
      (candidate) =>
        candidate.normalizedName === name &&
        choices.get(candidate.name) &&
        choices.get(candidate.name) !== "invalid",
    );
    if (selected.length === 1) allowed.add(selected[0].name);
  }
  return allowed;
}

function indexChoices(
  choices: readonly InitAdoptionChoice[],
): Map<string, InitAdoptionChoice["action"] | "invalid"> {
  const indexed = new Map<string, InitAdoptionChoice["action"] | "invalid">();
  for (const choice of choices) {
    indexed.set(
      choice.name,
      indexed.has(choice.name) ? "invalid" : choice.action,
    );
  }
  return indexed;
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof GitSourceError && error.code === "AUTH_REQUIRED";
}

async function mapPool<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        results[current] = await fn(items[current]!);
      }
    }),
  );
  return results;
}
