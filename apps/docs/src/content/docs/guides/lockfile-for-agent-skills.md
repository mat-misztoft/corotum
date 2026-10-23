---
title: A lockfile for agent skills: identical skills on every machine
description: How Corotum pins each agent skill to an exact commit SHA and content hash so every machine and agent installs identical bytes.
---

Corotum gives your agent skills a lockfile: `corotum.lock` records the exact commit SHA and content hash of every managed skill, and `corotum sync` installs those exact bytes on each machine.

## Why a lock, not a branch

A skill source like `owner/skills@main` points at different content on different days. If one machine installs on Monday and another on Friday, they can run different skills under the same name. Corotum separates *what you follow* from *what you install*:

- `corotum.yaml` is the manifest: source, skill name and the ref you follow (default `HEAD`).
- `corotum.lock` is the lock: repository, path, ref, the commit SHA resolved when you added or re-pointed the skill, and a content hash.

`corotum sync` installs the SHA from the lock. It never walks HEAD at reconcile time.

## Lock a skill

```bash
corotum add owner/skills --skill review --ref main
corotum diff
corotum sync
```

`add` resolves `main` to a commit SHA once and writes it to the lock. `diff` shows the plan for this machine; `sync` installs the locked revision into `~/.agents/skills/review/` and exposes it to the agents you enabled.

To pin to a tag or another ref, run `corotum set-ref review v1.2.3`. That changes the ref and locks the exact content in one step. Moving a lock is always a command you run, never a side effect of `sync`.

## The same lock on every machine

With Git Sync, the manifest and lock live in a Git repository you own. On a new machine:

```bash
corotum init repository git@github.com:you/corotum-state.git
corotum sync
```

Each machine keeps its own clone and installs the same locked revisions. With Corotum Cloud, each device reports the revision it applied.

## Skills without a Git source

A local skill with no readable source can be adopted as an **artifact**: Corotum stores sanitized exact files plus hashes, and sync installs those bytes. Files that match the secret denylist (for example `.env`, `*.pem` and `id_rsa`) are rejected. Committing artifact files to Git requires your consent.

## When bytes don't match

If installed content does not match the locked hash, Corotum reports `CONTENT_HASH_MISMATCH` instead of continuing quietly. Applied revision only advances after verification.

## Scope

v0.5 manages global (user-level) skills in `~/.agents/skills`. Project-level skills are out of scope. Agents are optional; the lock works with zero agents enabled.
