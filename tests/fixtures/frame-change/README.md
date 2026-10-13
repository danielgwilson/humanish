# Retained hosted-desktop frames for the screen-change comparison

Four 1440 x 950 screenshots copied unchanged from retained live run bundles on the hosted E2B
desktop. Each shows a public page only. `tests/evidence/frame-change.test.ts` reads them.

| File | Run and frame | What differs |
| --- | --- | --- |
| `example-clock-2229.png` | 0.125.0 `live-flush-smoke` run on example.com, participant `reader-01`, `turn-22` | reference |
| `example-clock-2230.png` | the same participant's `turn-23`, after three 5 s waits | the panel clock's minute digit: 64 pixels in the 4 tiles at x 1376 to 1408, y 0 to 32 |
| `tui-dry-run-selected.png` | 2026-10-08 `tui-self-study` run of the humanish TUI, `turn-07` | reference |
| `tui-live-run-selected.png` | the same run's `turn-08`, after one keypress | the selection moved from "Start a dry run" to "Start a live run": 1,434 pixels in 35 tiles at x 0 to 192, y 384 to 432 |

A pixel counts as changed when one of its channels differs by more than 24, and a 16 px tile when
one of its pixels does, the measure the design note's corpus counts used. The panel shows the
desktop's generic `user` account name and the time of day. No study secret, key or private page
is visible in any frame.
