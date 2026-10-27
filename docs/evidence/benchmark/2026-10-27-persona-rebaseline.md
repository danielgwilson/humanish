# Taskly benchmark after the persona change, 2026-10-27

humanish 0.152.0 removed `accessibility_needs: clear_terminal_output` from the committed
`synthetic-new-user` persona, which the Taskly benchmark uses. Up to 0.151.0, every
benchmark participant read "You rely on clear terminal output. Describe any difficulty
understanding the output you actually encounter." This rebaseline starts the new series and
checks the change against a control.

With the old persona, 12 of the 24 `gpt-6.1-sol` reports in one run set contained a terminal
claim about a web app, which the rubric scores harness-caused (class H4). With the new persona, 0
of 24 did. Report recall did not fall: 30/60 with the new persona, 27/60 with the old one on the
same code, and 32/60 on 10-26.

## Four run sets on the in-memory build

Each set is one `pnpm bench --brain computer-use --participant <model@effort> --participant-cap 1.5
--mission neutral --storage memory --runs 12` invocation: 12 planted and 12 clean runs, scored with
rubric `taskly-rubric` version 4. Analysis ran on `gpt-6.1-sol` with prompt `study-evidence-8`.

| | Sol, new persona | Sol, old persona | Sol, 0.149.0 build | Haiku, new persona |
| --- | --- | --- | --- | --- |
| humanish | 0.151.0 at b95802ca9 | 0.151.0 at b95802ca9 | 0.149.0 at f15eaa4d5 | 0.151.0 at b95802ca9 |
| Persona | `synthetic-new-user` | the 0.151.0 file, with the need | the 0.149.0 file, with the need | `synthetic-new-user` |
| Report recall, rubric | 30/60 (0.38 to 0.62) | 27/60 (0.33 to 0.58) | 31/60 (0.39 to 0.64) | 26/60 (0.32 to 0.56) |
| Analysis recall, rubric | 27/55 (0.36 to 0.62) | 28/50 (0.42 to 0.69) | 32/60 (0.41 to 0.65) | 25/55 (0.33 to 0.58) |
| Harness-caused claims in reports | 0 | 12, all H4 | 10 | 0 |
| Invented on the clean arm, reports / analyses | 1 / 0 | 0 / 0 | 0 / 0 | 2 / 0 |
| False assurance | 0 | 0 | 0 | 0 |
| Estimated spend | $4.45 | $4.46 | $4.40 | $2.35 |

Recall per defect, reports then analyses:

| | Sol, new persona | Sol, old persona | Sol, 0.149.0 build | Haiku, new persona |
| --- | --- | --- | --- | --- |
| D1 Clear completed does nothing | 0/12, 0/11 | 0/12, 0/10 | 0/12, 0/12 | 1/12, 1/11 |
| D2 Text over 30 characters truncated | 0/12, 0/11 | 1/12, 1/10 | 1/12, 0/12 | 1/12, 1/11 |
| D3 Filters swapped | 12/12, 10/11 | 12/12, 10/10 | 12/12, 12/12 | 11/12, 11/11 |
| D4 Empty list shows undefined | 12/12, 10/11 | 12/12, 10/10 | 12/12, 12/12 | 12/12, 11/11 |
| D5 Save in edit mode does nothing | 6/12, 7/11 | 2/12, 7/10 | 6/12, 8/12 | 1/12, 1/11 |

Intervals are 95% Wilson intervals. One analysis failed in each of three sets, so their analysis
denominators are below 60.

## What the comparison shows

- The persona's need produced the H4 claims. The two sets that ran with the need had 12 and 10
  harness-caused claims. The two without it had none. On 10-26 (0.149.0, the same persona), the
  recall phase of B0 had 14.
- The change did not reduce recall. The three Sol sets are within each other's intervals, and the
  10-26 recall phase on the same build scored 32/60.
- D5 did not regress. The 15/15 for B0 in the
  [10-26 report](2026-10-26-haiku-participants.md#results-on-the-in-memory-builds) is a hand-read
  count; the rubric scored those same reports 5/15 (1/3 pilot, 4/12 recall phase). Rubric against rubric, D5
  is 5/15 on 10-26 and 6/12, 2/12 and 6/12 here. In all 12 runs of every Sol set the participant
  opened edit mode. In the sampled run `cua-2026-10-27T06-24-02-675Z-dc6a0e7e` it clicked Save
  twice, saw nothing happen, and left it out of its report. The analysis caught D5 in 7 to 8 of
  10 to 12 runs from the screenshots.
- Haiku opened edit mode in 7 of 12 runs. On 10-26, no Haiku participant clicked Edit. Its D5
  recall is still 1/12. Its report recall, 26/60, compares with 27/75 by rubric on 10-26.

## How it ran

The four sets started their runs between 06:13 and 09:19 UTC on 2026-10-27, on E2B desktops, with at most two
sets in flight. The old-persona set passed `--persona` with the 0.151.0
`humanish/personas/synthetic-new-user.yaml`. The 0.149.0 set ran from a detached worktree at
f15eaa4d5, the build of the 10-26 report. Its participant prompt digest equals the old-persona
set's (`a0b137ee3d84f013`), so the prompt is the same. Every run's `reclaim --check` was `clean`.
Total estimated spend was $15.66.

Results: [new persona](2026-10-27-persona-rebaseline-sol.json),
[old persona](2026-10-27-persona-rebaseline-sol-old-persona.json),
[0.149.0 build](2026-10-27-persona-rebaseline-sol-0149.json),
[Haiku](2026-10-27-persona-rebaseline-haiku.json).

## Not checked

- Reports were not read by hand. The rubric scores D5 lower than hand-reading did on 10-26 (5/15
  against 15/15), so the D5 rows here undercount by an unknown amount.
- The localStorage builds were not rerun.
- Fidelity personas (keyboard-first, low-vision) were not rerun.
