# CLI

The compiled `toolmirror` binary is the v0.1 client. Git Sync uses the CLI for desired-state mutations. Cloud desired-state mutations after init are performed from the [dashboard or WebMCP](./dashboard-and-webmcp.md).

```text
toolmirror --help
toolmirror --version
```

Global flags:

```bash
toolmirror --json <command>
toolmirror --non-interactive <command>
```

`--json` prints a machine-readable envelope with `schemaVersion` `1`. `--non-interactive` never waits for a prompt. A missing TTY is also non-interactive. Non-interactive paths exit instead of prompting.

## Commands

| Command | What it does |
| --- | --- |
| `toolmirror init <repository> --source <source>` | Initialize Git Sync and adopt selected local skills |
| `toolmirror init cloud --source <source> [--origin <url>]` | Pair with Cloud if needed, then adopt selected local skills into Cloud |
| `toolmirror login [--origin <url>]` | Pair this device in a browser |
| `toolmirror logout [--origin <url>]` | Revoke this device token and delete local Cloud credentials |
| `toolmirror add <source> [--skill <name>] [--ref <ref>]` | Add one Git-backed skill (Git Sync) |
| `toolmirror adopt <name> --source <source> [--skill <name>] [--ref <ref>]` | Adopt one local unmanaged skill (Git Sync) |
| `toolmirror remove <skill>` | Remove a managed skill from desired state and reconciled targets (Git Sync) |
| `toolmirror unmanage <skill>` | Stop managing a skill and leave local copies in place (Git Sync) |
| `toolmirror restore [skill] [--all]` | Restore managed content from the exact lock (Git Sync) |
| `toolmirror update [skill]` | Update exact locks from upstream (Git Sync) |
| `toolmirror update --check` | Report upstream status without changing state |
| `toolmirror set-ref <skill> <ref>` | Change a managed skill ref and lock exact content (Git Sync) |
| `toolmirror status` | Show local reconciliation status (Git Sync) |
| `toolmirror diff` | Show the exact-lock reconciliation plan (Git Sync) |
| `toolmirror sync` | Reconcile local skills to the exact locked state (Git Sync) |
| `toolmirror config list` | Print local `config.json` |
| `toolmirror config get <key>` | Print one config value |
| `toolmirror config set telemetry true\|false` | Set anonymous CLI telemetry consent |
| `toolmirror migrate cloud --strategy <replace\|merge\|cancel>` | Copy Git desired state to Cloud |
| `toolmirror migrate git <repository> --strategy <replace\|merge\|cancel>` | Copy Cloud desired state to Git |
| `toolmirror cli-update` | Update the ToolMirror executable |
| `toolmirror cli-update --check` | Report CLI release availability |

`toolmirror update` updates skills. `toolmirror cli-update` updates the ToolMirror executable.

## Exit codes

| Code | Outcome |
| ---: | --- |
| 0 | `SUCCESS` |
| 1 | `GENERAL_ERROR` |
| 2 | `PARTIAL_SUCCESS` |
| 3 | `CONFLICT` |
| 4 | `AUTH_REQUIRED` |
| 5 | `INVALID_CONFIG` |
| 6 | `NETWORK_ERROR` |

Partial local apply does not roll back unrelated successful targets.

## Config and credentials

Local configuration lives in `config.json`. Device Cloud tokens live in `credentials.json` with restrictive file permissions. The plaintext device token is never printed by `login`.

`toolmirror config set` currently supports only `telemetry` (`true` or `false`). Telemetry is anonymous, opt-in, and stored on the device. It is not a dashboard account setting.

Default locations:

| Platform | Config | Skills / Git cache |
| --- | --- | --- |
| macOS | `~/Library/Application Support/ToolMirror/` | same tree (`skills/`, `git/`) |
| Linux | `$XDG_CONFIG_HOME/toolmirror/` (default `~/.config/toolmirror/`) | `$XDG_DATA_HOME/toolmirror/` |
| Windows | `%APPDATA%\ToolMirror\` | `%LOCALAPPDATA%\ToolMirror\` |

## Cloud origin

Default Cloud origin is `https://toolmirror.com`. Override with `--origin` or `TOOLMIRROR_CLOUD_ORIGIN`. Origins must be `http` or `https` and must not include credentials.

## Supported agents

v0.1 detects a closed built-in list. Init asks which detected agents to enable. Non-interactive init never enables agents automatically; enable them in `config.json` `agents` before running init without a TTY.

| Id | Agent |
| --- | --- |
| `codex` | Codex |
| `claude-code` | Claude Code |
| `pi` | Pi |
| `gemini-cli` | Gemini CLI |
| `opencode` | OpenCode |
| `cursor` | Cursor |
| `windsurf` | Windsurf |
| `cline` | Cline |
| `roo-code` | Roo Code |
| `github-copilot` | GitHub Copilot |
| `kiro-cli` | Kiro CLI |

v0.1 manages global/user-level skills only. Project-level skills are out of scope.

## Mutation lock

State-mutating commands share one process lock. If the recorded PID is dead, the stale lock is removed. `cli-update --check` does not replace the executable.
