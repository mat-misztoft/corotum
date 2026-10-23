---
title: Desired-state skill management (Terraform-style) with Corotum
description: Declare which agent skills should exist at which locked revision, preview the plan, and reconcile every machine and agent to it.
---

Corotum manages agent skills as desired state: you declare which skills should exist at which locked revision, `corotum diff` shows the plan, and `corotum sync` reconciles the machine to it, in the same spirit as Terraform or Nix, scoped to skills.

## The model

| Concept | In Corotum |
| --- | --- |
| Declared state | `corotum.yaml`: source, skill and followed ref |
| Locked state | `corotum.lock`: exact commit SHA and content hash, or artifact hashes |
| Plan | `corotum diff` |
| Apply | `corotum sync` |
| Actual state | `~/.agents/skills` plus agent exposure on each device |
| State backend | A Git repository you own (Git Sync) or a Cloud workspace (Corotum Cloud) |

Desired-state files use the v2 names `corotum.yaml`, `corotum.lock` and `corotum.transitions.json`. Each managed skill has a stable ID that stays in metadata.

## Change desired state, then reconcile

All changes go through explicit commands, the same in Git Sync and Cloud:

```bash
corotum add owner/skills --skill review --ref main   # declare + lock
corotum set-ref review v1.2.3                        # re-point + lock
corotum adopt review --source owner/skills           # bring an existing local skill under management
corotum remove review                                # remove from desired state and targets
corotum unmanage review                              # stop managing, keep local copies
corotum diff                                         # plan
corotum sync                                         # apply
```

With Corotum Cloud, the dashboard and WebMCP can change desired state too. Skills they add stay `PENDING_RESOLUTION` until a device with repository access runs `corotum sync` and locks the exact content.

## Safety rules

- Sync installs locked revisions only, never upstream HEAD.
- Unmanaged skills and managed local drift are not silently overwritten.
- One failing target does not roll back unrelated successful targets, and the applied revision advances only after verification.
- State-changing commands share one process lock.
- Nothing forces a remote device to reconcile. In Cloud, opt-in automatic sync (`corotum auto enable`) runs the same safe sync path on that device when it receives a revision hint.

## Two backends, one model

- **Git Sync (free):** state in your Git repository; manual `corotum sync` on each machine. No Corotum account.
- **Corotum Cloud:** hosted at $5.99/month or $59.90/year, or self-hosted for free under AGPLv3. Adds a dashboard, per-device status, WebMCP and opt-in automatic sync.

You can move between them with `corotum migrate cloud` or `corotum migrate git <repository>`, choosing `--strategy replace`, `merge` or `cancel`.

## Scope

v0.5 manages global (user-level) skills. Agents are optional. Supported agents:

- Codex
- Claude Code
- Pi
- Gemini CLI
- OpenCode
- Cursor
- Windsurf
- Cline
- Roo Code
- GitHub Copilot
- Kiro CLI
