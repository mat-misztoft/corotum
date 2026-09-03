---
title: CLI
---

The compiled `corotum` binary is the v0.5 client. Cloud Sync is the current workstream. Git Sync / Free remains documented. Desired-state mutations use the same CLI skill commands in both modes. The [dashboard and WebMCP](/webmcp/dashboard-and-webmcp/) can also mutate Cloud desired state. Local reconcile (`status`, `diff`, `sync`) works in both modes. After Cloud `sync`, the device reports the applied revision.

Contracts for named storage, source versus artifact, denylist, typed errors, and non-interactive consent are in [skills.md](/concepts/skills/).

```text
corotum --help
corotum --version
```

With no subcommand, `corotum` prints a read-only welcome/system screen: ASCII banner, version, Git availability, OS/arch, Corotum home readiness, detected agents, Git Sync and Corotum Cloud as sync modes, and getting-started commands. It does not mutate state, create config, prompt for telemetry, sync, enable agents, or run init. Detected agents are informational; an agent is never required.

`--help` and `--version` (including `corotum init --help` and any other command `--help`) have no side effects: no telemetry prompt, no config creation, no mutation, no sync, and no agent enablement.

`--json` prints a machine-readable envelope with `schemaVersion` `1`. It never includes the welcome banner or ANSI. `corotum --json` is an envelope only, not the welcome screen.

Global flags:

```bash
corotum --json <command>
corotum --non-interactive <command>
corotum --allow-artifacts <command>
```

`--non-interactive` never waits for a prompt. A missing TTY is also non-interactive. Non-interactive paths exit instead of prompting.

`--allow-artifacts` is the non-interactive consent to commit exact local artifact files to Git. Without it, those writes fail with `CONFIRMATION_REQUIRED` in JSON.

## init

```bash
corotum init
corotum init repository <git-url> [--skill <name...>] [--replace <name...>] [--keep <name...>] [--adopt-artifact <name...>] [--origin <url>]
corotum init cloud [--origin <url>] [--skill <name...>] [--replace <name...>] [--keep <name...>] [--adopt-artifact <name...>] 
corotum --non-interactive init repository <git-url>
corotum --non-interactive init cloud
```

Initialize Git Sync or Corotum Cloud and adopt selected local skills from `~/.agents/skills`. Agents are not required.

On a TTY, uses arrow-key prompts (`@clack/prompts`). After Git Sync vs Cloud (and a Git URL when needed) it may ask to enable detected agents, then which local skills to check against upstream. Checking uses one shallow clone per unique Git source and a progress bar. Batch decisions are **Skip all** (default except the first local-skills gate), **All (N)**, or **Choose…**: unknown provenance (adopt as artifacts), unavailable/private sources (keep as artifacts), and modified skills (replace / keep / skip). Git push shows a spinner.

If a previous TTY init committed desired state but the Git push failed, `corotum init` resumes: it skips skill selection, retries the push, then finishes local apply and config. Empty Git remotes (no commits / no `@{upstream}`) are valid; Corotum creates the first commit and `push -u`.

`--non-interactive` never prompts. Missing provider is an actionable error: pass `repository` or `cloud`. Missing Git repository URL for Git Sync is also an actionable error.

## login

```bash
corotum login [--origin <url>]
```

Pair this device with Corotum Cloud in a browser. On a TTY it prints the verification URL and user code. It never prints the device token. `--non-interactive` and a missing TTY fail instead of waiting for a browser.

## logout

```bash
corotum logout [--origin <url>]
```

Revoke this device token when possible and always delete local Cloud credentials.

## reset

```bash
corotum reset [--yes]
```

Delete Cloud desired-state skills, unlink this device, and clear local Corotum config. `--yes` skips the prompt.

## add

```bash
corotum add <source> [--skill <name>] [--ref <ref>]
```

Resolve and add one Git-backed skill (Git Sync or Cloud). `--ref` defaults to `HEAD` as the follow ref for later updates. The lock stores the resolved commit SHA. `sync` never installs `HEAD`.

