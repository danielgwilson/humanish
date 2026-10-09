# Automatic study analysis

Supported live studies automatically request analysis after each recording finishes. Findings remain
separate from participant feedback and the recorded study verdict.

The default is `gpt-6-astra` with high reasoning effort, a separate $3 cap on its
expected cost and a 600-second timeout. When no output limit is specified,
humanish selects 32,768 tokens if the exact input's expected cost still fits that
cap; otherwise it keeps the established 16,384-token allowance. This preserves
previously admitted studies without increasing their spending limit. To customize it:

```yaml
review:
  analysis:
    maxCostUsd: 3
    # Optional overrides. Omit maxOutputTokens for budget-aware selection.
    model: gpt-6-astra
    timeoutMs: 600000
    # maxOutputTokens: 32768
    # question: Where did participants need to recover?
```

Omitting `review.analysis` uses these defaults. Set `review.analysis: false` to
run participants without the additional analysis request. An explicit analysis
mapping using the default OpenAI API provider requires `maxCostUsd`. Admission
refuses the request when both its worst case and its expected cost plus a 10% margin are over
it; it does not limit the provider's final bill, and it is separate from participant spending limits. The
estimate gives two numbers: the expected cost, and the worst case if the analyst
spends its whole output allowance. `humanish study check` gives the expected cost
range for the study's participant count, from a run that keeps no evidence to one
that keeps the most evidence admission admits under the cap, at most the evidence limits. When
the cap admits no analysis at all, it says so instead. Use `analyze --dry-run --max-cost <usd>` on retained
evidence to inspect the expected cost, the worst case and the selected token
allowance before deliberately choosing a larger budget. Explicit
`maxOutputTokens` and `--max-output-tokens` limits are honored exactly. The output allowance
includes reasoning as well as the report; exhausting it does not produce a usable
report and never starts an automatic retry. Analysis
sends selected retained text and captures to OpenAI using `OPENAI_API_KEY`.
Analysis runs in the humanish runner using its credentials. This setting adds no
credential channel to the target application; each participant's route keeps
its existing authentication boundary. Review the separate analysis budget before running a manifest live; an actor's
zero-dollar cap does not cap post-run analysis. The bundled first-contact
zero-spend product fixture explicitly disables analysis.

To explicitly use your Codex ChatGPT account for the separate analyst:

```yaml
review:
  analysis:
    provider: codex
    model: gpt-6-astra
    timeoutMs: 600000
```

This requires Linux x64, a stable Codex CLI release from 0.154.0 on (`src/actors/codex/codex-admission.ts`), and a file-backed ChatGPT account login; the analyst
uses low reasoning effort and remote inference. Dollar cost and a provider
enforced output-token ceiling are unknown, so omit `maxCostUsd` and
`maxOutputTokens`. Numeric values are rejected before participant resources are
allocated. There is no API fallback. Missing or unsupported account setup leaves
an explicit failed analysis state and the original recording intact. Use
`humanish doctor --study <study>` for setup checks; account allowance and model access
remain untested until a request. An omitted provider still means OpenAI, including
hosted studies whose participant uses a local Codex or Claude login. This setting
does not enable managed local desktops.

The same configuration works through `humanish run <study>`,
`watch <study>`, and TUI live starts. Direct library calls to the five recording
producers honor it too. Supported routes are computer-use, scripted-browser,
terminal-product and shared-world. The synthetic route
never enables analysis by default and rejects an explicit analysis mapping
before execution. `false` is accepted on every route. Dry runs show analysis
as skipped, without reading analysis credentials or making a provider request.

Participant execution finishes and its recording is finalized before analysis is
queued. A participant who was blocked or interrupted can still have useful
retained evidence; analysis requires a verified live recording, not a successful
participant outcome. An active, missing or invalid recording is not analyzed.
Default analysis also skips recordings containing only setup or failure records
with no retained participant activity. A desktop startup failure does not start
an analysis request. The original failure remains visible.

CLI live starts disclose the selected analyst, its expected cost range and cap, or unknown account dollars before execution.
`humanish study check <study> --json` and the TUI study screen also expose the
resolved budget without dispatching analysis. Library callers can inspect
`resolveAutomaticAnalysis` or `automaticAnalysisBudget` before running.

The command waits for analysis and reports its separate state. A TUI-launched
runner continues after the TUI closes; reopening the TUI or Observer reads the
existing job and does not start another request. Concurrent or repeated automatic
invocations cannot silently retry a paid attempt. If a process disappears while
an attempt is in flight, its state can be unknown rather than falsely complete.
Use manual `humanish analyze --run <exact-run-id> --max-cost 3` for an intentional
follow-up after inspecting the existing attempt and its accounting. For the account branch, use `humanish analyze --run <exact-run-id> --provider codex --rerun` without a dollar limit.

Stopping participant execution does not start a fresh automatic analysis. A
recorded harness cancellation is skipped; ordinary time limits and participant
abandonment remain eligible evidence.

