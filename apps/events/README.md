# Automatic Cloud synchronization: implementation and verification

Verified locally on macOS ARM64, 2026-10-15. Repository, CLI and documentation versions: **0.8.0**. Changes are not committed, tagged, pushed, or deployed to a production Cloudflare account.

## Architecture

The existing web Worker authenticates device tokens, CLI versions, workspace membership/ownership and hosted entitlement. Its public endpoints are:

- `GET /api/v2/workspaces/:workspaceId/events`: authenticated WebSocket upgrade.
- `GET /api/v2/workspaces/:workspaceId/revision`: revision id/sequence only; no R2 or full desired-state reads.

`mutateDesiredState` announces a newly committed D1 revision once, after its atomic batch succeeds. Idempotent replays, failed writes, reads and device sync reports do not announce changes. Publication failure has a two-second deadline and cannot fail an already committed mutation. Reconnect and hourly metadata checks recover lost notifications.

`corotum-events` is a private service-binding Worker with one SQLite-backed `WorkspaceEvents` Durable Object per workspace. It has **no D1/R2 bindings, skill storage, alarms, timers, Git, or synchronization engine**. It uses `acceptWebSocket`, `getWebSockets` and socket attachments, with a per-socket sequence high-water mark. Its only wire payload is:

```json
{"type":"revision.updated","workspaceId":"ws_example","revisionSequence":42,"revisionId":"rev_example"}
```

Subscriptions use service-binding **fetch**, not RPC: actual workerd testing found WebSocket Responses cannot be serialized over RPC. Publish/revoke calls use RPC. The web route creates a mutable upgrade Response while preserving its socket because vinext modifies response headers.

**Do not expose this Worker publicly.** `workers_dev` and preview URLs are disabled and there are no routes. Internal subscription headers are trusted only because ingress is the private service binding; `events.internal` is not an authentication secret.

Every broadcast gets an authoritative, indexed active-token allowlist from D1 and rechecks entitlement. Thus revocation is enforced even if the explicit disconnect call fails or races a subscription. Sessions expire after at most one hour; expiry is checked before delivery. Explicit logout, device revoke and subscription cancellation also invalidate sockets. Caps: four sockets/device and 256/workspace.

The standalone CLI runs the existing `V2SyncService`/local applier under the existing mutation lock. Startup performs a full local check. Later unchanged revision checks skip state/artifact downloads, skill scans and reports. Two-second debounce, ordered hint validation, serial trailing work, jittered retries, Retry-After handling for metadata, hourly fallback, local config watches and sleep-gap detection provide recovery. Local conflicts stay blocked; partial results and failed reports remain retryable. Operational output is a bounded private JSON snapshot, not an accumulating log.

## CLI and native services

```sh
corotum auto enable
corotum auto status
corotum --json auto status
corotum auto disable
# Native service entry point:
corotum --non-interactive auto run
```

Enable proves both authenticated metadata and a real subscription before installing a service. Existing schema-1 configurations default disabled. The resolved origin is persisted for native execution. Disable and CLI upgrades ask the worker to finish ongoing work before removing/restarting native registration; no manual mutation is killed. Cloud-to-Git migration disables Cloud auto sync after releasing the migration lock. Git synchronization otherwise remains manual and unchanged.

Native integrations: macOS launchd LaunchAgent; Linux systemd user unit; Windows limited, interactive per-user Task Scheduler task. They reference the installed standalone executable, not a Bun/Node runtime or a copied binary.

## Deployment

1. Install repository dependencies with `bun install`.
2. Deploy `apps/events` first: `bun run --cwd apps/events deploy`. Its `v1` SQLite Durable Object migration creates `WorkspaceEvents`.
3. Keep the web `EVENTS` service binding pointing to that private Worker, plus `CLOUD_READ_LIMITER`, `CLOUD_WRITE_LIMITER` and `CLOUD_AUTH_LIMITER` native rate-limit bindings.
4. Apply D1 migrations, including `0014_auto_sync_indexes.sql`: from `apps/web`, run `bunx wrangler d1 migrations apply corotum --remote`.
5. Build and deploy the web Worker using the existing deployment process. `tooling/release-deploy.ts` deploys events before web and stops if events deployment fails; remote D1 migrations remain an explicit operator step.
6. No new public DNS name, secret, R2 bucket, D1 database or external service is needed. Clients continue using the configured Cloud origin. Self-hosted deployments do not need hosted billing.

The two partial indexes keep broadcast authorization bounded to the affected workspace/devices rather than scanning global membership/token tables. Existing installations retain manual sync when events are absent; `auto enable` refuses an unavailable event endpoint.

## Measured evidence

