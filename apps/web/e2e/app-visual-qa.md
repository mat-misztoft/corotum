# App visual QA and anti-slop review

**Task:** T085

**Design read:** ToolMirror is a developer-tool Operate UI for signed-in operators. This is a fidelity pass over the frozen hybrid paper/editorial and dark-machine language, not a redesign. Dials remain `DESIGN_VARIANCE 4`, `MOTION_INTENSITY 3`, and `VISUAL_DENSITY 6` for app surfaces.

**Routes reviewed:** `/`, `/sign-in`, `/dashboard`, `/dashboard/skills`, `/dashboard/devices`, `/dashboard/billing`, `/settings`, and an unknown route (`/does-not-exist`). API routes are non-visual and excluded.

**Render walk:** 1440px desktop and 390px mobile with Playwright against local vinext on 2026-08-30. Dashboard API responses were intercepted with representative locked and pending skills plus synced and behind devices so every app body could render. Every route had `scrollWidth <= clientWidth`. The unknown route returned HTTP 404 and rendered `Page not found` at both widths. Reduced-motion was also emulated for the 404 route; it remained legible and static.

## Route record

| Surface | Desktop | Mobile | Layout, hierarchy, type, palette, spacing, states, motion, accessibility | Result |
| --- | --- | --- | --- | --- |
| Landing `/` | PASS | PASS | Frozen Direction C composition and seven-section hierarchy remain intact. Editorial display, body, mono data, paper/machine/vermilion palette, semantic state marks, focused links, responsive tableaux, and product-semantic motion retain the T062 record. | PASS |
| Sign in `/sign-in` | PASS | PASS | One sharp dark auth panel retains labels above the email input, generic OAuth/email pending and error states, explicit confirmation focus, semantic error color, 4px brand rule, keyboard focus, and reduced-motion-safe control feedback. | PASS |
| Dashboard `/dashboard` | PASS | PASS | Sticky top bar, current route, workspace/revision header, two machine panels, semantic status word plus mark, table caption, pending explanation, skeleton, alert, and empty states all render in the frozen Operate language. Mobile uses stacked table rows and a scrollable nav cluster. | PASS |
| Skills `/dashboard/skills` | PASS | PASS | Desired-skills panel preserves the three meaningful fields, pending explanation, CLI empty-state hint, mono refs, semantic resolution, and mobile stacked rows without adding mutation controls. | PASS |
| Devices `/dashboard/devices` | PASS | PASS | Device metadata, target states, CLI pairing hint, semantic status labels, disabled revoke state, focusable secondary control, and narrow target grid all remain readable without page overflow. | PASS |
| Billing `/dashboard/billing` | PASS | PASS | Hosted and self-hosted state structures use the same machine panel; price and pending labels remain clear, primary/secondary actions preserve contrast and disabled feedback, and no new billing behavior is introduced. | PASS |
| Settings `/settings` | PASS | PASS | Local-only telemetry copy and selectable mono command slab remain inside the shared app shell. There is no invented dashboard setting or control. | PASS |
| Unknown route / 404 | PASS | PASS | Native App Router not-found entry returns HTTP 404 with paper/machine surface, wordmark, clear missing-route copy, landing and sign-in exits, semantic error word plus mark, focus treatment, explicit mobile collapse, and reduced-motion static behavior. | PASS |

## Fidelity remediation

- Fixed the narrow app-nav overflow path: `.dashboard-nav-links` now has a shrinkable flex basis (`flex: 1 1 auto; min-width: 0`) and explicit desktop/end versus mobile/start alignment. At mobile widths the five established destinations scroll inside their cluster rather than expanding the page or clipping off-screen.

## Post-T086 landing re-check

T086 changed only the landing header flex minimum to keep the approved navigation reachable on mobile. This final pass re-checked that change against the frozen Direction C record above: all seven sections, claims, semantic motion, focus treatment, and reduced-motion behavior remain intact. The shared app shell, sign-in form, and 404 do not consume `.landing-header` and have no regression from the landing-only fix.


## Anti-slop and accessibility check

| Check | Result | Evidence |
| --- | --- | --- |
| One product language | PASS | Paper, ink, machine panels, sharp edges, display title, Arial body, mono operational data, and restrained vermilion are shared without cloning the landing story into the app. |
| No generic SaaS chrome | PASS | No gradient, glass, card grid, pill system, sidebar, fake metrics, charts, or invented workflow controls. |
| Status semantics | PASS | `SYNCED`/`LOCKED`, attention, drift, and error states use the shared class, visible word, and `✓`/`!`/`≠` mark. Vermilion remains CTA/focus/current-nav only. |
| Loading, error, empty | PASS | Dashboard chrome remains mounted for skeleton loading and alerts; view bodies have scoped empty copy and no fabricated remote-sync action. |
| Keyboard and contrast | PASS | Interactive app, sign-in, landing, and 404 controls have 3px vermilion `:focus-visible` outlines. Inputs keep visible labels. Machine text and action colors use the frozen tokens. |
| Reduced motion | PASS | Landing, dashboard, sign-in, and 404 each disable animation and active transforms under `prefers-reduced-motion: reduce`. |
| Responsive behavior | PASS | The Playwright desktop/mobile walk found no page-wide horizontal overflow. Tables stack, actions expand where needed, and the app nav remains horizontally reachable below 850px. |
| Copy integrity | PASS | No new claims, remote force-sync implication, em dash, fake precision, or new product language was introduced. |

No remaining T077 raw app surface, broken alignment, or unstyled chrome finding remains. No waiver was needed.
