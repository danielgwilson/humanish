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
