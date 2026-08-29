# Landing visual QA and final anti-slop review

**Task:** T062  
**Compared against:** `toolmirror-planning/landing-directions/FROZEN-TARGET.md`, Direction C (`direction-c.svg`), and `LANDING-DESIGN.md`  
**Implementation:** `apps/web/app/page.tsx`, `apps/web/app/globals.css`, `apps/web/app/landing-flow-story.tsx`  
**Viewports:** desktop 1440 CSS px (asymmetric grids, sticky flow); mobile 390 CSS px via 850px / 500px breakpoints  
**design-taste-frontend:** fidelity / pre-flight pass only. Numbered dispatch labels, three-line condensed hero, and semantic device tableaux are frozen Direction C and were not redesigned.

Remediation in this task (fidelity/a11y, not a new art direction):

- sticky header is solid paper (no `backdrop-filter` glass)
- primary CTA remains vermilion `#df492f` at 19px bold so paper-on-vermilion meets large-text contrast
- vermilion product-flow copy uses `#110f0d` instead of `#501b13`
- `AUTH_REQUIRED` uses crimson `#e07a72`, not vermilion and not amber
- LOCK copy no longer uses an em-dash
- mobile header keeps every nav destination (horizontal scroll instead of hiding links)
- install commands expose an accessible name

## Desktop comparison (1440)

| Check | Result | Evidence |
| --- | --- | --- |
| Layout | PASS | Seven sections in frozen order. Hero is type-led left + dark Desired State / Diff-Reconcile / Actual Devices tableau. One State is paper intro + dark machine-room. Product flow is full-bleed vermilion with sticky dark operation panel. Git/Cloud is light Git band beside larger dark Cloud plane on one axis. Devices is a dark dispatch table. Agents returns to paper matrix. Final CTA is a compact vermilion-ruled close. |
| Hierarchy | PASS | One `h1` hero; section `h2`s; Git/Cloud and flow steps use `h3`. Primary CTA is vermilion; header has no extra CTA. Wordmark + approved nav. |
| Typography | PASS | Condensed display (Impact stack) for headlines, Arial/Helvetica body, monospace for commands/labels/status/revisions. Matches Direction C SVG stacks. |
| Palette | PASS | Paper `#f4eee4`, ink `#171512`, machine `#20201e` / `#171512`, vermilion `#df492f`. Status: synced `#7ecb91`, pending/behind `#efba58`, drifted `#d778ca`, error `#e07a72`. Vermilion is CTA/active axis only. |
| Spacing | PASS | Max width 1440px, 42px page gutters, generous section padding (`clamp` 100-220px on editorial pauses). Sticky header 68px. No card-grid rhythm. |
| Motion | PASS | Sticky flow highlights ADD → LOCK → DIFF → RECONCILE → SYNCED. Pending state-lines travel; axes flow. No blobs, parallax, particles, or decorative orbits. |

## Mobile comparison (390 / max-width 850 and 500)

| Check | Result | Evidence |
| --- | --- | --- |
| Layout | PASS | Hero, One State, Git/Cloud, Devices, and flow stack to a single column. Sticky flow panel becomes static. Git band above Cloud plane. Device table remains a table. Agent matrix becomes labelled stacked rows (`data-agent`). Dark tableaux go full-bleed at 500px without horizontal scroll of the page (`overflow-x: clip`). |
| Hierarchy | PASS | Headline, CTAs, then install command, then device list. Final CTA keeps the same CTA pair and command. Header nav remains complete and scrolls horizontally. |
| Typography | PASS | Display type scales down (`clamp`); install command stays monospace and wraps (`overflow-wrap: anywhere`, full width). |
| Palette | PASS | Same tokens. No theme inversion. |
| Spacing | PASS | 20px gutters; stacked actions; no overlapping required reading order. Install command remains selectable. |
| Motion | PASS | Reduced-motion and no-JS keep all five flow steps visible. Mobile does not rely on pin/sticky to explain the sequence. |

## Product claims (v0.1)

| Claim | Result | Evidence |
| --- | --- | --- |
| Approved hero / section / CTA / install copy | PASS | Matches `LANDING-DESIGN.md` headings, CTAs, and `curl -fsSL https://toolmirror.com/install.sh \| sh`. |
| Cloud price | PASS | `$5.99/month · $59.90/year` |
| Git Sync first-class and free | PASS | Git band: free, own repo, no account, credentials local, manifest + lockfile. |
| WebMCP | PASS | Agents manage desired state; devices current only when CLI runs. |
| No daemon / remote force-sync / stored Git credentials | PASS | Explicit in Cloud note and device note. No `sync_device` / `sync_all_devices`. |
| Supported agents only | PASS | Matrix subset Codex, Claude Code, Pi, Cursor, Gemini; roster adds OpenCode, Windsurf, Cline, Roo Code, GitHub Copilot, Kiro CLI. |
| Exact lock, not latest | PASS | LOCK shows source, ref, revision, hash, and "Exact, not latest." |
| Wordmark only, no invented logo | PASS | `ToolMirror` text wordmark. |

## Anti-slop checklist (`LANDING-DESIGN.md`)

| Item | Result |
| --- | --- |
| No purple/blue AI gradients, blobs, glass, glows, sparkles, robots, hexagons, network globes | PASS |
| No centered-hero + three feature cards, bento grids, pill soup, fake testimonials, logo walls, fake metrics | PASS |
| No "Supercharge your workflow" / "Built for teams" filler | PASS |
| Lines represent desired/actual or device relationships | PASS |
| Section compositions differ (split hero, machine room, vermilion sticky, asymmetric Git/Cloud, dark table, paper matrix, spare CTA) | PASS |
| Motion is product-semantic | PASS |
| No em-dash in visible copy | PASS |

## Accessibility

| Check | Result | Evidence |
| --- | --- | --- |
| Semantic sections and labels | PASS | `main`, `header`/`nav`, labelled `section`s, table captions, `aria-label` on install commands. |
| Keyboard focus | PASS | `.landing a:focus-visible` 3px vermilion outline. |
| Contrast | PASS | Body ink/graphite on paper; paper on machine; 19px bold paper on vermilion CTA; `#110f0d` on vermilion flow; status colors on machine ≥ 4.5:1 except large CTA which meets 3:1 large-text. |
| Status not color-only | PASS | `✓` / `≠` / `!` plus the status word; line style solid/dashed/dotted. |
| Reduced motion | PASS | CSS `animation: none`; FlowStory `data-motion="reduced"` shows the full sequence. |
| Diagram equivalents | PASS | Board note, machine-room result, flow-panel note, captions. |

## design-taste-frontend fidelity notes

Retained on purpose (frozen Direction C, not generic SaaS):

- `01 /` … `07 /` dispatch labels
- uppercase condensed hero wrapping like KEEP YOUR / AGENT SKILLS / IN SYNC
- operational device tableaux (real statuses, not decorative fake screenshots)
- hero + final CTA pair required by the brief

Rejected as slop during this pass: header glass, em-dash, vermilion-as-error, hidden mobile nav, undersized CTA type.
