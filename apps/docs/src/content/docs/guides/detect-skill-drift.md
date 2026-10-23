---
title: Detect skill drift between machines and agents
description: Use corotum status and corotum diff to find skills that differ from the locked revision, on one machine or across all your devices.
---

Run `corotum status` on a machine to see whether its managed skills match the locked desired state, and `corotum diff` to see the exact reconciliation plan; with Corotum Cloud, the dashboard shows the same per device and per agent.

## What counts as drift

Corotum compares three things: the desired state (manifest + lock), what is installed in `~/.agents/skills`, and what each enabled agent is exposed to. Differences show up as typed states:

| Status | Meaning | What sync does |
| --- | --- | --- |
| `SYNCED` | Matches the locked revision | Nothing |
| `DRIFTED` | A managed copy was changed locally | Does not clobber it |
| `LOCAL_CONFLICT` | Unmanaged or unproven content is in the way | Does not overwrite it |
| `PARTIALLY_SYNCED` | Some skills or targets failed | Reports partial, not success |
| `AUTH_REQUIRED` | This device can't read a private source | Keeps local files |
| `PENDING_PUSH` | A Git desired-state push is still pending | Refuses new mutations |

## Check one machine

```bash
corotum status
corotum diff
```

`status` never contacts upstream. It reports local reconciliation only. `diff` prints what `sync` would change. Both are read-only.

For scripts and CI, use JSON:

```bash
corotum --json status
```

The envelope includes `schemaVersion`, `outcome`, `status`, `revision`, `appliedRevision` and per-skill classifications. Exit codes are typed: for example `2` for partial success and `3` for conflict.

## Check all machines (Corotum Cloud)

After each device runs `corotum sync`, it reports the revision it applied. The dashboard's **Devices** page shows per-device and per-target status: pending, behind, partial, drift, error and `AUTH_REQUIRED`. A device is never shown as SYNCED until it has reported. Over WebMCP, `get_sync_status` returns the same device-reported status.

There is no remote force-sync. The dashboard shows drift; it does not reach into a machine to change it.

## Resolve drift

Corotum preserves drift rather than overwriting it. Decide which copy is right:

- To keep a hand-edited skill outside Corotum: `corotum unmanage <skill>` (local copies stay).
- If automatic Cloud sync is on and a conflict persists, run `corotum auto disable`, then `corotum status`, `corotum diff` and `corotum sync`, then `corotum auto enable`.

Don't delete skills just to silence a status error.
