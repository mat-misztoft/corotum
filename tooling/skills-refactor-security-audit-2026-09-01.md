# T107 Skills refactor security and architecture audit

Date: 2026-09-01  
Repository: `corotum`  
Scope: `COROTUM-SKILLS-REFACTOR.md` section I invariants, secret policy, archive safety, ownership/recovery, desired-state equivalence, and portable-core runtime boundaries.

Hosted production deployment is out of scope.

## Commands and results

Run from the product repository root.

| Command | Result |
| --- | --- |
| `bun run check:boundaries` | PASS (`Architecture boundaries: PASS`) |
| `bun run check:skills-security` | PASS (`93 pass / 0 fail` across 10 files, then `Architecture boundaries: PASS`) |
| `bun test` | PASS (`459 pass / 0 fail`, 79 files) |
| `bun run typecheck` | PASS (`bunx tsc --noEmit`) |
| `bun run docs:check` | PASS (`docs:check passed`) |
| `bun run web:build` | PASS (`Build complete`) |

Independent security-regression command: `bun run check:skills-security`  
Independent architecture-boundary command: `bun run check:boundaries`

## Finding summary

| ID | Severity | Status | Summary |
| --- | --- | --- | --- |
| F1 | P1 | Fixed | Git source materialization extracted `git archive` TAR with system `tar -xf` and no entry validation. Sync now parses the TAR with the shared validator, rejects traversal/symlink/device entries, and never publishes a failed staging directory. |
| — | P0/P1 | None remaining | No unresolved P0/P1 findings. |

P2 observations that are not defects against the frozen architecture:

- `add`/`adopt` default `--ref HEAD` is follow-ref update intent. Lock `revision` must be a 40/64 hex SHA; `parseV2Lockfile` rejects `revision: "HEAD"`.
- `apps/cli/src/init.ts` still contains a v1 helper that would record `ref: "HEAD"`. Live `init` uses T109/T110 adoption and does not call that path.

## Invariant map

Invariants are quoted from `COROTUM-SKILLS-REFACTOR.md` section I.

### Never uses HEAD during sync

- Implementation: `GitSkillMaterializer.materializeLockedSource` fetches `lock.revision` and throws `SOURCE_UNAVAILABLE` if the resolved commit is not exactly that revision. `ExactContentMaterializer.stage` for `kind: "source"` calls that path only. `immutableGitRevisionSchema` is `/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/`.
- Tests: `packages/skills-adapter/src/exact-materializer.test.ts` (“stages the locked Git revision after upstream HEAD changes”); `packages/skills-adapter/src/git-source.test.ts` (“materializeLockedSource refuses HEAD…”); `packages/core/src/index.test.ts` (“rejects malformed IDs, hashes…” including `revision: "HEAD"`); `apps/cli/src/init-adoption.test.ts` (“locks … immutable revision, not HEAD”).

### Never deletes/overwrites unmanaged or ambiguous content

- Implementation: `planV2Reconcile` classifies unknown or unmanaged collisions as `LOCAL_CONFLICT` with no operations. `recoverLocalOperationalState` leaves ambiguous regular directories unmanaged.
- Tests: `packages/core/src/index.test.ts` v2 local reconcile safety; `apps/cli/src/local-state.test.ts` recovery cases; Git/Cloud v2 E2E re-add after UNMANAGE.

### Never silently overwrites drift

- Implementation: drifted canonical or copy hashes plan `DRIFTED` and empty operations. Ordinary sync does not overwrite.
- Tests: `packages/core/src/index.test.ts` (“ordinary sync never overwrites a drifted managed skill”); `apps/cli/src/v2-sync.integration.test.ts`; Git v2 E2E restore-only drift.

### Never uploads a denylisted potential secret

- Implementation: `scanNormalizedContent` rejects denylisted paths even when ignored. Artifact creation and Git artifact trees scan before publish.
- Tests: `packages/skills-adapter/src/normalized-content.test.ts` denylist matrix; `apps/cli/src/init-adoption.test.ts` (“denylisted local content cannot be selected”); Git v2 E2E “rejects secrets”.

### Never follows an archive absolute/traversal/symlink escape

