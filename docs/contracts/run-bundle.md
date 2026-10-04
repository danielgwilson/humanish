# Run Bundle Contract

`humanish.run-bundle.v1` is the evidence contract. The TypeScript shape in `src/run/bundle.ts`
(with `streams[]` in `src/run/streams.ts` and `sharedWorld` as `SharedWorldEvidence` in
`src/run/shared-world-evidence.ts`) and the fail-closed checks in `src/verify/verify.ts` are the
source of truth. This page explains the stable public fields and the extension rules; it does not
version the runtime separately.

## Purpose

A run bundle is the durable evidence packet for one harness run. It should be
reviewable by a person, parseable by a tool, and safe to use as the source for
feedback drafts and future public issues.

## Minimum Bundle Shape

```yaml
schema: humanish.run-bundle.v1
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
simulations: [] # simCount entries, each paired with its streams
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

When a signal stops a live run, the handler writes `interrupted` into the last
flushed `run.json`, and every later write of that run keeps it. A run stopped
before its first flush has no `run.json`; its `status.json` is the record.

`outcome` is absent while a run is in progress, when its process died without
writing it, and on runs recorded before the field existed. For those, readers
take liveness from `status.json` and, for an older finished run, its `ok` and
`execution` from `status.json`'s `outcome`. That record is the only copy of an
older run's `ok`; for a run with `outcome` in `run.json`, `status.json` copies it.

Every surface that shows whether a run passed calls `runDisplay`
(`src/run/display.ts`) with the run's liveness, verdict and `ok`: the Observer
(`observer-data.json` `run.display`), its run library, the served Observer,
`humanish runs`, `humanish review`, `humanish stats`, the TUI and `review.md`'s
`outcome` line. A run
shows as `passed` only when its verdict is `pass` and its `ok` is not false.

## Recorded session stop causes

An actor trace may include `stopCause` alongside its unchanged `status`,
`completionReason` and verbatim `reason`. Computer-use sessions distinguish
`provider_output_limit`, `provider_token_limit`, `time_limit`, `spend_limit`,
`study_spend_limit`, `adapter_limit`, `provider_incomplete`, `provider_status`,
`provider_refused_prompt`, `harness_aborted`, and `usage_unreported`. Absence means the route or
recording did not retain this precise field; it does not mean the participant
finished.

`provider_refused_prompt` records that the model provider refused the request
under its usage policy (OpenAI `400 invalid_prompt`). The session ends as
`failed` / `actor_error`, not `harness_error`, and the harness does not send the
same prompt again. The provider's refusal message is not recorded, since it can
echo the prompt.

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

## Subject Provenance

`subject` is an optional, additive top-level field: structured provenance for
what the computer-use, shared-world or scripted route actually drove (code pin plus state story). It
is absent on pre-existing bundles and on bundles from routes that have not
adopted it. The field shape, its three sources (`clone`, `app-url`,
`local-tree`), and the `humanish verify` checks that guard it are the schema doc's
job, not this one: see the `subject` entry under
[`schemas.md`](schemas.md#run-bundle). In short, `clone` carries a
`repo`/`commit` pin, `local-tree` carries an `archiveSha256`/`dirty` pin
instead (a dirty working tree cannot be commit-pinned), and `app-url` carries
no code pin at all. No path, basename, or other host-machine string ever
enters this field; identity is digests, a sha, a boolean, and counts.

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
without `cost` has an unmeasured spend. A live terminal run's `cost` prices the E2B terminal
sandbox as a `desktop-minutes` line from its acquired-to-cleanup span and `e2b.getInfo` size.
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
.humanish/runs/latest.json
```

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

- `share_ready`: feedback draft commands may render public issue payloads;
- `local_only`: keep the run local; only supported redaction-only cases can produce a shareable derivative;
  `RAW_SANDBOX_ID` is one: a file other than `sandbox-receipts.ndjson` names one of the run's raw
  sandbox ids, which verify reads from the receipts and from any raw `providerResources[].id` in
  `run.json`, or a JSON file holds a raw id at a sandbox-id key. Runs from 0.110 keep raw ids only in the receipts, so it fires on runs recorded
  before 0.110, whose `run.json` holds them, until they are exported;
