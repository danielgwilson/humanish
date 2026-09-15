# Automatic study analysis

A lab can request analysis after each live recording finishes. Findings remain
separate from participant feedback and the recorded study verdict.

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

Omit `review.analysis` to leave the existing run behavior unchanged. The budget
is required when analysis is present. It limits an admission estimate, not the
provider's final bill, and is separate from participant spending limits. Analysis
sends selected retained text and captures to OpenAI using `OPENAI_API_KEY`.
The key is never sent to the target application. Review a manifest's opt-in
before running it live.

The same configuration works through `humanish run <lab>`, `lab run <lab>`,
`watch <lab>`, and TUI live starts. Direct library calls to the five recording
producers honor it too. Supported routes are computer-use, scripted-browser,
terminal-product, sequential shared-world and concurrent shared-world. Synthetic,
smoke and meta routes reject the setting before execution. Dry runs show analysis
as skipped, without reading analysis credentials or making a provider request.

Participant execution finishes and its recording is finalized before analysis is
queued. A participant who was blocked or interrupted can still have useful
retained evidence; analysis requires a verified live recording, not a successful
participant outcome. An active, missing or invalid recording is not analyzed.

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
unknown analysis produces exit code 2 without discarding the recording. Partial
findings remain visibly partial; a valid partial result can succeed, while a
partial result with an analysis error still fails the command. Recorded task
outcomes and the deterministic review verdict are never rewritten by analysis.

See the [analysis contract](../contracts/study-analysis.md) for selection limits,
evidence validation, actual usage, corrections and share-safe export behavior.
