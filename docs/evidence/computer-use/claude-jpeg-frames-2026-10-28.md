# Claude participants receive JPEG screenshots, 2026-10-28

The Messages API keeps no conversation, so each Claude request carries every screenshot since the
last compaction. On 10-27, PNG frames of a movie game's full-screen stills brought requests to
19.55 MB before the server compacted at 60,000 input tokens, against the provider's 30 MB stop.
Claude participants now receive each frame as JPEG at quality 75. Run bundles keep the lossless
frames.

## What other computer-use loops send

| Source | Format sent to the model | Where |
| --- | --- | --- |
| Anthropic `computer-use-best-practices` reference (2026-10-23) | JPEG, quality 75, "the value the desktop app's Swift encoder uses" | `constants.py`, `computer_use/image.py` in `anthropics/anthropic-quickstarts` |
| Anthropic `computer-use-demo` and the SDK toolset examples | PNG | `loop.py`; the browser-use SDK page |
| Browserbase Stagehand Claude toolset driver | PNG, and drops all but the last 3 screenshots on the client | `packages/integrations/claude-cua-sdk` |
| Browser Use Claude toolset integration | PNG | `browser_use/integrations/anthropic/browser_use.py` |
| Vercel agent-browser | PNG by default; JPEG quality 80 on request | `cli/src/native/screenshot.rs` |
| OpenAI computer use guide | PNG data URLs with `detail: "original"`; nothing on compression | developers.openai.com |

Anthropic's vision guide says lossy JPEG or WebP "can reduce latency by reducing the size of
requests" and warns that heavy compression can make text hard to read. Its computer-use guide says
to encode screenshots as PNG or JPEG and to consider compressing large ones. For Claude 5.5 models
it advises against pruning old screenshots on the client, since that invalidates later thinking
blocks, so humanish keeps its server-side compaction.

The Files API would keep requests small whatever the history holds. It stores each screenshot in
the operator's workspace until deleted and is not eligible for zero data retention, while computer
use is. humanish does not use it.

## Size and encode time

Forty 1440x950 frames from each app's run bundles, decoded from lossless WebP and encoded in Node
on this machine. The movie frames are the 10-27 Modal run's; the Taskly frames are the 10-27 Haiku
benchmark's. Sizes are means, in thousands of bytes.

| Encoding | Movie game | Taskly | Encode time, movie game |
| --- | --- | --- | --- |
| PNG (`pngjs`) | 423 KB | 64 KB | 111 ms |
| Lossless WebP | 248 KB | 26 KB | 309 ms |
| JPEG, quality 75, baseline, standard tables | 77 KB | 38 KB | 78 ms |
| JPEG, quality 75, mozjpeg defaults (progressive) | 68 KB | 30 KB | 152 ms |
| Lossy WebP, quality 75 | 40 KB | 17 KB | 121 ms |

humanish sends baseline JPEG with the standard tables, as libjpeg and the reference's Pillow
encoder write it. The frame's PNG decode adds about 50 ms. Both run on the turn's path, in the
participant's process.

## A 30-minute remote run on the movie game

Run `cua-2026-10-28T04-35-27-365Z-4a719393`: Claude Haiku 5.5, remote on Modal, the 10-27 study
cut to 30 minutes, humanish built from this change. It finished `pass`.

| | PNG, 10-27, first 168 requests | JPEG, 10-28, 188 requests |
| --- | --- | --- |
| Compactions | 7 | 7 |
| Largest request | 19.55 MB | 2.75 MB |
| Mean request | 6.52 MB | 1.30 MB |

Request bytes before and after each compaction: 2.75→0.09, 2.32→0.11, 2.49→0.11, 2.71→0.13,
2.57→0.12, 2.57→0.12, 2.36→0.09 MB.

The closing report reads the game's room codes, film titles, a daily puzzle's number and answer,
and the scores of each game from the JPEG frames, and names the friend from the first turn. Actor
cost was $0.24, against $0.47 for the 65-minute PNG run. Image tokens follow pixel count, so the
format does not change them.

## Taskly benchmark

The Haiku participant arm, 12 runs per arm, rubric-scored, against the 10-27 arm on the same code
with PNG frames:

| Defect | PNG, 10-27 | JPEG, 10-28 |
| --- | --- | --- |
| D1 Clear completed does nothing | 1/12 | 3/12 |
| D2 Text over 30 characters is truncated | 1/12 | 0/12 |
| D3 Filters swapped | 11/12 | 12/12 |
| D4 Empty list renders `undefined` | 12/12 | 12/12 |
| D5 Save in edit mode does nothing | 1/12 | 0/12 |
| Report recall | 26/60 | 27/60 |
| Invented on clean runs | 0 | 0 |

No participant report on either day mentions truncated text.

## Not checked

- An OpenAI participant. It still receives PNG.
- Event-loop delay with many participants in one process. Encoding blocks for about 125 ms a frame.
- A session long enough to reach the 30 MB stop with JPEG frames. Noise frames of 1440x950 are
  about 0.74 MB each as JPEG, so about 30 of them would still reach it.
- Hand-reading of the benchmark reports.
