# Run Bundle Contract

Date: 2026-06-02

Status: v0 draft contract for bundle identity, layout, source state, history,
lifecycle, and timing primitives.

## Purpose

A run bundle is the durable evidence packet for one harness run. It should be
reviewable by a person, parseable by a tool, and safe to use as the source for
feedback drafts and future public issues.

## Minimum Bundle Shape

```yaml
schema: mimetic.run-bundle.v1
runId: "<core run id>"
mode: "dry-run|live"
simCount: 1
createdAt: "<ISO timestamp>"
cwd: "[target-cwd]"
artifactRoot: ".mimetic/runs/<run-id>"
source:
  packageName: "<public package name or null>"
  mimeticSource: "present|missing"
  git:
    schema: mimetic.git-state.v1
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
  schema: mimetic.review.v1
  verdict: "contract_proof_only|pass|fail|blocked|timed_out"
adapterScore:
  schema: mimetic.adapter-score.v1
  namespace: "<adapter namespace>"
  status: "pass|partial|fail"
  score: 0
  summary: "<public-safe adapter score summary>"
  data: {}
feedbackCandidates:
  - schema: mimetic.feedback-candidate.v1
    id: "<stable candidate id>"
    failure_owner: "harness|target-app|actor|environment|unknown"
    evidence:
      - path: "<relative run artifact path>"
        kind: "review|state|log|trace|screenshot|filesystem"
adapterArtifacts:
  - schema: mimetic.adapter-artifact.v1
    namespace: "<adapter namespace>"
    label: "<human-readable artifact label>"
    path: "<relative run artifact path>"
    kind: "state|review|log|trace|screenshot|filesystem|summary"
    note: "<public-safe note>"
```

Persisted `run.json` files must not contain absolute local target paths. Runtime
commands may return the caller's working directory in process-local JSON
responses, but durable run bundles use the public-safe `[target-cwd]` marker.

## Adapter Score

`adapterScore` is optional and namespaced. It lets a downstream adapter summarize
its own product-specific rubric without adding product nouns to core schemas.
Core validates only `schema`, `namespace`, `status`, `score`, `summary`, and
that optional `data` is a record.

Terminal-product runs record `adapterScore` additively. Browser/computer-use
runs treat `status: fail` as product-red: the route result returns `ok: false`,
the persisted `review.verdict` becomes `fail` when it was pass-like, and a
generic adapter gap is appended. The bundle remains valid evidence for
`mimetic verify` because the failure is an observed product-acceptance outcome,
not corrupt evidence.

## Adapter Artifacts

`adapterArtifacts` is optional and namespaced. It lets a downstream adapter
attach product/state proof outputs to the Mimetic bundle without making the
payload shape a core concept. Core validates only:

- `schema: mimetic.adapter-artifact.v1`;
- non-empty `namespace`, `label`, `path`, and `note`;
- local relative paths only, with no absolute paths, traversal, or URLs;
- supported generic artifact kinds.

Adapters that use browser/shared-world hooks may write files under the ignored
run directory and return relative references through `deriveArtifacts`. Core
stores those references, Observer links them, and `mimetic verify` fails closed
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
teaching Mimetic private product nouns. Values must be public-safe tokens and
are projected into:

- the preflight lane plan;
- shared-world `laneWindows[]` and `outcomes[]`;
- Observer `laneGroups[]`;
- human-readable Observer stream labels.

`actorType` is deliberately separate from `actors[0].type`. The latter selects
the Mimetic execution actor, such as `openai-computer-use` or `scripted-browser`.
The former is the app-defined simulated user bucket, such as `viewer`,
`maintainer`, or a downstream adapter's own role label.

## Completion And Meaningful-Use Verdicts

Each live stream may include `completion` when the harness has enough evidence
to judge the lane. Completion state is deliberately compact and public-safe:
it records actor/app/nested-Observer status, terminal tails that have already
passed redaction, and optional setup-quality evidence.

