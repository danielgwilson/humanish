# Observer Architecture

Date: 2026-06-01

Status: implemented for synthetic stream contracts and local `codex-exec`
active-run Observer snapshots; broader live actor adapters next.

## Decision

The Observer is a mission-control surface over durable run artifacts, not a
static report page.

Every run writes immutable local evidence under `.mimetic/runs/<run-id>/`:

```text
.mimetic/runs/<run-id>/
  run.json
  review.json
  review.md
  events.ndjson
  observer/
    index.html
    observer-data.json
```

`run.json` remains the source bundle. `observer/observer-data.json` is the
normalized view model consumed by the Observer. `events.ndjson` is the appendable
event stream contract that live adapters will update while a run is active.

## Stream Model

Streams are the central abstraction. A stream is one watchable persona lane,
regardless of substrate:

- `ui`: browser/VNC style UI simulation lane;
- `browser`: browser-specific lane when the app and actor are separate;
- `terminal`: CLI persona lane with stdout/stderr evidence;
- `tui`: PTY/ANSI terminal UI lane;
- `codex-ui`: Codex-style app-server session lane;
- `artifact`: artifact-only evidence lane;
- `summary`: run-level synthesis lane.

Each stream points back to a simulation and carries its own transport,
terminal tail, UI state, artifact links, event timeline, and public-safe
metadata.

## Live Watch

`mimetic watch` now:

1. creates a fresh four-lane synthetic run bundle;
2. writes `observer-data.json` and `events.ndjson`;
3. starts a localhost Observer server;
4. opens the served Observer URL;
5. keeps the shell attached until Ctrl-C.

The browser polls `observer-data.json` with `no-store` caching. Static
`file://` opening still works for immutable review, but follow mode is the
operator path. Agents and CI should use `mimetic watch --json --no-open` for
the same fresh evidence without browser open or a long-running process.

Local `codex-exec` actor runs now publish an initial running `run.json` and
`observer/observer-data.json` before actor completion, then refresh both after
sanitized transcripts, traces, and verdict events are available. This gives a
served Observer a truthful active state to poll while noninteractive local
actors are still running.

## UI Shape

The Observer shell has:

- top mission-control band with run status and metrics;
- stream filters for UI, CLI, TUI, and Codex UI lanes;
- grid mode with one tile per sim stream;
- focus mode with left stream rail, center stage, and right tabs;
- terminal/TUI transcript stage;
- right evidence rail for events, artifacts, and known gaps.

## Codex UI Contract

`codex-ui` streams are normalized session/event projections. Public artifacts
must not store raw provider payloads, raw prompts, raw private transcripts,
private screenshots, PHI, PII, secrets, or source-system data.

A host adapter may provide:

- session identity;
- redacted lifecycle/status;
- event source or snapshot URL;
- optional embed URL;
- normalized event timeline;
- approval metadata;
- public-safe artifact links.

If no embed URL exists, the Observer still renders the Codex-style timeline and
session contract instead of failing the lane.

## Current Gaps

This slice implements the Observer substrate, synthetic stream contracts, and
active-run Observer snapshots for local `codex-exec`. The following are
intentionally still adapter work:

- real Playwright/browser actor execution;
- E2B or local PTY capture;
- Codex TUI live follow after workspace trust bootstrap;
- native Codex app-server session adapter;
- screenshot and trace galleries;
- reviewer acceptance gates over real product behavior.
