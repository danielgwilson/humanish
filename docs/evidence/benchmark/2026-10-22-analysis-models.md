# Analysis models on fixed recordings, 2026-10-22

This report compares study analysts on the same recordings: each model analyzed the same saved
runs, so differences between rows come from the analyst, not from what the participants did. It
is the evidence for making `gpt-6.1-sol` at medium reasoning effort the default analyst in place
of `gpt-6-astra` at high effort.

Two sets of recordings:

- **Taskly**: 8 runs from `pnpm bench --runs 4 --no-analysis` on humanish 0.141.0, 4 on the
  planted build and 4 on the clean build, one `openai-computer-use` participant each on
  `gpt-5.6-sol`. Each model analyzed every run 3 times with `pnpm bench --reanalyze`, and the
  committed rubric scored every analysis. The participants' own reports found 10 of the 20 planted
  defects they could have met; an analysis can only report what a participant ran into, so no
  analysis can score above what the recordings hold.
- **CineGuessr**: 3 runs of one study against cineguessr.com, a public movie-guessing game, each
  with a phone, a tablet and a desktop participant on E2B desktops (`gpt-5.6-sol`, three fictional
  personas). 8 of 9 participants finished; run 3's desktop participant stopped after 78 s on a
  typing error that ends the participant. Each model analyzed each run twice. No answer key exists for a real app,
  so analyses were graded by hand against the recordings.

## Taskly

Recall counts each planted defect each scored planted analysis reported, out of 5 per analysis.
Invented counts defects reported on the clean build or not in the app. False assurance counts a
planted analysis saying a broken control worked. Time is the median `humanish analyze` call.
Analyses that failed validation or stopped early are not scored, and their count is the
"completed" column.

| Analyst | Output limit | Completed | Recall | Invented | False assurance | Cost per analysis | Median time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `gpt-6-astra`, high (the 0.142.0 default) | 16,384 | 24/24 | 28/60 | 0 | 0 | $0.41 | 166 s |
| `gpt-6-astra`, medium | 16,384 | 24/24 | 23/60 | 0 | 0 | $0.31 | 64 s |
| `gpt-6.1-sol`, high | 16,384 | 22/24 | 29/60 | 0 | 0 | $0.09 | 146 s |
| **`gpt-6.1-sol`, medium** | 16,384 | **24/24** | **28/60** | **0** | **0** | **$0.06** | **111 s** |
| `gpt-6-luna`, high | 16,384 | 15/24 | 19/40 | 0 | 0 | $0.008 | 419 s |
| `gpt-6-luna`, high | 32,768 | 18/24 | 19/40 | 0 | 0 | $0.006 | 382 s |
| `gpt-6-luna`, medium | 16,384 | 12/24 | 22/40 | 0 | 0 | $0.003 | 35 s |
| `gpt-6-luna`, low | 16,384 | 10/24 | 17/35 | 0 | 0 | $0.003 | 24 s |
| `gemini-3.8-flash`, high | 32,768 | 23/24 | 32/60 | 0 | 1 | $0.10 | 145 s |
| `gemini-4-argon`, high | 32,768 | 19/24 | 32/55 | 0 | 2 | $0.18 | 153 s |
| `gemini-3.5-flash-lite`, high | 32,768 | 20/24 | 22/50 | 0 | 0 | $0.02 | 21 s |
| `gemini-3-flash-preview`, high | 32,768 | 15/24 | 14/30 | 0 | 0 | $0.03 | 40 s |

Per defect, every analyst that completed reported D3 (swapped filters) and D4 (`undefined` on
an empty list) in nearly every planted analysis, D1 (Clear completed) in a quarter to a half, D5
(Save in edit mode) rarely, and D2 (truncation) never: no participant typed a long enough task.
The recall intervals of the completed analysts overlap, so Taskly separates them on completion,
cost and time more than on recall.

The three false assurances concern D5. `gemini-3.8-flash` wrote that "inline task editing with
save worked as expected"; both `gemini-4-argon` lines attribute the claim to the participant
("reported that ... the edit and save controls worked well").

