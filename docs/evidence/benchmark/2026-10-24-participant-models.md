# Participant models on the Taskly benchmark, 2026-10-24

Five participant settings ran the neutral Taskly mission on humanish 0.146.0 plus the
`actor.serviceTier` setting added in the same change. The analyst stayed at the CLI default,
`gpt-6.1-sol` at medium effort, for every run. Each arm has 20 planted and 20 clean runs: 3 and 3
from the pilot, 17 and 17 from the recall phase. A fidelity sub-study added 4 runs per arm on each
of two more personas. Full numbers and every run id are in
[2026-10-24-participant-models.json](2026-10-24-participant-models.json). Definitions of recall,
false assurance and invented claims are in the [README](README.md).

| Arm | Participant | Price per 1M in / cached / out |
| --- | --- | --- |
| A0 | `gpt-5.6-sol`, medium effort (the shipped default) | $4 / $0.40 / $20 |
| A1 | `gpt-5.6-sol`, medium effort, `serviceTier: fast` | $8 / $0.80 / $40 |
| A2 | `gpt-6.1-sol`, low effort | $2 / $0.10 / $10 |
| A3 | `gpt-6.1-sol`, medium effort | $2 / $0.10 / $10 |
| A4 | `gpt-6-luna`, medium effort | $0.10 / $0.01 / $0.50 |

All three models accepted the `computer` tool on the Responses API before any run, and Fast mode
requests to `gpt-5.6-sol` and `gpt-6.1-sol` returned a fast tier. Each model was already priced in
`src/run/pricing.ts`. Fast mode rates came from developers.openai.com/api/docs/guides/fast-mode
and the Fast tab of developers.openai.com/api/docs/pricing, both read 2026-10-24.

## Results

| | A0 | A1 | A2 | A3 | A4 |
| --- | --- | --- | --- | --- | --- |
| Step latency, median / p90 (s) | 4.38 / 6.75 | 3.77 / 6.11 | 4.45 / 7.45 | 4.49 / 7.40 | 4.04 / 6.14 |
| Model call, median / p90 (s) | 2.95 / 3.98 | 2.47 / 3.12 | 2.80 / 3.64 | 2.85 / 4.13 | 2.79 / 3.79 |
| Session, median (s) | 58.8 | 50.7 | 48.6 | 59.6 | 58.8 |
| Turns per session, median | 11 | 12 | 8 | 11 | 11.5 |
| Ended on its own with a report | 40/40 | 40/40 | 40/40 | 40/40 | 40/40 |
| Said it would keep using Taskly | 36/40 | 38/40 | 12/40 | 9/40 | 36/40 |
| Harness-caused failures | 0 | 0 | 0 | 0 | 0 |
| Report recall, read by hand (95% interval) | 62/100 (0.52 to 0.71) | 66/100 (0.56 to 0.75) | 49/100 (0.39 to 0.59) | 53/100 (0.43 to 0.62) | 44/100 (0.35 to 0.54) |
| Report recall, rubric | 61/100 | 66/100 | 45/100 | 47/100 | 43/100 |
| Analysis recall, rubric (95% interval) | 59/100 (0.49 to 0.68) | 57/100 (0.47 to 0.66) | 57/100 (0.47 to 0.66) | 62/100 (0.52 to 0.71) | 55/95 (0.48 to 0.67) |
| False assurance in reports, rubric / by hand | 2 / 1 | 0 / 0 | 0 / 0 | 1 / 0 | 1 / 0 |
| Invented on the clean arm, rubric / by hand | 1 / 0 | 2 / 0 | 0 / 0 | 0 / 0 | 1 / 0 |
| Persona fidelity: synthetic-new-user, keyboard-first, low-vision | 1.00, 0.83, 1.00 | 1.00, 0.67, 1.00 | 0.99, 0.83, 1.00 | 0.99, 0.83, 1.00 | 0.98, 0.75, 1.00 |
| Participant cost per run, median | $0.178 | $0.383 | $0.052 | $0.071 | $0.005 |

Step latency runs from one screenshot to the next. It covers the model call, the actions and the
settle wait. The trace records no request timings, so the model call is estimated per step. The
estimate is the time from the screenshot to the first action, less that action kind's median
execution time pooled over all arms (click 0.35 s, type 1.10 s, keypress 0.10 s). Steps per arm:
433 for A1 and 306 to 425 for the others.

