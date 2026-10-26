# Claude Haiku 5.5 participants on the Taskly benchmark, 2026-10-26

Three participant settings ran the neutral Taskly mission on humanish 0.149.0 (f15eaa4d5) with
`actor.type: computer-use`, on the in-memory builds and on the localStorage builds
(`--storage local`). It follows the OpenAI participant comparison in
[2026-10-24-participant-models.md](2026-10-24-participant-models.md) and the default check in
[2026-10-25-participant-default.md](2026-10-25-participant-default.md). The analyst stayed at the
CLI default, `gpt-6.1-sol` at medium effort, for every run. Each arm has 15 planted and 15 clean
runs per build: 3 and 3 from the pilot, 12 and 12 from the recall phase. A fidelity sub-study added
4 runs per arm on each of two more personas. Recall is scored with rubric version 4. Full numbers
and every run id are in [2026-10-26-haiku-participants.json](2026-10-26-haiku-participants.json).
Definitions of recall, false assurance and invented claims are in the [README](README.md).

| Arm | Participant | Price per 1M in / cached / out |
| --- | --- | --- |
| B0 | `gpt-6.1-sol`, medium effort (the shipped default) | $2 / $0.10 / $10 |
| B1 | `claude-haiku-5-5`, medium effort | $0.10 / $0.01 / $0.50 |
| B2 | `claude-haiku-5-5`, high effort | $0.10 / $0.01 / $0.50 |

Haiku's cache writes cost $0.125 per 1M, and a request over 100,000 prompt tokens costs 5 times
each rate; no request here passed 35,000. B2 ran because the B1 pilot stopped early: its 12 pilot
participants took a median of 6.5 turns against B0's 11, and the planted reports said they had not
tried Edit or Clear completed. Every arm used the bench's `maxOutputTokens: 8192` and
`caps.maxUsd: 1.5`.

## Results on the in-memory builds

A page reload empties the list on these builds.

| | B0 | B1 | B2 |
| --- | --- | --- | --- |
| Step latency, median / p90 (s) | 5.19 / 9.13 | 6.82 / 10.52 | 7.43 / 9.70 |
| Model call, median / p90 (s) | 3.32 / 7.39 | 2.76 / 4.01 | 2.92 / 4.63 |
| Session, median (s) | 81.7 | 48.6 | 54.6 |
| Turns per session, median | 11 | 6 | 6 |
| Ended on its own with a report | 30/30 | 30/30 | 30/30 |
| Ended `gave_up` / `goal_satisfied` | 20 / 10 | 23 / 7 | 23 / 7 |
| Said it would keep using Taskly, clean / planted build | 0/15 / 0/15 | 2/15 / 0/15 | 0/15 / 0/15 |
| Harness-caused failures | 0 | 0 | 0 |
| Reports saying a screenshot did not come back | 0 | 9 | 11 |
| Report recall, read by hand (95% interval) | 51/75 (0.57 to 0.77) | 29/75 (0.28 to 0.50) | 31/75 (0.31 to 0.53) |
| Report recall, rubric | 41/75 | 27/75 | 31/75 |
| Analysis recall, rubric (95% interval) | 45/75 (0.49 to 0.70) | 27/75 (0.26 to 0.47) | 29/70 (0.31 to 0.53) |
| Analysis recall, read by hand (95% interval) | 51/75 (0.57 to 0.77) | 28/75 (0.27 to 0.49) | 29/70 (0.31 to 0.53) |
| False assurance in reports, rubric / by hand | 0 / 0 | 1 / 0 | 0 / 0 |
| Invented on the clean arm, reports, rubric / by hand | 0 / 0 | 0 / 0 | 1 / 0 |
| Invented on the clean arm, analyses, rubric / by hand | 0 / 0 | 0 / 0 | 0 / 0 |
| Participant cost per run, median | $0.071 | $0.0049 | $0.0054 |

Recall per defect, reports read by hand, then analyses read by hand:

