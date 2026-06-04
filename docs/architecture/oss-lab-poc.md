# OSS Lab POC

Date: 2026-06-01

Status: implemented as an experimental meta-lab command plus a retained smoke
harness.

## Decision

`mimetic lab oss` is the authorized-repo meta-simulation loop.

The command should feel like `mimetic watch`: it opens the Observer and, for
human output, keeps the shell attached. Its top-level Observer is an
Observer-of-Observers: each lane represents a headed E2B desktop assigned to a
GitHub `owner/repo` slug. Inside each desktop, the bootstrap clones the repo,
gets it into local dev mode where feasible, installs and initializes Mimetic,
runs nested Mimetic proof commands, starts the target app when a runnable script
is present, opens desktop/mobile app windows plus the nested Observer in the E2B
browser, and starts a nonblocking Codex actor attempt.

The previous clone/discard proof loop remains useful, but it is now explicitly
named `mimetic lab oss-smoke`.

## Commands

Main operator path:

```bash
mimetic lab oss
mimetic lab oss --repos developit/mitt,lukeed/clsx,sindresorhus/is-plain-obj,ai/nanoid
mimetic lab oss --repo developit/mitt --repo lukeed/clsx --count 4
```

Agent/CI contract path:

```bash
mimetic lab oss --dry-run --json --no-open
```

Disposable clone smoke path:

```bash
mimetic lab oss-smoke
mimetic lab oss-smoke --limit 1 --keep
mimetic lab oss --smoke --limit 1 --keep
```

Local dogfood shortcuts:

```bash
pnpm mimetic:lab:oss
pnpm mimetic:lab:oss:ci
pnpm mimetic:lab:oss:smoke
```

## Repo Selection

The default public targets are intentionally small JavaScript packages:

- `developit/mitt`
- `lukeed/clsx`
- `sindresorhus/is-plain-obj`
- `ai/nanoid`

`--repos` accepts a comma-separated list. Repeated `--repo` is also supported.
If `--count` is larger than the repo list, assignments cycle through the repo
pool. Inputs must be GitHub `owner/repo` slugs. Arbitrary URLs, local paths,
tokens, and SSH remotes are rejected. Private repos are maintainer-only and
require an authorized `GH_TOKEN` or `GITHUB_TOKEN` at runtime; no token value is
written to committed source or public issue text.

## Runtime Shape

The meta-lab writes ignored local Observer evidence:

```text
.mimetic/
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
  `MIMETIC_OSS_META_ACTOR_FIRST=1` and required through
  `MIMETIC_OSS_META_REQUIRE_ACTOR=1`;
- public-safe remote bootstrap log tail;
- public-safe gaps and events.

The current implementation launches live E2B desktop streams when
`E2B_API_KEY` and `OPENAI_API_KEY` are present, overlays those stream URLs only
in the attached Observer server, and marks missing key or launch failures
in-lane. It also packs the local Mimetic package, uploads it into each sandbox,
raises a visible bootstrap terminal, clones the assigned repo, runs nested
Mimetic setup and proof commands, starts the target app, opens desktop/mobile
app windows, opens the nested Observer in the sandbox browser, arranges visible
browser windows for screenshot proof, and starts the Codex actor attempt. By
default the actor remains nonblocking and runs after deterministic readback; with
`MIMETIC_OSS_META_ACTOR_FIRST=1`, the actor attempts setup/use before
deterministic validation; with `MIMETIC_OSS_META_REQUIRE_ACTOR=1`, the bootstrap
waits up to `MIMETIC_OSS_META_ACTOR_TIMEOUT_MS` for terminal actor readback and
will not mark the lane passed unless the actor exits cleanly.

The live desktop substrate is an optional peer dependency. Install it in the
project that runs live labs:

```bash
npm i -D @e2b/desktop
```

Remaining substrate work: upgrade the nested `--app-url` browser proof into
provider-backed personas that actually drive multi-step target-app journeys,
and live-prove actor-first setup/use, not only deterministic bootstrap readback.

## Smoke Harness Runtime

`mimetic lab oss-smoke` shallow clones lightweight public GitHub repos into
ignored runtime state, applies Mimetic setup inside each throwaway clone, runs
the synthetic four-lane proof path, verifies the generated bundle, records
git-status evidence, writes an ignored report, and removes cloned repos by
default.

```text
.mimetic/
  lab/oss/<run-id>/
    report.json
    report.md
  tmp/oss-lab/<run-id>/
    repos...      # removed by default
```

Each cloned repo receives disposable uncommitted changes:

- `mimetic/` source starter files;
- `.mimetic/` runtime state;
- `.gitignore` updates;
- `package.json` script updates;
- synthetic run/Observer evidence under the clone's ignored `.mimetic/`.

The clone is removed unless `--keep` is passed. The host report remains under
ignored `.mimetic/lab/oss/<run-id>/`.

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
- Do not write key values into committed `mimetic/` source.
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

The smoke harness proves first-run Mimetic package compatibility against
arbitrary public JavaScript repositories:

- setup can patch real package.json files without committing;
- generated `mimetic/` source can coexist with external repo layout;
- ignored `.mimetic/` runtime proof can be generated;
- the Observer can render from those disposable proofs;
- verification passes before the clone is discarded.

Neither path may claim private product behavior proof without live, redacted,
public-safe evidence.
