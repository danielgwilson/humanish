# What desktop recording costs a hosted run, 2026-11-09

`execution.desktop.recording` wrote one MP4 inside the sandbox and copied it at the end, so a lost
sandbox lost the video and a 128 MiB limit ended long recordings. Hosted recordings now write
30-second fragments that the host copies during the run. This page records what that recording
costs the participant's app and what it writes.

## Method

A script inside each sandbox opened Chrome, or Chromium on Modal, at 1440x950 and measured the page
for 30 s per cell with no recorder, the old recipe, and the new recipe in random order, three
repetitions of four pages. It sampled `requestAnimationFrame` gaps, the time of a fixed JavaScript
task every 250 ms, long tasks, and the recorder's own CPU from `/proc`. The pages were a static text
page with a 1 Hz clock, a local canvas and table churn page, Wikipedia scrolling continuously, and
the drawDB editor with a moving pointer and wheel events.

| Environment | vCPUs | Cells |
| --- | --- | --- |
| E2B stock `desktop` template, FFmpeg 4.4 | 8 | 36 |
| The same, Chrome and FFmpeg pinned to 2 cores with `taskset` | 2 | 36 |
| Modal desktop, FFmpeg 7.1 | 2 requested, 18 visible | 36 |

## Recording did not slow the app

Every one of the 108 cells held 60 frames a second. No cell had a long task. The fixed task's median
stayed within 0.5 ms of the no-recorder cells in all three environments.

The one measurable effect is on 2 pinned cores, where the new recipe raised the fixed task's 95th
percentile: from 15.5 to 18.0 ms on the canvas page and from 15.5 to 18.4 ms on Wikipedia.

The recorder used 0.08 to 0.35 of a core on E2B, 0.08 to 0.27 pinned to 2 cores, and 0.11 to 0.44 on
Modal, with 10-second keyframes.

## Keyframe spacing sets the size

One 120 s cell per row on stock E2B. Sizes are MB per hour of video.

| Page | Old recipe | 10 s keyframes | 30 s keyframes | 60 s keyframes |
| --- | --- | --- | --- | --- |
| Static text | 136 | 160 | 60 | 35 |
| Wikipedia, one jump every 8 s | 190 | 142 | 99 | 85 |
| drawDB with a moving pointer | 82 | 34 | 30 | 28 |

Keyframes every 10 s were larger than the old recipe on the static page. 30 s is smaller than the
old recipe on all three and bounds the loss from a dropped sandbox at about 30 s of video. The
recorder used 0.07 to 0.15 of a core at 30 s.

Continuous scrolling is far larger and not stable across sandboxes: 450 to 2,850 MB per hour across
environments with 10 s keyframes, against 470 to 5,800 for the old recipe.

## Live runs

Each run was one participant playing a public web game on the finished code for 150 s of session.

| Provider | Audio | Video | Size | `verify` |
| --- | --- | --- | --- | --- |
| E2B | yes | 180.0 s, last frame matches `durationMs` | 92 MB/h | `local_only` |
| Modal | no | 171.4 s, last frame matches `durationMs` | 81 MB/h | `local_only` |

An earlier build of the same recipe ran on E2B with its sandbox killed 94 s into the video. The run
kept 83.8 s of playable H.264, recorded `complete: false`, and passed `verify` as `local_only`.

## Timing

Earlier notes put video and trace about two seconds apart on a remote run. The host and sandbox
clocks agree to 8 ms on E2B and 59 ms on Modal. The gap came from the video's own lead-in: the first
frame sits at about 2 s, and FFmpeg's seek subtracts that start time. Chrome's `currentTime` is the
true presentation time. At every sampled seek, the frame Chrome showed matched the frame at that
time, on the old single-file format and on the fragments joined.

A joined recording of 4 hours and 717 MB opened in Chrome in 2 s and seeked in 76 to 820 ms from a
local server.

## Not measured

- A real 8-hour recording. At these rates one would be about 0.7 to 1.1 GB, under the 2 GiB limit.
- Modal's CPU ceiling. The sandbox requests 2 cores and shows 18, so its row may include bursting.
- Seek time over a remote connection.
- Whether continuous video changes participant behavior. It is opt-in and off by default.