- `blocked`: fix the verification or public-safety failure first.

`ok: true` also does not mean the run finished. A run killed mid-way leaves an
in-progress bundle that can pass every check. When the run is not finished,
`warnings[]` carries one entry starting with the stable code `RUN_NOT_FINISHED`.
`ok` and `shareSafety` do not change. Verify decides "not finished" by the run
index's rule, which the TUI and `humanish stats` use: the run's `status.json` when
it is well formed and names the run, else a `simulations[]` entry still `running` in the
bundle. A `running` record updated within the stale window reads as still
writing; an older one reads as interrupted. The warning names what verify saw:

- the record's state and its last `updatedAt`, or the running `simulations[]` entries when
  there is no usable record;
- how many streams are still `running`;
- what `reclaim-receipt.json` records: how many of the run's sandboxes are gone
  (killed or already gone), and how many journaled sandboxes it does not cover. It
  matches its outcomes to the receipts by `sandboxIdDigest`; a reclaim receipt from
  before 0.110 names raw ids, which are digested to match;
- with journaled sandboxes and no reclaim receipt, the command that stops them:
  `humanish reclaim --run <id>`.

The local-evidence check includes screenshots declared only by
`streams[].actor.items[].screenshotRef` or `streams[].liveActor.items[].screenshotRef`,
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

A screenshot is a non-interlaced PNG whose first chunk is a 13-byte IHDR, whose
IEND is empty, and which holds image data only. A chunk outside IHDR, PLTE, IDAT,
IEND, tRNS, cHRM, gAMA, sBIT, sRGB, pHYs and bKGD (text chunks, ICC profiles,
Exif, timestamps, private chunks) fails verification. The harness writers drop
those chunks before writing a frame.

The public-safety scan classifies a run file by its bytes, not its name. It scans
a file for secret and path patterns only when the bytes are strict UTF-8 with no
control bytes other than tab, line feed and carriage return, the rule bundle
export uses for text. `RAW_SCREENSHOTS` and `CONTINUOUS_MEDIA` grade the stream
screenshots that actor traces reference under `screenshots/`, where the harness
writes every frame, and the recordings `streams[].recording` registers. Every other file the scan cannot read as text, or cannot read at all,
contributes `UNSCANNED_ARTIFACT`. The reason's message lists the paths, and it keeps
otherwise valid evidence `local_only`. This includes images that only feedback
candidates, adapter artifacts or stream artifact entries cite, and a PNG an actor
trace references outside `screenshots/`. An unregistered
`.mp4`, and a file or directory whose name contains `\`, are public-safety
findings and block the run.

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
Its text is still scanned. Known limits: base64 split across separate strings,
nesting deeper than three levels, and encodings a pattern scan cannot undo (such
as encryption) still grade `share_ready`. `tests/verify/encoding-coverage.test.ts`
records each case.

Real email receiving adds `publication.restrictions: [real-communications]` and
an optional `commsReceiving` projection using `humanish.comms-receiving.v2`.
Either field contributes `REAL_COMMUNICATIONS` and keeps the run `local_only`.
This applies to interrupted bundles and after screenshot blurring: real mail can
appear in text and analysis as well as pixels. Malformed receiving metadata fails
bundle validation. The projection holds counts, local IDs and lifecycle/coverage
status; private provider identities and cleanup authority are kept outside the run.

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
  omission;
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

PNG files that actor traces reference as stream screenshots are re-encoded as
blurred thumbnails. A PNG that nothing in `run.json` cites is omitted and
inventoried. Export refuses a run whose feedback candidates, adapter artifacts or
stream artifact entries cite a PNG that is not a stream screenshot, since verify
cannot read that image and dropping it would change the evidence.
Known actor screenshot declarations describe export-time blur while retaining the
original redaction notes. Observer is rebuilt; old feedback outputs, local process
status and the operational sandbox journal are omitted and inventoried. A derivative
does not inherit resource cleanup authority. Unsupported images, binary formats,
inline image payloads, invalid evidence and references to omitted files are refused.
The original and derivative are independently verified. Text still requires human
review before sharing; screenshot blur does not certify natural-language privacy.

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
