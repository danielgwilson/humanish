# Run Bundle Contract

`humanish.run-bundle.v4` is the evidence contract. The TypeScript shape in `src/run/bundle.ts`
(with `streams[]` in `src/run/streams.ts` and `sharedWorld` as `SharedWorldEvidence` in
`src/run/shared-world-evidence.ts`) and the fail-closed checks in `src/verify/verify.ts` are the
source of truth. This page explains the stable public fields and the extension rules; it does not
version the runtime separately.

Terminal runs record the resolved telemetry setting as `doNotTrack` in
`streams[].actor.runtime` (`humanish.actor-runtime.v1`), also retained in `actor.json`
and `terminal-ledgers.json`. `true` means participant and product setup commands receive
`DO_NOT_TRACK=1`; `false` means humanish leaves it unset. Dry runs record the same boolean
in the JSON message of the `terminal-lab.runtime.declared` event. Older bundles omit it.
The setting does not attest that the studied CLI honors the variable.

## Participant traces

From v2, run.json holds each participant's summary and the trace file holds its items. The run
writer (`src/run/run.ts`, through `splitStreamTraces` in `src/run/stream-trace.ts`) writes, for
each stream with an `actor`:

- the trace file: the actor trace (`humanish.actor-trace.v1`) with every item, plus `artifacts`,
  the stream's screenshot entries, as one line of compact JSON. Its path is the stream's actor trace artifact (`actor.json` for
  one participant, `actors/<stream>.json` for more, `actor-<surface>.json` on the scripted route),
  or `actors/<n>.json`, `n` its position in `streams[]` (from 1), for a stream with none or whose
  trace artifact an earlier stream claimed. Names of that form are never reused as a stream's own
  artifact, so two streams never get one file;
- in run.json, `streams[].actor` without `items`, `streams[].artifacts` without the screenshot
  entries, and the index:

```yaml
trace:
  path: actors/stream-001.json
  bytes: 5480211 # the file's size
  sha256: "<hex digest of the file>"
  items: 23104 # entries in the file's items
  screenshots: 2881 # entries in the file's artifacts
```