| | B0 | B1 | B2 |
| --- | --- | --- | --- |
| D1 Clear completed does nothing | 0/15, 0/15 | 0/15, 0/15 | 1/15, 1/14 |
| D2 Text over 30 characters truncated | 6/15, 6/15 | 1/15, 1/15 | 0/15, 0/14 |
| D3 Filters swapped | 15/15, 15/15 | 13/15, 12/15 | 15/15, 14/14 |
| D4 Empty list shows undefined | 15/15, 15/15 | 15/15, 15/15 | 15/15, 14/14 |
| D5 Save in edit mode does nothing | 15/15, 15/15 | 0/15, 0/15 | 0/15, 0/14 |

## Results on the localStorage builds

A page reload keeps the list on these builds.

| | B0 | B1 | B2 |
| --- | --- | --- | --- |
| Step latency, median / p90 (s) | 5.19 / 8.77 | 6.52 / 9.78 | 7.16 / 9.92 |
| Model call, median / p90 (s) | 3.21 / 6.44 | 2.62 / 3.74 | 2.85 / 4.48 |
| Session, median (s) | 82.0 | 42.1 | 55.4 |
| Turns per session, median | 11 | 6 | 7 |
| Ended on its own with a report | 30/30 | 30/30 | 30/30 |
| Ended `gave_up` / `goal_satisfied` | 0 / 30 | 7 / 23 | 6 / 24 |
| Said it would keep using Taskly, clean / planted build | 15/15 / 0/15 | 14/15 / 0/15 | 14/15 / 0/15 |
| Harness-caused failures | 0 | 0 | 0 |
| Reports saying a screenshot did not come back | 0 | 10 | 7 |
| Report recall, read by hand (95% interval) | 52/75 (0.58 to 0.79) | 31/75 (0.31 to 0.53) | 33/75 (0.33 to 0.55) |
| Report recall, rubric | 44/75 | 30/75 | 32/75 |
| Analysis recall, rubric (95% interval) | 53/75 (0.60 to 0.80) | 30/75 (0.30 to 0.51) | 33/75 (0.33 to 0.55) |
| Analysis recall, read by hand (95% interval) | 54/75 (0.61 to 0.81) | 31/75 (0.31 to 0.53) | 33/75 (0.33 to 0.55) |
| False assurance in reports, rubric / by hand | 0 / 0 | 0 / 0 | 0 / 0 |
| Invented on the clean arm, reports, rubric / by hand | 1 / 0 | 1 / 0 | 4 / 0 |
| Invented on the clean arm, analyses, rubric / by hand | 0 / 0 | 2 / 0 | 1 / 0 |
| Participant cost per run, median | $0.071 | $0.0044 | $0.0053 |

Recall per defect, reports read by hand, then analyses read by hand:

| | B0 | B1 | B2 |
| --- | --- | --- | --- |
| D1 Clear completed does nothing | 1/15, 1/15 | 0/15, 0/15 | 2/15, 2/15 |
| D2 Text over 30 characters truncated | 6/15, 8/15 | 1/15, 1/15 | 0/15, 0/15 |
| D3 Filters swapped | 15/15, 15/15 | 15/15, 15/15 | 15/15, 15/15 |
| D4 Empty list shows undefined | 15/15, 15/15 | 15/15, 15/15 | 15/15, 15/15 |
| D5 Save in edit mode does nothing | 15/15, 15/15 | 0/15, 0/15 | 1/15, 1/15 |

Step latency runs from one screenshot to the next and covers the model call, the actions and the
settle wait. The model call is estimated per step as in the 10-24 comparison: the time from the
screenshot to the first action, less that action kind's median execution time pooled over all
three arms (click 0.35 s, type 1.13 s, keypress 0.10 s, wait 1.08 s). On the Claude arms every turn
also records its thinking summary at the moment the reply arrived; that time matches the estimate
within 0.02 s. Steps per arm: 298 and 302 for B0, 149 to 179 for the Claude arms.

