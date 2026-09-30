# Run Bundle Contract

Date: 2026-06-02 (current-state note updated 2026-07-14)

Status: `humanish.run-bundle.v1` is the shipped evidence contract. The
TypeScript shape in `src/run/bundle.ts` (with `streams[]` in `src/run/streams.ts` and
`sharedWorld` as `SharedWorldEvidence` in `src/run/shared-world-evidence.ts`) and fail-closed verification in `src/verify/verify.ts` are
authoritative; this document explains the stable public fields and extension
rules rather than independently versioning the runtime.

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
lab: # optional, additive: which manifest produced this run
  id: "<lab id>"
  path: "humanish/labs/<lab id>.yaml"
  origin: "committed|ignored|explicit"
cwd: "[target-cwd]"
artifactRoot: ".humanish/runs/<run-id>"
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
artifacts:
  run: "run.json"
  reviewJson: "review.json"
  reviewMarkdown: "review.md"
  observerData: "observer/observer-data.json"
  events: "events.ndjson"
review:
  schema: humanish.review.v1
  verdict: "contract_proof_only|pass|fail|blocked|timed_out"
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

## Recorded session stop causes

An actor trace may include `stopCause` alongside its unchanged `status`,
`completionReason` and verbatim `reason`. Computer-use sessions distinguish
`provider_output_limit`, `provider_token_limit`, `time_limit`, `spend_limit`,
`study_spend_limit`, `adapter_limit`, `provider_incomplete`, `provider_status`,
`provider_refused_prompt`, and `harness_aborted`. Absence means the route or
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
original lane/role instruction when one was supplied. `tasks` contains only the IDs and
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
and screenshots. See [desktop recording](../architecture/desktop-recording.md).

## Hosted Desktop Geometry

Hosted browser streams may carry additive `desktopGeometry` evidence. Its fields keep five
different facts separate:

- `screen.requested`: the E2B/X screen size requested by config;
- `screen.verified`: the screen size measured in-sandbox with `xdpyinfo`;
- `screen.declared`: the device preset the lab ASKED for, present only when it differs from
  `screen.requested` because the rendered width was floored to Chrome's ~500px window minimum.
  `verified` compares the floored number with itself and reports a match, so a matching
  `verified` block is NOT evidence that the preset width rendered. When `declared` is present,
  it did not: a `mobile` (414) and a `small-mobile` (360) seat both render at 500 and are
  indistinguishable by rendered width;
- `browserWindow`: measured browser bounds after the window-fill attempt; physical X client
  bounds (`source: xwininfo`) take precedence over page-reported outer bounds (`source: cdp`),
  which can reflect mobile emulation. Historical `source: xdotool` bundles remain readable;
  older xdotool versions can double-count decorations in reported coordinates;
- `viewport`: the page's CSS layout viewport and device-pixel ratio measured through CDP on
  Chromium-family hosted browsers.

