# T068 Fresh-install cross-system E2E evidence

Recorded against the product sources and tests in this repository. Playwright covers only critical browser flows. v0.1 binaries remain unsigned.

## Paths exercised

| Path | Expected | Result |
| --- | --- | --- |
| Official installer simulation | `install.sh` and `install.ps1` fixtures install a runnable CLI that prints `--version` before Git or Cloud work | PASS |
| Git Sync without Cloud subscription | Two homes adopt/add and install identical locked bytes with no Creem or hosted Cloud | PASS |
| Hosted Cloud launch access | Hosted Cloud pull/push works without a Creem grant through 30 September 2026, 23:59:59 UTC | PASS |
| Hosted Cloud after launch | Hosted Cloud operations return `Hosted Cloud subscription required` without a subscription from 1 October 2026, 00:00:00 UTC | PASS |
| Self-hosted Cloud without Creem | Self-hosted Cloud sync works and billing checkout is unavailable | PASS |
| Adoption and add | Git ADOPT then ADD, Cloud ADD of a locked skill | PASS |
| Two-device sync | Second device pulls the same revision and reports only after local apply | PASS |
| Private AUTH_REQUIRED | Private Git without credentials reports AUTH_REQUIRED and writes no state | PASS |
| PENDING_RESOLUTION | WebMCP `set_skill_ref` leaves the skill pending until a device resolves it | PASS |
| Device reporting | Sync reports store applied revision and derived aggregate only | PASS |
| Migration | Git → Cloud merge copies independent locked skills without rewriting the source | PASS |
| WebMCP | Read-only `get_sync_status` and mutation `set_skill_ref` use the dashboard mutation path | PASS |
| Drift/restore | Explicit restore rewrites drifted canonical bytes; unmanaged files stay | PASS |
| CLI update | Official `cli-update` replaces the installed 0.1.0 binary with 0.1.1 | PASS |
| Unmanaged content intact | Unmanaged `SKILL.md` is never overwritten or deleted | PASS |
| Status never SYNCED before apply | New devices stay `NEVER_SYNCED`; a SYNCED claim for a stale revision is stored as `BEHIND` | PASS |
| Playwright critical browser flows | Pairing approval, hosted billing, self-hosted billing, and device status | PASS |

## Notes

- Fresh installer simulations run first and must print `toolmirror 0.1.0` before Git or Cloud cases.
- Hosted Corotum Cloud is free through 30 September 2026, 23:59:59 UTC; after that it is gated by Creem. Self-hosted Cloud is free.
- Git Sync remains free and does not require a ToolMirror Cloud subscription.
- Device status is a report, never inferred as SYNCED from desired state alone.