"Said it would keep using Taskly" comes from each closing report's own verdict, classified by a
pattern and read by hand for the 35 the pattern left open. On the in-memory builds the reload
emptied the list in most runs on every arm, and the reports stop there.

## What the numbers say

Haiku 5.5 costs a fourteenth to a sixteenth as much per participant, and B1 ends sessions 33 to 40 s
sooner. It reports about 40% fewer planted defects. Read by hand, B1's reports found 60 of 150
planted defects over both builds and B0's found 103. The analyst does not recover the gap: B1's
analyses found 59 of 150 and B0's 105. An analysis reads what the participant did, and the Claude
participants did less. B0 tried Edit in all 30 planted runs and reported D5 in all 30. B1 and B2
reported D5 once in 60 planted runs between them. At least 20 of B1's 30 planted reports and 25 of
B2's say they did not try Edit or Clear completed, because the swapped filters had already decided
them: "Once I'd confirmed the filter problem, I didn't think those checks would change whether I'd
keep using the app." D1 stays rare on every arm: B0 reported it in 1 of 30 planted runs, B1 in none
and B2 in 3.

High effort did not change that. B2 took the same median of 6 to 7 turns and thought 15% to 23%
more per turn. Its reports found 64 of 150 by hand against B1's 60, and its step latency rose by
0.6 s.

Haiku's model call is faster: 2.6 to 2.9 s median against 3.2 to 3.3 s, and its p90 is about half of
B0's. Its steps are slower anyway, because it sends about 5 actions a turn and 29% of them are
1-second waits it asks for itself (the trace reads "click (690, 300)", "wait 1000ms", "screenshot").
B0 asked for 3 waits in 1,511 actions.

