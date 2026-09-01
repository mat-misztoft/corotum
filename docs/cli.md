# CLI

The compiled `corotum` binary is the v0.1 client. Git Sync uses the CLI for desired-state mutations. Cloud desired-state mutations after init are performed from the [dashboard or WebMCP](./dashboard-and-webmcp.md). Local reconcile (`status`, `diff`, `sync`) works in both modes.

Contracts for named storage, source versus artifact, denylist, typed errors, and non-interactive consent are in [skills.md](./skills.md).

```text
corotum --help
corotum --version
```

Global flags:

```bash
corotum --json <command>
corotum --non-interactive <command>
corotum --allow-artifacts <command>
```

`--json` prints a machine-readable envelope with `schemaVersion` `1`. `--non-interactive` never waits for a prompt. A missing TTY is also non-interactive. Non-interactive paths exit instead of prompting.

`--allow-artifacts` is the non-interactive consent to commit exact local artifact files to Git. Without it, those writes fail with `CONFIRMATION_REQUIRED` in JSON.

## Commands

| Command | What it does |
| --- | --- |
| `corotum init <repository> [--skill <name...>] [--replace <name...>] [--keep <name...>] [--adopt-artifact <name...>]` | Initialize Git Sync and adopt selected local skills from `~/.agents/skills` |
| `corotum init cloud [--origin <url>] [--skill <name...>] [--replace <name...>] [--keep <name...>] [--adopt-artifact <name...>]` | Pair with Cloud if needed, then adopt selected local skills into Cloud |
| `corotum login [--origin <url>]` | Pair this device in a browser |
| `corotum logout [--origin <url>]` | Revoke this device token and delete local Cloud credentials |
| `corotum add <source> [--skill <name>] [--ref <ref>]` | Add one Git-backed skill (Git Sync) |
| `corotum adopt <name> --source <source> [--skill <name>] [--ref <ref>]` | Adopt one local unmanaged skill (Git Sync) |
| `corotum remove <skill>` | Remove a managed skill from desired state and reconciled targets (Git Sync) |
| `corotum unmanage <skill>` | Stop managing a skill and leave local copies in place (Git Sync) |
| `corotum restore <skill>` | Restore one managed skill from its exact lock (Git Sync) |
| `corotum update [skill]` | Update exact locks from upstream (Git Sync) |
| `corotum update --check` | Report upstream status without changing state |
| `corotum set-ref <skill> <ref>` | Change a managed skill ref and lock exact content (Git Sync) |
| `corotum status` | Show local reconciliation status (Git or Cloud) |
| `corotum diff` | Show the exact-lock reconciliation plan (Git or Cloud) |
| `corotum sync` | Reconcile local skills to the exact locked state (Git or Cloud) |
| `corotum config list` | Print local `config.json` |
| `corotum config get <key>` | Print one config value |
| `corotum config set telemetry true\|false` | Set anonymous CLI telemetry consent |
| `corotum migrate cloud --strategy <replace\|merge\|cancel>` | Copy Git desired state to Cloud |
| `corotum migrate git <repository> --strategy <replace\|merge\|cancel>` | Copy Cloud desired state to Git |
| `corotum migrate legacy` | Import recoverable ToolMirror state into Corotum v2 |
| `corotum migrate legacy-cleanup` | Delete verified ToolMirror backup files after a successful import |
| `corotum cli-update` | Update the Corotum executable |
| `corotum cli-update --check` | Report CLI release availability |

`corotum update` updates skills. `corotum cli-update` updates the Corotum executable.

`add` / `adopt` `--ref` defaults to `HEAD` as the *follow* ref for later updates. The lock stores the resolved commit SHA. `sync` never installs `HEAD`.

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

JSON may also set `outcome` to `CONFIRMATION_REQUIRED` (artifact consent) while the process still exits `GENERAL_ERROR`. Partial local apply does not roll back unrelated successful targets.

## JSON examples

```json
{
  "schemaVersion": 1,
  "outcome": "SUCCESS"
}
```

Status / diff / sync envelopes add `command`, `status`, `revision`, `appliedRevision`, `pendingPush`, `recovery`, `classifications`, and `operations`. Example after a successful sync:

```json
{
  "schemaVersion": 1,
  "outcome": "SUCCESS",
  "status": "SYNCED",
  "command": "SYNC",
  "revision": "abc123",
  "pendingPush": false
}
```

`status` values include `READY`, `SYNCED`, `PARTIAL`, `DRIFTED`, `LOCAL_CONFLICT`, `PENDING_PUSH`, `RECOVERABLE`, and `ERROR`.

## Config and credentials

Local configuration lives in `config.json`. Device Cloud tokens live in `credentials.json` with restrictive file permissions. The plaintext device token is never printed by `login`.

`corotum config set` currently supports only `telemetry` (`true` or `false`). Telemetry is anonymous, opt-in, and stored on the device. It is not a dashboard account setting.

Default locations:

| Platform | Config | Named skills | Git cache |
| --- | --- | --- | --- |
| macOS | `~/Library/Application Support/Corotum/` | `~/.agents/skills/` | same Corotum tree (`git/`) |
| Linux | `$XDG_CONFIG_HOME/corotum/` (default `~/.config/corotum/`) | `~/.agents/skills/` | `$XDG_DATA_HOME/corotum/` |
| Windows | `%APPDATA%\Corotum\` | `~/.agents/skills/` | `%LOCALAPPDATA%\Corotum\` |

## Cloud origin

Default Cloud origin is `https://corotum.com`. Override with `--origin` or `COROTUM_CLOUD_ORIGIN`. Origins must be `http` or `https` and must not include credentials.

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
