# Automatic study analysis

Supported live studies automatically request analysis after each recording finishes. Findings remain
separate from participant feedback and the recorded study verdict.

The default is `gpt-6-astra` with high reasoning effort, a separate $3 admission
estimate limit and a 600-second timeout. When no output limit is specified,
Humanish selects 32,768 tokens if the exact input's admission estimate fits that
budget; otherwise it keeps the established 16,384-token allowance. This preserves
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
mapping using the default OpenAI API provider requires `maxCostUsd`. This limits an admission estimate, not the
provider's final bill, and is separate from participant spending limits. Analysis
can decline a large study before dispatch when its conservative estimate exceeds
that limit. Use `analyze --dry-run --max-cost <usd>` on retained evidence to inspect
the estimate and selected token allowance before deliberately choosing a larger budget. Explicit
`maxOutputTokens` and `--max-output-tokens` limits are honored exactly. The output allowance
includes reasoning as well as the report; exhausting it does not produce a usable
report and never starts an automatic retry. Analysis
sends selected retained text and captures to OpenAI using `OPENAI_API_KEY`.
Analysis runs in the Humanish runner using its credentials. This setting adds no
credential channel to the target application; each participant backend retains
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

This requires Linux x64, qualified Codex CLI `0.154.0`, and a file-backed ChatGPT account login; the analyst
uses low reasoning effort and remote inference. Dollar cost and a provider
enforced output-token ceiling are unknown, so omit `maxCostUsd` and
`maxOutputTokens`. Numeric values are rejected before participant resources are
allocated. There is no API fallback. Missing or unsupported account setup leaves
an explicit failed analysis state and the original recording intact. Use
`humanish doctor --lab <lab>` for setup checks; account allowance and model access
remain untested until a request. An omitted provider still means OpenAI, including
hosted studies whose participant uses a local Codex or Claude login. This setting
does not enable managed local desktops.

The same configuration works through `humanish run <lab>`, `lab run <lab>`,
`watch <lab>`, and TUI live starts. Direct library calls to the five recording
producers honor it too. Supported routes are computer-use, scripted-browser,
terminal-product, sequential shared-world and concurrent shared-world. Synthetic,
smoke and meta routes never enable analysis by default and reject an explicit
analysis mapping before execution. `false` is accepted on every route. Dry runs show analysis
as skipped, without reading analysis credentials or making a provider request.

Participant execution finishes and its recording is finalized before analysis is
queued. A participant who was blocked or interrupted can still have useful
retained evidence; analysis requires a verified live recording, not a successful
participant outcome. An active, missing or invalid recording is not analyzed.
Default analysis also skips recordings containing only setup or failure records
with no retained participant activity. A desktop startup failure does not start
an analysis request. The original failure remains visible.

CLI live starts disclose the selected analyst and its separate admission estimate limit or unknown account dollars before execution.
`humanish lab preflight <lab> --json` and the TUI lab screen also expose the
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

The CLI's JSON keeps `runOk` for the original backend result, `automaticAnalysis`
for post-run analysis, and `ok` for the overall request. Failed, cancelled or
unknown analysis produces exit code 2 without discarding the recording. A missing
`OPENAI_API_KEY` skips default analysis and preserves a successful run exit;
`automaticAnalysisTrigger: "default"` distinguishes that case in JSON. A missing
key for an explicitly configured analysis remains a failed overall request.
Either skip is retained for review and does not retry automatically. Partial
findings remain visibly partial; a valid partial result can succeed, while a
partial result with an analysis error still fails the command. Recorded task
outcomes and the deterministic review verdict are never rewritten by analysis.

See the [analysis contract](../contracts/study-analysis.md) for selection limits,
evidence validation, actual usage, corrections and share-safe export behavior.
