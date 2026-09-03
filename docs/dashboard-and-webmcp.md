# Dashboard and WebMCP

The Cloud dashboard is a full product surface: overview, skills, devices, billing, and settings. Cloud UI and WebMCP call the same application services as the CLI. They change desired state only. v0.1 has no `sync_device` or `sync_all_devices` tool and does not remotely force a device to sync. A device applies revisions only when `corotum sync` runs on that device, then reports the applied revision. The dashboard never shows `SYNCED` before that report. There is no revision-history route.

CLI skill commands (`add`, `adopt`, `remove`, `unmanage`, `restore`, `update`, `set-ref`) also mutate Cloud desired state. Zero agents is valid.

On hosted corotum.com, paid Cloud functionality requires hosted Cloud entitlement. Self-hosted deployments do not require a Creem subscription.

## Dashboard

Sign in at the Cloud origin, then open:

| Path | Contents |
| --- | --- |
| `/dashboard` | Desired skills, pending resolution, device reports |
| `/dashboard/skills` | Skill id, ref, resolution, lock |
| `/dashboard/devices` | Per-device sync status, target rows, revoke |
| `/dashboard/billing` | Hosted Creem checkout/portal, or the self-hosted free notice |
| `/settings` | Points at local CLI telemetry; telemetry is not an account setting |

Revoking a device invalidates only that device's Cloud token. Remote machine rows are kept.

Device status chips sit on machine panels. A machine is not `SYNCED` until it reports an applied revision. Pending, behind, partial, drift, error, `AUTH_REQUIRED`, and hosted `402` states are visible as status, not decoration.

Skills that dashboard or WebMCP add or retarget are `PENDING_RESOLUTION` until a device with repository access resolves the exact lock (CLI resolve on a machine with Git also works). The UI states that no remote sync is requested. Devices then install that locked SHA or artifact; they never follow upstream `HEAD` during `corotum sync`.

Cloud skill mutations from the browser use same-origin `POST /api/v1/dashboard` with `baseRevisionId`, `idempotencyKey`, and a mutation object (`ADD`, `REMOVE`, `UPDATE`, `SET_REF`). A stale `baseRevisionId` returns HTTP `409`.

## WebMCP

`POST /api/v1/webmcp` with an authenticated session.

Read-only tools (no desired-state change):

| Tool | Result |
| --- | --- |
| `list_skills` | Workspace skills and revision |
| `list_devices` | Paired devices |
| `get_sync_status` | Device-reported sync and target status |
| `check_skill_updates` | Device-reported upstream check rows only. WebMCP never contacts a Git remote |

Mutation tools require `baseRevisionId` and `idempotencyKey`. Mutations also require a same-origin request.

| Tool | Arguments |
| --- | --- |
| `add_skill` | `source`, `skill`, optional `ref`, optional `targets` |
| `remove_skill` | `skillId` |
| `update_skill` | `skillId` |
| `set_skill_ref` | `skillId`, `ref` |

Example:

```bash
curl -X POST https://cloud.example.com/api/v1/webmcp \
  -H 'content-type: application/json' \
  --cookie 'session=<session>' \
  --data '{"tool":"list_skills"}'
```

```bash
curl -X POST https://cloud.example.com/api/v1/webmcp \
  -H 'content-type: application/json' \
  -H 'origin: https://cloud.example.com' \
  --cookie 'session=<session>' \
  --data '{"tool":"add_skill","baseRevisionId":"<revision-id>","idempotencyKey":"<uuid>","arguments":{"source":"owner/skills","skill":"review","ref":"main"}}'
```

Repository URLs must not include credentials. Retries with the same idempotency key do not duplicate revisions.

When add, update, or set-ref succeeds but devices have not locked content yet, the response includes `pendingResolution`. That is success, not a remote sync.

There is no WebMCP tool that runs `corotum sync` on a device.
