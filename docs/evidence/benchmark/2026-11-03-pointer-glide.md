# Pointer glide against jump on Taskly, 2026-11-03

`execution.pointer: glide` (0.156.0) moves a computer-use participant's real pointer along a curve
to each target. This compares it with the default, `jump`, on the same code and scorer before any
default change. Two batches per mode, each 12 planted and 12 clean runs, mission `neutral`, rubric
`taskly-rubric` version 4, participants and analysis on `gpt-6.1-sol` at medium effort, in-memory
builds. Built from feat/pointer-glide at 052621f74, src/ as of 07a447923, which 0.156.0 shipped
unchanged. Results:
[jump 1](2026-11-03-pointer-jump.json), [jump 2](2026-11-03-pointer-jump2.json),
[glide 1](2026-11-03-pointer-glide.json), [glide 2](2026-11-03-pointer-glide2.json).

## Recall, both batches together

| | jump reports | glide reports | jump analyses | glide analyses |
|---|---|---|---|---|
| D1 Clear completed does nothing | 0/24 | 0/24 | 0/24 | 0/23 |
| D2 Text over 30 characters is silently truncated on add | 0/24 | 1/24 | 0/24 | 0/23 |
| D3 Active and Completed filters are swapped | 24/24 | 24/24 | 24/24 | 23/23 |
| D4 Empty list renders the literal text undefined | 24/24 | 24/24 | 24/24 | 23/23 |
| D5 Save in edit mode does nothing; only Enter commits | 9/24 | 8/24 | 17/24 | 8/23 |
| All defects | 57/120 | 57/120 | 65/120 | 54/115 |
| False assurance | 1 | 0 | 0 | 0 |
| Invented, clean arm | 0 | 1 | 0 | 0 |

By batch, D5 in analyses was 9/12 and 8/12 with jump, and 5/11 and 3/12 with glide. One glide
analysis (planted 8, batch 1) failed and is not counted. Every participant in all four arms used
Save in edit mode.

## Reading

- Participants report the same with either mode: 57 of 120 planted defects each, and D5 9/24
  against 8/24.
- The analysis gap is D5 alone, in both batches. Glide analyses mention Save at all in 8 of 23
  planted runs, against 15 of 24 with jump.
- The analysis does not read `pointerApproach`: it renders each action from its title and text
  (`src/analysis/evidence-sources.ts`). Runs kept the same evidence in both modes, a median of 12
  screenshots and 12 turns per participant.
- The one invented claim is the scorer matching D3 to a clean-build report that says "switched back
  to all, and refreshed the page", not a participant inventing a defect.

`jump` stays the default until the D5 gap in analyses is explained.

## Spend

About $4.4 to $4.6 per batch of 24 runs: participants about $1.8, desktops about $0.3, analysis
about $2.4. All runs' cleanup checks were clean.