`completion.meaningfulUse` is the first-class scored verdict for meta-lab
lanes where a coding agent is asked to set up Mimetic inside another project.
It is a rubric over already-redacted evidence, not a raw transcript dump.

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
    schema: mimetic.meaningful-use-score.v1
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

The current OSS meta-lab rubric totals 100 points:

- setup correctness: 15;
- filesystem evidence: 10;
- nested Mimetic evidence: 20;
- actor activity: 15;
- product surface: 15;
- feedback quality: 25.

A score of 80 or higher is `pass` only when no hard failure is present and
every rubric component passes. Scores from 45 through 79, or scores of 80 or
higher with any non-passing component, are `partial`. Scores below 45,
failed/timed-out bootstraps, missing nested Mimetic proof, required actor
failure, or completed lanes without a running visible product surface are
`fail`.

## Relative Artifact Layout

For run id `example-2026-06-02t10-00-00-000z-proof`, the core layout is:

```text
.mimetic/runs/example-2026-06-02t10-00-00-000z-proof/run.json
.mimetic/runs/example-2026-06-02t10-00-00-000z-proof/review.json
.mimetic/runs/example-2026-06-02t10-00-00-000z-proof/review.md
.mimetic/runs/example-2026-06-02t10-00-00-000z-proof/observer/observer-data.json
.mimetic/runs/example-2026-06-02t10-00-00-000z-proof/events.ndjson
.mimetic/runs/latest.json
```

Absolute paths, traversal segments, remotes, hosted logs, and private artifact
URLs are not part of the core layout.

## Filesystem Evidence

Filesystem setup evidence is first-class when a lane asks an actor to install
or configure Mimetic inside another project. It is not a repo dump.

The durable artifact kind is `filesystem`. The current schema is:

```yaml
schema: mimetic.setup-quality.v1
status: "passed|needs_review|blocked"
redaction:
  status: "passed"
  rawPreviews: "included|suppressed"
checks:
  - id: "mimetic-config"
    ok: true
tree:
  - path: "mimetic/config.ts"
    type: "file"
previews:
  - path: "mimetic/config.ts"
    language: "typescript"
studyQuality:
  schema: mimetic.study-quality.v1
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
  mimetic: "mimetic watch"
mimetic:
  configPresent: true
  personaCount: 1
  scenarioCount: 1
  packageScriptPresent: true
  gitignoreContainsRuntimeIgnore: true
```

For public OSS runs, previews may include allowlisted setup files such as
`package.json`, `.gitignore`, `mimetic/config.ts`, and
`mimetic/labs/*.yaml` / `mimetic/personas/*.yaml` /
`mimetic/scenarios/*.yaml`. For token-backed or private maintainer runs, raw
previews are suppressed by default. Generated state, `.git`, `.env*`, `.npmrc`,
browser profiles, `node_modules`, `.mimetic/`, and arbitrary source files are
not included. `studyQuality` is deliberately structural: it stores booleans,
checks, and a rating so private runs can preserve the useful quality signal
without committing raw private persona, scenario, or coverage text.

## Latest And History

The latest pointer is a small local index:

```yaml
schema: mimetic.latest-run.v1
runId: "<run-id>"
path: ".mimetic/runs/<run-id>"
updatedAt: "<ISO timestamp>"
```

History entries use:

```yaml
schema: mimetic.run-history-entry.v1
runId: "<run-id>"
createdAt: "<ISO timestamp>"
mode: "dry-run|live"
path: ".mimetic/runs/<run-id>"
```

The latest pointer may move. Run bundle directories should not.

## Contract Fixture Proof

The core fixture proves:

- deterministic run ids from explicit inputs;
- stable relative artifact paths;
- latest/history/lifecycle/timing records;
- git status counts without branch names, remotes, file names, file paths, or
  absolute directories;
- no environment-specific nouns in `src/core`.

Proof commands:

```bash
pnpm test
pnpm typecheck
```