A Claude turn often asks for a screenshot in the middle of its batch, for example click Active,
screenshot, click Completed, screenshot. On the Anthropic path only the screen after the batch's
last action comes back; an earlier screenshot call is answered "The screen after this turn's last
action is in its last result." 32% to 39% of Claude turns did this, 288 screenshot calls in all, and
37 of 120 Claude reports say a screenshot "didn't come back", so the participant could not confirm
what a view showed. Two B1 planted reports on the in-memory build miss D3 for that reason ("I only
got a screenshot after the last click in each batch, so I didn't see the filter tabs actually
filter"). One B1 clean participant clicked where Clear completed had been in a view it never saw
and deleted an active task instead. This harness behavior lowers Claude recall by an amount these
runs cannot separate from the model's early stopping. See "Needs a decision" below.

No arm made a false assurance or an invented claim read by hand. Every rubric hit on the clean arms
is a true sentence: Clear completed working on the clean build ("clear completed removed the
finished task"), a filter view switching as expected, or a misclick the participant blamed on the
layout moving ("the clear completed button moved as the list changed, so i clicked where it used to
be and nothing happened"). The one B1 rubric false assurance is a conditional: "If the labels were
fixed and Edit, Delete, and Clear completed worked, I'd try it again."

The rubric undercounts B0 more than the Claude arms. B0 wrote D5 as "It stayed in the editing box,
so I wasn't sure it had saved" or "The Save button stayed there, and switching views brought back
the old wording"; rubric version 4 missed 17 such report lines and 7 analysis titles. Read by hand,
every B0 planted report names D5. The Claude arms' hand additions are two D2 reports ("The plumber
task was saved as 'Call the plumber about the sin'", "The word 'clock' disappeared") and one D1
report ("Clicked Clear completed while the edit field was still open. Buy printer paper stayed in
the list"). One B1 report's Active view "also showed 'undefined' in place of the list, even though
the counter said '3 left'", which is D3.

## Claude participants: thinking, clearing, actions, refusals

| | B0 | B1 | B2 |
| --- | --- | --- | --- |
| Thinking tokens per turn, median / mean / p90, in-memory | 0 / 2.6 / 11 | 114 / 153 / 365 | 131 / 186 / 445 |
| Thinking tokens per turn, median / mean / p90, localStorage | 0 / 2.2 / 11 | 100 / 136 / 380 | 121 / 167 / 422 |
| Output tokens per turn, median | 54 | 337 to 360 | 356 |
| Requests where context clearing fired | 0 of 719 | 0 of 426 | 0 of 473 |
| Largest request input, tokens | 25,429 | 31,281 | 34,706 |
| `zoom` uses (runs) | 0 | 21 (15) | 29 (18) |
| `triple_click` uses (runs) | 0 | 7 (7) | 11 (11) |
| `mouse_down`, `mouse_up`, `hold_keys`, `read_pointer` | 0 | 0 | 0 |
| Refusals | 0 | 0 | 0 |
| Runs with incomplete usage | 0 | 0 | 0 |

Thinking tokens come from `usage.output_tokens_details.thinking_tokens` in each reply, captured with
`HUMANISH_CUA_WIRE_CAPTURE_DIR` for every run of every arm; the trace keeps only `output`. For B0
the same column is the Responses API's `reasoning_tokens`, which was 0 on 85% of turns. Closing
requests are left out. The server's tool-result clearing starts past 60,000 input tokens, and no
session came near it. The OpenAI provider never proposes the six new actions.

Claude used `zoom` to read the page more closely, mostly on the localStorage builds, and
`triple_click` to select a task's text in the edit box before retyping it, then clicked Save. One B2
fidelity participant called a member named `click`; the provider rejected it, the participant read
the reason and went on. Two Claude participants' closing requests hit a bug, fixed in this change:
see "Bugs found".

## Actions per model turn

A B0 turn carried 2.4 actions on average; 54% of turns carried more than one and the most was 7.
B1 carried 5.2 to 5.3 and B2 5.1 to 5.2, and every Claude turn but 4 carried more than one; the most
was 16. Counted as on 10-24: the `ui_action` items between two screenshots, waits included.

## Persona fidelity

The 10-24 rubric is reused, and every check is an automated count from the trace. An addendum
written before the fidelity runs reports Claude's `zoom` action as a separate check.

| | B0 | B1 | B2 |
| --- | --- | --- | --- |
| synthetic-new-user, F1 / F2 / F3, all 60 runs | 60 / 58 / 60 | 60 / 60 / 60 | 60 / 60 / 60 |
| skeptical-power-user (`keyboard_first`), K1 / K2 / K3, 4 runs | 4 / 4 / 2 | 1 / 4 / 0 | 1 / 4 / 1 |
| low-vision-reader (`low_vision`), V1 / V2 / V3, 4 runs | 4 / 4 / 4 | 4 / 4 / 4 | 4 / 4 / 4 |
| Mean fidelity: synthetic-new-user, keyboard-first, low-vision | 0.99, 0.83, 1.00 | 1.00, 0.42, 1.00 | 1.00, 0.50, 1.00 |

Both B0 F2 failures are `CTRL+END`, as on 10-24. The keyboard-first persona separates the arms. B0's
keypresses outnumbered its clicks in all 4 runs (13 to 23 keypresses against 4 to 10 clicks). Claude
clicked at least as often as it pressed keys in 6 of 8 runs (4 to 10 keypresses against 3 to 11
clicks), and probed an edge case once in 8. Every low-vision run on every arm pressed Ctrl+plus on
its first action turn: B0 4 or 5 times, Claude 3 times. One B2 low-vision run also used the `zoom`
action. Fidelity was not read by hand this time.

## How it ran

Each arm and build was one `pnpm bench --brain computer-use --participant <model@effort>`
invocation with `--participant-cap 1.5`, `--mission neutral` and `--storage memory` or `local`. The
pilot ran `--runs 3`: B0 and B1 on both builds at once from 10:29 UTC, four desktops in flight,
then B2 on both builds from 10:48 UTC, two in flight. The recall phase ran `--runs 12` for all six
invocations at once from 11:02 UTC, 8 s apart, six desktops in flight. The Claude invocations
finished between 11:51 and 11:59 UTC and B0's at 12:10 and 12:13, so B0's last 13 runs ran with two
desktops in flight. B0's median step was 5.05 s while all six ran and 5.57 s after. The fidelity
runs (`--runs 2`, `--persona`, in-memory build) ran all six invocations at once from 12:14 to
12:27 UTC.

Work directories were outside the checkout. A wrapper passed as `--cli` set a fresh
`HUMANISH_CUA_WIRE_CAPTURE_DIR` for each live run and otherwise ran this checkout's `dist/cli.js`
unchanged; the captures are the only source of the thinking-token counts.

All 204 runs had `reclaim --check` state `clean`. After the last run, E2B listed 0 running or paused
sandboxes in the account. One B2 analysis failed on `analysis_output_incomplete` and is left out of
analysis recall.

Estimated spend was $25.43: participants $5.46, desktops $2.39 and analyses $17.58. By arm: B0
$12.46, B1 $6.04, B2 $6.93, of which the fidelity sub-study was $1.62, $0.71 and $0.97. Per run
outside the fidelity runs, B0 cost $0.18 in all and B1 $0.09; the analysis, $0.075 to $0.097, is
most of a Claude run's cost.

## Bugs found

Fixed in this change: a Claude participant's strict closing retry always failed. When a closing
report or impressions reply is not the JSON asked for, the provider asks once more with the schema
as `output_config.format`. The schema carries `maxItems` on its arrays, and the Messages API answers
that with 400 `invalid_request_error` at `output_config.format.schema`. Two of 136 Claude
participants hit it and kept their first reply. The fix removes `maxItems` from the output-format
schema only; the request text still states the limits and the reply is still parsed against them.

## Needs a decision

A mid-batch screenshot call on the Anthropic path returns no image. Either answer it with a fresh
capture taken at that point in the batch, as `zoom` already does, or end the batch at a screenshot
call and answer the calls after it as not executed. Both change what the participant sees and what
the bundle keeps, so neither is in this change. A rerun of B1 after the change would show how much
of the recall gap it accounts for.

## Recommendation

Offer `claude-haiku-5-5` as a documented participant option, which 0.149.0 already lists. Do not
recommend it for large studies yet, and do not make it the default.

The tradeoff is cost against coverage. A Haiku participant costs $0.005 against $0.071, and a whole
run with its analysis costs about half as much ($0.09 against $0.18), because the analyst stays the
larger part of the bill. For that, a study gets about half the planted problems, read by hand over
both builds 60 of 150 against 103, and the analysis does not recover them. Haiku stops once it has
one reason to decide, so a study that relies on participants reaching a second or third feature
gets little from it. It made no false assurance and no invented claim read by hand, so what it
reports can be trusted as far as it goes. It does not follow a keyboard-first persona as well as
`gpt-6.1-sol` (K1 2 of 8 against 4 of 4).

High effort is not worth offering separately: B2 cost 10% to 20% more per participant and 0.6 s
more per step, and its reports found 4 more defects in 150.

Revisit large studies after the mid-batch screenshot decision and a rerun of B1.

## What these numbers are not

- Recall read by hand is the rubric's count plus lines I read; no second rater checked them. I
  read every planted report and every unmatched analysis title, and every rubric invented, false
  assurance and harness line.
- 15 planted runs per arm and build give intervals about 0.2 wide, and the recall units within a
  run are not independent, so the intervals are narrower than the data supports.
- The keep-using counts are a pattern plus my reading of 35 reports.
- Model-call latency is an estimate from trace timestamps. On the Claude arms it agrees with the
  reply timestamp, which is also a trace time; no request was timed.
- The fidelity personas ran 4 times per arm, and fidelity was not checked by hand.
- B0's last 13 recall runs and B2's pilot ran at lower concurrency than the rest.
- The fixed closing retry has not run in a live participant session; its request body was sent to
  the API by hand and returned 200 with parseable JSON for both closing kinds.
- The localStorage builds are a variant of the same app. No second app was run.
