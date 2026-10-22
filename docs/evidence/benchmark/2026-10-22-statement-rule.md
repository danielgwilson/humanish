# Participant statements that cite captures, 2026-10-22

This follow-up to [gpt-6-luna with low text verbosity](2026-10-22-luna-verbosity.md) reruns
`gpt-6-luna` at high effort and `gpt-6.1-sol` at medium effort, the default analyst, after one
validation rule changed. It uses the same saved recordings as the two earlier reports.

## What changed in humanish

An observation with basis `participant_statement` now needs at least one quote-eligible citation
and may also cite captures or actions (`src/analysis/validation.ts`). Before, any citation that was
not quote-eligible failed the whole analysis with `analysis_validation_failed_statement_source_invalid`.
The prompt is now `study-evidence-9`. It says a statement may cite the captures or actions the
participant was speaking about, and it tells the analyst to label its own judgment `inference`.
humanish still sends `gpt-6-luna` `text.verbosity: "low"` and sends `gpt-6.1-sol` the default.

## How it ran

Every analysis ran from a build of commit `3ca0fdc6e`, on fresh copies of the earlier work
directories. The four sets ran one after another and never overlapped: Taskly with `gpt-6-luna`,
the movie game with `gpt-6-luna`, Taskly with `gpt-6.1-sol`, then the movie game with
`gpt-6.1-sol`. Taskly ran 8 analyses at once. The movie game ran one analysis per run, 3 at once.
The earlier report ran all its settings in overlapping windows, up to 19 analyses at once.

## Taskly

The 8 recordings from the first report, each analyzed 3 times per setting with `pnpm bench
--reanalyze --analysis-repeats 3 --analysis-concurrency 8 --analysis-max-output-tokens 32768`.
Recall uses rubric version 2. Time is the median wall time of the bench's `humanish analyze` call,
and tokens per second is the median of each analysis's output tokens over its wall time, as in the
earlier report. The `study-evidence-8` rows are from that report.

| Analyst | Prompt | Scored | Recall | Invented | False assurance | Cost per analysis | Median time | Output tokens/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `gpt-6-luna`, high | `study-evidence-8` | 20/24 | 31/55 | 0 | 0 | $0.008 | 110 s | 117 |
| **`gpt-6-luna`, high** | **`study-evidence-9`** | **22/24** | **27/50** | **0** | **0** | **$0.007** | **111 s** | **105** |
| `gpt-6.1-sol`, medium | `study-evidence-8` | 24/24 | 35/60 | 0 | 0 | $0.060 | 97 s | 37 |
| **`gpt-6.1-sol`, medium** | **`study-evidence-9`** | **22/24** | **34/60** | **0** | **0** | **$0.061** | **71 s** | **54** |

The analyses that were not scored, by code:

| Analyst | Prompt | Not scored |
| --- | --- | --- |
| `gpt-6-luna`, high | `study-evidence-8` | 2 `statement_source_invalid`, 2 `analysis_admission_estimate_exceeded` |
| `gpt-6-luna`, high | `study-evidence-9` | 1 `quote_invalid`, 1 `analysis_admission_estimate_exceeded` |
| `gpt-6.1-sol`, medium | `study-evidence-8` | none |
| `gpt-6.1-sol`, medium | `study-evidence-9` | 2 `participant_coverage_invalid` |

No analysis in this report failed with `statement_source_invalid`.

The `analysis_admission_estimate_exceeded` analysis passed every evidence check. It billed
$0.0124 against a cap of $0.0121, so humanish marked it partial and the bench did not score it.
Counting it, 23 of 24 `gpt-6-luna` analyses passed the evidence checks.

The `quote_invalid` analysis quoted "while Completed filter displayed unfinished tasks" where the
participant wrote "while the Completed filter displayed unfinished tasks".

Both `gpt-6.1-sol` rejections are on clean recordings with one participant. Each listed that
participant twice, the second time as "Structured source record only" with no evidence. In the
first report, `gpt-6.1-sol` at high effort failed 2 of 24 the same way. At medium effort it had passed all 72 earlier
analyses, 24 of them with low verbosity.

D1 and D5 appear in the evidence of the third and fourth planted recordings only. Of the
`gpt-6-luna` analyses scored on those recordings, D1 was in 4 of 4 and D5 in 3 of 4. Of the
`gpt-6.1-sol` analyses, D1 was in 5 of 6 and D5 in 5 of 6. Every scored planted analysis from
both analysts reported D3 and D4, and none reported D2.

17 of the 23 `gpt-6-luna` outputs that passed the evidence checks, and 17 of the 22 such
`gpt-6.1-sol` outputs, have a statement observation that cites a capture or action. Under the
earlier rule each of those would have failed. No `gpt-6.1-sol` analysis failed that rule under
`study-evidence-8`, so the new prompt text changes what both analysts cite.

`gpt-6.1-sol` ran faster here than in the earlier report, 71 s against 97 s, with fewer analyses
in flight. Its median output was 3,950 tokens against 3,780. The two windows differ in
concurrency and in time of day, and this report does not separate the two.

## Movie game

The three runs of a public movie-guessing web game the maintainer built, from the first report,
each analyzed twice per setting with `humanish analyze --rerun --max-cost 10 --max-output-tokens
32768`.

| Analyst | Prompt | Completed | Cost per analysis | Median time | Not completed |
| --- | --- | --- | --- | --- | --- |
| `gpt-6-luna`, high | `study-evidence-8` | 4/6 | $0.010 to $0.023, mean $0.016 | 188 s | 2 `statement_source_invalid` |
| **`gpt-6-luna`, high** | **`study-evidence-9`** | **5/6** | **$0.012 to $0.022, mean $0.016** | **233 s** | 1 `participant_reference_invalid` |
| `gpt-6.1-sol`, medium | `study-evidence-8` | 6/6 | $0.08 to $0.29, mean $0.17 | 184 s | none |
| **`gpt-6.1-sol`, medium** | **`study-evidence-9`** | **6/6** | **$0.08 to $0.28, mean $0.17** | **156 s** | none |