run.json keeps every field readers list runs by: each stream's status, judged status,
assignment and geometry, and the actor's status, completion reason, counts, persona, debrief,
impressions, token usage totals and estimated cost. Each trace is written once. From v4 the
per-request lists are only in the trace file ([Per-request lists](#per-request-lists)).

`trace.path` must be one of those trace file names (`actor.json`, `actors/<name>.json`,
`actor-<name>.json`, with `<name>` a plain file name); `isStreamTracePath` in
`src/run/stream-shape.ts` holds the rule, and the writer, the shape check and the loader all use
it. Any other path, such as `observer/index.html`, fails the shape check.

A reader outside humanish loads a run through the package's `loadRunBundle(cwd, run)`, with `run`
a run id or `latest`: it returns run.json with every trace file and live file joined and checked
as below, for v1, v2, v3 and v4 bundles, with each participant's per-request lists, and throws an Error named `StreamTraceRefusedError` for a
file that does not match its index. Inside humanish, readers load a stream through
`loadStreamTrace(runPaths, stream)`. A v1 stream returns as it is.
An indexed stream's file is read under the 32 MiB per-file limit, by analysis as by every other
reader, and refused unless its size, sha256, item count and screenshot count
match the index. A trace or live file whose index records more than the limit is refused before it
is read, and the refusal says the file is larger than humanish reads of one file and that
restoring a copy does not help. A trace file whose index is under the limit and whose bytes are
over it changed after the run wrote it, and its refusal says to restore the run folder from a copy.
A live file may hold bytes past its index while the writer appends; the loader reads only the
indexed bytes. A trace file belongs to one participant: every stream whose index names a file
another stream's index names, compared without case as a case-insensitive file system compares
names, is refused before any file is read. The writer claims names the same way. In a v2 run.json every `actor`
must have an index: an actor with no index, with
or without inline `items`, is refused, and so is one with both an index and inline `items`.
verify reports a refused trace in the `local evidence artifacts exist` check, so the run is
`blocked`. A trace or live file whose index records more than the limit is reported that way too,
unless the file on disk is a single-link regular file verify can open that holds more than 32 MiB.
verify lists such a file under `UNSCANNED_ARTIFACT`, so the run is `local_only`. It adds the
refusal to its warnings and checks that participant without its items. Where the run cites the
file as evidence, verify counts it as present if it is still past 32 MiB when that check reads it;
a citation as a screenshot or recording is still checked as one, so the run is `blocked`. verify also scans the bytes of each trace it loaded with the public-safety text scan,
apart from its walk of the run folder, so no path exemption the walk makes applies to a trace.
run.json's digest, which an analysis record binds, covers each index and so each trace.

Mid-run flushes: the writer indexes every finished participant on every write, flushes included,
so a run.json from v2 on never holds `actor.items`. A participant still working has its items so
far in `streams[].liveActor`. A run.json may carry `liveActor` only while its run has not
finished: one whose `outcome.state` is `finished` and still holds `liveActor` is refused. An
unfinished run.json with `liveActor` (a flush, or the last write of an interrupted run) verifies
as `local_only` with the share-safety reason `RUN_NOT_FINISHED`, never `share_ready`. v1 bundles
keep their earlier behavior.

## Live items

From v3, a running participant's items so far are in a live file, so a flush appends only the
items recorded since the last one instead of rewriting run.json with every item. The run writer
(`liveItemsWriter` in `src/run/live-items.ts`, called from `src/run/run.ts`) keeps, for each
stream with a `liveActor`:

- the live file `live/<position>.<generation>.ndjson`, `position` the stream's place in
  `streams[]` (from 1). Each line is one trace item as JSON, scrubbed of the run's raw sandbox ids
  as it is appended. A live file is never truncated or rewritten;
- in run.json, `liveActor` as `humanish.live-actor.v2`: its summary fields (`updatedAt`,
  `persona`, `tokenUsage`, `ids`, `executionProfile`, `historyTurnsOmitted`, `estimatedCost`, and
  in v3 `providerRequests`) and, in place of `items`, the index of the prefix written so far:

```yaml
liveActor:
  schema: humanish.live-actor.v2
  updatedAt: "<ISO timestamp>"
  itemsFile:
    path: live/1.1.ndjson
    generation: 1
    items: 4210 # lines in the indexed prefix
    bytes: 1048211 # the indexed prefix's size
    sha256: "<hex digest of the indexed prefix>"
```

Each write appends the items past the indexed count, syncs them, then writes run.json, so run.json
never indexes bytes that are not on disk. The sha256 is a running hash, so no write rehashes a
file. The writer starts the next generation, holding the participant's full list, when appending
cannot keep the file equal to that list: the list shrank, an item already written is not the same
object it wrote, an append failed, or a sandbox id the run learned since occurs in the current
generation. Once run.json naming the new generation is written, the writer removes every earlier
one, so at most two generations of a participant exist at once. A failed removal or a failed
run.json write keeps the earlier generations until the next run.json is written, which removes
them. The live flush deep-freezes each item it is handed, so a producer that edits an item after
recording it throws there; a producer records a new item instead.

A write that starts a new generation copies the participant's whole list, as every flush did
before v3. When a participant's generation is replaced on two writes in a row, the run records one
warn event in `events`, type `live-items.rewritten`, with that stream's `streamId`, and keeps it in
every later write. A run records at most one.

`Run.finish` writes the final trace files and run.json, then removes every live file it wrote and
`live/`, so a finished v3 bundle holds no live files and differs from v2 only in its schema name.
A run that ends without its final write (interrupted, or killed) keeps its live files and the
last run.json that indexes them.

Readers load live items through the same loader as traces: `loadStreamTraces` reads exactly the
indexed bytes of the live file (bytes appended after run.json was written are not read), refuses
them unless their size, sha256 and line count match the index and each line is a JSON object,
and returns the stream with `liveActor.items` and without `itemsFile`. It refuses a `liveActor`
schema it does not know, and inline live items (`humanish.live-actor.v1`) in a v3 or v4 run.json. A
reader that cannot read a live file reads run.json again once and loads that bundle instead, since
the writer may have removed a superseded generation, or every live file at finish, after the
reader read run.json. v1 and v2 run.json keep `liveActor.items` inline (`humanish.live-actor.v1`)
and load as before.

Readers that show a run (the Observer server, run detail and the TUI, the review command's
provenance) load traces through the same loader and rules. A participant whose trace the loader
refused shows none of the items run.json or a file supplied for it: its stream carries
`traceUnavailable` with the reason, its Observer timeline a `trace.unavailable` warning, and its
run-detail entry `evidenceUnavailable`. The Observer server reads run.json, and the saved
observer-data.json, under the same 32 MiB limit; past it the server answers 404 with a reason
naming the limit. It reads the saved observer-data.json only while a run has no run.json at all; a run.json that is there and cannot be read, parsed or
used as a bundle answers 404 with the reason, never the saved projection. In safe serving
(`observe --all --safe`) every read is checked against the files admitted with the run's
share_ready verification, so a run.json changed after admission is refused and the admitted
projection is served.
observer-data.json is built from the loaded bundle. From 0.124.0 it leaves out each participant's
trace items, which stay in the traces, and from this release it is `humanish.observer-data.v3`,
which also leaves out each participant's per-request lists (docs/architecture/observer.md).
The Observer page and `observer-feed.json` carry the items as `humanish.observer-items.v2`, each
participant's entry gzip-compressed on its own, so `humanish observe` renders a run whose traces
together pass V8's longest string. It was measured on 25 participants with 30 MiB traces.

## Per-request lists

From v4, three lists that gain one entry per model request are only in each participant's trace
file: `tokenUsage.turns` (each request's usage, with a row of its own ahead of it for a server-side
compaction the request ran), `conversation.requests` (each request's mode and, in
explicit_context, what it carried and whether it was compacted) and `providerRequests` (an account participant's receipt for
each dispatch). Before v4 run.json held a copy of each beside the trace file's, and a flush wrote
every running participant's usage rows into run.json and observer-data.json. A synthetic run of
30 participants making 2,880 requests each, written through the run writer, leaves a run.json of
about 0.1 MB, where the same run with the lists was 16 MB with threaded conversations and 42 MB
with account receipts. `REQUEST_LISTS` in `src/run/stream-trace.ts` names the three paths, and the
writer, the loader and the Observer projection read it.

The writer (`splitStreamTraces`) writes a finished participant's trace file as before, lists
included, and run.json's `streams[].actor` without `items` and without the three lists:
`tokenUsage` keeps its totals and `conversation` its `mode` and `summarizedTurns`.

For a running participant, run.json's `liveActor` holds no `tokenUsage.turns` and no
`providerRequests`. When it has `tokenUsage` and a model id in `ids.model`, the writer prices its
rows before leaving them out and records the figure as `liveActor.estimatedCost`
(`humanish.actor-estimated-cost.v1`, from `estimateActorCostForExecution` in
`src/run/pricing.ts`), in place of any estimate the producer passed. The long-context tier prices
a request by its own input size, so the totals alone can price a long session at under half its
cost. An account participant's estimate is a null figure with the reason
`account_billing_unknown`.

```yaml
liveActor:
  schema: humanish.live-actor.v2
  updatedAt: "<ISO timestamp>"
  tokenUsage: { input: 412000, output: 9100, cachedInput: 380000, cacheWriteInput: 21000 }
  ids: { model: gpt-5.6-sol }
  estimatedCost:
    schema: humanish.actor-estimated-cost.v1
    estimatedCostUsd: 0.4123
    ratesAsOf: "2026-09-03"
    source: "<rate source>"
  itemsFile: { path: live/1.1.ndjson, generation: 1, items: 4210, bytes: 1048211, sha256: "<hex>" }
```

The rows and receipts are written once, in the trace file, when the participant finishes. A run
interrupted before then keeps each running participant's totals, estimate and live file. No file
holds that participant's rows or receipts, including a receipt with `usageComplete: false` or
`cleanup: "unconfirmed"`, so neither the trace path nor `loadRunBundle` recovers them.

The loader joins the lists back for every indexed stream, whatever its version: each list the
trace file holds goes into run.json's `tokenUsage` or `conversation` when run.json has that
object, and `providerRequests` at the actor's top level. A v2 or v3 writer wrote run.json's copy
and the file's from one actor, so their result does not change. A trace file whose `conversation`
has no `requests` list, or that holds one of the three as something other than a list, is
refused.

Which writer rules the loader applies depends on the version run.json declares. A run.json that
breaks one did not come from that version's writer, and the stream is refused before any file is
read:

| Rule                                                        | v1      | v2      | v3      | v4      |
| ----------------------------------------------------------- | ------- | ------- | ------- | ------- |
| Two streams index one trace file                            | refused | refused | refused | refused |
| An actor without a trace index                              | read    | refused | refused | refused |
| `liveActor` in a run whose `outcome.state` is `finished`    | read    | refused | refused | refused |
| Inline live items (`humanish.live-actor.v1`)                | read    | read    | refused | refused |
| One of the three lists in run.json's `actor` or `liveActor` | read    | read    | read    | refused |

A reader that shows a run (`displayedTraces`) shows a refused stream without the lists run.json held
for it, so run detail never prices rows the loader refused. Run detail shows a refused participant's
cost only when run.json records an `estimatedCost` for it, since its totals alone could price under
half of what its rows give. verify checks a running participant's `liveActor.estimatedCost` as it
checks a finished one's: its schema, a `ratesAsOf` date and `source` beside a figure, and a reason
beside a null figure. In a v4 run.json it no longer asks a running account participant for receipts;
the check that account dollars stay unknown still applies, and the run still grades `local_only`
with `RUN_NOT_FINISHED`. verify does not check the receipts of a participant whose trace the loader
refused, in any version: the refusal fails `local evidence artifacts exist`, and from v4 the
receipts are only in that trace.

Compatibility: humanish 0.122.0 and earlier read only v1 and refuse a later run.json by its schema
(`run schema` fails in verify, analysis refuses the source); 0.123.0 and 0.124.0 read v1 and v2
and refuse v3 and v4 the same way. 0.125.0 and 0.126.0 read v1, v2 and v3: their verify fails
`run schema` on a v4 run.json, their analysis refuses it, and their `loadRunBundle` returns null.
Their Observer server and run detail parse run.json without checking its schema and show a v4
run without the lists; the 0.126.0 page refuses an account participant's data without receipts.
This release reads v1, v2 and v3 bundles as they are, with no migration. An exported copy
(`humanish export --format bundle`) is written as v4 whatever the source version.

## Purpose

A run bundle is the durable evidence packet for one harness run. It should be
reviewable by a person, parseable by a tool, and safe to use as the source for
feedback drafts and future public issues.

## Minimum Bundle Shape

```yaml
schema: humanish.run-bundle.v4 # v3, v2 and v1 bundles are still read
runId: "<core run id>"
mode: "dry-run|live"
simCount: 1
createdAt: "<ISO timestamp>"
cwd: "[target-cwd]"
artifactRoot: ".humanish/runs/<run-id>"
study: # optional, additive: which study file produced this run
  id: "<study id>"
  path: "humanish/studies/<study id>.yaml"
  origin: "committed|ignored|explicit"
# Runs saved by 0.108 and earlier also have `lab:`, with the same value as `study:`.
source:
  packageName: "<public package name or null>"
  humanishSource: "present|missing"
  git:
    schema: humanish.git-state.v1
    status: "clean|dirty|missing|unavailable"
    capturedAt: "<ISO timestamp>"
    head:
      shortSha: "<short sha or null>"
      refState: "attached|detached|unborn|unknown"
    changes:
      staged: 0
      unstaged: 0
      untracked: 0
      total: 0
    note: "<public-safe note>"
lifecycle:
  - at: "<ISO timestamp>"
    event: "run.created"
    message: "<public-safe message>"
persona:
  id: "<persona id>"
  name: "<persona name>"
  source: "<persona source>"
  sourceDigest: "<sha256>"
scenario:
  id: "<scenario id>"
  title: "<scenario title>"
  goal: "<scenario goal>"
  source: "<scenario source>"
  sourceDigest: "<sha256>"
simulations: [] # simCount entries, each paired with its streams; `arrival` when the study declares starts
streams: []
events: []
artifacts:
  run: "run.json"
  reviewJson: "review.json"
  reviewMarkdown: "review.md"
  observerData: "observer/observer-data.json"
  events: "events.ndjson"
review:
  schema: humanish.review.v1
  verdict: "contract_proof_only|pass|fail|blocked|timed_out"
outcome: # optional, additive: how the run ended (Run Outcome below)
  state: "finished"
  ok: false
  execution:
    succeeded: false
    failures:
      - kind: "harness|provider-cleanup|provider-policy|sandbox-cleanup|evidence|cap|run"
        message: "<public-safe message>"
    warnings: [] # omitted when empty
redaction:
  status: "passed"
  notes: "<public-safe note>"
adapterScore:
  schema: humanish.adapter-score.v1
  namespace: "<adapter namespace>"
  status: "pass|partial|fail"
  score: 0
  summary: "<public-safe adapter score summary>"
  data: {}
feedbackCandidates:
  - schema: humanish.feedback-candidate.v1
    id: "<stable candidate id>"
    failure_owner: "harness|target-app|actor|environment|unknown"
    evidence:
      - path: "<relative run artifact path>"
        kind: "review|state|log|trace|screenshot|filesystem"
adapterArtifacts:
  - schema: humanish.adapter-artifact.v1
    namespace: "<adapter namespace>"
    label: "<human-readable artifact label>"
    path: "<relative run artifact path>"
    kind: "state|review|log|trace|screenshot|filesystem|summary"
    note: "<public-safe note>"
```

Persisted `run.json` files must not contain absolute local target paths. Runtime
commands may return the caller's working directory in process-local JSON
responses, but durable run bundles use the public-safe `[target-cwd]` marker.

## Run Outcome

`outcome` records how the run ended as an execution. `review.verdict` is what the
participants experienced; `outcome.ok` is the route result's `ok`, which
`humanish run --json` prints as `runOk`. The two differ: a terminal run whose agent passed but whose sandbox
teardown is unproven has verdict `pass` and `ok: false`.

```yaml
# Run.finish published the final bundle.
outcome:
  state: finished
  ok: true
  execution:
    succeeded: true
    failures: []
    warnings: # omitted when empty
      - kind: sandbox-cleanup
        message: "lane-01: Sandbox release is unconfirmed. Reclaim it by recorded id with `humanish reclaim --run <id>`."
---
# The CLI's signal handler stopped the run before it finished.
outcome:
  state: interrupted
  ok: false
  signal: SIGINT # or SIGTERM, SIGHUP
  at: "<ISO timestamp>"
```

`Run.finish` (`src/run/run.ts`) writes `finished` with the route's `ok` and its
execution outcome (`judgeExecution` in `src/run/judge.ts`). Each route's policy in
`OUTCOME_POLICIES` decides which failure kinds fail the run and which only warn.
An Observer that does not render is an `evidence` failure known only after
`run.json` is on disk: `FinishedRun.renderObserver` adds it to `outcome` and to
`status.json` before the route returns, and no Observer page exists that could
show the run without it. Messages pass the same redaction and sandbox id scrub
as the rest of the bundle.

After that write, `Run.finish` replaces each raw sandbox id `sandbox-receipts.ndjson` names in the
run's other text files with its label (`scrubRunSandboxIds` in `src/run/sandbox-ids.ts`). A file
the sweep cannot read, such as a trace past the 32 MiB read limit, may still name a sandbox. The run
still finishes: `Run.finish` writes `run.json` again with a `sandbox-ids.unresolved` warn event that
names each such file and why.

When a signal stops a live run, the handler writes `interrupted` into the last
flushed `run.json`, and every later write of that run keeps it. A run stopped
before its first flush has no `run.json`; its `status.json` is the record.

`outcome` is absent while a run is in progress, when its process died without
writing it, and on runs recorded before the field existed. For those, readers
take liveness from `status.json` and, for an older finished run, its `ok` and
`execution` from `status.json`'s `outcome`. That record is the only copy of an
older run's `ok`; for a run with `outcome` in `run.json`, `status.json` copies it.
The bundle's outcome wins even if the process stopped before updating `status.json`.
Without an outcome or a usable status record naming the run, a bundle with a simulation still
`running` reads as interrupted. A fresh status record keeps an in-progress bundle running.

Every surface that shows whether a run passed calls `runDisplay`
(`src/run/display.ts`) with the run's liveness, verdict and `ok`: the Observer
(`observer-data.json` `run.display`), its run library, the served Observer,
`humanish runs`, `humanish review`, `humanish stats`, the TUI and `review.md`'s
`outcome` line. A run
shows as `passed` only when its verdict is `pass` and its `ok` is not false.

## Host suspensions

The run's status cadence, every 5 s, is also its heartbeat. A wall-clock gap of 30 s or more
between two ticks, or between the last tick and a bundle write, is a host suspension: the machine
slept, or the process was stopped, and every participant loop on it stopped too. The wall clock
counts suspended time on macOS and Linux; Node's timers and `performance.now()` count it on macOS
only. Every bundle write records each suspension as a `host.suspended` warn event, `at` its start,
whose message names its start, end, length and offset into the run (`src/run/host-suspension.ts`).

On a computer-use run, a participant that failed in the harness or at its session time limit, and
was in flight across a suspension, likely failed because of it. So did a participant skipped after
such a failure (the pipeline gate). When any did, the outcome's first failure has
`kind: run` and one sentence, such as "The host was suspended for 6m 5s at +1m; the 34
participant failures after it are likely its effect.", ahead of each participant's own failure.
`review.summary` starts with the same sentence, the attributed participants share one gap line,
and the study result's `hostSuspension` holds the sentence, the participant ids and the
suspensions. Participant records, streams and traces stay as they ended. The other routes record
the events only.

## Recorded session stop causes

An actor trace may include `stopCause` alongside its unchanged `status`,
`completionReason` and verbatim `reason`. Computer-use sessions distinguish
`provider_output_limit`, `provider_token_limit`, `time_limit`, `spend_limit`,
`study_spend_limit`, `adapter_limit`, `provider_incomplete`, `provider_status`,
`provider_refused_prompt`, `harness_aborted`, `usage_unreported`, `scheduled_end`, and `session_cap`. Absence means the route or
recording did not retain this precise field; it does not mean the participant
finished.

`provider_refused_prompt` records that the model provider refused the request
under its usage policy: an error response (OpenAI `400 invalid_prompt`), or a
billed reply that declines, whose usage stays in `tokenUsage` and whose
category, when the provider names one, is in the `provider refused the prompt`
notice. The session ends as `failed` / `actor_error`, not `harness_error`, and
the harness does not send the same prompt again. The provider's refusal message
is not recorded, since it can echo the prompt.

Observer projects this as optional `streams[].ending` with a `cause` and readable
`label`. Older `budget_reached` traces without a recognized machine notice say
“limit reached.” An exact historical provider token-limit notice can
establish a token limit, but cannot distinguish output from context exhaustion.
Participant prose is never used to infer the cause. Study summaries retain the
recorded outcome counts while explaining a cause only when the matching traces
cover that outcome's count.

`adapter_limit` records a library adapter's explicit declaration that a configured
local control limit refused the next request before provider dispatch. It ends
the interactive session as `incomplete` / `budget_reached`; earlier actions,
usage and task observations remain intact. It is not independent transport or
billing attestation, and generic historical errors are not reclassified. See
[the adapter admission contract](adapter-admission.md).

## Participant Assignment

`streams[].assignment` optionally records the original participant-facing assignment:

```yaml
assignment:
  mission: "Try the settings screen."
  focus: "Use the keyboard."
  tasks:
    - id: save-setting
      goal: "Save a setting."
```

`mission` is the authored mission, or the runner's default when omitted. `focus` is the
participant's original instruction when one was supplied. `tasks` contains only the IDs and
goals actually composed into participant instructions; hidden success criteria are excluded.
Computer-use single/fan-out, shared-world, and terminal-product
runners record assignments in dry-run and live bundles. Current shared-world and terminal
prompts do not consume task protocols, so their assignments omit `tasks`.

The snapshot precedes runtime inbox URLs, multiplayer lobby grants, and other access
details. Known provisioned values and secret/path patterns are redacted before persistence,
including initial and incremental live bundles where that runner produces them. It is
assignment evidence, not a copy of the full system prompt, a participant report, or proof
that the participant completed its mission. Dry-run assignments describe what would be sent.

Older bundles and uninstrumented routes may omit `assignment`; consumers must preserve
that absence rather than reconstructing it from `scenario.goal`, `ui.intent`, or narration.
The study-level scenario and actor trace retain their existing meanings. The legacy
first-participant scenario goal and feedback goal copies receive the same known-value
redaction; the actual execution prompt is unchanged. Verification
accepts absence and rejects malformed assignment fields or extra task fields such as criteria.

## Continuous desktop recording

A stream can add `recording` without changing the screenshot/action contract:

```yaml
recording:
  schema: humanish.desktop-recording.v1
  path: recordings/lane-01/desktop.mp4
  mimeType: video/mp4
  startedAt: "2026-09-26T10:00:00.000Z"
  durationMs: 12000
  bytes: 240000
  audioSources: [microphone-input, speaker-output]
  complete: true
```

The stream registers the same path as an artifact with `kind: recording`.
`durationMs` comes from the retained file, not the participant's lifetime.
`complete: false` means the retained media stopped early. Audio sources describe
capture points, not remote delivery; an empty list means screen-only. No recording
field means no retained video, not proof that nothing happened between captures.

Verification checks the local file, declared size, MP4 header and matching artifact
entry without loading the whole video into memory. Raw continuous media makes the
run `local_only` regardless of screenshot redaction. Analysis input remains text
and screenshots. See [desktop recording](https://humanish.dev/docs/desktop-recording).

## Browser network log

A hosted computer-use participant whose study sets `execution.network` and whose browser is
Chrome or Chromium carries `streams[].network`:

```yaml
network:
  schema: humanish.browser-network.v1
  path: network/p1.ndjson
  records: 412
  failed: 3 # records with `failed`
  pending: 2 # records with `pending`
  bytes: 66104
  sha256: "<hex digest of the file>"
  startedAt: "2026-10-16T10:00:07.812Z"
  origins: [https://shop.example]
  complete: true
  omitted: { otherOrigin: 1203, overCap: 0, invalid: 0 }
```

When capture kept at least one request the stream also has `network/<participantId>.ndjson`,
registered in `streams[].artifacts` with kind `log`. The folder is `network/` because "request"
in this contract already means a model request. `path`, `records`, `failed`, `pending`, `bytes`
and `sha256` are absent when no file was written: capture did not start, the file could not be
read, or capture started and kept no request, which is the case with `startedAt` present. They
bind the file as a trace index binds its trace, and verify checks each one. `origins` are
redacted as `items[].page` origins are, and verify reports a record whose origin is not one of
them or the `[REDACTED_URL_PART]` marker. `startedAt` is when capture answered on the launch
page, on the desktop's clock.

Each line of the file is one request hop as a JSON object, sorted by `at`:

| Key              | Meaning                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `at`             | When the request started, as an ISO time on the desktop's clock                                                                                                                                            |
| `turn`           | The turn the request fell in, by the rule below. Absent when no checkpoint screenshot recorded a browser-state read                                                                                        |
| `method`         | `GET`, `HEAD`, `POST`, `PUT`, `DELETE`, `OPTIONS`, `PATCH`, `CONNECT` or `TRACE`; any other method is `OTHER`. Absent on a back-forward record                                                             |
| `origin`, `path` | The address as `items[].page` records it: no query, fragment or user info, and token-shaped or secret-bearing path segments become `[REDACTED_URL_PART]`                                                   |
| `type`           | The lowercase CDP resource type: `document`, `fetch`, `xhr`, `prefetch`, `script`, `image` and the rest of the documented list. Any other value is `other`                                                 |
| `status`         | 100 to 599. Absent when no response arrived                                                                                                                                                                |
| `ms`             | Start to finish, failure or the next hop, in whole milliseconds. Absent when `pending`, on a back-forward record, and when the events arrived after the request finished, as a cross-origin preflight's do |
| `redirect`       | `true`: a 3xx response started this hop. The 3xx itself is the hop before it                                                                                                                               |
| `cache`          | `memory`, `disk`, `prefetch`, `service-worker` or `back-forward`. A `back-forward` record is a page restored from the back-forward cache: `type: document` and no `status`, since no request was sent      |
| `failed`         | The load's error text without its `net::` prefix, such as `ERR_CONNECTION_REFUSED`. `failed` with no `status` means the request failed before any response                                                 |
| `pending`        | `true`: no end was recorded. The request was still open when the file was read, or capture stopped first (`reason: capped` or `holder-stopped`)                                                            |

A request's `turn` is the N of the first `turn-NN` or `turn-NN-after-dwell` screenshot whose
browser-state read came after the request started; requests after the last screenshot carry the
last N plus 1. The read and `at` use the desktop's clock, so a request that turn N's actions
started carries N: the actions run before that screenshot's read. A held turn and a reply cut
off by the output limit take no screenshot, so their requests carry the next screenshot's N.

The file holds no bodies, cookies, header names or values, query strings, fragments or user
info. Requests to origins outside `origins` are counted in `omitted.otherOrigin` and not
written. Absent from the file:

- requests that started before `startedAt`. A desktop participant's capture starts once its
  browser's DevTools answer, several seconds after launch, so most of its first page load is
  missing; a phone-emulated participant's launch page reloads under capture;
- requests from workers, service workers and cross-site iframes, and WebSocket frames;
- a new tab's first request, which can be missing.

Path segments are redacted as `items[].page` redacts them. A run of 16 or more characters is
withheld only when a piece of it mixes letters and digits, so a short code, a long all-digit
invite code or a long all-letter token in a path stays in the file. A segment that names a
sandbox id the run journaled is withheld too, and verify reports a record whose path keeps a
segment these rules withhold. The in-sandbox holder cuts a path longer than 4,096 characters at
its last whole segment within them, and the file keeps at most 1,024 characters of the redacted
path, as `items[].page` does, ending in `[TRUNCATED]` when cut. The file keeps the first 20,000
records, then up to 5,000 more that failed, are pending or have status 400 or above, and stops
before 8 MiB.

`complete: false` comes with `reason`: `no-capture` (capture did not start: a browser other than
Chrome or Chromium, or a holder that could not start it), `not-collected` (the file could not be
read at teardown), `capped` (records past the file's caps, counted in `omitted.overCap`; or the
holder's events file reached 32 MiB, after which requests are absent and counted nowhere) or
`holder-stopped` (the in-sandbox holder stopped during the session: it wrote its exit line, or
its process had exited by teardown, as a holder killed by a signal has). A stream with no `network`
field had capture off, or its participant never started: a dry run, or one skipped before its
desktop was created. Example: `jq -c 'select(.turn==7 and (.failed or .pending or
.status>=400))' network/p1.ndjson` lists what failed in turn 7.

## Hosted Desktop Geometry

Hosted browser streams may carry additive `desktopGeometry` evidence. Its fields keep five
different facts separate:

- `screen.requested`: the E2B/X screen size requested by config;
- `screen.verified`: the screen size measured in-sandbox with `xdpyinfo`;
- `screen.declared`: the device preset the study asked for, present only when it differs from
  `screen.requested` because the rendered width was floored to Chrome's ~500px window minimum.
  `verified` compares the floored number with itself and reports a match, so a matching
  `verified` block is not evidence that the preset width rendered. When `declared` is present,
  it did not: a `mobile` (414) and a `small-mobile` (360) participant both render at 500 and are
  indistinguishable by rendered width;
- `browserWindow`: measured browser bounds after the window-fill attempt; physical X client
  bounds (`source: xwininfo`) take precedence over page-reported outer bounds (`source: cdp`),
  which can reflect mobile emulation. Historical `source: xdotool` bundles remain readable;
  older xdotool versions can double-count decorations in reported coordinates;
- `viewport`: the page's CSS layout viewport and device-pixel ratio measured through CDP on
  Chromium-family hosted browsers.

Before participant actions, hosted computer-use participants check measured X bounds against every
edge of the captured desktop. If a browser is clipped, a bounded move-and-fit correction
remeasures the client origin after each of up to two resize attempts, preserving browser
controls when they fit. A fullscreen fallback remains for minimum-width windows that cannot
fit a narrow desktop. A window that remains clipped, or whose repair
cannot be verified, ends the participant before it acts. A fully contained smaller window
can run. Missing X measurements are explicitly unverified; an emulated CSS viewport cannot
establish physical containment. Final capture observes geometry without resizing the app.

For new hosted-desktop computer-use bundles, `stream.viewport` mirrors the measured
`desktopGeometry.viewport`; it is omitted when runtime measurement is unavailable. It is never
filled from the requested screen size. Dry-run bundles therefore carry the requested screen but
no verified screen, browser bounds, or viewport. Historical bundles remain loadable and may
contain the older requested-screen `stream.viewport` shape without `desktopGeometry`.
Deterministic Playwright-style adapters remain free to declare a viewport that they also render
exactly; this hosted-desktop rule does not change that contract.

## Desktop Files

A hosted computer-use participant's stream carries `desktopFiles` when its study gave it
`participants[].files`: one entry per file confirmed on the desktop before the participant
started, in the order they landed.

```yaml
desktopFiles:
  - as: Downloads/photo.png
    size: 251
    sha256: <64 hex characters>
```

`as` is relative to the desktop user's home folder. `size` is the byte count humanish copied,
which `files.getInfo` on the desktop matched. `sha256` is the digest of those bytes, read on the
host before any sandbox existed. The contents and the `from` path are not recorded. A participant
whose copy failed records the files confirmed before the failure. No `desktopFiles` means no file
was confirmed on that desktop: the study gave the participant none, the run was a dry run, or the
copy failed before the first file was confirmed. A copy that failed records a `warn` event of type
`cua-lab.desktop.files.completed`.

## Participant Time Zone

A computer-use or shared-world participant's stream carries `timeZone`, a tz database name such as
`Europe/London`, when its study gave it one: `participants[].clock.timeZone`, else
`actor.clock.timeZone`. Its turns gave the local time in that zone, and on a hosted desktop its
browser launched with `TZ` set to it. The field records the declared zone, also on a dry run; it is
not read back from the browser. No `timeZone` means the participant had none, and its hosted
browser ran in the desktop's UTC.

## Subject Provenance

`subject` is an optional, additive top-level field: structured provenance for
what the computer-use, shared-world or scripted route actually drove (code pin plus state story). It
is absent on pre-existing bundles and on bundles from routes that have not
adopted it. The field shape, its five sources (`clone`, `app-url`,
`local-tree`, `desktop-cli`, `local-app`), and the `humanish verify` checks that guard it are the
schema doc's job, not this one: see the `subject` entry under
[`schemas.md`](schemas.md#run-bundle). In short, `clone` carries a
`repo`/`commit` pin, `local-tree` carries an `archiveSha256`/`dirty` pin
instead (a dirty working tree cannot be commit-pinned), `desktop-cli` carries the
declared `product` name, and `app-url` and `local-app` (a running app the caller drives in
process) carry no code pin at all. A computer-use run of a desktop-cli study saved before
`desktop-cli` was recorded, or of a local-app study saved before `local-app` was recorded, says
`app-url`, and readers accept it. No path, basename, or other host-machine string ever
enters this field; identity is digests, a sha, a boolean, counts and the declared product name.

## Cost Estimate (advisory)

`cost` is optional and additive (`humanish.run-cost-summary.v1`): the
computer-use, shared-world, scripted-browser or terminal-product run's cost estimate: the sum of each participant's
token-derived model cost plus E2B desktop compute lines. New independent CUA runs
emit one line per owned desktop, keyed by public participant ID and carrying observed CPU/memory,
resource source, host-measured minutes, and the derived per-second rate. Concurrent
shared-world runs carry the same lines for each participant, plus a desktop line with
`laneId: subject` for a provisioned plane; an external-public plane is not a humanish
desktop and has no line. Older single aggregate desktop lines remain valid. Missing resource metadata stays
unpriced; unconfirmed cleanup adds an unknown remaining-lifetime line. It is an
estimate, never authoritative: every dollar is a rate-table multiply from the
operator-editable `src/run/pricing.ts`, carries the pricing `ratesAsOf` date and
`source`, and is surfaced with the "estimated (rates as of `<date>`)" label. It is
never shown as a bare charge. It follows the same **declared-absent** discipline as the
terminal cost ledger: an unpriceable line stays present with
`estimatedCostUsd: null` + a `reason` and contributes nothing;
`estimatedTotalUsd` is `null` iff every line is null (never coerced to `0`).
Dry runs omit `cost`. A live run that spends nothing records an explicit zero: no
`breakdown` lines, `estimatedTotalUsd: 0`, `ratesAsOf: null` and `fullyEstimated: true`.
A local scripted run (no model request, no hosted desktop) is such a run; a scripted run on
a provisioned clone records the clone's desktop as a `laneId: subject` line. A live bundle
without `cost` has an unmeasured spend. A live terminal run's `cost` prices its shell sandbox
as a `desktop-minutes` line from its acquired-to-cleanup span and size: E2B's report
(`resourceSource: e2b.getInfo`), or the size humanish asked Modal for (`modal.create`), priced at
Modal's sandbox rate. A computer-use run on `execution.target: modal-desktop` records each
desktop's `providerResources[].provider` as `modal-desktop` and prices it the same way.
Its Codex `model-tokens` line prices the agent's tokens from the model passed as `--model`
(`actor.model`, else `gpt-5.6-sol`). Codex reports usage per turn, summed over the turn's
requests, so the line prices every token at the base tier and carries
`basis: aggregated_turns_base_rate`. It stays `null` with `no_token_usage` when Codex reported
none. `terminal-ledgers.json` still counts those tokens without a price, because its provider line
takes only provider-reported cost. Bundles written before 0.107.0 price against the provider id
`codex` and record `no_rate_for_model`, so their total is a lower bound
(`fullyEstimated: false`) and the unpriced tokens are not $0. Each participant's own estimate also rides its
`stream.actor.estimatedCost` (`humanish.actor-estimated-cost.v1`), kept distinct
from the reserved provider-returned `tokenUsage.costUsd`. See
[`schemas.md`](schemas.md) → Run Cost Summary And Estimated Actor Cost.

This bundle subtotal excludes separate study-analysis requests. Use
`humanish stats` for the complete retained estimate and explicit accounting
gaps across run costs and analysis attempts. See [study cost statistics](study-costs.md).

`humanish verify` treats cost as advisory on magnitude and fail-closed on
labeling: absence passes, but a claimed dollar figure without its `ratesAsOf`
date + `source`, or a total that does not match its known lines, fails. Verify
never inspects the magnitude, so a correctly-labeled large estimate still passes.

## Adapter Score

`adapterScore` is optional and namespaced. It lets a downstream adapter summarize
its own product-specific rubric without adding product nouns to core schemas.
Core validates only `schema`, `namespace`, `status`, `score`, `summary`, and
that optional `data` is a record.

Terminal-product runs record a library scorer's `adapterScore` additively; a
config-declared scorer's `status: fail` flips the verdict as below. Browser/computer-use
runs treat `status: fail` as product-red: the route result returns `ok: false`,
the persisted `review.verdict` becomes `fail` when it was pass-like, and a
generic adapter gap is appended. The bundle remains valid evidence for
`humanish verify` because the failure is an observed product-acceptance outcome,
not corrupt evidence.

## Adapter Artifacts

`adapterArtifacts` is optional and namespaced. It lets a downstream adapter
attach product/state proof outputs to the humanish bundle without making the
payload shape a core concept. Core validates only:

- `schema: humanish.adapter-artifact.v1`;
- non-empty `namespace`, `label`, `path`, and `note`;
- local relative paths only, with no absolute paths, traversal, or URLs;
- supported generic artifact kinds.

Adapters that use browser/shared-world hooks may write files under the ignored
run directory and return relative references through `deriveArtifacts`. Core
stores those references, Observer links them, and `humanish verify` fails closed
when any referenced file is missing. The adapter owns the artifact payload schema
under its namespace.

## Participant Grouping Metadata

Multi-participant browser/shared-world routes may carry optional participant grouping metadata:

```yaml
actor:
  type: openai-computer-use
participants:
  - id: lane-01
    actorType: viewer
    surface: intake
    caseGroup: case-001
```

For repeated participants, a `participants` entry can take a `count`. The parser expands
each such group into deterministic participants before the engine runs:

```yaml
actor:
  type: openai-computer-use
participants:
  - id: viewer
    count: 3
    actorType: viewer
    surface: review-queue
    caseGroup: case-001
    persona: curious-reviewer
    device: desktop
```

The generated participant ids are `<group.id>-01`, `<group.id>-02`, and so on, even when
`count` is 1. A group is an authoring convenience, not a second runtime shape.

These fields are adapter-owned labels, not core enums. They let downstream
projects express "N actors of M app-defined types across S surfaces" without
teaching humanish private product nouns. Values must be public-safe tokens and
are projected into:

- the preflight participant plan;
- shared-world `laneWindows[]` and `outcomes[]`;
- Observer `laneGroups[]`;
- human-readable Observer stream labels.

`actorType` is deliberately separate from `actor.type`. The latter selects
the humanish execution actor, such as `openai-computer-use` or `scripted-browser`.
The former is the app-defined simulated user bucket, such as `viewer`,
`maintainer`, or a downstream adapter's own role label.

## Completion And Meaningful-Use Verdicts

Only older bundles carry `completion`. The OSS meta-lab wrote it, and that lab
was removed. No current route writes the field. `RunStream` in
`src/run/streams.ts` still accepts it, so those bundles stay readable.

In those bundles, `completion` is compact and public-safe. It records
actor/app/nested-Observer status, terminal tails that have already passed
redaction, and optional setup-quality evidence. `completion.meaningfulUse` scored
a coding agent setting up humanish inside another project.

```yaml
completion:
  status: "running|passed|failed|blocked|timed_out"
  reason: "<public-safe participant summary>"
  actorStatus: "not_started|running|passed|failed|blocked|timed_out|suspended|unknown"
  appStatus: "not_started|running|blocked|failed|missing|unknown"
  nestedObserverPresent: true
  nestedVerifyPassed: true
  visualStatus: "not_started|visible|blocked|unknown"
  meaningfulUse:
    schema: humanish.meaningful-use-score.v1
    status: "pass|partial|fail"
    score: 0
    summary: "<public-safe score explanation>"
    hardFailures:
      - "<hard failure that prevents green proof>"
    components:
      - id: "setup-correctness"
        label: "Setup correctness"
        status: "pass|partial|fail"
        score: 0
        detail: "<public-safe detail>"
```

The meta-lab's rubric totalled 100 points:

- setup correctness: 15;
- filesystem evidence: 10;
- nested humanish evidence: 20;
- actor activity: 15;
- product surface: 15;
- feedback quality: 25.

A score of 80 or higher is `pass` only when no hard failure is present and
every rubric component passes. Scores from 45 through 79, or scores of 80 or
higher with any non-passing component, are `partial`. Scores below 45,
failed/timed-out bootstraps, missing nested humanish proof, required actor
failure, or completed participants without a running visible product surface are
`fail`.

## Relative Artifact Layout

For run id `example-2026-06-02t10-00-00-000z-proof`, the core layout is:

```text
.humanish/runs/example-2026-06-02t10-00-00-000z-proof/run.json
.humanish/runs/example-2026-06-02t10-00-00-000z-proof/review.json
.humanish/runs/example-2026-06-02t10-00-00-000z-proof/review.md
.humanish/runs/example-2026-06-02t10-00-00-000z-proof/observer/observer-data.json
.humanish/runs/example-2026-06-02t10-00-00-000z-proof/events.ndjson
.humanish/runs/example-2026-06-02t10-00-00-000z-proof/actors/stream-001.json
.humanish/runs/example-2026-06-02t10-00-00-000z-proof/network/p1.ndjson
.humanish/runs/latest.json
```

`actors/<stream>.json` (or `actor.json` for one participant) is a participant's trace file; see
[Participant traces](#participant-traces). `network/<participantId>.ndjson` is a participant's
browser network log, present only when its study set `execution.network`; see
[Browser network log](#browser-network-log).

Absolute paths, traversal segments, remotes, hosted logs, and private artifact
URLs are not part of the core layout.

## Filesystem Evidence

Filesystem setup evidence came from the removed meta-lab, which asked an actor to
install or configure humanish inside another project. Only bundles from that lab
carry it; no current route writes it and `src/run/bundle.ts` no longer types it. It
was not a repo dump.

The durable artifact kind was `filesystem`. Its last schema was:

```yaml
schema: humanish.setup-quality.v1
status: "passed|needs_review|blocked"
redaction:
  status: "passed"
  rawPreviews: "included|suppressed"
checks:
  - id: "humanish-config"
    ok: true
tree:
  - path: "humanish/config.ts"
    type: "file"
previews:
  - path: "humanish/config.ts"
    language: "typescript"
studyQuality:
  schema: humanish.study-quality.v1
  rating: "none|ceremonial|useful|high_leverage"
  checks:
    - id: "coverage-customized"
      ok: true
  signals:
    appUrlProofBlocked: false
    appUrlProofMentioned: true
    actorInsightCaptured: true
    coverageCustomized: true
    personaCustomized: true
    scenarioCustomized: true
packageScripts:
  humanish: "humanish watch"
humanish:
  configPresent: true
  personaCount: 1
  scenarioCount: 1
  packageScriptPresent: true
  gitignoreContainsRuntimeIgnore: true
```

For public OSS runs, previews could include allowlisted setup files such as
`package.json`, `.gitignore`, `humanish/config.ts`, and
`humanish/studies/*.yaml` / `humanish/personas/*.yaml` /
`humanish/scenarios/*.yaml`. For token-backed or private maintainer runs, raw
previews were suppressed by default. Generated state, `.git`, `.env*`, `.npmrc`,
browser profiles, `node_modules`, `.humanish/`, and arbitrary source files were
not included. `studyQuality` was deliberately structural: it stored booleans,
checks, and a rating so private runs could preserve the useful quality signal
without committing raw private persona, scenario, or coverage text.

## Latest Pointer

The latest pointer is a small local index:

```yaml
schema: humanish.latest-run.v1
runId: "<run-id>"
path: ".humanish/runs/<run-id>"
updatedAt: "<ISO timestamp>"
```

The latest pointer may move. Run bundle directories should not.

## Reviewer notes

Each note a person adds while reviewing a run is its own file in the run directory,
`notes/<id>.json`, written by `humanish notes --add` and by an Observer served on loopback.
`notes/` is absent until the first note.

```json
{
  "schema": "humanish.run-note.v1",
  "runId": "example-2026-06-02t10-00-00-000z-proof",
  "id": "note-20260602t103000000z-000000000001",
  "atMs": 151000,
  "participant": "stream-001",
  "nearest": { "participant": "stream-001", "itemId": "turn-07-call-01" },
  "text": "They looked for the save button here.",
  "author": "you",
  "createdAt": "2026-06-02T10:30:00.000Z",
  "editedAt": null
}
```

- `id`: `note-`, the creation time as `yyyymmddthhmmssmmmz`, `-` and 12 hex digits of
  random bits. The file is named `<id>.json`, so the files sort in the order they were
  added.
- `runId`: the run directory's name. A file whose `runId` or `id` does not match its run or
  its file name is not read.
- `atMs`: milliseconds from the run clock's start, the earliest timed capture or
  desktop video of any participant. The Observer's study timeline shows that moment as
  00:00. A participant's captures count only when every one is stamped and the stamps
  never go back.
- `participant`: the stream id the note belongs to, or `null` for the whole run.
  `humanish notes --add --participant` and the Observer also take the participant's id from
  the study (the stream's `laneId`) and record its stream id. A name that is one stream's id
  and another stream's study id is refused.
- `nearest`: the latest stamped trace item, a capture or an event, at or before the
  moment, among the note's participant or every participant; `null` when there is none.
- `text`: 1 to 2000 characters, after the run's known values, secret-shaped values and
  local paths are replaced.
- `author`: `"you"` in this version.
- `createdAt`, `editedAt`: ISO-8601. Notes cannot be edited yet, so `editedAt` is `null`.

A note file is created once under its own name, only when no file has that name (`O_CREAT` with
`O_EXCL`), filled in one write and never rewritten; a taken name gets a new id. No temporary
file or second link is made, so the run directory passes the single-link check that `verify`,
serving and adding a note run while a note is added. A reader can find a note while it is being
written, as an empty or short file; it skips and names that file like any unreadable note, and
the next read finds the whole note. A writer stopped mid-write leaves such a file, which readers
keep skipping. Adding a note reads no other note, so notes added at the same time from any
process are all kept, and there is no lock. Readers list at most 1000 entries of `notes/` and
read at most 500 notes, each within 16 KiB and refused before reading past that; any other
entry, or a file that is not a note of the run, is skipped and named. The Observer servers serve
any file under `notes/` only within 16 KiB. A run takes no note past 500.
`verify` scans the note files with every other run file, so a secret-shaped value in a note
keeps the run from `share_ready`. A bundle export copies them; an HTML export carries the notes
read-only after checking the set it read.

Threat model: forged web requests are refused, whether from a page on another site or through a
name rebound to 127.0.0.1, by the token, Origin and Host checks on `POST /api/notes`. A local
process with write access to the run directory is out of scope: it already has the user's
privileges and can change any file in the run.

## Verify Result Share Safety

`humanish.verify-result.v1` includes a machine-readable `shareSafety` block in
addition to `ok`, `checks[]`, and `warnings[]`:

```yaml
schema: humanish.verify-result.v1
ok: true
shareSafety:
  status: "share_ready|local_only|blocked"
  reasons:
    - code: "RAW_SCREENSHOTS"
      message: "Full-fidelity screenshots, or frames with no redaction claim, are present ..."
```

`ok: true` means the bundle is valid evidence. It does not necessarily mean the
bundle is safe to promote into a public issue. Public promotion should branch on
`shareSafety.status`:

- `share_ready`: feedback draft commands may render public issue payloads, and `observe --all --safe`
  serves the run. The folder still holds `sandbox-receipts.ndjson` (raw sandbox ids) and `status.json`
  (the recording pid); no Observer server serves them and bundle export omits them;
- `local_only`: keep the run local; only supported redaction-only cases can produce a shareable derivative;
  `RAW_SANDBOX_ID` is one: a file other than `sandbox-receipts.ndjson` names one of the run's raw
  sandbox ids, which verify reads from the receipts and from any raw `providerResources[].id` in
  `run.json`, or a JSON file holds a raw id at a sandbox-id key. Runs from 0.110 keep raw ids only in the receipts, so it fires on runs recorded
  before 0.110, whose `run.json` holds them, until they are exported;
- `blocked`: fix the verification or public-safety failure first.

`ok: true` also does not mean the run finished. A run killed mid-way leaves an
in-progress bundle that can pass every check. When the run is not finished,
`warnings[]` carries one entry starting with the stable code `RUN_NOT_FINISHED`.
`ok` does not change. `shareSafety` changes only for a v2 bundle that holds a participant's
in-progress items (`liveActor`): it is `local_only` with the reason `RUN_NOT_FINISHED`, since no
trace index binds those items. Verify decides "not finished" by the run
index's rule, which the TUI and `humanish stats` use: the run's `status.json` when
it is well formed and names the run, else a `simulations[]` entry still `running` in the
bundle. A `running` record updated within the stale window reads as still
writing; an older one reads as interrupted. The warning names what verify saw:

- the record's state and its last `updatedAt`, or the running `simulations[]` entries when
  there is no usable record;
- how many streams are still `running`;
- the sandbox state, and what `reclaim-receipt.json` records: how many of the run's
  sandboxes are gone (killed or already gone), and how many journaled sandboxes it does
  not cover. It matches its outcomes to the receipts by `sandboxIdDigest`; a reclaim
  receipt from before 0.110 names raw ids, which are digested to match;
- with no reclaim receipt, the command that stops the journaled sandboxes and searches
  E2B by the run's owner tags: `humanish reclaim --run <id>`.

The result also carries `unfinished: { liveness, sandboxes }`, and the one-line output
leads with it, for example `verified <id> (interrupted, sandboxes unknown) · share_ready`.
`sandboxes` is `clean` only when the reclaim receipt records every sandbox gone and its
`state` is `clean`, which means the search by tag finished. It is `unconfirmed` when the
receipt records a sandbox not gone or misses a journaled one, and `unknown` otherwise,
including a receipt from humanish 0.110.0 or earlier, which did not search by tag.

The local-evidence check includes screenshots declared only by
`streams[].actor.items[].screenshotRef` (in the trace file for a v2 bundle) or
`streams[].liveActor.items[].screenshotRef`,
as well as every feedback candidate's evidence. Actor frame paths are relative
to the run root; missing, malformed or nonlocal references fail verification.
Screenshots use the existing bounded PNG decoder. Nonimage candidate evidence
may be an empty regular file, consistent with feedback verification, but that
permission cannot relax another consumer's nonempty-file requirement. The
qualified zero-event terminal-log exception remains unchanged.

A frame counts as redacted only when its bytes have the redactor's output shape
and a redaction claim covers it. The shape is IHDR, IDAT and IEND chunks only,
an empty IEND that ends the file, and a width of at most 128 pixels. The claim is
`screenshotRef.redaction: blurred`, or no `redaction` while the stream's final
`actor.redaction.screenshots` is `blurred` (bundles from before per-frame
claims). Every other frame is raw: it contributes `RAW_SCREENSHOTS` and keeps
otherwise valid evidence `local_only`. That includes `none`, any other value,
an unclaimed frame on a raw, silent or live-only trace, and `ocr_scrubbed`, which
the trace contract reserves but no writer produces. An aggregate raw declaration
wins over every frame claim.

A screenshot is a PNG or, at a path ending `.webp`, a lossless WebP. A PNG
screenshot is non-interlaced, its first chunk is a 13-byte IHDR, its IEND is
empty, and it holds image data only. A chunk outside IHDR, PLTE, IDAT, IEND,
tRNS, cHRM, gAMA, sBIT, sRGB, pHYs and bKGD (text chunks, ICC profiles, Exif,
timestamps, private chunks) fails verification. The harness writers drop those
chunks before writing a frame. A WebP screenshot is the simple lossless form: a
RIFF container holding one VP8L chunk that ends the file, with version 0 and
dimensions under the PNG pixel cap. The extended form (VP8X), which carries Exif,
XMP, ICC profiles and animation, fails verification. Verify reads a WebP's
structure without decoding its pixels, so a WebP frame is always full-fidelity
evidence: only a PNG in the redactor's shape counts as blurred. Earlier humanish
versions do not accept WebP screenshots. A computer-use participant writes each
frame as PNG during its session. When the session ends, its trace references
the lossless WebP of each frame encoded by then in place of its PNG, and the run
removes those PNGs once its final bundle is written. A study that blurs its
screenshots keeps PNG frames, and an interrupted run can hold both files of a
frame, with run.json's live trace naming the PNG.

The public-safety scan classifies a run file by its bytes, not its name. It scans
a file for secret and path patterns only when the bytes are strict UTF-8 with no
control bytes other than tab, line feed and carriage return, the rule bundle
export uses for text. `RAW_SCREENSHOTS` and `CONTINUOUS_MEDIA` grade the stream
screenshots that actor traces reference under `screenshots/`, where the harness
writes every frame, and the recordings `streams[].recording` registers. Every
other file the scan cannot read as text, cannot read at all, or that is larger
than 32 MiB (verify reads at most that much of one file) contributes
`UNSCANNED_ARTIFACT`. So does a folder the scan cannot list, and the rest of a
run past its first 10,000 files and folders plus 5,000 for each participant
`run.json` records, counting at most 128. `export --format bundle` takes at most
10,000. The reason's message lists the paths, and it keeps otherwise valid
evidence `local_only`. This includes images that only feedback candidates,
adapter artifacts or stream artifact entries cite, and a PNG an actor trace
references outside `screenshots/`. An adapter artifact larger than 32 MiB grades
the run `local_only` when nothing cites it, and `blocked` when the bundle cites
it as evidence, because the evidence check cannot read it. An unregistered
`.mp4`, and a file or directory whose name contains `\`, are public-safety
findings and block the run.

The patterns live in `src/evidence/redaction.ts`: provider key formats (OpenAI,
Anthropic, E2B, GitHub, GitLab, npm, Vercel, AWS, Google, Stripe, Slack,
SendGrid, Hugging Face), JWTs, bearer and basic `Authorization` values, private
key headers, database URLs with a password, the password in any URL's user info,
credential query and fragment parameters with a value of 16 characters or more,
credential-named upper-case variables set to a value of 16 characters or more
with a digit and a letter, an AWS secret access key next to its name, E2B URLs, and Linux,
macOS and Windows local paths. `tests/verify/secret-formats.test.ts` lists the
formats and the ordinary values that must not match.

Before matching, the scan undoes JSON and JS escapes, percent-encoding and HTML
character references, the decoding bundle export applies (`decodeEscapes`), and
then JSON whitespace escapes and quoted-printable. It reads inside base64 runs of
16 characters or more in the standard or URL-safe alphabet, including base64
wrapped across lines, and inside hex runs of 32 characters or more:

- a run that decodes to UTF-8 text, or to mostly-ASCII UTF-16 in either byte
  order, is scanned in turn, up to three levels of base64 deep;
- the printable stretches of a run that decodes to other binary are scanned too;
- a base64 run that decodes to an archive (gzip, zip, 7z, bzip2, xz, zstd), at
  any length, or to other binary of 128 characters or more with at least 16
  distinct characters, contributes `UNSCANNED_ARTIFACT`.

`observer/index.html` is exempt from that base64 rule: serve renders it from
`run.json`, export regenerates it, and it embeds the Observer's own base64 fonts.
Its text is still scanned. A base64 run of up to 4096 characters is also read one
slash-separated piece at a time, and from just after each slash in its first 64
characters, so a URL path before an encoded key cannot shift its decoding. Known
limits: base64 split across separate strings, nesting deeper than three levels,
base64 that holds a slash itself and starts more than 64 characters into a longer
run, and encodings a pattern scan cannot undo (such as encryption) still grade
`share_ready`. `tests/verify/encoding-coverage.test.ts`
records each case.

Real email receiving adds `publication.restrictions: [real-communications]` and
an optional `commsReceiving` projection using `humanish.comms-receiving.v2`.
Either field contributes `REAL_COMMUNICATIONS` and keeps the run `local_only`.
This applies to interrupted bundles and after screenshot blurring: real mail can
appear in text and analysis as well as pixels. Malformed receiving metadata fails
bundle validation. The projection holds counts, local IDs and lifecycle/coverage
status; private provider identities and cleanup authority are kept outside the run.

## Zoom and screenshot frames

The image a computer-use participant was given for a `zoom` is a frame of the bundle, so a
decision the participant made on it can be checked. The loop writes it as it writes a screenshot
(`persistFrame` in `src/actors/computer-use/loop/frames.ts`), as `zoom-NNN.png` beside the turn
screenshots, numbered from 001 in the order the participant zoomed, and references it from the
zoom's `ui_action` item through `screenshotRef`, with the zoomed `region` beside it
([schemas](schemas.md)). Every rule above for a stream screenshot applies to it: the metadata
chunks are dropped, a study that blurs its screenshots keeps the redactor's blurred PNG, a study
that does not ends with the lossless WebP, the frame is listed in the stream's screenshot
artifacts and the trace index's `screenshots` count, verify reads it under the screenshot checks
and grades it `RAW_SCREENSHOTS` unless it is blurred, and export blurs it. The frame holds the
region at the desktop's own pixels, as the screen held it. A provider that enlarges a zoom for its
model sends the enlarged copy and keeps nothing else: the Anthropic provider fits it within the
screenshot size, as Claude's computer-use toolset documents for `zoom`.

A `screenshot` before the last action of its batch, for a provider whose model is shown each
screenshot it calls (`batchScreenshots: "frame"`; the Anthropic provider), captures the whole
screen at that point of the batch. The participant is given that capture, and the loop keeps it
the same way as `screenshot-NNN.png`, numbered from 001 in the order the session took them, on
the screenshot's `ui_action` item through `screenshotRef`, with no `region`. The same rules hold:
blur, WebP, artifact listing, verify and export. A batch's last screenshot captures nothing of its
own, since the turn screenshot after the batch is its screen. A turn of only waits and
screenshots is watched before its batch runs (the idle watch), so its screenshots capture the
screen after the watch, and the turn screenshot after such a batch is observed afresh, never
taken from the watch's last look, so the frames stay in the order they were captured. A provider without
`batchScreenshots` (the OpenAI provider and the local-agent participants) sends no screenshot to
the desktop and keeps no such frame.

A pointer read records the position it returned as `pointer` on its `ui_action` item; it writes
no file.

A zoom's item is not a frame of the participant's replay (`isCapture` in `src/run/run-clock.ts`):
the Observer shows the image on the zoom's activity row and opens a cited zoom at the screen it
was taken on, and analysis offers it as a capture the analyst can cite. humanish versions before
this one read the bundle and verify it, since a `ui_action` with a `screenshotRef` is already
valid evidence, but their Observer shows a zoom frame as a replay frame. A screenshot frame within
a batch is the whole screen, so it is a replay frame like a scripted action's own capture, and
analysis offers it as a full-screen capture.

## Redacted Derivative Workspace

`humanish export --run RUN --format bundle --redact-screenshots --out DIRECTORY`
creates a new workspace at `DIRECTORY/.humanish/runs/RUN/`. The source remains
unchanged, including its latest pointer and statistics. The derivative retains the
original run ID and measured outcomes; it is not a new attempt. Standard commands
select it with `--cwd DIRECTORY --run RUN`.

Its `derivation.json` uses schema `humanish.redacted-derivation.v1` and records:

- `sourceRunId`, `createdAt` (export time), and `transformation` (`png-blur-at-export-v1`);
- `sourceInventorySha256`: SHA256 of the JSON array of `[path, byteLength, sha256]`
  rows, sorted by path using JavaScript string order;
- `files[]`: source-relative `path`, `sourceSha256`, action (`copied`, `updated`,
  `blurred`, or `omitted`), and `outputSha256` for retained files or a reason for
  omission; `outputPath` when the copy holds the file at another path, as it does a
  WebP frame;
- `generated[]`: paths and SHA256s of rebuilt Observer projections.

The receipt describes the transformation; it does not attest that a participant's
finding is true. Its own bytes are not included in its hash inventory. Feedback
commands can subsequently generate new derivative-local artifacts.

The derivative names no sandbox. In every JSON and NDJSON file it copies, the
values at `sandboxId`, `subjectSandboxId`, each `providerResources[].id` and each
cleanup.json `resources[].id` read `[redacted-sandbox-id]`, with the id's digest
beside them. In every text file it copies, Markdown, logs and YAML included, each
id the source names becomes `[redacted-sandbox-id <digest>]`: the ids in its
`sandbox-receipts.ndjson`, and any raw id at one of those keys, which is where a
run recorded before 0.110 with no receipts names them. Only those exact ids are
replaced, so the rest of each file is unchanged. In YAML the label is
`redacted-sandbox-id-<digest>`, without brackets, so a value keeps its type.
An id that appears only in free text, in a run with no receipts, is not known to
export. `sandbox-receipts.ndjson` is omitted, and the source keeps its raw ids,
which reclaim reads.

PNG and WebP files that actor traces reference as stream screenshots are
re-encoded as blurred PNG thumbnails. A WebP frame's thumbnail is written at the
same path ending `.png`, and the copy's actor traces, stream artifacts, feedback
evidence and adapter artifacts name that path. Export refuses a run that already
holds a file at that path, and a run whose other copied text names the WebP frame,
since the copy could not resolve that reference. An image that nothing in
`run.json` cites is omitted and inventoried. Export refuses a run whose feedback
candidates, adapter artifacts or stream artifact entries cite an image that is not
a stream screenshot, since verify cannot read that image and dropping it would
change the evidence.
Known actor screenshot declarations describe export-time blur while retaining the
original redaction notes. Observer is rebuilt; old feedback outputs, local process
status and the operational sandbox journal are omitted and inventoried. A derivative
does not inherit resource cleanup authority. Unsupported images, binary formats,
inline image payloads, invalid evidence and references to omitted files are refused.
The original and derivative are independently verified. Text still requires human
review before sharing; screenshot blur does not certify natural-language privacy.
Export counts the run's files and folders against the public-safety scan's limit
(10,000 plus 5,000 for each participant `run.json` records) and refuses a run past it.

## Git Provenance

`captureGitState` (`src/run/git-state.ts`) records git status as counts, without
branch names, remotes, file names, file paths or absolute directories. It
refuses a forged gitdir file and unsafe linked-worktree metadata before running
git. `tests/run/git-state.test.ts` covers these cases.

Proof commands:

```bash
pnpm test
pnpm typecheck
```
