# Git Sync

Git Sync is the free backend. No Corotum account is required. System Git must be installed. If Git is missing, Corotum stops before partial mutation and tells you to install Git.

Cloud mode does not require Git unless a skill source is a Git repository.

## Initialize

```bash
corotum init git@github.com:example/corotum-state.git --source owner/skills
```

`<repository>` is the desired-state Git remote Corotum owns as a local clone. `--source` is the Git repository that contains the local skills being adopted. Init detects agents, discovers global skills, and adopts only the skills you select. Source-unknown local skills stay visible and unmanaged. Adoption is never all-or-nothing.

Non-interactive init requires `--skill` names when you want a subset, refuses divergent local copies, and never enables undetected or unconfigured agents.

## Add, adopt, update, restore

```bash
corotum add owner/skills --skill review --ref main
corotum adopt review --source owner/skills --ref main
corotum update --check
corotum update
corotum update review
corotum set-ref review v1.2.3
corotum restore review
corotum restore --all
```

`owner/skills` is GitHub shorthand for `https://github.com/owner/skills.git`. HTTPS, SSH, GitLab, Codeberg, self-hosted Git, and other normal Git remotes also work. URLs with embedded credentials or tokens are rejected. Git credentials stay with system Git.

One managed entry is allowed per `source + skill`. Repeating `add` for the same identity does not change its ref; use `set-ref`.

Default `--ref` is `HEAD`. Manifest `ref` is what later updates follow. The lockfile stores the exact commit installed during sync.

`status` never performs upstream checks. `update --check` reports `UP_TO_DATE`, `UPDATE_AVAILABLE`, `UNKNOWN`, `AUTH_REQUIRED`, or `CHECK_FAILED` without changing state.

## Remove versus unmanage

```bash
corotum remove review
corotum unmanage review
```

`remove` deletes the skill from desired state and reconciled agent targets. `unmanage` stops managing the skill and preserves local copies.

## Reconcile

```bash
corotum status
corotum diff
corotum sync
```

`sync` applies the exact locked revisions to enabled agent targets. Prefer symlink exposure; Corotum falls back to a normal copy when a symlink cannot be used. One failing target does not roll back unrelated successful targets.

There is no daemon, watch mode, scheduled update, or remote forced sync. A device reconciles only when you run `corotum sync` on that device.

## PENDING_PUSH

Git mutations pull first. If a previous desired-state push is still pending, mutating commands refuse to change state and report `PENDING_PUSH`. Restore network access and retry. Read-only `status`, `diff`, and `update --check` remain available while a push is pending.

## Another machine

`corotum init` refuses a desired-state repository that already contains skills. On a second machine, install the CLI, create `config.json` with `schemaVersion` `1`, `mode` `git`, and `gitRepository` set to that remote, enable the agents you want under `agents`, then run:

```bash
corotum sync
```

Do not re-run init against the existing repository. `corotum config set` does not write `mode` or `gitRepository`; those keys are set by init on the first machine or by editing `config.json` directly. Each machine has its own canonical store and Git clone.
