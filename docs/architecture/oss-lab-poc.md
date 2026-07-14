# Maintainer OSS Meta-Lab

Date: 2026-06-01

Status: implemented as an experimental repo-owned lab manifest plus
compatibility aliases.

Safety amendment (2026-07-14): beginning with `0.15.1`, the bundled `oss`
manifest is a contract-only dry-run. A direct live OSS meta-lab request fails
with `HUMANISH_OSS_META_LIVE_ISOLATION_REQUIRED` before callbacks, filesystem
or network side effects, credential forwarding, or provider launch. The
historical design and evidence description below is preserved as a record; it
is not current execution guidance. The separate `oss-smoke` clone/discard lane
remains available for public repositories.

## Decision

`humanish/labs/oss.yaml` is this repo's authorized-repo meta-simulation
dogfood loop. It is intentionally a lab manifest, not the canonical consumer
shape. Consumer projects should author their own `humanish/labs/*.yaml` files
and run them with `humanish watch <lab>` or `humanish lab run <lab>`.

The lab should feel like `humanish watch`: it opens the Observer and, for human
output, keeps the shell attached. Its top-level Observer is an
Observer-of-Observers: each lane represents a headed E2B desktop assigned to a
GitHub `owner/repo` slug. Inside each desktop, the bootstrap clones the repo,
gets it into local dev mode where feasible, installs and initializes Humanish,
runs nested Humanish proof commands, starts the target app when a runnable
script is present, opens desktop/mobile app windows plus the nested Observer in
the E2B browser, and starts a nonblocking Codex actor attempt.

The previous clone/discard proof loop remains useful, but it is now explicitly
named `humanish/labs/oss-smoke.yaml`.

## Commands

Main operator path:

```bash
humanish watch oss
humanish lab run oss
humanish lab run oss --repos CorentinTh/it-tools,drawdb-io/drawdb,maciekt07/TodoApp,lissy93/dashy
humanish lab run oss --repo CorentinTh/it-tools --repo drawdb-io/drawdb --count 4
```

Agent/CI contract path:

```bash
humanish lab run oss --dry-run --json --no-open
```

Disposable clone smoke path:

```bash
humanish lab run oss-smoke
humanish lab run oss-smoke --limit 1 --keep
```

Local dogfood shortcuts:

```bash
pnpm humanish:lab:oss
pnpm humanish:lab:oss:ci
pnpm humanish:lab:oss:smoke
```

## Repo Selection

The default public targets are product-like, locally runnable apps/tools:

- `CorentinTh/it-tools`
- `drawdb-io/drawdb`
- `maciekt07/TodoApp`
- `lissy93/dashy`

Target selection should minimize distance from a real user-facing journey.
Good defaults expose an app, CLI, or agent-facing tool that can be tried out of
the box, preferably with a local dev script and no account setup. Libraries,
frameworks, starters, and infrastructure packages belong only in scenarios that
explicitly test developer experience. They are poor defaults for proving
Humanish as a user-simulation harness because they add another abstract setup
layer before any product behavior is visible.

`--repos` accepts a comma-separated list. Repeated `--repo` is also supported.
If `--count` is larger than the repo list, assignments cycle through the repo
pool. Inputs must be GitHub `owner/repo` slugs. Arbitrary URLs, local paths,
tokens, and SSH remotes are rejected. Private repos are maintainer-only and
require an authorized `GH_TOKEN` or `GITHUB_TOKEN` at runtime; no token value is
written to committed source or public issue text.

## Private Product Labs

Private products can be used for local maintainer dogfood, but they must stay
out of the public package surface. Do not commit private repo names as defaults,
fixtures, screenshots, README examples, npm assets, skill examples, or issue
draft text.

The safe local shape is:

```bash
humanish watch .humanish/labs/private-app.yaml --env-file .humanish/local/provider.env
```

with an authorized runtime GitHub token and default repo redaction enabled.
Do not pass `--no-redact-repos` for a private target. Public receipts for
those runs should say `authorized private app target` and point only to ignored
local artifact paths, redacted statuses, and verifier results. Never publish
private screenshots, logs, app URLs, source snippets, branch names, issue
names, stream URLs, or operational details.

## Runtime Shape

The meta-lab writes ignored local Observer evidence:

```text
.humanish/
  runs/<oss-meta-run-id>/
    run.json
    review.json
    review.md
    events.ndjson
    observer/
      index.html
      observer-data.json
```

Each stream lane records:

- assigned repo slug for public runs, or a redacted lane label for token-backed
  maintainer/private runs;
- whether a live E2B desktop stream exists; auth-bearing stream URLs are
  runtime-only for the attached Observer server and are not persisted;
- target app URL/status when a runnable script becomes HTTP-ready inside the
  sandbox;
- nested Observer presence and nested verification status;
- headed desktop visual-window status and browser window count;
- Codex actor status, optionally moved before deterministic setup with
  `HUMANISH_OSS_META_ACTOR_FIRST=1` and required through
  `HUMANISH_OSS_META_REQUIRE_ACTOR=1`;