Before participant actions, hosted computer-use lanes check measured X bounds against every
edge of the captured desktop. If a browser is clipped, a bounded move-and-fit correction
remeasures the client origin after each of up to two resize attempts, preserving browser
controls when they fit. A fullscreen fallback remains for minimum-width windows that cannot
fit a narrow desktop. A window that remains clipped, or whose repair
cannot be verified, ends the lane before participant actions. A fully contained smaller window
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
what the computer-use backend actually drove (code pin plus state story). It
is absent on pre-existing bundles and on bundles from backends that have not
adopted it. The field shape, its three sources (`clone`, `app-url`,
`local-tree`), and the `humanish verify` checks that guard it are the schema doc's
job, not this one: see the `subject` entry under
[`schemas.md`](schemas.md#contract-schema-index). In short, `clone` carries a
`repo`/`commit` pin, `local-tree` carries an `archiveSha256`/`dirty` pin
instead (a dirty working tree cannot be commit-pinned), and `app-url` carries
no code pin at all. No path, basename, or other host-machine string ever
enters this field; identity is digests, a sha, a boolean, and counts.

## Cost Estimate (advisory)

`cost` is optional and additive (`humanish.run-cost-summary.v1`): the
computer-use or terminal-product run's cost ESTIMATE: the sum of each lane's
token-derived model cost plus E2B desktop compute lines. New independent CUA runs
emit one line per owned desktop, keyed by public lane ID and carrying observed CPU/memory,
resource source, host-measured minutes, and the derived per-second rate. Concurrent
shared-world runs carry the same lines for each seat, plus a desktop line with
`laneId: subject` for a provisioned plane; an external-public plane is not a humanish
desktop and has no line. Older single aggregate desktop lines remain valid. Missing resource metadata stays
unpriced; unconfirmed cleanup adds an unknown remaining-lifetime line. It is an
ESTIMATE, never authoritative: every dollar is a rate-table multiply from the
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
Its Codex `model-tokens` line stays `null` (`no_rate_for_model`, model `codex`): the lane
does not pin Codex's model, and `terminal-ledgers.json` counts those tokens without a price.
So a terminal total is a lower bound (`fullyEstimated: false`), and the unpriced tokens are
not $0. Each lane's own estimate also rides its
`stream.actor.estimatedCost` (`humanish.actor-estimated-cost.v1`), kept distinct
from the reserved provider-returned `tokenUsage.costUsd`. See
[`schemas.md`](schemas.md) → Run Cost Summary And Estimated Actor Cost.

This bundle subtotal excludes separate study-analysis requests. Use
`humanish stats` for the complete retained estimate and explicit accounting
gaps across run costs and analysis attempts. See [study cost statistics](study-costs.md).

`humanish verify` treats cost as ADVISORY on magnitude and FAIL-CLOSED on
labeling: absence passes, but a claimed dollar figure without its `ratesAsOf`
date + `source`, or a total that does not match its known lines, fails. Verify
never inspects the magnitude, so a correctly-labeled large estimate still passes.

## Adapter Score

`adapterScore` is optional and namespaced. It lets a downstream adapter summarize
its own product-specific rubric without adding product nouns to core schemas.
Core validates only `schema`, `namespace`, `status`, `score`, `summary`, and
that optional `data` is a record.

Terminal-product runs record `adapterScore` additively. Browser/computer-use
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

## Lane Grouping Metadata

Multi-lane browser/shared-world routes may carry optional lane grouping metadata:

```yaml
actors:
  - type: openai-computer-use
    lanes:
      - id: lane-01
        actorType: viewer
        surface: intake
        caseGroup: case-001
```

For repeated lanes, authors can use compact roster groups. The parser expands
each group into deterministic `lanes[]` before the engine runs:

```yaml
actors:
  - type: openai-computer-use
    roster:
      - id: viewer
        count: 3
        actorType: viewer
        surface: review-queue
        caseGroup: case-001
        persona: curious-reviewer
        device: desktop
```

The generated lane ids are `<group.id>-01`, `<group.id>-02`, and so on. `roster`
is mutually exclusive with explicit `lanes`, homogeneous `count`, and
`laneFocus`; it is an authoring convenience, not a second runtime shape.

These fields are adapter-owned labels, not core enums. They let downstream
projects express "N actors of M app-defined types across S surfaces" without
teaching humanish private product nouns. Values must be public-safe tokens and
are projected into:

- the preflight lane plan;
- shared-world `laneWindows[]` and `outcomes[]`;
- Observer `laneGroups[]`;
- human-readable Observer stream labels.

`actorType` is deliberately separate from `actors[0].type`. The latter selects
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
  reason: "<public-safe lane summary>"
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
failure, or completed lanes without a running visible product surface are
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

Filesystem setup evidence is first-class when a lane asks an actor to install
or configure humanish inside another project. It is not a repo dump.

The durable artifact kind is `filesystem`. The current schema is:

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

For public OSS runs, previews may include allowlisted setup files such as
`package.json`, `.gitignore`, `humanish/config.ts`, and
`humanish/labs/*.yaml` / `humanish/personas/*.yaml` /
`humanish/scenarios/*.yaml`. For token-backed or private maintainer runs, raw
previews are suppressed by default. Generated state, `.git`, `.env*`, `.npmrc`,
browser profiles, `node_modules`, `.humanish/`, and arbitrary source files are
not included. `studyQuality` is deliberately structural: it stores booleans,
checks, and a rating so private runs can preserve the useful quality signal
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
      message: "Full-fidelity screenshots are present ..."
```

`ok: true` means the bundle is valid evidence. It does not necessarily mean the
bundle is safe to promote into a public issue. Public promotion should branch on
`shareSafety.status`:

- `share_ready`: feedback draft commands may render public issue payloads;
- `local_only`: keep the run local; only supported redaction-only cases can produce a shareable derivative;
- `blocked`: fix the verification or public-safety failure first.

`ok: true` also does not mean the run finished. A run killed mid-way leaves an
in-progress bundle that can pass every check. When the run is not finished,
`warnings[]` carries one entry starting with the stable code `RUN_NOT_FINISHED`.
`ok` and `shareSafety` do not change. Verify decides "not finished" by the run
index's rule, which `humanish runs` and the TUI use: the run's `status.json` when
it is well formed and names the run, else a simulation still `running` in the
bundle. A `running` record updated within the stale window reads as still
writing; an older one reads as interrupted. The warning names what verify saw:

- the record's state and its last `updatedAt`, or the running simulations when
  there is no usable record;
- how many streams are still `running`;
- what `reclaim-receipt.json` records: how many of the run's sandboxes are gone
  (killed or already gone), and how many journaled sandboxes it does not cover;
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

An explicit `screenshotRef.redaction: none` on either final or live actor items
contributes the existing `RAW_SCREENSHOTS` reason and keeps otherwise valid
evidence `local_only`. Either an aggregate raw declaration or a raw frame wins
over a blurred declaration. Missing or unknown per-frame metadata retains the
existing permissive compatibility behavior; verification does not infer pixel
privacy from that absence.

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

PNG files are re-encoded as blurred thumbnails, including unreferenced images.
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
