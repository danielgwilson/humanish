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
| E2B | yes | 177.4 s, last frame matches `durationMs` | 76 MB/h | `local_only` |
| Modal | no | 168.2 s, last frame matches `durationMs` | 85 MB/h | `local_only` |

A third run on E2B had its sandbox killed 97 s into the video. The run kept 61.3 s of playable
H.264, recorded `complete: false`, and passed `verify` as `local_only`. It lost about 36 s: the
30-second segment being written and the time since the last copy.

## Timing

Earlier notes put video and trace about two seconds apart on a remote run. The host and sandbox
clocks agree to 8 ms on E2B and 59 ms on Modal. The gap came from the video's own lead-in: the first
frame sits at about 2 s, and FFmpeg's seek subtracts that start time. Chrome's `currentTime` is the
true presentation time. At every sampled seek, the frame Chrome showed matched the frame at that
time, on the old single-file format and on the fragments joined.

A joined recording of 4 hours and 717 MB opened in Chrome in 2 s and seeked in 76 to 820 ms from a
local server.

## Long recordings on a remote run (2026-11-10)

A remote run now copies a file over 64 MiB in checked ranges, and the limit is 2 GiB. To reach that
size in minutes, these runs recorded a page that repaints every pixel with noise, which encodes at
about 6 MB/s. Ordinary sessions in this page's first table are about 200 times smaller per hour.

| Provider | Recording copied back | Complete | Launcher peak memory | Result |
|-|-|-|-|-|
| E2B | 2,019 MiB, 342 s | yes | 452 MB | `verify` ok, `local_only` |
| Modal | 1,181 MiB, 198 s | yes | 545 MB | `verify` ok, `local_only` |
| E2B, 12 min page | 1,913 MiB, 331 s | no, reached the limit | 447 MB | `verify` ok, `local_only` |
| Modal, 12 min page | 1,984 MiB, 331 s | no, reached the limit | 505 MB | `verify` ok, `local_only` |

The first two rows ran on the final code. The last two ran before two review fixes and show a
recording stopping at the limit while its participant goes on.

A runner sandbox has 21 GB free on E2B and 504 GB on Modal. A 512 MiB read took 37 s on E2B (14 MiB/s)
and 3.7 s on Modal (139 MiB/s). A recording at the limit therefore copies back in about 2.5 minutes
on E2B.

A 1.9 GB video at an ordinary bitrate, 22 hours long and fragmented every 30 s, took 10 of 10 Chrome
seeks without a failure, in 72 to 647 ms from a local server. The noise recordings are different: at
sizes from about 1.3 GB, seeking crashed the Chrome page in 10 of 26 tries, while a 559 MB and a 939 MB
prefix of the same file did not crash in 11 tries. Those files hold 180 MB in each 30-second fragment,
which no ordinary session approaches. The cause was not found.

## Not measured

- An 8-hour recording at its real length. The sizes above are reached by bitrate, and the 22-hour
  file was built by looping a real recording.
- A disk that really fills. The stop is tested against a reported free-space figure.
- Modal's CPU ceiling. The sandbox requests 2 cores and shows 18, so its row may include bursting.
- Seek time over a remote connection.
- Whether continuous video changes participant behavior. It is opt-in and off by default.
