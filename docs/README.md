# Corotum documentation

Public documentation for Corotum v0.5. These pages describe only commands and behavior that exist in this repository.

Cloud Sync is the current workstream. Git Sync / Free remains documented and available. Zero installed or enabled agents is valid. Global skill management does not require an agent. The Cloud dashboard is a full product surface.

| Page | Contents |
| --- | --- |
| [Install and cli-update](./install.md) | Official installers, unsigned binaries, SHA-256 verification, `cli-update` |
| [CLI](./cli.md) | Welcome screen, commands, flags, exit codes, JSON envelope, config, optional agents |
| [Skills and v2 contracts](./skills.md) | Named `~/.agents/skills`, source vs artifact, denylist, errors |
| [Git Sync](./git-sync.md) | Free Git backend, `corotum.yaml` / lock, skill mutations, `PENDING_PUSH` |
| [Self-hosted Cloud](./self-hosting.md) | Deploy Corotum Cloud without Creem |
| [Hosted corotum.com](./hosted-cloud.md) | Creem checkout, subscription, billing portal, entitlement |
| [Dashboard and WebMCP](./dashboard-and-webmcp.md) | Full Cloud product surface, device reports, WebMCP tools |
| [Terms of Service](https://corotum.com/terms) / [Privacy Policy](https://corotum.com/privacy) | Hosted-service legal terms and privacy policy |
| [Migration](./migration.md) | Git ↔ Cloud, ToolMirror upgrade, `corotum migrate legacy-cleanup` |

v0.5 binaries are unsigned. Official installers are the only supported installation path. There is no daemon and no remote forced sync.