- Implementation: `parseTar` / `validatedTarFiles` reject absolute paths, `..`, non-regular entries (symlinks, hardlinks, devices), duplicate paths, and bomb limits (`MAX_ENTRIES = 10_000`, `MAX_EXPANDED_BYTES = 64 MiB`). Pax `g`/`x` headers are skipped and cannot override paths. Git source extract now uses this parser instead of system tar.
- Tests: `packages/skills-adapter/src/artifact-archive.test.ts` traversal/absolute/link/bomb cases; `packages/skills-adapter/src/git-source.test.ts` symlink Git archive; `apps/web/src/artifacts.test.ts` corrupt archives never published.

### Never records credentials

- Implementation: `assertSafeGitSource` rejects URL userinfo before Git runs. Cloud origin and desired-state PUT reject credential URLs. Device tokens persist `token_hash` only.
- Tests: `git-source.test.ts` credential URLs; `apps/web/e2e/security.test.ts`; `apps/cli/src/cloud-auth.test.ts`; `apps/web/src/tokens.test.ts`.

### Never declares Cloud SYNCED before local verification

- Implementation: Cloud sync reports after canonical and target verification. Stale or failed local apply does not claim SYNCED.
- Tests: `packages/saas-provider/src/v2-sync.test.ts`; `apps/cli/src/cloud-v2.e2e.test.ts` report-after-verify; `apps/web/src/sync-report.test.ts`.

### Never deletes the current/retained artifact

- Implementation: GC deletes only objects absent from current and previous per-skill references; ambiguous listing deletes nothing.
- Tests: `apps/web/src/artifacts.test.ts` GC; Cloud v2 E2E retention/GC.

### Never converts UNMANAGE to REMOVE because history is short

- Implementation: durable `activeDispositions` ledger, not a bounded transition walk.
- Tests: `packages/core/src/index.test.ts` ledger + offline UNMANAGE vs REMOVE; Git/Cloud v2 E2E offline dispositions.

### Never infers ownership from name/hash alone

- Implementation: recovery requires verified canonical path plus symlink-to-canonical or retained copy evidence. Same-hash unmanaged directories stay unmanaged.
- Tests: `apps/cli/src/local-state.test.ts` (“leaves ambiguous matching regular directories unmanaged”, copy recovery requires evidence).

### Never auto-adopts all discovered skills

- Implementation: init requires explicit selection / non-interactive flags. Unselected content is untouched.
- Tests: `apps/cli/src/init-adoption.test.ts`; init transaction tests.

### Never allows two active managed names

- Implementation: `validateV2DesiredState` rejects duplicate NFC/case-folded names.
- Tests: `packages/core/src/index.test.ts` duplicate normalized names.

### Never replaces an agent target it cannot prove it owns

- Implementation: `AgentTargetManager` no-ops unowned targets; reconcile plans collisions as `LOCAL_CONFLICT`.
- Tests: `packages/agent-targets/src/targets.test.ts`; core target collision planning; v2 lifecycle restore/unmanage.

### Never destructively migrates legacy data without a recoverable copy

- Implementation: ToolMirror/old-store migration stages, verifies, retains originals until explicit cleanup; failures restore previous roots.
- Tests: `apps/cli/src/legacy-migration.test.ts`; `apps/cli/src/skills-storage-migration.test.ts`; Git v2 E2E legacy import.

## Runtime boundaries

`packages/core` and `packages/shared` import only portable modules (`yaml`, `zod` in core). `bun run check:boundaries` scans those trees and rejects Bun, Node builtins, Git, Cloudflare, UI, auth, and billing imports.

`packages/core/src/index.ts` contains no Bun/Node/Cloud imports.

## Desired-state equivalence

Git (`corotum.yaml` / `corotum.lock` / ledger / `artifacts/`) and Cloud (D1 metadata + R2 `r2-tar-zst`) share `validateV2DesiredState`, `planV2Reconcile`, and `ExactContentMaterializer`. Cross-provider round trips are covered by `apps/cli/src/v2-migration.test.ts` and Cloud v2 E2E.

## Defect fixed in this audit

Git `git archive` TAR was extracted with `tar -xf --strip-components`. That could materialize symlink or other non-file entries before the normalized-content scan. Extraction now:

1. parses USTAR with the shared validator
2. ignores Git pax global/extended headers without applying path overrides
3. allows directory headers with trailing slashes
4. writes only regular files under the locked skill prefix
5. discards staging on any failure

Evidence: `git-source.test.ts` symlink rejection; existing hash/HEAD exact-revision tests still pass.