The rejected `gpt-6-luna` output, on the first run, cited every evidence entry with a short id
such as `e003` for `e000003`. None of its citations resolved, so it broke ten rules at once,
`statement_source_invalid` among them.

### Findings compared with the control

Each valid `gpt-6-luna` analysis was compared with both `gpt-6.1-sol` analyses of the same run,
problem by problem, design findings included. Every problem one analyst named and the other did
not was checked against the run bundle: the participant's messages and reasoning, and the
screenshots.

- On all three runs, `gpt-6-luna` named every problem a participant reported in a message.
- On the first run it named all 7 problems both control analyses named. One control analysis
  also named the phone layout's black space. The screenshots show it, and no participant on that
  run mentioned it.
- On the second run, neither `gpt-6-luna` analysis named four problems that only screenshots
  show: "Map" as the picker's label, the phone layout's black space, the search field moving when
  a film is selected, and a badge covering a film's year. Both control analyses named the first
  two, and one named each of the others. No participant on that run reported any of the four.
  Both control analyses also named a search that returned no match. One `gpt-6-luna` analysis
  reviewed that concern and marked it unsupported, though the capture it cites shows "0 matches".
- On the third run, neither `gpt-6-luna` analysis named two problems both control analyses named:
  the search field moving when a film is selected, and Daily clue frames shrinking after the first
  try. One control analysis also named a cut-off film title on the phone recap. All three are in
  the screenshots, and no participant reported them. Both control analyses named the no-match
  search for "The Boss Baby" as a finding, and one `gpt-6-luna` analysis kept it as an unsupported
  concern.
- `gpt-6-luna` named three problems the control did not: "Searching..." shown while a matching
  film is already on screen, no keyboard cue on the Daily results, and the phone participant's
  report that the separate select-and-confirm step felt slow. All three are in the bundle.
- One `gpt-6-luna` finding on the first run says all three participants reported the separate
  confirm step as extra effort. Two did. The third described a keyboard problem with the same
  step.
- One `gpt-6-luna` finding on the second run says the reported preselected-film worry is not
  confirmed by the capture it cites. That capture shows the film the participant had just typed.
  Two screenshots outside the 40 captures the analyst received show an unrelated film ready to
  confirm.

Every other finding from either analyst matched the bundle. Counted by run, the problems that
both control analyses named and `gpt-6-luna` did not were 0, 3 and 3. Two on each run are visible
only in screenshots. The third on each run is a no-match search, which one `gpt-6-luna` analysis
of that run reviewed and marked unsupported.

### Statement observations that cite a capture or action

Of the 89 statement observations in the 5 valid `gpt-6-luna` analyses, 37 cite a capture or
action. Of the 98 in the 6 `gpt-6.1-sol` analyses, 24 do. Each of the 11 analyses has at least
one, so each would have failed the earlier rule. All 61 were read by hand, with every cited
screenshot opened.

| Analyst | Observations | Extra citations all support the quote | Some citation partly supports it or is unrelated | A citation contradicts the quote |
| --- | --- | --- | --- | --- |
| `gpt-6-luna`, high | 37 | 26 | 10 | 1 |
| `gpt-6.1-sol`, medium | 24 | 16 | 6 | 2 |

On the third run, every partial citation shows the moment after the one the participant
described, such as the "+5,000" screen after a reported zero score. Five `gpt-6-luna` citations on the second run show
something unrelated to the quote: another participant's screen, a geometry warning or a later
round.

All three contradicting citations are the same capture on the first run. A participant's
reasoning said the frame timestamp always showed zero, and that capture shows 106:27. Each analyst
cited it in a concern review it marked unsupported.

What each claim reports:

| Analyst | A participant's message | A message plus a visual claim | Only the participant's reasoning | Analyst judgment |
| --- | --- | --- | --- | --- |
| `gpt-6-luna`, high | 20 | 10 | 7 | 0 |
| `gpt-6.1-sol`, medium | 11 | 9 | 4 | 0 |

No observation from either analyst labels the analyst's own judgment as a participant statement.
Evidence entries of kind `reasoning` are quote-eligible, so a claim drawn only from a
participant's private reasoning passes as a statement. 11 of the 61 do that. In 7 more, 2 from
`gpt-6-luna` and 5 from `gpt-6.1-sol`, the statement half of a mixed claim rests on reasoning
alone for at least one participant.

## Not verified

- This is one window per analyst on 2026-10-22. Run-to-run spread with the new prompt is not
  measured beyond 3 Taskly repeats and 2 movie-game repeats.
- The speed differences from the earlier report mix concurrency and serving variation.
- Whether `study-evidence-9` causes the `gpt-6.1-sol` `participant_coverage_invalid` rejections is
  not established. They match the earlier high-effort failures.
- The movie-game comparison and the statement reading were done by hand, by one reader per run.
- The movie-game analysts saw 40 captures per run. Problems outside those captures were not
  searched for.
- `DEFAULT_ANALYSIS_MODEL` is unchanged.

The scored Taskly results are in
[2026-10-22-statement-rule-luna.json](2026-10-22-statement-rule-luna.json) and
[2026-10-22-statement-rule-sol.json](2026-10-22-statement-rule-sol.json). Their `humanish` field
names the build that recorded the participants; the analyses ran from `3ca0fdc6e`.
