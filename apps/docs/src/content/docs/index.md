---
title: Corotum documentation
---

Public documentation for Corotum v0.5. These pages describe only commands and behavior that exist in this repository.

Cloud Sync is the current workstream. Git Sync / Free remains documented and available. Zero installed or enabled agents is valid. Global skill management does not require an agent. The Cloud dashboard is a full product surface.

| Page | Contents |
| --- | --- |
| [Install and cli-update](/getting-started/install/) | Official installers, unsigned binaries, SHA-256 verification, `cli-update` |
| [CLI](/cli/commands/) | Welcome screen, commands, flags, exit codes, JSON envelope, config, optional agents |
| [Skills and v2 contracts](/concepts/skills/) | Named `~/.agents/skills`, source vs artifact, denylist, errors |
| [Git Sync](/concepts/git-sync/) | Free Git backend, `corotum.yaml` / lock, skill mutations, `PENDING_PUSH` |
| [Self-hosted Cloud](/cloud/self-hosting/) | Deploy Corotum Cloud without Creem |
| [Hosted corotum.com](/cloud/hosted/) | Creem checkout, subscription, billing portal, entitlement |
| [Dashboard and WebMCP](/webmcp/dashboard-and-webmcp/) | Full Cloud product surface, device reports, WebMCP tools |
| [Terms of Service](https://corotum.com/terms) / [Privacy Policy](https://corotum.com/privacy) | Hosted-service legal terms and privacy policy |
| [Migration](/guides/migration/) | Git ↔ Cloud, ToolMirror upgrade, `corotum migrate legacy-cleanup` |

v0.5 binaries are unsigned. Official installers are the only supported installation path. There is no daemon and no remote forced sync.
