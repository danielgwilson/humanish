# Observer review continuity — 2026-09-09

Scope: the researcher path through live capture-follow, recorded review, saved
moments, comparison and the served library. No new stream authority or schema.

## Actual study and workflow

Retained run: `observer-review-journey-n2-20260909`. Two synthetic participants
used commit-pinned drawDB (`95cc92ec0f35d30ad2d18eb8480b7ae6df780df8`) on hosted
Linux desktops: one desktop expert and one phone-sized newcomer. The result was
one goal reached, one blocked, and two reports of friction. The phone participant
could not finish the table relationship or export. This is a study outcome,
not a claim of an independently confirmed drawDB defect or physical-device
fidelity. The study retained 92 screenshots; both hosted resources were confirmed
absent through provider reads after their cleanup receipts.

The production `observe` path passed six capture-follow transitions at each of
1440px and 390px touch emulation: open a running study, inspect latest evidence,
pause at an earlier frame, retain it while captures grow, resume latest and open
the library. This follows saved captures; it does not claim a new live-desktop
transport test.

The production `serve` library passed one uninterrupted 14-step review path at
each viewport (28/28): select a phone capture, inspect narration and actual setup
notices, save, reload, recall after stepping forward, compare participants, open
the exact compared frame, return to the same comparison, load another retained
recording, open its frame, switch back through the library and recall the saved
moment. Saved identifiers were checked against the actual actor frame item.

## Bugs found and proof boundaries

The real workflow reproduced same-address saved recall leaving the later image
visible after the URL returned to the saved frame. It was fixed before release;
failed attempts remain retained. Independent browser checks then confirmed that
the URL, counter and decoded image agree, while keeping the selected inspector
tab. Separate review caught a comparison-return action that used edited grid
selections; both cleared and changed selections now restore the original view.

Comparison stages share a bounded height, including a smaller phone cap, and
keep complete raster images contained. Phone Open frame links retain 44px touch
targets. This equalizes preview areas, not the drawn raster dimensions of mixed
aspect ratios.

Regression gates cover 160 Observer tests, 37 built-artifact browser scenarios,
15 iframe/artifact isolation checks, the core/TUI release gates, and site checks.
The synthetic browser matrix remains separate from the actual provider and
library receipts. Physical devices, other engines, screen readers, continuous
video and guaranteed per-action before/after captures are not certified here.
