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

### Reopening a run

The TUI's **Open Observer** action opens an HTTP view that follows saved captures
as the run writes them. One loopback evidence server is shared by the session's
browser tabs; exiting the TUI closes it, including when the UI fails. Opening a
run does not launch a study. The URL is always shown for manual opening or SSH
port forwarding, and only contained run paths in the TUI's project are accepted.

| Entry point | What updates | Lifetime |
| --- | --- | --- |
| `watch` during a study | Saved evidence and available in-memory desktop streams | Until the attached command exits |
| `observe --run <id>` | Saved evidence from the selected run | Until the command exits |
| TUI Open Observer | Saved evidence in the selected run; shares the project's evidence library | Until the TUI exits |
| `serve` | Saved evidence across the project's library | Until the server command exits |
| Static HTML or `file://` | The exported snapshot | Independent of a server |

`observe` uses the same current-data projection as the attached viewer, scoped
to the selected run. Its history cannot enumerate other runs. HTML exports use
the installed Observer renderer around the recording's saved data and embedded
images, so older recordings get UI improvements without changing their source.

Reopening an active run follows its saved captures; it cannot recover a live
desktop URL held by another process. Stream credentials are never recovered
from disk or added to the TUI/library server. Original `watch` attachment is
what enables a live desktop stream. The loopback library retains its Host
allowlist, contained file reads, read-only routes and no-store security headers.

Served data may also include `runtime` with `state`, `observedAt`, and
`source: "local-run-status"`. This is a current observation of a contained,
matching `status.json`; it never changes the run's recorded verdict or participant
outcomes. A fresh heartbeat means running, an explicitly finalized record means
finished, and stale or invalid timing means unknown. Missing, malformed, or
mismatched records omit the observation. A stale heartbeat alone does not prove
interruption, and stored PIDs are neither probed nor returned. Static rendering
and export do not create this served-only observation.

Local `codex-exec` actor runs now publish an initial running `run.json` and
`observer/observer-data.json` before actor completion, then refresh both after
sanitized transcripts, traces, and verdict events are available. This gives a
served Observer a truthful active state to poll while noninteractive local
actors are still running.

Watch is deliberately distinct from `humanish serve`. Watch serves ONE
attached run, and the process that created it may inject runtime stream URLs
(live hosted-desktop viewers) into the observer data it serves. Serve is the
LIBRARY surface — every run under `.humanish/runs/` — and never serves runtime
stream URLs in any mode; remote viewers see persisted evidence only. See
[Serve: the run library surface](serve.md).

### Exposed hardening and `watch --expose`

The live `serveObserver` server binds `127.0.0.1` and, by default, is a
local-dev server without a Host allowlist. Every response carries security
headers, including `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'`.
Under its
`exposed` option — set by `watch --expose` — it enforces the SAME
DNS-rebinding defense as the library surface: a strict Host allowlist (loopback
names at bind, extended by `addPublicOrigin(tunnel.url | public-url)`, `421
Misdirected Request` otherwise) and the shared `buildServeSecurityHeaders()` on
every response (both live in `src/serve-http.ts`, shared without a module cycle).
The Host allowlist applies in exposed mode; frame-denial headers apply in both modes.

Exposed mode also SCOPES the surface to the attached live run (`result.run`): the
`/_humanish/history.json` index is filtered to that one run, and `/_humanish/runs/<id>/…`
404s byte-identically to a nonexistent run for any other id. A remote viewer who
clears the edge auth can therefore see only the run being watched — never enumerate
or fetch a prior run's raw, unverified evidence. Loopback keeps the full cross-run
library (history + any run by id) exactly as before.

`watch --expose` is the ONE surface that DELIBERATELY streams the live E2B
desktop to a remote viewer: the attached watch process genuinely holds the
runtime stream URLs (in the in-memory `WeakMap`, never persisted), and streaming
them is the whole point of watching from a phone. It is safe only because the
ngrok edge (Google OAuth + allow rules) or an operator `--public-url` edge
authenticates the viewer first — `watch --expose` therefore always requires edge
auth (a live run is never `share_ready`, so `--safe` alone cannot gate it). The
attached server comes up DURING the run and survives a `timed_out`/`failed` run
(serving is not gated on pass/fail), so a failed run's evidence stays inspectable
to Ctrl-C. `serve` still never injects stream URLs. See
[Serve: the run library surface](serve.md).

