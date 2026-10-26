# Participant default on Taskly with saved tasks, 2026-10-25

Two participant settings ran the neutral Taskly mission on humanish 0.146.0, on Taskly builds that
keep their tasks in localStorage. On the [2026-10-24 comparison](2026-10-24-participant-models.md)'s
builds a page refresh empties the list, and `gpt-6.1-sol` stopped there in about 30 of 40 runs. The
maintainer decided on 2026-10-25 that stopping at the refresh is a plausible human reaction. These
runs ask whether `gpt-6.1-sol` holds up on an app that keeps its data across a refresh. The analyst
stayed at the CLI default, `gpt-6.1-sol` at medium effort. Each arm has 15 planted and 15 clean
runs. Full numbers and every run id are in
[2026-10-25-participant-default.json](2026-10-25-participant-default.json). Definitions of recall,
false assurance and invented claims are in the [README](README.md).

| Arm | Participant | Price per 1M in / cached / out |
| --- | --- | --- |
| A0 | `gpt-5.6-sol`, medium effort (the shipped default) | $4 / $0.40 / $20 |
| A3 | `gpt-6.1-sol`, medium effort | $2 / $0.10 / $10 |

## Why a localStorage Taskly

`bench/` holds no second app with both a planted defect and a clean build. TodoMVC and drawDB have
no answer key, so they measure invented claims but not recall. The save-feedback builds keep tasks
in memory and differ by one defect. `bench/taskly-planted-local` and `bench/taskly-clean-local`
change only `app.js`: it loads the list from localStorage at start and saves it on every render.
The five planted defects and the answer key carry over, so these numbers compare with the 10-24
ones. `pnpm bench --storage local` serves them. Rubric version 3 counts a lost-on-reload claim
(B10) as invented on these builds.

## Results

| | A0 | A3 |
| --- | --- | --- |
| Step latency, median / p90 (s) | 4.49 / 6.96 | 3.75 / 6.44 |
| Model call, median / p90 (s) | 3.09 / 4.33 | 2.35 / 3.44 |
| Session, median (s) | 69.0 | 53.4 |
| Turns per session, median | 13 | 11 |
| Ended on its own with a report | 30/30 | 30/30 |
| Said it would keep using Taskly, clean build | 14/15 | 15/15 |
| Said it would keep using Taskly, planted build | 0/15 | 0/15 |
| Harness-caused failures | 0 | 0 |
| Report recall, read by hand (95% interval) | 56/75 (0.64 to 0.83) | 52/75 (0.58 to 0.79) |
| Report recall, rubric (95% interval) | 53/75 (0.60 to 0.80) | 35/75 (0.36 to 0.58) |
| Analysis recall, rubric (95% interval) | 48/70 (0.57 to 0.78) | 42/75 (0.45 to 0.67) |
| Analysis recall, read by hand (95% interval) | 53/70 (0.65 to 0.84) | 52/75 (0.58 to 0.79) |
| False assurance in reports, rubric / by hand | 2 / 1 | 0 / 0 |
| False assurance in analyses, rubric | 0 | 0 |
| Invented on the clean arm, reports, rubric / by hand | 3 / 0 | 1 / 0 |
| Invented on the clean arm, analyses, rubric / by hand | 1 / 0 | 0 / 0 |
| Participant cost per run, median | $0.216 | $0.071 |

Step latency and the model-call estimate are computed as in the 10-24 comparison, with action
execution times pooled over both arms (click 0.34 s, type 1.08 s, keypress 0.09 s). Steps per arm:
356 for A0 and 297 for A3.

Every run ended `goal_satisfied`: the participant decided whether to keep using Taskly. The keep
counts come from each closing report's own verdict.

Recall per defect, reports read by hand, then analyses by the rubric, then analyses read by hand:

| | A0 | A3 |
| --- | --- | --- |
| D1 Clear completed does nothing | 14/15, 13/14, 14/14 | 0/15, 0/15, 0/15 |
| D2 Text over 30 characters truncated | 0/15, 0/14, 0/14 | 7/15, 7/15, 7/15 |
| D3 Filters swapped | 15/15, 14/14, 14/14 | 15/15, 15/15, 15/15 |
| D4 Empty list shows undefined | 15/15, 13/14, 13/14 | 15/15, 15/15, 15/15 |
| D5 Save in edit mode does nothing | 12/15, 8/14, 12/14 | 15/15, 5/15, 15/15 |

