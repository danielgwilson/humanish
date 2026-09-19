# Observer capture and motion proof

Run after building the Observer:

```sh
node scripts/observer-reliability-proof.mjs
```

The test serves fictional captures from loopback with `Cache-Control: no-store`.
It delays an image for 650 ms, seeks again before an earlier request completes,
and records each animation frame in desktop and 390 px phone viewports.
The declared viewport deliberately disagrees with the raster dimensions.

The assertions cover:

- The prior decoded DOM image remains visible until the selected image decodes.
- Same-size captures retain their geometry throughout loading.
- A late response cannot replace the selected capture.
- Pinning moves the selected and displaced cards while keeping their DOM nodes,
  keyboard focus and scroll position. Reduced motion disables the movement.

Each run retains mid-transition screenshots, animation-frame measurements and
request receipts under gitignored `.humanish/observer-reliability/`.
`--artifact <html> --baseline` records a prior artifact without enforcing the new
behavior; baseline success means the measurements completed, not that it meets
the new contract. `--output <new-directory>` selects a different receipt path.

## Recorded comparison

On 2026-09-19, the 0.93.1 artifact lost the visible grid image in 41–43 of 49
sampled frames and the player image in 31–36 of 49 sampled frames during the
controlled delay. The player temporarily returned to the incorrect declared
viewport geometry. With decoded DOM slots, desktop and phone each retained a
visible image throughout all 49 grid samples, 49 player samples and 52 rapid-seek
samples. These counts describe the captured test runs, not a throughput benchmark.

The image's loading notice and alternative text identify the prior capture.
Grid capture-age text changes to “Loading capture…” during the transition;
player action pins remain hidden until the selected raster is ready. Failure
continues to show an unavailable state and a retry action. Neither the recorded
images nor their source timestamps are rewritten.

## Accessibility supplement

`--axe <axe.min.js>` additionally audits the grid, player and findings in both
themes at both widths. Retain the audit script's version/source with the local
receipt; it is not bundled into the Observer.

The 2026-09-19 audit found no automated violations in those twelve states.
The 249 sampled text contrast checks per theme had minimum ratios of 4.61:1
in light mode and 4.70:1 in dark mode. Existing registry tokens were sufficient;
no palette changes were made. The playback control group gained a named region
to ensure it is contained by a landmark.

Incomplete checks stay in the receipt. The Base UI checkbox naming checks need
human review because a wrapping label and explicit ARIA name coexist; the names
match the visible “Running only”, “Group waits” and “Thinking” labels. Phone
player text partly outside its scrollable feed is checked again after scrolling
the row fully into view; that contrast recheck passes. The existing browser
suite separately exercises these controls by keyboard and accessible name.

This is Chromium renderer proof with an emulated phone viewport. It is not
physical-device testing, screen-reader certification, or provider/runtime proof.
Image-error recovery, global playback and ordinary navigation remain covered by
the main Observer browser suite.
