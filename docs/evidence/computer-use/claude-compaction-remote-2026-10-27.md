# Claude participants compact on remote E2B and Modal runners, 2026-10-27

humanish 0.151.0 compacts a long Claude participant session on the server at 60,000 input tokens.
Its live check, on 10-26, was one local run on Taskly. These runs check compaction remotely, on
both sandbox providers, with a Claude Haiku 5.5 participant on a public movie-guessing game for 65
minutes. They also found the E2B runner memory failure that 0.152.0 fixed.

| Run | Route | humanish | Requests | Compactions | Largest request | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `cua-2026-10-27T05-43-19-224Z-704c4ea2` | remote, Modal | 0.151.0 | 364 | 15 | 19.55 MB | ran its 65 minutes; `pass` |
| `cua-2026-10-27T05-43-19-224Z-187f6ae4` | remote, E2B base template | 0.151.0 | about 21 | 0 | not recorded | runner died at 4 minutes |
| `cua-2026-10-27T06-50-48-399Z-13502392` | remote, E2B base template, 15 min | 0.151.0 | 77 | 3 | 15.66 MB | passed, 38 MB of memory left |
| `cua-2026-10-27T07-06-45-382Z-3de6e3fb` | remote, E2B desktop template, 15 min | 0.151.0 plus the runner fix | 70 | 2 | 19.79 MB | passed |
| `cua-2026-10-27T07-23-09-184Z-7a0387c6` | remote, E2B desktop template | 0.151.0 plus the runner fix | 358 | 14 | 19.97 MB | ran its 65 minutes; `blocked` by the participant's own account |

No compaction in any run came back without notes or cut off at the output limit.

## The participant kept its place across 14 and 15 compactions

The mission asked the participant to play for the hour, keep track of its rounds, and name, at
the end, the friend who sent the game, whom only the first turn named. Both 65-minute closing
reports name the friend, Bartholomew Quince. They also list each room code with its score, the
daily puzzle's number and answer, and the try it was solved on. The E2B report corrects one of
its own earlier totals ("I recorded 15000 earlier, which I now doubt").

The E2B run's `blocked` verdict is the participant's own outcome. It searched the home page, the
daily archive and the lobby for the friend's best streak, found no leaderboard, and wrote "I did
not reach a goal, because the task was to beat Bartholomew's best streak and I could not find it."
The game has no such leaderboard.

Actor cost was $0.47 on Modal and $0.45 on E2B.

## Request bytes on an image-heavy page

On Taskly, the largest request of the 10-26 run was 3.6 MB. The movie game shows full-screen film
stills, and its requests reached 19.55 to 19.97 MB before the 60,000-token trigger: about 35
screenshots of about 430 KB each, sent as PNG. The provider stops a session at 30 MB
(`REQUEST_BYTE_BUDGET`, `src/actors/computer-use/anthropic-provider.ts`). On Modal, 10 of 364
requests were over 15 MB. Each compaction took the next request back under 0.7 MB:

19.55→0.60, 12.61→0.48, 9.62→0.34, 11.14→0.34, 8.21→0.51, 16.29→0.61, 16.67→0.32, 9.28→0.18,
10.89→0.37, 8.72→0.24, 6.77→0.25, 6.85→0.65, 13.64→0.29, 11.96→0.34, 11.69→0.35 MB.

An open issue tracks the margin and two ways to widen it.

## The E2B runner ran out of memory

The first E2B run's runner stopped 4 minutes in. Its humanish process ended without writing a
result. The last stderr lines were ordinary progress lines, and both sandboxes were gone a few
seconds later. The runner was made from E2B's stock base template. A probe polled `free -m` and
the process list in the runner every 15 s during the next two runs:

| Runner | Memory | Node resident memory | Lowest available |
| --- | --- | --- | --- |
| base template, 15-minute run | 473 MB | 250 to 383 MB | 38 MB |
| desktop template, 15-minute run | 7955 MB | up to 471 MB | 6865 MB |
| desktop template, 65-minute run | 7955 MB | 162 MB at start, 385 at 5 min, 500 to 522 from 25 min on | 7026 MB |

On the base template, available memory stayed between 38 and 83 MB from the fourth minute on. The
first run's death fits an out-of-memory kill at a peak. 0.152.0 moved the runner to the desktop
template, and the 65-minute run's node process levelled off at about 510 MB.

## How it ran

The studies were `humanish.study.v3` files with one participant: `actor.type: computer-use`,
`model: claude-haiku-5-5`, `reasoningEffort: medium` and `persona: synthetic-new-user`. They set
`endAfterMs: 3900000` (65 minutes) or 900000 (15 minutes), `caps.maxUsd: 5` and
`review.analysis: false`. Each ran with `humanish run <study> --json` from a fresh project with
humanish installed from the npm package or from the runner fix's packed tarball. E2B runs set
`HUMANISH_E2B_MAX_SANDBOX_MINUTES=120`. Modal ran in its own environment. Every run's
`reclaim --check` was `clean`.

## Not checked

- Runs longer than 65 minutes. An 8-hour session has not run.
- A session that reaches the 30 MB byte stop.
- Analysis of these runs. Each set `review.analysis: false`.
- What the E2B runner's 500 MB of node memory holds.