## adopt

```bash
corotum adopt <name> --source <source> [--skill <name>] [--ref <ref>]
```

Adopt one local unmanaged skill from a matching Git source. `--source` is required. `--skill` is the source name when it differs from the local name. `--ref` defaults to `HEAD` as the follow ref; the lock stores the resolved SHA.

## remove

```bash
corotum remove <skill>
```

Remove a managed skill from desired state and reconciled targets (Git Sync or Cloud).

## unmanage

```bash
corotum unmanage <skill>
```

Stop managing a skill and leave local copies in place (Git Sync or Cloud).

## restore

```bash
corotum restore <skill>
```

Restore one managed skill from its exact lock (Git Sync or Cloud).

## update

```bash
corotum update [skill]
corotum update --check
```

Update exact locks from upstream (Git Sync or Cloud). `--check` reports upstream status without changing state. This updates skills, not the CLI binary.

## set-ref

```bash
corotum set-ref <skill> <ref>
```

Change a managed skill ref and lock exact content (Git Sync or Cloud).

## status

```bash
corotum status
```

Show local reconciliation status (Git or Cloud). Spinner on a TTY.

## diff

```bash
corotum diff
```

Show the exact-lock reconciliation plan (Git or Cloud). Spinner on a TTY.

## sync

```bash
corotum sync
```

Reconcile local skills to the exact locked state (Git or Cloud). Cloud then reports the applied revision. Spinner on a TTY. Never installs upstream `HEAD`.

Git failures (auth, missing Git, bad repository, unreachable remote) are classified on every command. Interactive Git never waits on a credential prompt (`GIT_TERMINAL_PROMPT=0`). After auth failure on a pending push, sign in with system Git (`gh auth login` or a credential helper) and retry `corotum init` (resume) or `corotum sync` if already initialized.

## agents

```bash
corotum agents
corotum agents scan
corotum agents enable <agent>
corotum agents disable <agent>
```

List optional local agents. `scan` detects without enabling. `enable` exposes global skills for one agent on this device. `disable` removes only local exposure; `~/.agents/skills` and shared desired state stay.

## config

```bash
corotum config
corotum config list
corotum config get <key>
corotum config set telemetry true
corotum config set telemetry false
corotum config set origin <url>
```

Inspect or set local `config.json`. `list` (also the default) prints Git and Cloud keys without prompting. `set` supports only `telemetry` (`true` or `false`) and `origin` (`http` or `https`, no credentials).

## migrate

```bash
corotum migrate cloud --strategy <replace|merge|cancel> [--origin <url>]
corotum migrate git <repository> --strategy <replace|merge|cancel>
corotum migrate legacy
corotum migrate legacy-cleanup
```

`cloud` copies Git desired state to Cloud. `git` copies Cloud desired state to a Git repository. `legacy` imports recoverable ToolMirror state into Corotum v2. `legacy-cleanup` deletes verified ToolMirror backup files after a successful import. `--strategy` is required for Git ↔ Cloud.

## cli-update

```bash
corotum cli-update
corotum cli-update --check
```

Update the Corotum executable from official release metadata. `--check` reports availability without replacing the binary. `cli-update --check` does not take the mutation lock.

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

`status` values include `READY`, `SYNCED`, `PARTIALLY_SYNCED`, `DRIFTED`, `LOCAL_CONFLICT`, `PENDING_PUSH`, `RECOVERABLE`, `AUTH_REQUIRED`, and `ERROR`. Cloud classifications may also include `PENDING_RESOLUTION`.

## Config and credentials

Local configuration lives in `config.json`. Device Cloud tokens live in `credentials.json` with restrictive file permissions. The plaintext device token is never printed by `login`.

`corotum config list` and `corotum config get` inspect Git Sync and Cloud keys without prompting and without requiring an enabled agent. Known keys include `mode`, `gitRepository`, `workspaceId`, `deviceId`, `skillsStoragePath`, `gitStoragePath`, `telemetry`, `origin`, `installationId`, and `agents`.

