# An 8-hour study of 20 participants on a public movie game, 2026-10-28

Two remote studies ran for 8 hours on a public movie-guessing game, on humanish 0.153.0. The
OpenAI study had 2 participants who kept the game open all day and 18 visitors who arrived in
three waves. The Claude study had one all-day participant on Modal. They are the first runs of
that length and size. They found five bugs, fixed for 0.154.0, and two more that are filed.

| Run | Route | Participants | Wall time | Result | Cost |
| --- | --- | --- | --- | --- | --- |
| `cua-2026-10-28T19-16-54-241Z-fc2a3c31` | remote, E2B, gpt-6.1-sol medium | 2 regulars for 8 h, 18 visitors with a 40-minute cap | 19:17 to 03:17 UTC, analysis done 03:22 | 16 passed, 3 gave up, 1 failed | $46.92 |
| `cua-2026-10-28T19-16-26-079Z-6428d75e` | remote, Modal, claude-haiku-5-5 medium | 1 regular for 8 h | 19:16 to 03:16 UTC, analysis done 03:18 | passed | $5.77 |

## The study

The regulars share one persona: a print-shop worker who keeps the game open all day and plays a
few rounds between jobs. Each declares `endAfterMs: 28800000` and `windDownMs: 600000`. The
visitors are six personas, three of each, every one with `maxSessionMs: 2400000`. A film-studies
graduate starts at +5 minutes, a commuter on a phone at +30, a grandparent on a tablet at +55, a
second-language speaker at +1 h 20, a party planner on a phone at +1 h 45, and a friend's drop-in
at +2 h 10. Each repeats every 2 h 30 (`startEveryMs: 9000000`). The OpenAI study set `concurrency:
6`, `maxUsd: 40` per participant and `maxTotalUsd: 150`.

The plan said at most 4 participants run at once and the worst case is 1980 sandbox-minutes: 2 ×
495 for the regulars and 18 × 55 for the visitors. All 20 started at their scheduled times, and
none waited for a slot.

## Outcomes

| Participant | Started (UTC) | Minutes | Turns | 10-minute watches | Outcome | Actor cost |
| --- | --- | --- | --- | --- | --- | --- |
| regular-01 | 19:17 | 480 | 297 | 52 | goal_satisfied, scheduled_end | $21.47 |
| regular-02 | 19:17 | 222 | 269 | 39 | actor_error | $11.73 |
| film-buff ×3 | 19:22, 21:52, 00:22 | 4 to 6 | 48 to 68 | 0 | goal_satisfied | $1.79 |
| commuter ×3 | 19:47, 22:17, 00:47 | 4 to 5 | 58 to 69 | 0 | goal_satisfied | $0.79 |
| grandparent ×3 | 20:12, 22:42, 01:12 | 2 to 3 | 21 to 30 | 0 | goal_satisfied | $0.45 |
| second-language ×3 | 20:37, 23:07, 01:37 | 5 to 7 | 55 to 77 | 0 | goal_satisfied | $1.98 |
| party-planner ×3 | 21:02, 23:32, 02:02 | 3 | 41 to 47 | 0 | goal_satisfied | $0.46 |
| drop-in ×3 | 21:27, 23:57, 02:27 | 2 to 6 | 28 to 63 | 0 | gave_up | $1.31 |
| regular-claude (Modal) | 19:17 | 479 | 1404 | 17 | goal_satisfied, scheduled_end | $1.96 |

regular-02 ended at 22:59 with `computer-use loop error: fetch failed`, phase "looking at the
screen during turn 269". The failure was one screenshot request during a 10-minute watch, about
8 minutes in. The loop retried a stalled observe once but rethrew a transport error.

The three drop-ins came to beat a friend's posted score. Each closing report says the game showed
no friend's score to compare against, and one adds that title search found no match for a film it
recognized. `gave_up` is their own verdict.

## Persona behavior over the day

The regulars played in bursts with breaks. regular-01 took 52 waits that ran their full 10
minutes, the longest one wait can last, between bursts of rounds. Its closing report lists six
games over the shift, with scores rising from 10,000 to 25,000. The OpenAI regulars never tried to
end before their scheduled end. The Claude regular tried 16 times and was told each time that its
session ends at the scheduled time. It took fewer long waits (17) and many more turns (1404 to
297).