### Live desktop iframe authority

Only a URL in the attached server's in-memory runtime map receives
`stream.embed.runtimeDesktop: true`. Persisted markers are removed when building
Observer data and again when reading served fallback projections. Cross-run
library routes do not inherit the attached run's runtime URLs, even when their
stream ids match. Ended or invalid runtime entries do not receive the grant.
The generic static-server helper strips this marker and saved `runtime` state
from Observer JSON and inline data. Static responses carry the same framing
denial headers; they never grant active desktop attachment.

The browser can preserve a cross-origin provider's origin for its desktop viewer
modules only with this grant. Ordinary stored embeds remain isolated. Every
Observer/library response, including raw run HTML, refuses framing, so a provider
redirect or scripted navigation back to an Observer-origin document cannot load
it inside the iframe and gain access to the parent. This protects the receiving
origin without a fixed provider allowlist that becomes stale as desktops start.
The underlying standards are [iframe sandbox permissions](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
and [CSP frame-ancestors](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors).

Raw artifact responses also carry `sandbox allow-scripts` in their CSP. Opening
a saved HTML or SVG document directly gives its scripts an opaque origin, so
they cannot read the Observer's other evidence or browser storage. The policy
applies to every raw file, including unknown extensions, alongside `nosniff`.
Generated Observer HTML and JSON routes retain normal same-origin access for
updates. The generic static helper serves raw documents under the sandbox;
origin-dependent scripts and modules in those artifacts may require independent
hosting. See the [CSP sandbox standard](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox).

History entries may include `runtimeState` from the same contained local status
read as the Observer. Their existing `status` remains the recorded verdict.
Running filters should use runtime state when present, preserving the difference
between an active study and its provisional evidence outcome.

## UI Shape

See [Watching and reviewing evidence](observer-review.md) for current controls,
entry-point capabilities, timing limits and browser acceptance commands.

The Observer shell has:

- top mission-control band with run status and metrics;
- stream filters for UI, CLI, TUI, and Codex UI lanes;
- grid mode with one tile per sim stream;
- focus mode with left stream rail, center stage, and right tabs;
- terminal/TUI transcript stage;
- right evidence rail for events, artifacts, and known gaps.

The participant grid uses equal-height previews and a compact identity/outcome
caption. Generated computer-use lane labels display the recorded persona identity;
repeated identities gain a lane or stream qualifier. Card actions appear on hover
or keyboard focus and remain visible on touch devices. Notices and exceptional
outcomes remain visible; final messages, dimensions, duration and exact identifiers
live in the participant details popover. Search, preview size and monitor mode
share the view/filter popover. Monitor mode keeps its exit beside the run status.
Live previews remain bounded to four visible cards, with the hovered or focused
participant taking priority when the grid shows more than four eligible cards.

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

## The rendering layer (#426, cut over 2026-08-16)

The renderer is the `observer/` workspace: a Vite single-file build on the
`@humanish` registry tokens, frozen against `humanish.observer-data.v1`
(`tests/observer-data-contract.test.ts`). The root build copies the workspace
artifact to `dist/observer-app.html`; in a repo checkout a missing or stale
artifact auto-builds, and an unconditional preflight at CLI startup makes a
broken artifact cost seconds, never a completed session. `renderObserverHtml`
— the one choke point every surface (observe, watch, serve, labs) funnels
through — injects the run's snapshot into the artifact
(`tests/observer-artifact.test.ts` pins the path, cold, so CI exercises the
auto-build every run). The legacy string-concat renderer
(`src/observer-assets.ts`) was deleted at cutover; there is no flag and no
fallback — rollback is a version pin. The workspace's own tests pin the
durability constraints (self-contained single file, fonts inlined, no network
references).