`corotum config set` supports `telemetry` (`true` or `false`) and `origin` (Cloud URL). Telemetry is anonymous, opt-in, and stored on the device. It is not a dashboard account setting.

## Optional CLI telemetry

Telemetry is off until you confirm the first-run prompt or explicitly enable it. It is controlled locally on each device:

```bash
corotum config set telemetry true
corotum config set telemetry false
```

When enabled, Corotum sends anonymous operational data to Cloudflare Analytics Engine: a random installation identifier, CLI version, OS, architecture, command name, duration, outcome/error code, managed-skill count, active-agent count, and supported-agent identifiers. It does not send skill names, repository URLs, local paths, skill contents, credentials, device names, or Git usernames/emails. Telemetry is retained for no longer than 90 days.

CLI telemetry is separate from self-hosted Umami website analytics; their identifiers are not linked.

Default locations:

| Platform | Config | Named skills | Git cache |
| --- | --- | --- | --- |
| macOS | `~/Library/Application Support/Corotum/` | `~/.agents/skills/` | same Corotum tree (`git/`) |
| Linux | `$XDG_CONFIG_HOME/corotum/` (default `~/.config/corotum/`) | `~/.agents/skills/` | `$XDG_DATA_HOME/corotum/` |
| Windows | `%APPDATA%\Corotum\` | `~/.agents/skills/` | `%LOCALAPPDATA%\Corotum\` |

## Cloud origin

Default Cloud origin is `https://corotum.com`. Override with `COROTUM_CLOUD_ORIGIN`, `--origin`, or `corotum config set origin <url>` (env, then flag, then config, then default). Origins must be `http` or `https` and must not include credentials.

## Cloud Sync

Cloud Sync is the current workstream. Git Sync remains available ([git-sync.md](/concepts/git-sync/)).

`corotum login` pairs this device in a browser. On a TTY it prints the verification URL and user code. It never prints the device token. `--non-interactive` and a missing TTY fail instead of waiting for a browser. Pairing does not require hosted entitlement. `corotum logout` revokes the server token when possible and always deletes local Cloud credentials.

After `corotum init cloud` (or migrate to Cloud), these commands mutate Cloud desired state through the same v2 mutation path as Git, then apply locally:

```text
add
adopt
remove
unmanage
restore
update
set-ref
```

Missing login is a typed `corotum login` error. Hosted corotum.com Cloud mutations require an active entitlement (HTTP `402`). Self-hosted Cloud does not use Creem.

`add`, `update`, and `set-ref` resolve Git on this device. The dashboard and WebMCP can also mutate Cloud desired state. Skills they add or retarget may stay `PENDING_RESOLUTION` until a device with repository access locks exact content. A later CLI resolve on a device with Git access can complete that lock. Sync never installs upstream `HEAD`.

`status`, `diff`, and `sync` pull exact lockfile state. After a verified local sync, the device reports the applied revision. The dashboard does not show `SYNCED` until that report exists. Partial skill or target failure is `PARTIALLY_SYNCED` (or a per-target error), not a silent full success. There is no daemon and no remote forced sync.

## Optional agents

Agents are optional. Zero detected or enabled agents is a valid Corotum state. Global skill management, Git Sync, and Cloud Sync do not require an agent. Missing `~/.agents/skills` is valid. Existing global skills are discovered independently of agent detection.

v0.5 detects a closed built-in list. Interactive init may offer to enable detected agents; declining is valid. Non-interactive init never enables agents automatically.

```bash
corotum agents
corotum agents scan
corotum agents enable pi
corotum agents disable pi
```

`scan` detects without enabling. `enable` later may expose already managed global skills on this device. `disable` removes only local exposure: it does not delete `~/.agents/skills` and does not change shared desired state.

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

v0.5 manages global/user-level skills only. Project-level skills are out of scope.

## Mutation lock

State-mutating commands share one process lock. If the recorded PID is dead, the stale lock is removed. `cli-update --check` does not replace the executable.
