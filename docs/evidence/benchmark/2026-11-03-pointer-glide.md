# Pointer glide against jump on Taskly, 2026-11-03

`execution.pointer: glide` (0.156.0) moves a computer-use participant's real pointer along a curve
to each target. This compares it with the default, `jump`, on the same code and scorer before any
default change. Two batches per mode, each 12 planted and 12 clean runs, mission `neutral`, rubric
`taskly-rubric` version 5 (rescored; the runs were scored with version 4 first), participants and analysis on `gpt-6.1-sol` at medium effort, in-memory
builds. Built from feat/pointer-glide at 052621f74, src/ as of 07a447923, which 0.156.0 shipped
unchanged. Results:
[jump 1](2026-11-03-pointer-jump.json), [jump 2](2026-11-03-pointer-jump2.json),
[glide 1](2026-11-03-pointer-glide.json), [glide 2](2026-11-03-pointer-glide2.json).

## Recall, both batches together

Scored with rubric version 5, which reads the D5 wordings rubric 4 missed (see below). The files
above hold the rubric 5 scores of the same recordings.

| | jump reports | glide reports | jump analyses | glide analyses |
|---|---|---|---|---|
| D1 Clear completed does nothing | 0/24 | 0/24 | 0/24 | 0/23 |
| D2 Text over 30 characters is silently truncated on add | 0/24 | 1/24 | 0/24 | 0/23 |
| D3 Active and Completed filters are swapped | 24/24 | 24/24 | 24/24 | 23/23 |
| D4 Empty list renders the literal text undefined | 24/24 | 24/24 | 24/24 | 23/23 |
| D5 Save in edit mode does nothing; only Enter commits | 9/24 | 10/24 | 22/24 | 23/23 |
| All defects | 57/120 | 59/120 | 70/120 | 69/115 |
| Invented, clean arm | 0 | 1 | 0 | 0 |

One glide analysis (planted 8, batch 1) failed and is not counted. Every participant in all four
arms used Save in edit mode. Participants gave up in 40 of 48 jump sessions and 37 of 48 glide
sessions. Time between captures was a median of 3.61 s with jump and 4.00 s with glide (means 4.09
s and 4.48 s): Taskly turns batch several clicks, and each glide took 150 to 500 ms.

## What rubric 4 missed

Under rubric 4 the analyses scored D5 17/24 with jump and 8/23 with glide. Every planted analysis
in both modes said the editor stayed open after Save; the D5 rules did not read "Saving an edit
left it open", "remained an input with a Save button afterward" or "did not produce a visible exit
from editing", and the glide analyses happened to use those wordings more. The analysis inputs
differ only in timestamps: it does not read `pointerApproach`, both modes kept a median of 12
captures, and the Taskly Save handler has no hover or blur behavior a glide could trigger. Rubric 5
adds those wordings, with a test per sentence; it reads no D5 in any clean-arm report or analysis.

## Reading

- Participants report the same with either mode: 57 and 59 of 120 planted defects.
- Analyses find the same: 70 of 120 and 69 of 115, and D5 22 of 24 and 23 of 23.
- The one invented claim is the scorer matching D3 to a clean-build report that says "switched back
  to all, and refreshed the page", not a participant inventing a defect.
- Glide costs time per step on a click-dense app: about 0.4 s a capture here.

## Quicker glides and the default

0.157.0 shortens each glide to 120 to 380 ms and makes `glide` the default. One more glide batch at
that timing, 12 planted and 12 clean runs scored with rubric 5
([glide 3](2026-11-03-pointer-glide3.json)), found reports 31/60 and analyses 31/55 (D5 9/11), with
participants giving up in 18 of 24 sessions. A step between captures took a median of 3.91 s
against 3.61 s with jump (means 4.42 s and 4.09 s), 8% longer; the mean glide was 252 ms, against
309 ms at the first timing.

## Spend

About $4.4 to $4.6 per batch of 24 runs: participants about $1.8, desktops about $0.3, analysis
about $2.4. All runs' cleanup checks were clean.