The visitors each played one game, or one game and the daily puzzle, and left. That fits the
grandparent ("play a round or two") and the party planner, who checked the room setup alone. The
commuters' brief says "about fifteen minutes to fill", and all three stopped after 4 to 5 minutes:
"That's enough for this stretch of the train ride". The study declared no time zone, so no turn
text told them the time. The desktop panel showed a UTC clock. We have not tested whether a clock
in the turn text changes how long they stay.

Spend per hour of an all-day OpenAI participant rose as its conversation grew. regular-01 spent
$1.26 in its first 47 minutes and $6.39 between 22:35 and 00:05 UTC, then slowed to $0.63 in the
hour before 02:37 UTC as its breaks grew longer. It ended at $21.47 on 75.1 million input tokens,
97% of them cached.

## Bundle, verify and Observer at this size

| Measure | OpenAI run, 20 participants | Claude run, 1 participant |
| --- | --- | --- |
| Bundle on disk | 307 MB, of which screenshots 301 MB | 367 MB |
| Screenshot files | 1477 | 1455 |
| `run.json` | 466 KB | 47 KB |
| `observer/observer-data.json` | 457 KB | 27 KB |
| `events.ndjson` | 63 KB | 3 KB |
| Files left to copy back after the run | 34 of 1511 | 18 of 1470 |
| `humanish verify` | ok, 16 checks, 3.6 s, 313 MB peak memory | ok, 16 checks, 3.3 s, 322 MB |
| Share safety | `local_only` (raw screenshots) | `local_only` (raw screenshots) |
| Reclaim | clean: runner killed, 20 desktops already gone | clean: runner killed, desktop already gone |
| Observer page load, `humanish observe`, 3 loads in Chromium | 512 to 618 ms, 23 requests, 4.1 MB, 20 cards | not measured |

Live flush had copied all but 34 files back by the time the run ended, so the copy took seconds.
The Observer load was measured on this machine against the local server, so it leaves out network
time.
After both runs, E2B listed 0 running or paused sandboxes and Modal listed 0 in the study's
environment.

## Automatic analysis

Both analyses are `partial`. The OpenAI run's analysis covered all 20 participants with 1600
evidence items and 80 captures. It cost $1.06 and returned 15 findings and 4 design findings.
The Claude run's covered 800 evidence items and 40 captures of 1455 frames. It cost $0.41 and
returned 6 findings. `coverage.omissions` names the packet size and capture count limits. An
8-hour participant gets about one capture every 12 minutes.

The Observer shows the analysis's outcome for each participant beside the participant's own. For
the OpenAI run the analysis read 12 completed, 1 interrupted, 1 abandoned and 6 unknown, while
the participants reported 16 complete, 1 failed and 3 gave up.

The OpenAI findings concern the game: answer reveals with mixed outcomes, expected titles that
search did not find, a title picker that moved as results loaded, automatic progression that cut
off reading the result, small secondary text, and a limited image area on phones.

## Bugs the study found

Found while setting up or watching these runs, fixed for 0.154.0:

- A roster of 20 that arrives over 8 hours, at most 4 at once, was counted as 20 at once
  and fell back to a local run.
- Every participant read as running from the first minute; the Observer said "20 of 20
  participants active" while 2 had started.
- A participant that ended at minute 4 read as running until the whole run ended.
- One dropped connection on a screenshot ended an 8-hour participant.
- The plan line said "when every session uses its 40m budget" for a roster with two 8-hour
  participants, though its figures counted the 8 hours.

Filed: analysis coverage of long runs. A separate check the same day found that a Ctrl-C during
copy-back of a finished remote run printed the stop line and exited 130; its fix is in review.

## Not verified

- The screenshot retry has not met a real dropped connection. Its tests fake the error.
- One transport failure in 21 participants and about 21 participant-hours is one sample. We do not know the rate
  of transport drops on E2B or Modal.
- Which participants the analysis marked unknown, and whether its sample of frames is the reason.
- Whether the commuters would stay longer with the time in their turn text.
