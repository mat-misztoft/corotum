## Static landing artwork QA

The three supplied, unmodified JPEGs render as complete static artwork. No custom visual components, overlays, crops, frames, or animations remain. The `03 / ACTUAL PRODUCT FLOW` scroll behavior is unchanged.

| Viewport | Result | Evidence |
| --- | --- | --- |
| 1440 | PASS | All three images are within their existing slots at natural 1:1 proportions; no document overflow. Section 01 artwork and copy share the vertical center. Section 02 has a 144 px text-to-image gap; section 04 has a 187 px gap and its image is right of the text. |
| 1920 | PASS | All three images remain inside the 1440 px content width; no document overflow. Section 01 artwork and copy share the vertical center. Section 02 has a 160 px text-to-image gap; section 04 has a 208 px gap and its image is right of the text. |
| 390 | PASS | Images scale to the 350 px content width, retain their natural proportions, stack without crop, and do not cause horizontal overflow. |