During analysis, Ctrl-C asks the request to cancel. The TUI's **Cancel analysis**
action writes a cancellation request for that recording; it does not signal the
finished participant process. Cancelling cannot undo provider work already
accepted. Known usage is retained; missing usage remains unknown.

The CLI's JSON keeps `runOk` for the route's own result, `automaticAnalysis`
for post-run analysis, and `ok` for the overall request. Failed, cancelled or
unknown analysis produces exit code 2 without discarding the recording. When the
run's own result is ok, the first line of the human output reads
`humanish run <study>: live run finished; the analysis did not complete`. A missing
`OPENAI_API_KEY` skips default analysis and preserves a successful run exit;
`automaticAnalysisTrigger: "default"` distinguishes that case in JSON. So does a
default analysis whose expected cost, plus the margin, is over the default $3 cap:
it is skipped with `AUTOMATIC_ANALYSIS_ADMISSION_REFUSED` and the run exits 0. For
any analysis refused for its cost, the job records the expected cost, the worst
case and the cap, and the CLI, `humanish review` and the Observer give them with
the `humanish analyze --run <id> --max-cost <n>` command that runs it, `n` being
the worst case rounded up. A missing key or an over-cap estimate for an explicitly
configured analysis remains a failed overall request. Every skip is retained for review and does not
retry automatically. Partial
findings remain visibly partial; a valid partial result can succeed, while a
partial result with an analysis error still fails the command. Recorded task
outcomes and the deterministic review verdict are never rewritten by analysis.

`automaticAnalysis.reason` is one of these codes, in `--json` and in the human line
`analysis: <state> (<reason>)`:

| `reason`                                      | `state`                   | Meaning                                                               |
| --------------------------------------------- | ------------------------- | --------------------------------------------------------------------- |
| none (`null`)                                 | `complete`                | Analysis completed                                                    |
| `AUTOMATIC_ANALYSIS_REUSED`                   | that of the reused result | An earlier analysis of this run was reused                            |
| `AUTOMATIC_ANALYSIS_LIMITATIONS`              | `partial`                 | Analysis completed with recorded limitations                          |
| `AUTOMATIC_ANALYSIS_ADMISSION_EXCEEDED`       | `partial`                 | Usage passed the worst case or the cap                                |
| `AUTOMATIC_ANALYSIS_FAILED`                   | `failed` or `partial`     | Analysis failed, or an unexpected error stopped it                    |
| `AUTOMATIC_ANALYSIS_CANCELLED`                | `cancelled`               | Ctrl-C or the TUI's **Cancel analysis** stopped it                    |
| `AUTOMATIC_ANALYSIS_DRY_RUN`                  | `skipped`                 | A dry run records no participant evidence                             |
| `AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE`       | `skipped`                 | This invocation published no run to analyze, or the run id is invalid |
| `AUTOMATIC_ANALYSIS_SOURCE_CHANGED`           | `failed`                  | The run directory changed after the run published its bundle          |
| `AUTOMATIC_ANALYSIS_KEY_MISSING`              | `skipped`                 | No OpenAI API key                                                     |
| `AUTOMATIC_ANALYSIS_NO_PARTICIPANT_EVIDENCE`  | `skipped`                 | A default analysis found no participant evidence                      |
| `AUTOMATIC_ANALYSIS_ACTOR_CANCELLED`          | `skipped`                 | The harness cancelled the participants, or a signal stopped the run   |
| `AUTOMATIC_ANALYSIS_CLEANUP_UNCONFIRMED`      | `skipped`                 | A local VM study could not confirm its cleanup; the command exits 2   |
| `AUTOMATIC_ANALYSIS_ALREADY_REQUESTED`        | `skipped`                 | Another request already claimed this run's analysis                   |
| `AUTOMATIC_ANALYSIS_BUSY`                     | `skipped`                 | Another analysis is running                                           |
| `AUTOMATIC_ANALYSIS_ADMISSION_REFUSED`        | `skipped`                 | The configuration or the cost estimate was refused before any request |
| `AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE`      | `skipped` or `unknown`    | Analysis history or the job record could not be read or written       |
| `AUTOMATIC_ANALYSIS_CODEX_UNAVAILABLE`        | `failed`                  | The Codex analysis provider was unavailable                           |
| `AUTOMATIC_ANALYSIS_PUBLICATION_FAILED`       | `failed`                  | The analysis could not be published                                   |
| `AUTOMATIC_ANALYSIS_CANCELLATION_UNAVAILABLE` | `unknown`                 | A cancellation could not be recorded                                  |
| `AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN`          | `unknown`                 | The outcome could not be determined                                   |

A run refused before it was created (`run: not-created`) prints no `analysis:` line, since there
is no run to analyze and the refusal says why. Its JSON keeps the record, with
`AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE`, or `AUTOMATIC_ANALYSIS_DRY_RUN` for a dry run.

See the [analysis contract](../contracts/study-analysis.md) for selection limits,
evidence validation, actual usage, corrections and share-safe export behavior.
