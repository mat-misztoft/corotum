# CLI

The compiled `corotum` binary is the v0.1 client. Git Sync uses the CLI for desired-state mutations. Cloud desired-state mutations after init are performed from the [dashboard or WebMCP](./dashboard-and-webmcp.md).

```text
corotum --help
corotum --version
```

Global flags:

```bash
corotum --json <command>
corotum --non-interactive <command>
```

`--json` prints a machine-readable envelope with `schemaVersion` `1`. `--non-interactive` never waits for a prompt. A missing TTY is also non-interactive. Non-interactive paths exit instead of prompting.

## Commands

| Command | What it does |
| --- | --- |
| `corotum init <repository> [--replace <name...>] [--keep <name...>] [--adopt-artifact <name...>]` | Initialize Git Sync and adopt selected local skills |
| `corotum init cloud [--origin <url>] [--replace <name...>] [--keep <name...>] [--adopt-artifact <name...>]` | Pair with Cloud if needed, then adopt selected local skills into Cloud |
| `corotum login [--origin <url>]` | Pair this device in a browser |
| `corotum logout [--origin <url>]` | Revoke this device token and delete local Cloud credentials |
| `corotum add <source> [--skill <name>] [--ref <ref>]` | Add one Git-backed skill (Git Sync) |
| `corotum adopt <name> --source <source> [--skill <name>] [--ref <ref>]` | Adopt one local unmanaged skill (Git Sync) |
| `corotum remove <skill>` | Remove a managed skill from desired state and reconciled targets (Git Sync) |
| `corotum unmanage <skill>` | Stop managing a skill and leave local copies in place (Git Sync) |
| `corotum restore [skill] [--all]` | Restore managed content from the exact lock (Git Sync) |
| `corotum update [skill]` | Update exact locks from upstream (Git Sync) |
| `corotum update --check` | Report upstream status without changing state |
| `corotum set-ref <skill> <ref>` | Change a managed skill ref and lock exact content (Git Sync) |
| `corotum status` | Show local reconciliation status (Git Sync) |
| `corotum diff` | Show the exact-lock reconciliation plan (Git Sync) |
| `corotum sync` | Reconcile local skills to the exact locked state (Git Sync) |
| `corotum config list` | Print local `config.json` |
| `corotum config get <key>` | Print one config value |
| `corotum config set telemetry true\|false` | Set anonymous CLI telemetry consent |
| `corotum migrate cloud --strategy <replace\|merge\|cancel>` | Copy Git desired state to Cloud |
| `corotum migrate git <repository> --strategy <replace\|merge\|cancel>` | Copy Cloud desired state to Git |
| `corotum cli-update` | Update the Corotum executable |
| `corotum cli-update --check` | Report CLI release availability |

`corotum update` updates skills. `corotum cli-update` updates the Corotum executable.

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

`corotum config set` currently supports only `telemetry` (`true` or `false`). Telemetry is anonymous, opt-in, and stored on the device. It is not a dashboard account setting.

Default locations:

| Platform | Config | Skills / Git cache |
| --- | --- | --- |
| macOS | `~/Library/Application Support/ToolMirror/` | same tree (`skills/`, `git/`) |
| Linux | `$XDG_CONFIG_HOME/corotum/` (default `~/.config/corotum/`) | `$XDG_DATA_HOME/corotum/` |
| Windows | `%APPDATA%\ToolMirror\` | `%LOCALAPPDATA%\ToolMirror\` |

## Cloud origin

Default Cloud origin is `https://corotum.com`. Override with `--origin` or `TOOLMIRROR_CLOUD_ORIGIN`. Origins must be `http` or `https` and must not include credentials.

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