"Said it would keep using Taskly" counts `goal_satisfied` endings. The rest ended `gave_up` with a
full closing report. The neutral mission asks the participant to decide whether to keep using the
app, so `gave_up` is a mission outcome and counts as completed.

Recall per defect, reports read by hand, then analyses by the rubric:

| | A0 | A1 | A2 | A3 | A4 |
| --- | --- | --- | --- | --- | --- |
| D1 Clear completed does nothing | 8/20, 8/20 | 13/20, 13/20 | 0/20, 0/20 | 0/20, 0/20 | 1/20, 3/19 |
| D2 Text over 30 characters truncated | 0/20, 0/20 | 0/20, 0/20 | 5/20, 5/20 | 4/20, 11/20 | 0/20, 0/19 |
| D3 Filters swapped | 20/20, 20/20 | 20/20, 20/20 | 20/20, 20/20 | 20/20, 20/20 | 20/20, 19/19 |
| D4 Empty list shows undefined | 20/20, 19/20 | 20/20, 12/20 | 20/20, 20/20 | 20/20, 19/20 | 20/20, 19/19 |
| D5 Save in edit mode does nothing | 14/20, 12/20 | 13/20, 12/20 | 4/20, 12/20 | 9/20, 12/20 | 3/20, 14/19 |

## What the numbers say

Fast mode cut the median model call by 0.48 s (16%) and the p90 by 0.86 s (22%). It cut the median
step by 0.61 s (14%) and the median session by 8 s. It cost 2.15 times as much per participant.
Every one of A1's 40 runs recorded `service_tier: priority` on every request, so no request fell
back to the standard tier.

Most of a step is not the model call. On A0 the model call is 2.95 s of a 4.38 s step. A faster
model can save at most that share.

Neither `gpt-6.1-sol` arm was faster per step than A0. Both gave up on Taskly in most runs: A2 in 28
of 40 and A3 in 31 of 40, on both builds. Their reports name the page refresh, which empties the
list on both builds, as where they stopped. No A2 or A3 report or narration mentions Clear
completed, so D1 recall is 0/20 on both. Their reports describe D5 in words the rubric does not
match ("the row stayed in an editable box with save still showing"). Read by hand, 4 A2 lines and 6
A3 lines are D5. A2 and A3 left 58 and 73 report paragraphs unresolved, against 12 to 14 on the
other arms.

`gpt-6-luna` ran at the same step latency as A0 for 2.8% of its participant cost. Its reports name
D1 once and D5 three times in 20 planted runs. Its analyses, from the same recordings, name D5 14
times in 19. The rubric counted one Luna false assurance. Read by hand, that line is a D5 report
("clicking save appeared to leave the item in edit mode, but pressing enter committed it"). No arm
showed a Luna-specific rise in false assurance.

Analysis recall sits between 55% and 62% on every arm, and the intervals overlap. The analyst reads
the screenshots and actions, so it recovers defects a participant did not write down. A1's analyses
named D4 in 12 of 20 runs while every A1 report named it; the cause was not investigated.

## Actions per model turn

A `computer_call` already carries several actions. On A0, a turn carried 2.48 actions on average,
57% of turns carried more than one, and the most was 15. A1 matched A0. A2 carried 2.87, A3 2.47 and
A4 2.19 (43% of A4 turns carried more than one). The count is the `ui_action` items between two
screenshots in the trace, with the opening screenshot request counted as 0.

## Persona fidelity

The rubric was written before any run and is copied below. Every check is an automated count from
the trace, so no model judge ran.

- synthetic-new-user, all 200 runs: F1 stays on the app with no view-source or devtools, F2 uses no
  keyboard shortcut outside ordinary editing and reload, F3 ends on its own. Four runs failed F2 on
  `CTRL+END`, which is an ordinary editing key; the rubric did not list it.
- skeptical-power-user (`keyboard_first`), 4 runs per arm: K1 keypresses are at least half of
  keypresses plus clicks, K2 Enter or Tab right after typing, K3 an edge-case probe (Ctrl+Z, Escape,
  or typing 60 or more characters). The rubric also listed an empty submit under K3; it was not
  automated. The median keyboard share was 0.67 to 0.76 on this persona and 0.33 to 0.38 on
  synthetic-new-user, on every arm.
- low-vision-reader (`low_vision`, `bench/personas/low-vision-reader.yaml`), 4 runs per arm: V1
  zooms, V2 zooms within the first 3 turns, V3 the report mentions size, zoom, contrast or
  readability. Every run on every arm pressed Ctrl+plus 3 or 4 times on its first action turn.