- **131 tests passed, zero failed**, 21 focused files, 725 assertions and two snapshots: auto protocol/scheduler/native/lifecycle/config, mutation locking, existing V2 sync/applier/lifecycle, migration CLI, Cloud/Git V2 E2E, revision publishing, token/revocation, HTTP routes, entitlement and rate limiting. Intentional publication-outage tests log `REVISION_NOTIFICATION_FAILED`.
- `bun run --cwd apps/events test`: real workerd WebSockets; fanout/isolation, duplicate and out-of-order rejection, attachment expiry, explicit and missed-invalidation revocation, both connection caps and input rejection. After **12 seconds without DO work**, a new constructor instance served the still-connected sockets and restored their attachment sequence: actual hibernation/reconstruction, not only a mock.
- `bun run --cwd apps/events test:clients`: builds the production vinext app and runs **two compiled CLI processes** with isolated homes against real workerd, D1 migrations and the events Worker. Both installed a Git-backed skill automatically. One final local run observed **2245 ms** from commit to both verified applied revisions, including debounce; this is a functional sample, not an edge latency benchmark.
- The same production-build test proves socket reconnection checks only revision metadata for an unchanged head, offline restart converges, REMOVE preserves its ledger semantics, and a revoked token cannot receive/apply the next revision or read protected state even without an explicit invalidation.
- During its 2.5-second idle observation, state/revision/report counters did not change. Before that window, counters were `{state:4, revision:1, reports:2}`; the revision count includes the fixture's production-route probe. Two macOS `ps` samples reported unchanged cumulative CPU time `0:00.16` per process and approximately **70,544–70,672 KiB RSS**. These are short, coarse local observations, not sustained utilization measurements.
- Real macOS launchd install/start/running/stop/remove passed with a standalone compiled idle fixture; its temporary registration was removed.
- All five CLI targets compiled: macOS ARM64/x64, Linux ARM64/x64 and Windows x64. The ARM64 macOS executable reports `corotum 0.8.0` and executed the convergence tests without a separate runtime.
- Root and events TypeScript checks, production web build, Astro docs check/build, architecture-boundary check and diff whitespace check passed. Scoped Biome check had no errors; warnings remain in test code (an existing unused binding and test non-null assertions). Astro emits its existing missing-404-entry warning.
- Events Wrangler dry-run validated the private binding/migration configuration; an observed bundle was approximately **6 KiB**, gzip **1.8 KiB**. No production deployment or billing measurements were performed.

## Cost and scale estimates — not benchmarks

With a healthy, unchanged workspace, there are **no continuous server loops**, notification messages, full-state downloads, R2 accesses or periodic skill scans. The local sleep-gap timer performs no network or filesystem work in the normal case. Authentication rotates approximately every 58–59 minutes, with device-specific jitter.

Per steady device/hour, approximately one subscription plus one metadata read performs **six SELECT statements** in self-hosted/free-launch mode, or **eight** with normal hosted entitlement checks. Up to two timestamp UPDATE statements occur per rotation; fresh authentication does not rewrite them. These are SQL statement estimates, **not billed D1 rows**. Indexed join/result sizes and concurrent foreground activity affect row charges.

| Connected devices across workspaces | Web API requests/hour | SELECT statements/hour | Activity UPDATE statements/hour | DO subscription requests/hour |
| --- | ---: | ---: | ---: | ---: |
| 100 | ~200 | ~600–800 | ~200 | ~100 |
| 1,000 | ~2,000 | ~6,000–8,000 | ~2,000 | ~1,000 |
| 10,000 | ~20,000 | ~60,000–80,000 | ~20,000 | ~10,000 |

Allow roughly 2–4% extra for the rotation interval, plus startup/reconnect/error traffic. Service-binding Worker invocations and close lifecycle callbacks are additional to this table. This assumes devices are distributed across workspaces within the per-workspace cap; it does not promise 10,000 sockets in one workspace. Shared-IP rate limits can also defer mass reconnects.

Each committed workspace revision adds two SELECTs for owner/active token authorization, or three when hosted entitlement needs a query, and one publish RPC to that workspace's DO. Each changed client checks metadata (three/four SELECTs), then uses the existing state/artifact/report pipeline. Its total reads/writes depend on desired-state size, changed skills, targets and pending resolutions; there is no honest constant cost for that existing pipeline. Pure Git skills require no R2. Unchanged reconnects do not create sync reports.

There are no per-notification D1 timestamp/rate-limit writes. Native rate-limit bindings replace D1 request counters on these paths. D1 revision commits and verified device reports retain their existing writes.