## What the numbers say

With the list kept across a refresh, `gpt-6.1-sol` no longer stopped early. All 30 A3 runs refreshed
the page, kept going and ended with a verdict. Every A3 planted report names D5, and A0's names it
in 12 of 15.

A3 still did not reach Clear completed on the planted build. Its reports or narration mention the
button in 14 of 15 clean runs and in none of 15 planted runs, so D1 is 0/15 here, as it was 0/20 on
10-24. The planted reports stop after the failed edit and the swapped filters: "I stopped rather
than spend more time working around them." A0 mentions the button in all 30 runs. A3 typed task
names past 30 characters in enough runs to report D2 in 7; A0 reported D2 in none. A3's analysis
recall read by hand trails A0's by the D1 gap: 15 defects across the 15 runs.

The rubric undercounts A3 more than A0. A3 wrote D5 as "the edit did not persist after Save and
refresh". On these builds the B10 pattern catches that sentence and scores it invented on the
planted arm, so the rubric finds D5 in 1 of 15 A3 reports and 5 of 15 analyses. Read by hand, all 15
reports and all 15 analyses describe it. The rubric's D2 claim pattern also misses a cut-off day
name when the paragraph says "errand" or "reminder".

Hand reading removed every invented claim on the clean arm. The A0 report lines are "refreshing
reset the filter to all, though the tasks themselves remained" and a sentence that refreshed to
confirm the list persisted. The A3 line says refreshing switched the view back to All. All three
are true. A0's one analysis line says the same about the filter. A0's two rubric false assurances
are a D5 report ("clicking save appeared to do nothing"), which is a detection, and one real false
assurance: "Clear completed removed finished tasks at first, but they returned after I reloaded
the page." Clear completed does nothing on that build.

A3 was faster here: 0.74 s less per step and 15.6 s less per session. On 10-24 the two were equal
per step. These runs had two desktops in flight against five on 10-24; the cause of the change was
not investigated.

## How it ran

Each arm was one `pnpm bench` invocation with `--storage local`, `--participant`,
`--participant-cap 1.5`, `--max-usd 14`, `--runs 15` and `--mission neutral`. The two invocations
started at 22:08 UTC and ran at once, one participant at a time each, at least 40 s between starts,
so at most two desktops ran at once. A3 finished at 23:16 UTC and A0 at 23:24 UTC, so A0's last
three runs ran alone.

A first attempt put the work directories under the worktree's gitignored `.humanish/`. The
local-tree packer found no packable files there, so the first four runs were refused before any
desktop or model call. The runs above used work directories outside the checkout.

All 60 runs had `reclaim --check` state `clean`. After the last run, E2B listed 0 running or paused
sandboxes in the account. One A0 analysis failed on
`analysis_validation_failed_participant_coverage_invalid` and is left out of analysis recall.

Estimated spend was $15.48: A0 $10.16 (participants $6.48, desktops $0.39, analyses $3.29) and A3
$5.33 (participants $2.13, desktops $0.33, analyses $2.87).

## Recommendation

Make `gpt-6.1-sol` at medium effort the participant default. Its analysis recall interval overlaps
A0's on these builds by the rubric (0.45 to 0.67 against 0.57 to 0.78) and read by hand (0.58 to
0.79 against 0.65 to 0.84). It overlapped and led on 10-24 (62/100 against 59/100). Read by hand it
made no false assurance and no invented claim here, against one false assurance for A0. It costs a
third as much per participant and was not slower.

On the planted build, `gpt-6.1-sol` stopped after the failed edit and the swapped filters in these
runs, and no report or narration of its 35 planted runs over both days names Clear completed. A
study that needs participants to keep going past early failures can name `gpt-5.6-sol` in
`actor.model`.

## What these numbers are not

- The localStorage builds are a variant of the same app. A second app with a different layout was
  not run.
- 15 planted runs per arm give intervals about 0.2 wide, and the recall units within a run are not
  independent, so the intervals are narrower than the data supports.
- Recall read by hand is my reading of every planted report and analysis; no second rater checked
  it.
- The bench's D2 engagement flag read false on every run, including runs that typed 32 characters,
  so the D2 engagement count is not reported. The cause was not investigated.
- Persona fidelity was not measured; both arms ran `synthetic-new-user` only.
- The `gpt-5.6-sol` promotional rate holds at least through November 21, 2026. A0 costs change
  after it.
