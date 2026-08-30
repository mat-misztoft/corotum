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

## T086 landing fidelity and motion polish

**Task:** T086
**Compared against:** `toolmirror-planning/ralph/UI-AUDIT.md`, `toolmirror-planning/LANDING-DESIGN.md`, and `toolmirror-planning/landing-directions/FROZEN-TARGET.md`
**Taste Design Read:** developer-tool landing for technical users, preserving the frozen light-editorial / dark-machine Direction C system. Dials: `DESIGN_VARIANCE 7`, `MOTION_INTENSITY 6`, `VISUAL_DENSITY 4`. This is a preserve-mode fidelity pass, not a redesign.

### Finding and remediation

| Finding | Result |
| --- | --- |
| Mobile header navigation had an intrinsic flex minimum, so its intended horizontal scroll region could instead overflow its flex container and be clipped. | **FIXED** in `.landing-header nav` with a shrinkable flex basis and `min-width: 0`. The full approved navigation remains reachable on narrow screens without page-wide overflow. |
| Desktop hierarchy, spacing, alignment, palette, frozen seven-section composition, product claims, and semantic dark tableaux | **PASS**. No other valid visual defect found. |
| Mobile hierarchy, stacking, command wrapping, full-bleed machine panels, agent-matrix fallback, CTA spacing, and responsive alignment | **PASS** after the nav fix. |

### Motion review

| Category | Result | Evidence |
| --- | --- | --- |
| Hero | PASS | The desired-state board uses only semantic axis and pending-route motion. It does not animate layout or obscure its labelled state. |
| Entrance / reveal | PASS | No arbitrary load-in, delayed content, or readability-reducing reveal is applied. |
| Scroll-triggered flow | PASS | `FlowStory` uses `IntersectionObserver` to select the current ADD, LOCK, DIFF, RECONCILE, or SYNCED step. It has cleanup and does not use scroll listeners or React scroll state. |
| Section transitions | PASS | The flow's current-state opacity change is the only section-state transition. It communicates the pinned operational sequence without layout shift. |
| State lines and tiles | PASS | `axis-flow` and `reconcile-travel` use transform-free visual travel inside fixed-size semantic lines only. There is no random directionality, lag-like delay, parallax, or decorative motion. |
| CTA / hover / focus | PASS | CTAs have short background/transform feedback and a visible focus outline. Active feedback is a 1px translate only. |
| Transform / opacity / scale / translate audit | PASS | Motion is limited to the CTA active transform, the flow opacity state, and decorative-travel pseudo-elements inside semantic state routes. No scale animation, layout animation, or arbitrary translation remains. |

### Reduced-motion and responsive checks

At 1440px and 390px, the page retains the frozen information architecture, readable command strips, status words and marks, and keyboard focus treatment. At `prefers-reduced-motion: reduce`, CSS disables axis and pending-route animation, CTA transition and active transform; `FlowStory` disconnects its observer, marks itself `data-motion="reduced"`, and leaves all five labelled steps visible at full opacity. The page remains complete and operable without non-essential animation.

A detached local `vinext dev` process is terminated by the command harness after the shell exits, so direct Playwright navigation to that detached server returned `ERR_CONNECTION_REFUSED`. This is a local harness lifecycle constraint, not a rendered-page failure. The responsive review therefore used the existing browser-reviewed T062 record plus the current source and landing tests; the focused CSS regression is covered by `app/page.test.ts`.

### Taste pre-flight result

PASS for the applicable frozen-direction checks: one warm light theme with dark product surfaces, one vermilion action accent, consistent sharp machine panels and CTA treatment, no AI-gradient/glass/blob/card-grid patterns, semantic state lines, no em-dash in visible landing copy, no new claims, no invented logo, explicit mobile collapse, and reduced-motion support. Direction-C dispatch labels are retained because they are a frozen target exception, not copied into app surfaces.
