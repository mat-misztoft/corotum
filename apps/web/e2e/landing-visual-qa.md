## Static landing artwork QA

The three supplied, unmodified JPEGs render as complete static artwork. No custom visual components, overlays, crops, frames, or animations remain. The `03 / ACTUAL PRODUCT FLOW` scroll behavior is unchanged.

| Viewport | Result | Evidence |
| --- | --- | --- |
| 1440 | PASS | All three images are within their existing slots at natural 1:1 proportions; no document overflow. Section 01 artwork and copy share the vertical center. Section 02 has a 144 px text-to-image gap; section 04 has a 187 px gap and its image is right of the text. |
| 1920 | PASS | All three images remain inside the 1440 px content width; no document overflow. Section 01 artwork and copy share the vertical center. Section 02 has a 160 px text-to-image gap; section 04 has a 208 px gap and its image is right of the text. |
| 390 | PASS | Images scale to the 350 px content width, retain their natural proportions, stack without crop, and do not cause horizontal overflow. |

## Pricing QA

| Viewport | Result | Evidence |
| --- | --- | --- |
| 1440 | PASS | Pricing follows `GIT OR CLOUD` as a shared two-column state sheet. Git Sync is paper-toned; Cloud is the existing machine surface. The sharp Monthly/Yearly selector has a clear vermilion active state; only the selected price is primary. |
| 390 | PASS | The two plans stack in reading order with a full-width Cloud CTA. The billing controls and selected price stay readable, feature rows collapse to one column, and the section has no horizontal overflow. |

The yearly state was checked with keyboard navigation. It shows `$59.90 / year`; `Save 2 months` stays attached to the Yearly control in both states, and the price display retains its dimensions when switching periods.