I read 10 runs by hand against the same checks: 4 synthetic-new-user, 3 keyboard-first and 3
low-vision. 28 of 30 checks agreed. Both disagreements are K3: one participant pressed Enter on an
empty field and one typed a whitespace-only task, and the automated count has no empty-submit
clause. Fidelity does not separate the arms: every arm followed both declared traits.

## How it ran

Each arm was one `pnpm bench` invocation with `--participant`, `--service-tier fast` for A1,
`--participant-cap 1.5` and `--mission neutral`. The pilot ran `--runs 3`, the recall phase
`--runs 17`. The five recall invocations started 8 s apart and ran at once. Each ran one participant
at a time, at least 40 s between starts, so at most five desktops ran at once. A2 finished first,
so the last runs of the other arms ran with four or fewer in flight. The pilot ran A0, A2, A3 and A4
at once from 00:29 UTC; A1's pilot started at 00:37 UTC on the build with `serviceTier`. The recall
phase ran from 00:52 to 02:26 UTC, and the fidelity runs from 02:31 to 02:59 UTC.

The pilot dropped no arm. All 30 pilot runs ended on their own with a closing report, and none had a
harness-caused failure.

All 240 runs had `reclaim --check` state `clean`. After the last run, E2B listed 0 running or
paused sandboxes in the account. Three of 240 analyses failed: two on
`analysis_validation_failed_participant_coverage_invalid` and one on `analysis_output_incomplete`.
They are left out of analysis recall.

Estimated spend was $61.98: participants $35.22, desktops $2.84 and analyses $23.91. The fidelity
sub-study cost $12.04 of it.

## Recommendation

Keep `gpt-5.6-sol` at medium effort as the participant default. It had the second-highest report
recall and one false assurance in 20 planted runs read by hand.

Offer Fast mode as a declared opt-in for studies where wait time matters. It saves about 14% per
step and 8 s per session at 2.15 times the participant cost. Its report recall, 66/100, overlaps
A0's.

Do not move participants to `gpt-6.1-sol` at either effort. It is not faster, and it stops at the
refresh in most runs, so it never reaches Clear completed.

`gpt-6-luna` is a candidate for large studies where participant cost dominates. Its own reports
miss more, and its analyses recover most of the gap. Twenty planted runs cannot rule out the
adversarial false-assurance gap OpenAI reports for it.

## Rubric version 4 rescored these runs on 2026-10-26

`pnpm bench --rescore` with rubric version 4 re-read the saved pilot and recall bundles and
analyses offline; no run was repeated. The tables above keep the version 3 counts. Counts below are
rubric version 3, version 4, then by hand.

| | A0 | A1 | A2 | A3 | A4 |
| --- | --- | --- | --- | --- | --- |
| Report recall | 61, 61, 62 | 66, 66, 66 | 45, 62, 49 | 47, 63, 53 | 43, 43, 44 |
| D2 in reports | 0, 0, 0 | 0, 0, 0 | 5, 8, 5 | 4, 11, 4 | 0, 0, 0 |
| D5 in reports | 13, 13, 14 | 13, 13, 13 | 0, 14, 4 | 3, 12, 9 | 2, 2, 3 |
| Analysis recall, rubric | 59, 59 | 57, 57 | 57, 57 | 62, 62 | 55, 55 |
| D2 engagement: typed more than 30 characters, v4 | 0/20 | 5/20 | 9/20 | 18/20 | 3/20 |

Version 4 counts more D2 and D5 on A2 and A3 than the hand counts above. I read each of the 33 new
report matches: each says Save left the edit open ("clicked Save, but it stayed in the editing
box") or that a task name was cut off ("My library reminder appeared cut off at Wednes"). The hand
counts were the rubric's count plus lines I read, so those reports were not read again. Clean-arm
invented counts and false assurance are unchanged, and no clean-arm report or analysis changed
verdict.

## What these numbers are not

- The `gpt-5.6-sol` promotional rate holds at least through November 21, 2026. A0 and A1 costs
  change after it.
- Model-call latency is an estimate from trace timestamps, not a measured request time.
- Recall read by hand is the rubric's count plus lines I read; no second rater checked them.
- The fidelity personas ran 4 times per arm, and both traits are stated in the persona text, so
  fidelity here measures following a stated behavior.
- A1's runs never hit the Fast mode ramp limit, so the downgrade path to `default` pricing ran in
  unit tests only.
