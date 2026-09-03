---
title: Git Sync
---

# Git Sync

Git Sync / Free remains a fully documented Git-backed backend. No Corotum account is required. Cloud Sync is the current workstream; Git Sync is not hidden or removed. System Git must be installed. If Git is missing, Corotum stops before partial mutation and tells you to install Git.

Zero installed or enabled agents is valid. Global skills live in `~/.agents/skills`. Agents are optional local exposure, not a prerequisite for init, skill management, or sync.

Desired state in the sync repository is v2:

```text
corotum.yaml
corotum.lock
corotum.transitions.json
artifacts/
```

Source-backed locks store metadata only. Artifact-backed skills store sanitized files under `artifacts/`. See [skills.md](/concepts/skills/) for source-versus-artifact rules, denylist, and `--allow-artifacts`.

Cloud mode does not require Git unless a skill source is a Git repository.

## Initialize

On a TTY, `corotum init` asks Git Sync versus Corotum Cloud (arrow keys), then a Git URL, optional agent enablement, which local skills to check, and batch Skip/All/Choose gates. Explicit Git Sync:

```bash
corotum init repository git@github.com:example/corotum-state.git
```

`<git-url>` is the desired-state Git remote Corotum owns as a local clone. An empty remote (no commits) is valid. Init discovers `~/.agents/skills` independently of agents. Missing that directory is valid. Init classifies each skill from its own provenance (including `~/.agents/.skill-lock.json` as a hint, not a commit proof) and adopts only the skills you select. Checking upstream uses one shallow clone per unique source URL. Source-unknown local skills stay unmanaged unless you adopt them as artifacts (TTY gate or `--adopt-artifact`). Skills whose recorded source cannot be read can be kept as artifacts with source metadata retained. **Replace** at init overwrites that named folder in `~/.agents/skills` with the locked bytes. Adoption is never all-or-nothing.

If init commits locally but `git push` fails (`PENDING_PUSH`), a later `corotum init` on the same machine resumes without repeating skill prompts.

Non-interactive init never prompts. Pass `repository` or `cloud`. Git Sync also requires the repository URL:

```bash
corotum --non-interactive init repository git@github.com:example/corotum-state.git
```

Non-interactive init applies only exact `--replace`, `--keep`, and `--adopt-artifact` choices, and never enables undetected or unconfigured agents.

A machine that is already configured refuses init (`ALREADY_INITIALIZED`).

## Add, adopt, update, restore

```bash
corotum add owner/skills --skill review --ref main
corotum adopt review --source owner/skills --ref main
corotum update --check
corotum update
corotum update review
corotum set-ref review v1.2.3
corotum restore review
```

`owner/skills` is GitHub shorthand for `https://github.com/owner/skills.git`. HTTPS, SSH, GitLab, Codeberg, self-hosted Git, and other normal Git remotes also work. URLs with embedded credentials or tokens are rejected. Git credentials stay with system Git.

One managed entry is allowed per `source + skill`. Repeating `add` for the same identity does not change its ref; use `set-ref`.

Default `--ref` is `HEAD` as the manifest follow ref. The lockfile stores the exact commit SHA resolved at add/update/set-ref time. `sync` installs that SHA. It never walks `HEAD` at reconcile time.

A skill with `source: null` remains syncable from its artifact. `update` reports `SOURCE_UNAVAILABLE` for it.

`status` never performs upstream checks. `update --check` reports `UP_TO_DATE`, `UPDATE_AVAILABLE`, `SOURCE_UNAVAILABLE`, `UNKNOWN`, `AUTH_REQUIRED`, or `CHECK_FAILED` without changing state.

These commands work with zero agents. Failures for missing Git, a bad repository, an unavailable remote, or Git authentication are typed and actionable.

## Remove versus unmanage

```bash
corotum remove review
corotum unmanage review
```

`remove` deletes the skill from desired state and reconciled agent targets. `unmanage` stops managing the skill and preserves local copies. Offline REMOVE/UNMANAGE stay typed; unmanaged content is not overwritten.

## Reconcile

```bash
corotum status
corotum diff
corotum sync
```

`sync` installs the exact locked revisions into `~/.agents/skills`. Enabled agents on this device then receive local exposure. Prefer symlink exposure; Corotum falls back to a normal copy when a symlink cannot be used. One failing target does not roll back unrelated successful targets. Applied revision advances only after verification. Absent or corrupt operational state is recovered only from proven ownership.

Zero enabled agents is valid: Git Sync still manages the global named store. Enable an agent later with `corotum agents enable` to expose already managed skills on that device.

There is no daemon, watch mode, scheduled update, or remote forced sync. A device reconciles only when you run `corotum sync` on that device.

## PENDING_PUSH

Git mutations pull first. If a previous desired-state push is still pending, mutating commands refuse to change state and report `PENDING_PUSH`. Restore network or Git credentials and retry (`corotum sync`, or `corotum init` if config was never written). Auth failures say that Git authentication is required. Read-only `status`, `diff`, and `update --check` remain available while a push is pending.

## Another machine

On a second home that is not already configured, join the existing desired-state repository:

```bash
corotum init repository git@github.com:example/corotum-state.git
corotum sync
```

Do not re-run init on a machine that already has Corotum configured. `corotum config set` does not write `mode` or `gitRepository`; inspect those keys with `corotum config list` or `corotum config get`. Each machine materializes into `~/.agents/skills` and keeps its own Git clone. Agents remain optional on every machine.
