# Automatic study analysis

Supported live studies automatically request analysis after each recording finishes. Findings remain
separate from participant feedback and the recorded study verdict.

The default is `gpt-6-astra` with high reasoning effort, a separate $3 admission
estimate limit, a 300-second timeout and 16,384 output tokens. To customize it:

```yaml
review:
  analysis:
    maxCostUsd: 3
    # Optional; these values match manual analysis defaults.
    model: gpt-6-astra
    timeoutMs: 300000
    maxOutputTokens: 16384
    # question: Where did participants need to recover?
```

Omitting `review.analysis` uses these defaults. Set `review.analysis: false` to
run participants without the additional analysis request. An explicit analysis
mapping requires `maxCostUsd`. This limits an admission estimate, not the
provider's final bill, and is separate from participant spending limits. Analysis
sends selected retained text and captures to OpenAI using `OPENAI_API_KEY`.
Analysis runs in the Humanish runner using its credentials. This setting adds no
credential channel to the target application; each participant backend retains
its existing authentication boundary. Review the separate analysis budget before running a manifest live; an actor's
zero-dollar cap does not cap post-run analysis. The bundled first-contact
zero-spend product fixture explicitly disables analysis.

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

CLI live starts disclose the separate admission estimate limit before execution.
`humanish lab preflight <lab> --json` and the TUI lab screen also expose the
resolved budget without dispatching analysis. Library callers can inspect
`resolveAutomaticAnalysis` or `automaticAnalysisBudget` before running.

The command waits for analysis and reports its separate state. A TUI-launched
runner continues after the TUI closes; reopening the TUI or Observer reads the
existing job and does not start another request. Concurrent or repeated automatic
invocations cannot silently retry a paid attempt. If a process disappears while
an attempt is in flight, its state can be unknown rather than falsely complete.
Use manual `humanish analyze --run <exact-run-id> --max-cost 3` for an intentional
follow-up after inspecting the existing attempt and its accounting.

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
