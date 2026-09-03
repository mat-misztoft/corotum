---
title: Product reference
---

Corotum keeps global skills in `~/.agents/skills`. Zero installed or enabled agents is a valid state; agents only expose that shared directory when you choose to enable them.

## Sync modes

- **Git Sync / Free** stores desired state in a Git repository you control.
- **Corotum Cloud** stores desired state in a hosted or self-hosted Cloud workspace. Hosted Corotum Cloud may require an entitlement; self-hosted Cloud never requires hosted billing.

Both modes use the same local `corotum sync` command. Sync is explicitly invoked: Corotum has no daemon, no scheduled/background sync, and no remote force-sync operation.

## Safety model

Managed skills retain stable IDs and exact locked revisions. Corotum does not silently overwrite unmanaged skills or managed local drift. Source-backed skills are resolved from their source; artifact-backed skills require explicit artifact permission.