## CineGuessr

| Analyst | Completed | Cost per analysis | Median time |
| --- | --- | --- | --- |
| `gpt-6-astra`, high | 6/6 | $0.88 to $1.76, mean $1.28 | 352 s |
| `gpt-6.1-sol`, high | 6/6 | $0.14 to $0.35, mean $0.24 | 279 s |
| **`gpt-6.1-sol`, medium** | **6/6** | **$0.08 to $0.29, mean $0.17** | **191 s** |
| `gpt-6-luna`, medium | 1/6 | $0.01 | 88 s |
| `gpt-6-luna`, low | 0/6 | $0.01 | 39 s |
| `gemini-3.8-flash`, high | 1/6 | $0.17 | 181 s |
| `gemini-4-argon`, high | 0/6 | $0.50 | 341 s |

On every run, `gpt-6-astra` and `gpt-6.1-sol` at either effort reported the same problems:
"Map" as the name of the movie picker, Enter not submitting a guess, a separate select-then-confirm
step, scoring and the "beat 27%" comparison left unexplained, slow transitions and a countdown that
shows the round just finished, a phone layout that is mostly black space, unrelated titles in
search, and posters chosen by mistake while reaching for search. Each was checked against the
recordings: the participants said or did each one (for example, two closing impressions call
"map" confusing, and the desktop participant's trace has Enter presses that did not advance the
guess). No finding from these analysts was invented. `gpt-6-astra` wrote 6 to 9 findings per run
against `gpt-6.1-sol`'s 5 to 7; the extra ones are minor, such as one player briefly questioning a
score.

## Why the other analysts are not the default

`gpt-6-luna` and the Gemini models fail humanish's evidence checks, which refuse an analysis
whose citations do not support its claims. Most of their failures are
`analysis_validation_failed_statement_source_invalid`: an observation labelled as a participant
statement cites an evidence item that is not a quotable statement. On the three-participant
CineGuessr runs, they completed 2 of 24 analyses between them. `gpt-6-luna` at high effort also
wrote a median 14,822 output tokens at about 29 tokens per second, so 9 of 24 analyses ran out of
output and 5 of 24 at the larger limit ran past the 600 s timeout.

A follow-up outside the bench replayed humanish's request for the same Taskly packets 198 times.
Most of `gpt-6-luna`'s high-effort output is reasoning (median 9,800 reasoning tokens against
3,404 visible), and at high effort with default verbosity it decoded at 45 to 64 tokens per
second against 130 to 146 with `text.verbosity: "low"`, run side by side on the same packet.
With low verbosity, 10 of 10 analyses validated in a median 88 s. Every rejected output inspected
(19 of 19) failed one rule: an observation labelled as a participant statement that also cites a
capture or an action. The samples are small and only Taskly was replayed; the next comparison
runs `gpt-6-luna` with low verbosity on both sets of recordings.

## What changed

The default analyst is `gpt-6.1-sol` at medium effort. On these recordings it matched
`gpt-6-astra` at high on Taskly recall (28/60 each) and on the CineGuessr findings, completed
every analysis, and cost about one seventh as much per analysis (Taskly $0.06 against $0.41,
CineGuessr mean $0.17 against $1.28) in less time.

## Not verified

- Studies larger than 3 participants, studies over 16 participants (analysed in cohorts and
  merged), and terminal or shared-world studies.
- CineGuessr grading is one reviewer's reading of the recordings; it has no answer key.
- Taskly recall for the completed analysts rests on 8 recordings, and its intervals overlap.
- Whether a repair step could make `gpt-6-luna` or Gemini pass the evidence checks.
- `gpt-6-luna` and Gemini at efforts and output limits other than those in the tables.

The scored Taskly results for each set of analysts are in
[2026-10-22-analysis-models-high.json](2026-10-22-analysis-models-high.json),
[2026-10-22-analysis-models-32k.json](2026-10-22-analysis-models-32k.json) and
[2026-10-22-analysis-models-effort.json](2026-10-22-analysis-models-effort.json).
