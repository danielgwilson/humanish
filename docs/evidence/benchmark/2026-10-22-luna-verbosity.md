# gpt-6-luna with low text verbosity, 2026-10-22

This follow-up to [analysis models on fixed recordings](2026-10-22-analysis-models.md) reruns
`gpt-6-luna` after humanish started sending it `text.verbosity: "low"`. It uses the same saved
recordings, with `gpt-6.1-sol` at medium effort, the default analyst, as the control in the same
window. It also rescores every earlier analysis with rubric version 2, which reads more of the
analysts' wordings of D1 and D5.

## What changed in humanish

`src/analysis/models.ts` lists a text verbosity per OpenAI model, and the OpenAI analysis wire
sends it beside the strict `json_schema` format. Only `gpt-6-luna` has one, `low`. Other models
send no `text.verbosity`, which the Responses API reads as `medium`.

The Responses API reference lists `text.verbosity` as `low`, `medium` or `high`, default
`medium`, in the same `text` object as `format`
([responses create](https://developers.openai.com/api/docs/api-reference/responses/create), read
2026-10-22). The reference names no model that refuses it. The deployment checklist says lower
verbosity "means fewer output tokens, so the model generates less and returns output faster"
([deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist),
read 2026-10-22). The structured outputs guide does not mention verbosity. Every `gpt-6-luna` request in
this report, and every `gpt-6.1-sol` request from the scratch build below, sent both fields, and
the API refused none.

## Taskly

The 8 recordings from the first report, each analyzed 3 times per setting with `pnpm bench
--reanalyze`, at a 32,768-token output limit. Recall is scored with rubric version 2 for every
row, including the earlier ones. Time is the median wall time of the bench's `humanish analyze`
call over all 24 analyses, and tokens per second is output tokens over that wall time; the
earlier rows are recomputed the same way, so their times differ slightly from the first report.

| Analyst | Verbosity | Output limit | Scored | Recall | Invented | False assurance | Cost per analysis | Median time | Output tokens/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `gpt-6-luna`, high | default | 16,384 | 15/24 | 20/40 | 0 | 0 | $0.008 | 479 s | 29 |
| `gpt-6-luna`, high | default | 32,768 | 18/24 | 20/40 | 0 | 0 | $0.007 | 406 s | 30 |
| **`gpt-6-luna`, high** | **low** | 32,768 | **20/24** | **31/55** | **0** | **0** | **$0.008** | **110 s** | **117** |
| `gpt-6-luna`, medium | default | 16,384 | 12/24 | 24/40 | 0 | 0 | $0.004 | 41 s | 125 |
| `gpt-6-luna`, medium | low | 32,768 | 15/24 | 24/40 | 0 | 0 | $0.004 | 80 s | 63 |
| `gpt-6.1-sol`, medium | default | 16,384 | 24/24 | 36/60 | 0 | 0 | $0.059 | 110 s | 37 |
| `gpt-6.1-sol`, medium (control) | default | 32,768 | 24/24 | 35/60 | 0 | 0 | $0.060 | 97 s | 37 |
| `gpt-6.1-sol`, medium | low | 32,768 | 24/24 | 34/60 | 0 | 0 | $0.055 | 63 s | 52 |

The analyses that were not scored, by code:

| Analyst | Verbosity | Output limit | Not scored |
| --- | --- | --- | --- |
| `gpt-6-luna`, high | default | 16,384 | 9 `analysis_output_incomplete` |
| `gpt-6-luna`, high | default | 32,768 | 5 `analysis_timeout`, 1 `statement_source_invalid` |
| `gpt-6-luna`, high | low | 32,768 | 2 `statement_source_invalid`, 2 `analysis_admission_estimate_exceeded` |
| `gpt-6-luna`, medium | default | 16,384 | 12 `statement_source_invalid` |
| `gpt-6-luna`, medium | low | 32,768 | 9 `statement_source_invalid` |
| `gpt-6.1-sol` rows | either | either | none |

The two `analysis_admission_estimate_exceeded` analyses passed every evidence check. They billed
$0.0115 and $0.0121, just over the bench's per-analysis cap of $0.0114 and $0.0117, which is the
admitted cost `humanish analyze --dry-run` reported, so humanish marked them partial. A study's
own analysis has a $10 cap, which these would not reach. Counting them, low verbosity validated
22 of 24 `gpt-6-luna` analyses at high effort.

Every scored planted `gpt-6-luna` analysis at high effort with low verbosity reported D3 and D4
(11 of 11 each). It reported D1 in 4 and D5 in 5. The `gpt-6.1-sol` control reported D1 and D5 in
6 of its 12 planted analyses each. D1 and D5 appear in the evidence of two planted recordings only,
so their ceiling is 6 of 12. No analyst reported D2.

The speed-up is on `gpt-6-luna` at high effort: its median call fell from 406 s to 110 s, and its
slowest from 602 s, the timeout, to 167 s. Median output stayed about the same, 13,022 tokens
before and 13,032 after, so the time saved is decode speed and the output did not get shorter.
At medium effort, low verbosity halved the decode speed and doubled the time, from 41 s to 80 s.

`gpt-6.1-sol` with low verbosity ran from a scratch build of this branch that also lists
`gpt-6.1-sol: "low"`, concurrently with the control. It wrote a median 3,264 output tokens against
the control's 3,780, ran in a median 63 s against 97 s, and recalled 34 of 60 against 35 of 60.
On the movie game it completed 6 of 6 in a median 158 s against the control's 184 s. humanish
still sends `gpt-6.1-sol` the default verbosity: these are two sets of recordings in one window,
and its findings with low verbosity were not graded.

## Movie game

The three movie-game runs from the first report, each analyzed twice per setting with
`humanish analyze --rerun --max-cost 10 --max-output-tokens 32768`. Earlier rows are from the first
report; `gpt-6-luna` at high effort did not run on the movie game before.

| Analyst | Verbosity | Completed | Cost per analysis | Median time | Not completed |
| --- | --- | --- | --- | --- | --- |
| **`gpt-6-luna`, high** | **low** | **4/6** | **$0.010 to $0.023, mean $0.016** | **188 s** | 2 `statement_source_invalid` |
| `gpt-6-luna`, medium | default | 1/6 | $0.010 | 86 s | 2 `statement_source_invalid`, 2 `participant_reference_invalid`, 1 `design_membership_invalid` |
| `gpt-6-luna`, medium | low | 1/6 | $0.010 | 172 s | 5 `statement_source_invalid` |
| `gpt-6.1-sol`, medium | default | 6/6 | $0.08 to $0.29, mean $0.17 | 191 s | none |
| `gpt-6.1-sol`, medium (control) | default | 6/6 | $0.08 to $0.29, mean $0.17 | 184 s | none |
| `gpt-6.1-sol`, medium | low | 6/6 | $0.08 to $0.27, mean $0.17 | 158 s | none |

The four completed `gpt-6-luna` high-effort analyses cover all three runs. They name the problems
the control names on the same run: "Map" as the movie picker's label, Enter not submitting a
guess, the separate confirm step, the unexplained score and "beat 27%", slow transitions, the
phone layout's black space, unrelated search results and accidental picks. One of them, on the
second run, names neither "Map" nor the phone layout; both control analyses of that run name both.
This comparison reads finding titles against the control's; it was not checked against the
recordings again.

## Statement-source failures

`analysis_validation_failed_statement_source_invalid` refuses an observation with basis
`participant_statement` that cites any item that is not a quotable participant statement. The
rejected outputs humanish keeps in `.humanish/analysis-diagnostics` (at most 20 per project) were
replayed through `checkAnalysisResult` from this branch's build. The replay reproduced the recorded
error set for every one. Two other rules were then tried without changing `validation.ts`:

- Rule A accepts a statement observation that cites at least one quotable statement among others.
- Rule B drops the non-quotable citations from statement observations and validates again.

| Recordings | Kept rejections with this error | Would pass under A | Would pass under B |
| --- | --- | --- | --- |
| Taskly, before this change | 30 (of 36 recorded) | 30 | 30 |
| Taskly, low verbosity | 11 | 11 | 11 |
| Movie game, before this change | 17 | 11 | 11 |
| Movie game, low verbosity | 7 | 6 | 6 |

The movie-game outputs that fail under both rules also break another rule, such as
`design_membership_invalid` or `participant_reference_invalid`. Of the 49 offending Taskly
observations before this change, all 49 were in `concernReviews` and all cited a quote beside the
extra items: 70 screenshots and 26 UI actions.

Eleven offending observations read by hand, six from Taskly and five from the movie game:

- In 6, the claim reports only what the participant said, and the extra screenshot or click shows
  the screen or action they spoke about. One example: "The participant reported hesitation because
  the inline editor showed Save but no Cancel", citing the participant's message and a capture of
  that editor.
- In 3, the claim joins a statement and a visual observation in one sentence, such as "the
  participant reported that the task name reverted ... captures show the changed text followed by
  the original text". Each half has its own support.
- In 2, both from Gemini on the movie game, the claim is the analyst's judgment ("Mandatory
  two-step confirmation adds repetitive friction to every movie guess"), so `inference` was the
  right basis.

In none of the eleven did an extra citation contradict the statement.

The rule now accepts a statement that cites at least one quote. The rerun under that rule is in
[participant statements that cite captures](2026-10-22-statement-rule.md).

## Rubric version 2

Rubric version 1 matched D5 only where the finding said Save did nothing in a few fixed forms. It
left these unresolved: "Saving the edit left the row in editing mode", "Inline task row remains in
edit mode after clicking Save", "The edited task still showed Save after saving", "Task rename
reverted after two Save attempts" and "Two Save attempts did not retain the edited title". It also
missed "Clear completed left both checked rows visible" and "Completed tasks remained after
repeated clearing attempts" for D1. Version 2 reads those forms. It skips a sentence that names
Enter or a reload, because on the clean build Enter does not save an edit and a reload empties the
list. Over the earlier analyses it added no invented claim. "Save left the row in edit mode"
already matched in version 1.

Recall before and after rescoring, from the same analyses:

| Analyst | Output limit | Version 1 | Version 2 |
| --- | --- | --- | --- |
| `gpt-6-astra`, high | 16,384 | 28/60 | 35/60 |
| `gpt-6-astra`, medium | 16,384 | 23/60 | 33/60 |
| `gpt-6.1-sol`, high | 16,384 | 29/60 | 35/60 |
| `gpt-6.1-sol`, medium | 16,384 | 28/60 | 36/60 |
| `gpt-6-luna`, high | 16,384 | 19/40 | 20/40 |
| `gpt-6-luna`, high | 32,768 | 19/40 | 20/40 |
| `gpt-6-luna`, medium | 16,384 | 22/40 | 24/40 |
| `gpt-6-luna`, low | 16,384 | 17/35 | 19/35 |
| `gemini-3.8-flash`, high | 32,768 | 32/60 | 36/60 |
| `gemini-4-argon`, high | 32,768 | 32/55 | 32/55 |
| `gemini-3.5-flash-lite`, high | 32,768 | 22/50 | 27/50 |
| `gemini-3-flash-preview`, high | 32,768 | 14/30 | 16/30 |

The participants' own reports go from 10 to 11 of 20: one planted report says "after saving an
edit, the row stayed in editing mode with a save button". Invented claims and false assurances are
unchanged for every row.

## Not verified

- The speed effect of low verbosity is not documented by OpenAI. It held on 2026-10-21 in the
  research replay and on 2026-10-22 here, and it may change with OpenAI's serving.
- Taskly is one fixture with 8 recordings. D1 and D5 recall rests on two planted recordings.
- The movie-game comparison reads finding titles; the recordings were not reread for these runs.
- `gpt-6.1-sol` with low verbosity ran from a scratch build only, on Taskly and the movie game.
- The Taskly runs used a 32,768-token output limit where the earlier medium-effort rows used
  16,384. No medium-effort analysis came near either limit.
- All eight Taskly settings and the movie game ran in overlapping windows, up to 19 analyses at
  once. The control ran in the same window as the `gpt-6-luna` rows.

The scored results are in [2026-10-22-luna-verbosity.json](2026-10-22-luna-verbosity.json) and
[2026-10-22-sol-verbosity-low.json](2026-10-22-sol-verbosity-low.json). The earlier results files
are rescored with rubric version 2.
