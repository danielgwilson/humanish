# Automatic study analysis

Supported live studies automatically request analysis after each recording finishes. Findings remain
separate from participant feedback and the recorded study verdict.

A study that declares no `review.analysis` gets its analyst from its participant (`actor`). A
Codex `local-agent` participant, on a local or hosted desktop, gets the Codex account analyst
described below, so a study run on a signed-in Codex needs no OpenAI API key for its findings.
Every other participant, including a Claude Code `local-agent` participant, gets the OpenAI
analyst. humanish never moves a study to the other analyst because a key is missing: the account
that pays for analysis is the one the study names or its participant implies.

The OpenAI default is `gpt-6.1-sol` at medium reasoning effort (`review.analysis.reasoningEffort`
sets another), a separate $10 cap on its
expected cost and a 600-second timeout. A study or command that names a model but no effort runs
that model at high; only the default analyst, with no model named, runs at medium. On the same
recordings it matched `gpt-6-astra` at high, the earlier default, at about one seventh of the cost
([analysis models on fixed recordings](https://github.com/danielgwilson/humanish/blob/main/docs/evidence/benchmark/2026-10-22-analysis-models.md)). When no output limit is specified,
humanish sizes it to the analysis: at low or medium effort, 12,288 tokens plus 2,048 per
participant (14,336 for one), and 32,768 at high effort, on Gemini and past 16 participants. An
allowance above 16,384 that the cap would refuse falls back to 16,384, so a study its cap admitted
before stays admitted ([output limit](../contracts/study-analysis.md#invocation)). A
request that runs out of output is sent once more while the cap admits it. To customize it:

```yaml
review:
  analysis:
    maxCostUsd: 10
    # Optional overrides. Omit maxOutputTokens for a limit sized to the analysis.
    # A named model without reasoningEffort runs at high.
    model: gpt-6.1-sol
    reasoningEffort: medium
    timeoutMs: 600000
    # maxOutputTokens: 32768
    # question: Where did participants need to recover?
```

Omitting `review.analysis` uses these defaults for any participant other than a Codex
`local-agent`. Set `review.analysis: false` to
run participants without the additional analysis request. An explicit analysis
mapping using the default OpenAI API provider requires `maxCostUsd`. Admission
refuses the request when both its worst case and its expected cost plus a 10% margin are over
it; it does not limit the provider's final bill, and it is separate from participant spending limits. The
estimate gives two numbers: the expected cost, and the worst case if the analyst
spends its whole output allowance. `humanish study check` gives the expected cost
range for the study's participant count, from a run that keeps no evidence to one
that keeps the most evidence admission admits under the cap, at most the evidence limits. When
the cap admits no analysis at all, it says so instead. A study of more than 16 participants is
analysed in cohorts of at most 16, one request each, and one more request merges their reports;
the range covers every request and the analysis line names them (see
[runs with more than 16 participants](../contracts/study-analysis.md#runs-with-more-than-16-participants)).
The default $10 cap admits the default analyst up to the evidence limits: a single request at
$0.76 expected for one participant and $0.91 for 16, and 17 to 40 participants at $0.92 to $3.24
from no evidence to the limits. Admission expects 13,000 output tokens for one participant at any
effort; on 24 Taskly analyses `gpt-6.1-sol` at medium wrote a mean 3,747 and cost a mean $0.06.
`gpt-6-astra` at high expects $3.79 for one participant at the limits and $4.60 to $7.05 for 17 to
40 with no evidence, so a run that keeps more evidence can be refused, and its skip names the
`--max-cost` that admits it. Use `analyze --dry-run --max-cost <usd>` on retained
evidence to inspect the expected cost, the worst case and the selected token
allowance before deliberately choosing a larger budget. Explicit
`maxOutputTokens` and `--max-output-tokens` limits are honored exactly. The output allowance
includes reasoning as well as the report; a request that exhausts it has no usable report. It
is sent once more when the spend so far and admission's figure for one more request fit the cap,
and the CLI says so under the analysis line; the attempt's usage counts both requests. Analysis
sends selected retained text and captures to OpenAI using `OPENAI_API_KEY`, or to Google with
`provider: gemini`.
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
remain untested until a request. An omitted provider means this analyst for a Codex
`local-agent` participant on any target, and OpenAI for every other participant. This setting
does not enable managed local desktops.

To use Google's Gemini API for the separate analyst:

```yaml
review:
  analysis:
    provider: gemini
    model: gemini-3.8-flash
    maxCostUsd: 2
```

Gemini analysis sends the same evidence packet and captures to Google, at the high thinking level
unless the study declares a `reasoningEffort`,
with each capture at high media resolution. It reads `GEMINI_API_KEY`, which `humanish keys set
gemini` stores, and `GOOGLE_API_KEY` only when `GEMINI_API_KEY` is unset. Key discovery treats
the two names as one key: a project's `.humanish/local/provider.env` or the user store never adds
one while the other is already in the environment. A missing Gemini key skips the analysis
(`AUTOMATIC_ANALYSIS_GEMINI_KEY_MISSING`); the OpenAI key is never used in its place. Admission,
`maxCostUsd`, `maxOutputTokens` and priced usage work as they do on OpenAI, at the paid-tier
rates in `src/run/pricing.ts`; requests made with a free-tier key bill nothing, and Google's
terms let it use free-tier content to improve its products. The supported model is
`gemini-3.8-flash`, the one with a completed live analysis.

The same configuration works through `humanish run <study>`,
`watch <study>`, and TUI live starts. Direct library calls to the five recording
producers honor it too. Supported routes are computer-use, scripted-browser,
terminal-product and shared-world. The synthetic route
never enables analysis by default and rejects an explicit analysis mapping
before execution. `false` is accepted on every route. Dry runs show analysis
as skipped, without reading analysis credentials or making a provider request.

Automatic analysis starts when the run ends: every participant has stopped and the run has
published its bundle (`run.json` with an outcome, and `status.json` state `finished`). It runs in
the same process, so `humanish run` returns only after it. A participant who was blocked or
interrupted can still have useful retained evidence; analysis requires a verified live recording
whose participant streams all ended, not a successful participant outcome. An active, missing or
invalid recording is not analyzed. Default analysis also skips recordings containing only setup
or failure records with no retained participant activity. A desktop startup failure does not
start an analysis request. The original failure remains visible.

While analysis runs, the run reads as analyzing. `status.json` records `analysis.startedAt` and
its heartbeat keeps refreshing `updatedAt`; `humanish runs` lists the run as `passed, analyzing`
(or its other result); the TUI adds `analyzing` to the run; the served Observer shows **Writing
findings** in its status band and the Findings tab in a pending state with how long ago analysis
started; `humanish review` says the analysis is running and when it started. In a terminal, `run`
prints `Participants finished. Writing findings; this usually takes 1 to 4 minutes.` to stderr,
then `Still writing findings: <elapsed> elapsed.` every 20 seconds. With `--json` it prints only
the first line, on stderr.

A run whose process ended before it published (a crash, or a refusal after the run started) is
recorded `interrupted` with `reason: no-publish`, and one whose process was killed is marked
`interrupted` by `humanish reclaim`. `humanish analyze` accepts an interrupted run when every
participant stream ended; when one was still running it refuses with
`ANALYSIS_RUN_INCOMPLETE` and names `humanish run <study>`. It refuses a run that is still alive
with `ANALYSIS_RUN_ACTIVE`, and a run whose heartbeat stopped while its pid is still in use with
`ANALYSIS_RUN_UNCONFIRMED`, naming `humanish reclaim --run <id>`. When the process running an
automatic analysis stops before it finishes, `review` says so and names the `analyze` command
that runs it again. That command takes over the run's `.analysis-lock` when the process that
held it is gone, and says so in a warning.

CLI live starts disclose the selected analyst, its expected cost range and cap, or unknown account dollars before execution.
`humanish study check <study> --json` and the TUI study screen also expose the
resolved budget without dispatching analysis. Library callers can inspect
`resolveAutomaticAnalysis` or `automaticAnalysisBudget` before running.

The command waits for analysis and reports its separate state. A TUI-launched
runner continues after the TUI closes; reopening the TUI or Observer reads the
existing job and does not start another request. Concurrent or repeated automatic
invocations cannot silently retry a paid attempt. If a process disappears while
an attempt is in flight, its state can be unknown rather than falsely complete.
Use manual `humanish analyze --run <exact-run-id> --max-cost 10` for an intentional
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
`automaticAnalysisTrigger: "default"` distinguishes that case in JSON. The skip names the next
command: with Codex signed in with a ChatGPT account it is `humanish analyze --run <id>
--provider codex`, and the message names `review.analysis.provider: codex` as the setting that
makes that analyst the study's; otherwise it says to set the key and names `humanish analyze
--run <id> --max-cost 10`. A study analyzed on Gemini names `humanish keys set gemini` and
`humanish analyze --run <id> --provider gemini --model <model> --max-cost 10`. So does a
default analysis whose expected cost, plus the margin, is over the default $10 cap:
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

After a live run the human output ends with the analysis line. When the analysis left findings,
the line gives its state and the top three findings follow, with the `humanish review --run <id>`
command that prints all of them. Otherwise the line says what happened and a `next:` line gives
the command that gets findings, when one can. A dry run keeps its one line,
`analysis: skipped for dry runs`.

`run --json` and `watch --json` carry the same on `automaticAnalysis`: `message`, the sentence the
human line is built from, and `nextCommand`, the command that gets findings or, when the analysis
left them, the `review` command (null when no command can). When the analysis left findings the
JSON also has `findings`:

| Field                | Meaning                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analysisId`         | The analysis the findings come from                                                                                                                |
| `status`             | `complete` or `partial`                                                                                                                            |
| `count`              | How many findings the analysis made                                                                                                                |
| `designFindingCount` | How many design findings it made; null for an analysis written before them                                                                         |
| `top`                | At most five findings, highest priority first: `id`, `title`, `headline`, `impact`, `confidence` and `participants` (the affected participant ids) |
| `review`             | `humanish review --run <id>`, which prints every finding with its evidence                                                                         |
| `observer`           | The run's Observer page opened on the findings (`observer/index.html#/report`); null without an Observer                                           |
| `path`               | analysis.json relative to the project directory                                                                                                    |

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
| `AUTOMATIC_ANALYSIS_GEMINI_KEY_MISSING`       | `skipped`                 | No Gemini API key for a study analyzed on Gemini                      |
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
| `AUTOMATIC_ANALYSIS_STOPPED`                  | `unknown`                 | Read only: the process running it stopped refreshing its job record   |

A run refused before it was created (`run: not-created`) prints no `analysis:` line, since there
is no run to analyze and the refusal says why. Its JSON keeps the record, with
`AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE`, or `AUTOMATIC_ANALYSIS_DRY_RUN` for a dry run.

See the [analysis contract](../contracts/study-analysis.md) for selection limits,
evidence validation, actual usage, corrections and share-safe export behavior.