DO request demand is approximately connection establishments plus workspace publications/revocations and incoming lifecycle work. The client sends no application heartbeats or skill data. Cloudflare documents no charge for outgoing WebSocket messages and a 20:1 billing ratio for incoming WebSocket messages. Hibernation duration is unbilled; awake processing and the platform's pre-eviction interval remain billable. Duration depends on traffic **per workspace**, including hourly reconnects, not just total connected devices. No CPU-ms, GB-s, production dollar estimate or 10,000-device load benchmark was measured.

## Remaining verification limits

- Linux systemd, Windows Task Scheduler, macOS x64 and Linux/Windows binaries were not executed on their native platforms in this macOS ARM64 environment. Definitions, escaping and lifecycle behavior have focused tests; compilation alone is not native runtime certification.
- Production Cloudflare authorization, account quotas, DNS, remote migrations, deployment and edge billing were not exercised. The full production web response pipeline was exercised locally in workerd.
- A silent network black hole can wait for transport failure or the hourly fallback; sleep-gap detection and explicit disconnect recovery were tested/implemented, but physical network-roaming/sleep hardware tests were not performed.
- Services inherit the native user's environment, not arbitrary shell session overrides. Persist the Cloud origin; custom platform environment paths must be available to the native user service as well. Source skills still need non-interactive system Git access. Linux needs a working systemd user session; Windows runs while the user is logged in.
- Conflicts are never automatically approved. A stuck lock/manual mutation or service stop exceeding the drain deadline is reported for retry rather than killed. There is no claim that all safety/platform cases were load-tested.

## Changed files

```text
README.md
package.json
bun.lock
apps/cli/package.json
apps/cli/src/auto-cloud.ts
apps/cli/src/auto-cloud.test.ts
apps/cli/src/auto-command.ts
apps/cli/src/auto-command.test.ts
apps/cli/src/auto-native.ts
apps/cli/src/auto-native.test.ts
apps/cli/src/auto-sync.ts
apps/cli/src/auto-sync.test.ts
apps/cli/src/cli.ts
apps/cli/src/cli.test.ts
apps/cli/src/cli-update-command.ts
apps/cli/src/cloud-auth-command.ts
apps/cli/src/config.ts
apps/cli/src/migrate-command.ts
apps/cli/src/migrate-cli.test.ts
apps/cli/src/sync-command.ts
apps/cli/src/v2-sync.ts
apps/cli/src/v2-sync.integration.test.ts
apps/docs/package.json
apps/docs/astro.config.mjs
apps/docs/src/content/docs/cli/commands.md
apps/docs/src/content/docs/cloud/automatic-sync.md
apps/docs/src/content/docs/cloud/hosted.md
apps/docs/src/content/docs/cloud/self-hosting.md
apps/docs/src/content/docs/concepts/git-sync.md
apps/docs/src/content/docs/concepts/skills.md
apps/docs/src/content/docs/getting-started/install.md
apps/docs/src/content/docs/index.md
apps/docs/src/content/docs/reference/product.md
apps/docs/src/content/docs/webmcp/dashboard-and-webmcp.md
apps/events/README.md
apps/events/package.json
apps/events/tsconfig.json
apps/events/wrangler.jsonc
apps/events/src/index.ts
apps/events/scripts/fixture.ts
apps/events/scripts/integration.mjs
apps/events/scripts/client-fixture.ts
apps/events/scripts/built-client-fixture.ts
apps/events/scripts/client-integration.mjs
apps/web/cloudflare-env.d.ts
apps/web/wrangler.jsonc
apps/web/app/api/v1/cli/logout/route.ts
apps/web/app/api/v1/dashboard/route.ts
apps/web/app/api/v1/devices/[id]/revoke/route.ts
apps/web/app/api/v1/webhooks/creem/route.ts
apps/web/app/api/v1/webmcp/route.ts
apps/web/app/api/v1/workspaces/[id]/state/route.ts
apps/web/app/api/v1/workspaces/[id]/state/resolve/route.ts
apps/web/app/api/v2/workspaces/[id]/events/route.ts
apps/web/app/api/v2/workspaces/[id]/revision/route.ts
apps/web/src/auth.ts
apps/web/src/billing.ts
apps/web/src/billing.test.ts
apps/web/src/db/schema.ts
apps/web/src/rate-limit.ts
apps/web/src/revisions.ts
apps/web/src/revisions.test.ts
apps/web/src/state-http.ts
apps/web/src/state-http.test.ts
apps/web/src/tokens.ts
apps/web/src/tokens.test.ts
apps/web/src/workspace-events.ts
apps/web/src/workspace-events.test.ts
apps/web/src/events-routes.test.ts
apps/web/scripts/events-route-check.ts
apps/web/migrations/0014_auto_sync_indexes.sql
apps/web/migrations/meta/0014_snapshot.json
apps/web/migrations/meta/_journal.json
tooling/release-deploy.ts
```
