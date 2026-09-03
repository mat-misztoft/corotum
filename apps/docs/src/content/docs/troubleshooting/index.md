---
title: Troubleshooting
---

# Troubleshooting

## A skill is pending resolution

`PENDING_RESOLUTION` means a device with repository access must resolve the source. Run `corotum sync` from that device. The dashboard records desired state, but never requests a remote sync.

## A local skill changed

Corotum preserves managed drift rather than overwriting it. Review the reported target and use the CLI's documented recovery commands before changing local files.

## Cloud access is unavailable

Hosted Corotum Cloud can require an active entitlement. A self-hosted Corotum Cloud instance is free to use and does not need Creem or hosted Corotum billing.

## Need more detail?

Use the [CLI command reference](/cli/commands/), [Git Sync guide](/concepts/git-sync/), or [migration guide](/guides/migration/) for the exact workflow.
