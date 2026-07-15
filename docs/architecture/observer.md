# Observer Architecture

Date: 2026-06-01 (current-state note updated 2026-07-14)

Status: implemented for synthetic streams and persisted live browser,
terminal-product, fan-out, and sequential/concurrent shared-world evidence.
Plain computer-use and shared-world runs can publish an in-progress bundle to
an attached loopback Observer without persisting runtime stream-auth URLs. The
version-pinned README image is a synthetic technical sample, not real-application
proof.

## Decision

The Observer is a mission-control surface over durable run artifacts, not a
static report page.

Every run writes durable local evidence under `.humanish/runs/<run-id>/`. Active
runs refresh their bundle and Observer projection; later review, feedback, or
Observer commands may add derived artifacts:

```text
.humanish/runs/<run-id>/
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
event stream contract that live adapters update while a run is active.

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

`humanish watch` now:

1. creates a fresh four-lane synthetic run bundle;
2. writes `observer-data.json` and `events.ndjson`;
3. starts a localhost Observer server;
4. opens the served Observer URL;
5. keeps the shell attached until Ctrl-C.

The browser polls `observer-data.json` with `no-store` caching. Static
`file://` opening still works for immutable review, but follow mode is the
operator path. Agents and CI should use `humanish watch --json --no-open` for
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
private screenshots, PHI, PII, secrets, or upstream data.

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

## Historical slice and remaining gaps

The original 2026-06-01 slice implemented the Observer substrate and synthetic
stream contracts; local `codex-exec` active-run snapshots followed.

Subsequent additions through 2026-06-11 included:

- Playwright-backed browser proof with scripted, app-specific
  `browser.steps` authored in `humanish/scenarios/*.yaml` (`src/run.ts`);
- native Codex app-server session adapter (`src/codex-app-server.ts`,
  registered in `src/actor-registry.ts`);
- E2B desktop substrate lanes on the meta and computer-use routes;
- computer-use bundles persist a `screenshots/` directory and the Observer
  renders the frames (`src/cua-actor-lab.ts`).

Intentionally still adapter work:

- local PTY capture;
- Codex TUI live follow after workspace trust bootstrap;
- richer screenshot/trace galleries across multi-step product journeys;
- reviewer acceptance gates over real product behavior.