- setup-quality filesystem evidence: shallow tree, Humanish setup checks,
  package scripts, study-quality rating, and allowlisted previews for public
  runs;
- public-safe remote bootstrap log tail;
- public-safe gaps and events.

The current implementation launches live E2B desktop streams when
`E2B_API_KEY` and `OPENAI_API_KEY` are present, overlays those stream URLs only
in the attached Observer server, and marks missing key or launch failures
in-lane. It also packs the local Humanish package, uploads it into each sandbox,
raises a visible bootstrap terminal, clones the assigned repo, runs nested
Humanish setup and proof commands, starts the target app, opens desktop/mobile
app windows, opens the nested Observer in the sandbox browser, arranges visible
browser windows for screenshot proof, and starts the Codex actor attempt. By
default the actor remains nonblocking and runs after deterministic readback; with
`HUMANISH_OSS_META_ACTOR_FIRST=1`, the actor attempts setup/use before
deterministic validation; with `HUMANISH_OSS_META_REQUIRE_ACTOR=1`, the bootstrap
waits up to `HUMANISH_OSS_META_ACTOR_TIMEOUT_MS` for terminal actor readback and
will not mark the lane passed unless the actor exits cleanly.

When the remote bootstrap completes, the host persists a local
`setup-quality/<stream>-setup-quality.json` artifact. The Observer Files tab can
render it inline from the served Observer. Static `file://` observers keep the
artifact link openable but do not hydrate it inline. Token-backed/private runs
suppress raw file previews by default while preserving the setup checks and
tree shape. They also preserve `studyQuality` structural signals so an actor
that merely installs Humanish receives a `ceremonial` rating instead of being
treated as successful user-study leverage.

The live desktop substrate is an optional peer dependency. Install it in the
project that runs live labs:

```bash
npm i -D @e2b/desktop
```

Remaining substrate work: upgrade the nested `--app-url` browser proof into
provider-backed personas that actually drive multi-step target-app journeys,
and live-prove actor-first setup/use, not only deterministic bootstrap readback.

## Smoke Harness Runtime

`humanish lab run oss-smoke` shallow clones lightweight public GitHub repos into
ignored runtime state, applies Humanish setup inside each throwaway clone, runs
the synthetic four-lane proof path, verifies the generated bundle, records
git-status evidence, writes an ignored report, and removes cloned repos by
default.

```text
.humanish/
  lab/oss/<run-id>/
    report.json
    report.md
  tmp/oss-lab/<run-id>/
    repos...      # removed by default
```

Each cloned repo receives disposable uncommitted changes:

- `humanish/` source starter files;
- `.humanish/` runtime state;
- `.gitignore` updates;
- `package.json` script updates;
- synthetic run/Observer evidence under the clone's ignored `.humanish/`.

The clone is removed unless `--keep` is passed. The host report remains under
ignored `.humanish/lab/oss/<run-id>/`.

## Safety Rules

- GitHub `owner/repo` slugs only.
- Private repos require an authorized runtime token. Token-backed runs redact
  repo labels in durable artifacts by default and must not appear in committed
  fixtures, docs examples, public issue text, or published media.
- pnpm dependency build scripts may be allowed only inside the disposable E2B
  lab so target app surfaces can start. Never use this as a host install
  default.
- No credential prompts; smoke clone calls set `GIT_TERMINAL_PROMPT=0`.
- No commits, pushes, branches, tags, GitHub API mutation, deploys, or issue
  filing.
- Do not write key values into committed `humanish/` source.
- Do not emit PII, PHI, raw private transcripts, private screenshots, secrets,
  keys, or private upstream artifacts.

## What This Proves

The meta-lab proves the operator control surface and artifact contract for
watching multiple Codex/E2B setup attempts at once. The live path now detects
E2B desktop fanout, visible bootstrap terminals, local-package upload,
disposable authorized-repo setup, target app HTTP readiness when a runnable
script is present, headed browser-window layout, nested live `--app-url`
desktop/mobile browser proof when the target app runs, nested Observer opening,
and top-level lane completion from remote evidence. It does not yet prove a
general provider-backed multi-step target-app persona runtime.

The smoke harness proves first-run Humanish package compatibility against
arbitrary public JavaScript repositories:

- setup can patch real package.json files without committing;
- generated `humanish/` source can coexist with external repo layout;
- ignored `.humanish/` runtime proof can be generated;
- the Observer can render from those disposable proofs;
- verification passes before the clone is discarded.

Neither path may claim private product behavior proof without live, redacted,
public-safe evidence.

Feedback candidates are derived from this evidence when a lane records concrete
setup-quality gaps, ceremonial/absent study quality, or actor-reported Humanish
CLI blockers. `humanish feedback` uses those candidates before falling back to
generic dry-run follow-up drafts.
