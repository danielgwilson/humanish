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
cwd: "<local cwd; public issue drafts must not copy this>"
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
feedbackCandidates:
  - schema: mimetic.feedback-candidate.v1
    id: "<stable candidate id>"
    failure_owner: "harness|target-app|actor|environment|unknown"
    evidence:
      - path: "<relative run artifact path>"
        kind: "review|state|log|trace|screenshot|filesystem"
```

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
`mimetic/personas/*.yaml` / `mimetic/scenarios/*.yaml`. For token-backed or
private maintainer runs, raw previews are suppressed by default. Generated
state, `.git`, `.env*`, `.npmrc`, browser profiles, `node_modules`, `.mimetic/`,
and arbitrary source files are excluded.

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
