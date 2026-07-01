# Contract Schema Index

Date: 2026-06-02 (updated 2026-06-24)

Status: schema map aligned to the shipped v0.6.x surface. Rows marked
"reserved" name layering intent only — no code emits or validates them yet.
Do not emit a reserved schema.

## Purpose

This document names the core Mimetic contracts before more implementation
lands. It is intentionally public-safe: examples use synthetic ids, local
relative artifact paths, env var names without values, and redacted evidence
notes.

Core contracts are reusable. Adapter contracts describe a target app, CLI, or
workflow without leaking private upstream truth into core.

## Ownership Rule

| Layer | Owns | Does not own |
| --- | --- | --- |
| Core | Schema versions, run ids, artifact layout, lifecycle events, actor/substrate status, evidence shape, review, verification, redaction, feedback mechanics, latest/history indexes. | Product routes, real customer data, private screenshots, private transcripts, credential values, target-specific acceptance language. |
| Adapter | Product routes, scenario/persona choices, app topology, env var names, network allowlists, coverage vocabulary, milestones, fixture data, target-specific proof expectations. | Generic run bundle schema, public-safety gates, provider secret values, raw private artifacts, GitHub mutation authority. |

## Contract Index

| Contract | Schema | Public-safe fixture |
| --- | --- | --- |
| Run bundle | `mimetic.run-bundle.v1` | `synthetic-run-bundle` |
| Adapter | `mimetic.adapter.v1` | `synthetic-cli-adapter` |
| Lab | `mimetic.lab.v2` | `first-run` |
| Persona | `mimetic.persona.v1` | `synthetic-maintainer` |
| Scenario | `mimetic.scenario.v1` | `first-run-smoke` |
| Actor trace | `mimetic.actor-trace.v1` | `synthetic-actor-trace` |
| Substrate | reserved (never shipped) | none |
| Evidence stream | reserved (streams live inside the run bundle) | see [`run-bundle.md`](run-bundle.md) |
| Review | `mimetic.review.v1` | `contract-proof-review` |
| Verification | `mimetic.verify-result.v1` | `five-check-verify` |
| Policy | `mimetic.policy.v1` (fixture-only; not engine-validated) | `public-safety-policy` |
| Feedback | `mimetic.feedback.v1` | `public-safe-feedback` |
| Terminal cost ledger | `mimetic.terminal-cost-ledger.v1` | see Terminal Cost Ledger below |
| Terminal no-spend proof | `mimetic.terminal-no-spend-proof.v1` | see Terminal Cost Ledger below |
| Adapter score | `mimetic.adapter-score.v1` (`RunBundle.adapterScore`; namespaced; route-specific acceptance semantics) | see Product-Adapter Extension Seam below |
| Adapter artifact | `mimetic.adapter-artifact.v1` (`RunBundle.adapterArtifacts[]`; namespaced; local relative proof references) | see Product-Adapter Extension Seam below |
| Shared-world evidence | `mimetic.shared-world.v1` (additive `RunBundle.sharedWorld` + `RunBundle.attributionClass`; `topologyMode: sequential \| concurrent`) | see Shared-World Evidence below |

## Lab Manifest

Schema: `mimetic.lab.v2` (`src/lab-config.ts`). There is deliberately no v1
compatibility: v1 (`kind`, top-level `sims`) had zero real users and was
deleted when labs became config.

A lab is a composition over code primitives, not a hardcoded kind:

- `subject`: what the run acts on — `this-repo`, `clone` (owner/repo slugs,
  optional in-sandbox `serve` + env var names + `state`), `app-url`
  (loopback unless `policies.allowPublicTargets` declares an owned deployment),
  `local-app` (an already-running LOCAL dev server driven IN-PROCESS via a
  custom `CuaExecutor`, NO clone and NO E2B desktop — always loopback), or
  `terminal-product` (a CLI/product a real autonomous terminal agent studies
  from PUBLIC surfaces only — see below). A
  `local-app` subject pairs a computer-use actor with `execution.target: local`
  (or absent) and is library-assisted: the caller supplies
  `cuaHooks.buildExecutor` + `buildProvider`; with no hooks the engine fails
  closed (`MIMETIC_CUA_LAB_LOCAL_APP_NO_EXECUTOR`), never a desktop attempt. See
  [`docs/architecture/state-driven-executor.md`](../architecture/state-driven-executor.md);
- `subject.product` (terminal-product subjects): the product the agent studies.
  `product.name` is a public-safe token (committed fixtures use a NEUTRAL mock
  name); `product.publicSurfaces[]` is the list of http(s) URLs (docs, llms.txt,
  skill manifest) that are the ONLY world the agent sees — the lab does not
  clone/provision the product, so its provenance is recorded UNPINNED
  (invariant 5). `serve`/`clone`/`state`/`repos`/`appUrl` are rejected on a
  terminal-product subject (a field that cannot act on the route is a parse
  error, not silently dropped). See
  [`docs/architecture/terminal-product-lane.md`](../architecture/terminal-product-lane.md);
- `subject.state` (clone subjects, computer-use route): the subject's state
  story. `state.seed[]` declares ordered, bounded seed/migration/fixture steps
  (`{ name, command, when: before-build | before-start | after-ready,
  timeoutMs }`) executed in-sandbox around the serve sequence; `state.external[]`
  declares env var NAMES (each must also appear in `subject.env`) pointing at
  state the lab does not control, recorded as UNPINNED in provenance. Commands
  persist in evidence as sha256-16 digests only, never as text;
- `actors`: who drives it. On the computer-use and scripted-browser routes
  `actors[0].type` is a real dispatch key resolved against the actor registry;
  elsewhere it is a descriptive label (e.g. `synthetic-persona`).
  `actors[0].count` carries route-specific meanings: synthetic route lane
  count (simCount); scripted-browser route surface roster (1 = desktop,
  2 = desktop + mobile, default 1); computer-use **E2B** route the HOMOGENEOUS
  fan-out lane count (N identical lanes, each its own E2B desktop — per-lane
  worlds, cap 16). The in-process/local-app computer-use route stays single
  lane (no E2B to fan out);
- `actors[0].lanes[]` (computer-use E2B route): a DIFFERENTIATED fan-out roster,
  each `{ id?, actorType?, surface?, caseGroup?, persona?, device?,
  instruction?, target?, entry? }` becoming one independent E2B desktop (or, on the
  shared-world routes, one role/seat against the shared plane). `actorType`,
  `surface`, and `caseGroup` are adapter-owned public-safe labels for grouping
  simulated users; they are not core enums, and `actorType` is deliberately
  separate from the execution dispatch key `actors[0].type`. `lanes` is XOR with
  `count` (declare a roster OR a homogeneous count) and XOR with
  `actors[0].laneFocus` (a roster's per-lane `instruction` is the steer);
  `lanes[].device` is XOR with a raw `execution.desktop.resolution`. Lane ids
  default `lane-01`..`lane-NN`, must be unique, and name per-lane evidence paths
  (`actors/<streamId>.json`, `screenshots/<laneId>/`). Cap 16 lanes. On every
  non-cua route `lanes` is inert (warned). `subject.clone.fanout` is REJECTED on
  the cua route (declare fan-out via `count`/`lanes`; `clone.fanout` drives the
  OSS smoke/meta routes only);
- `actors[0].lanes[].target` (app-url × computer-use E2B route only): an
  absolute browser URL that lane opens instead of `subject.appUrl`. This is the
  setup-produced-target handoff for crawler/swarm labs: an adapter may start any
  topology it needs, then declare exactly which target each actor should drive.
  If any lane declares `target`, every lane in that roster must declare one.
  Public/non-loopback targets still require `policies.allowPublicTargets: true`.
  `target` is mutually exclusive with `entry`: `target` is an absolute app-url
  browser target; `entry` is a shared-world same-origin seat path;
- `actors[0].roster[]` (computer-use E2B route): compact authoring sugar for
  repeated lane groups, each `{ id, count, actorType?, surface?, caseGroup?,
  persona?, device?, instruction?, target?, entry? }`. The parser expands it into
  deterministic `lanes[]` before the engine runs (`viewer-01`, `viewer-02`,
  ...), so the runtime and run bundle keep one normalized lane shape. `roster`
  is XOR with explicit `lanes`, homogeneous `count`, and `laneFocus`;
- `execution.concurrency` (computer-use E2B route): bounds in-flight (paid)
  fan-out lanes; default `min(laneCount, 3)`. The env override
  `MIMETIC_CUA_MAX_CONCURRENCY` may only LOWER the effective bound, never raise
  concurrent paid desktops (invariant 3). Inert (warned) on other routes.
  `execution.timeoutMs` is the PER-LANE session budget on this route (semantics
  change: it was the single-session budget pre-fan-out); there is no run-level
  wall clock. `policies.allowPublicTargets` cannot combine with N>1 against one
  implicit public `subject.appUrl` (ambiguous shared-world-ish topology); it may
  combine with N>1 only when the roster declares explicit `lanes[].target` for
  every lane;
- `execution`: where it runs — `local`, `e2b-desktop`, or `e2b-terminal`, plus
  desktop device/resolution and timeouts. app-url subjects pair `e2b-desktop`
  with a computer-use actor, or `local` (or absent) with a scripted-browser
  actor; terminal-product subjects pair `e2b-terminal` (or absent → implied)
  with a registered terminal actor;
- `execution.desktop.template` (e2b-desktop computer-use routes): a custom E2B
  desktop TEMPLATE (image) NAME or ID the run launches on — for a subject that
  needs runtimes the stock `desktop` image lacks (e.g. node/bun/a local Postgres
  baked into an adopter-maintained image). Any non-empty string is a valid
  name/id (no allowlist); a blank/whitespace value is rejected. Threaded to the
  SDK's `Sandbox.create(template, opts)` on EVERY desktop-creating route (the
  single-lane + fan-out cua lanes, the sequential shared-world plane, and the
  concurrent shared-world subject AND every actor sandbox); when absent the call
  stays the byte-stable `Sandbox.create(opts)` default (the stock template). The
  template actually used is recorded in the run bundle as `desktopTemplate`
  (public-safe — a template name is not a secret). Inert (warned) on every route
  that creates no desktop, incl. the in-process `local-app` cua route and the
  meta route — never silently ignored (invariant 6);
- `execution.desktop.browser` (e2b-desktop computer-use/fan-out routes, plus
  sequential and concurrent shared-world actor seats): optional browser family
  preference: `default`, `chrome`, `chromium`, or `firefox`. Absent/default
  preserves the historical desktop opener behavior. A concrete value means
  launch that browser or fail closed; when configured, the bundle records
  `desktopBrowser` with the requested value and the resolved in-sandbox command
  when known. Inert (warned) where this route-specific browser launcher is not
  used;
- `execution.terminal` + `execution.runtimeAuth` (terminal-product route):
  `terminal.transport` is `exec-stream` — captured NON-interactive exec output
  (stdin disabled); `pty` is rejected because labeling captured exec output as
  an interactive PTY would overstate the mechanism (invariant 6; a true duplex
  PTY transport is a deferred slice). `terminal.stdin` defaults to `disabled`
  (`sent`/assisted input is rejected until the interventions ledger + a
  non-comparable marker exist). `runtimeAuth: openai-env` declares the agent's
  runtime-auth channel — recorded as NAMES ONLY; the command-scoped injection
  (`keyPlacement: in-sandbox-command-scoped`) is enforced by the engine in a
  later slice;
- `scenario`: `mode: dry-run` (contract evidence, no spend) or `live`.
  `scenario.ref` is CONSUMED (and REQUIRED) on the scripted-browser route: it
  resolves a committed scenario (`mimetic/scenarios/<ref>.yaml` or a repo
  path) whose `browser.steps` ARE what the actor executes, digest-pinned into
  bundle provenance; on other routes `ref`/`inline` stay forward-declared
  warnings. On the scripted route `live` gates real browser ACTUATION against
  the declared app — provider spend stays $0 by mechanism (no model runs);
- `scenario.caps` (terminal-product route): `{ maxUsd, maxJobs, maxMinutes }`,
  all non-negative numbers (0 = no-spend, the default). The blast-radius budget
  that bounds the in-sandbox live key by MECHANISM, not by hope — the live key
  is never exercised without a fail-closed cap in force. `maxMinutes` is the
  wall-clock kill; `maxUsd`/`maxJobs` are enforced fail-closed against the cost
  ledger (a run whose KNOWN spend exceeds the cap fails closed,
  `MIMETIC_TERMINAL_LAB_CAPS_EXCEEDED`). The no-spend proof is derived from that
  real ledger, never asserted (see Terminal Cost Ledger And No-Spend Proof).
  Inert (warned) on every other route;
- `policies`: `redactRepos`, `redactScreenshots`, `allowPublicTargets`, and the
  terminal-product credential-boundary booleans `allowPrivateRepoAccess`,
  `allowProviderCredentials`, `allowPaymentCredentials`, `allowGitHubMutation`
  (all DEFAULT FALSE — deny-by-default; only the runtime LLM key enters, and
  only command-scoped). The scripted-browser route is loopback-only and rejects
  `redactScreenshots: true` (blur unimplemented there) and
  `allowPublicTargets: true` fail-closed rather than ignoring them.

Lab backends report results in their own schemas (`mimetic.run-result.v1`,
`mimetic.oss-lab-result.v1`, `mimetic.oss-meta-lab-result.v1`,
`mimetic.cua-lab-result.v2`, `mimetic.scripted-lab-result.v1`,
`mimetic.terminal-lab-result.v1`); the evidence record stays
`mimetic.run-bundle.v1` in every case. The computer-use result bumped to v2 for
fan-out: it carries `plan` (the pre-flight lane table — concurrency, waves,
per-lane session budget, worst-case sandbox-minutes), `lanes[]` (ALWAYS present,
length 1 at N=1; per-lane status/session/sandbox/subject), and `laneSummary`
(passed/skipped/harnessError/hollow counts). The top-level `session`/`sandbox`
mirror the first lane and `subject.commit` is unanimity-gated across lanes
(omitted with a divergence warning when lanes resolve different commits). At N=1
the run bundle is byte-stable with the pre-fan-out output; only the result
projection changed. A fan-out run records a `cua-lab.fanout.plan` bundle event
(and a `cua-lab.fanout.fail-fast` event when a harness error skips queued lanes);
`ok = observer.ok ∧ no skipped lane ∧ all lanes terminal ∧ no harness error ∧ no
hollow lane`.

Explicit failed-lane reruns are supported on the CUA fan-out route via
`mimetic lab run <lab> --rerun-failed-from <run-id> [--lanes lane-a,lane-b]`.
The source run must be a live CUA fan-out bundle. Mimetic creates a NEW run for
the selected failed/blocked/timed-out/hollow lanes (or explicit lane ids), leaves
the source verdict unchanged, and records lineage as `run.rerun` plus a
`cua-lab.fanout.rerun` event: source run id, selected lane ids, and previous lane
statuses/reasons. This is intentionally not automatic retry; a passing rerun is a
nondeterminism candidate for human/product scoring, not a rewrite of the old run.

Manifests are human-authored `.yaml` source under `mimetic/labs/*.yaml` for
committed public-safe labs, or ignored `.mimetic/labs/*.yaml` /
`.mimetic/local/labs/*.yaml` for private local dogfood. Fields the engine does
not yet consume are accepted but reported as warnings (`mimetic lab inspect`
shows them), so a manifest never silently claims behavior that did not run.

Committed fixture (`mimetic/labs/first-run.yaml`):

```yaml
schema: mimetic.lab.v2
id: first-run
title: First-run synthetic Observer
description: Public-safe starter lab that generates a synthetic run bundle and Observer without provider spend.
subject:
  source: this-repo
actors:
  - type: synthetic-persona
    count: 4
scenario:
  mode: dry-run
defaults:
  open: true
```

## Run Bundle

Run bundles are the canonical evidence record. Observer data, review Markdown,
feedback drafts, and issue text are projections from the bundle.

Core-owned fields:

- `schema`
- `runId`
- `mode`
- `simCount`
- `createdAt`
- `artifactRoot`
- `source.git`
- `lifecycle`
- `simulations`
- `streams`
- `events`
- `redaction`
- `artifacts`
- `review`
- `feedbackCandidates`
- `subject` (optional, additive): structured subject provenance —
  `{ source: clone | app-url, repo?, commit?, envNames?, state }` where `state`
  is `{ provenance: seeded | unpinned | declared-not-run | undeclared,
  seed?: [{ name, when, commandDigest, ok?, exitCode?, timedOut?, durationMs? }],
  externalEnvNames? }`. Emitted by the computer-use backend; absent on
  pre-existing and other backends' bundles. `commandDigest` is the sha256-16 of
  the exact seed command — command text and env values never appear. Verified
  by the `subject state provenance` check in `mimetic verify`.
- `desktopTemplate` (optional, additive): the custom E2B desktop TEMPLATE (image)
  the run's sandbox(es) launched on, from `execution.desktop.template` — so the
  evidence shows WHICH image ran. Present only when a template was configured;
  absent == the stock `desktop` template, so every pre-existing bundle is
  byte-stable. Public-safe (a template name is not a secret).
- `attributionClass` (optional, additive): `isolated | shared-world`. Absent ==
  `isolated`, so every existing bundle is byte-stable. The interaction-attribution
  honesty axis (#164) — ORTHOGONAL to the persona-sampling evidence classes. Set
  to `shared-world` by the shared-world backend, paired with `sharedWorld`.
- `sharedWorld` (optional, additive): the shared-world evidence block
  (`mimetic.shared-world.v1`) — see [Shared-World Evidence](#shared-world-evidence)
  below. Present only on shared-world runs; verified fail-closed by the
  `shared-world evidence` check in `mimetic verify`.

Adapter-owned fields:

- `source.packageName`
- `source.mimeticSource`
- `persona`
- `scenario`
- target-specific stream labels and public-safe summaries

Synthetic fixture:

```yaml
schema: mimetic.run-bundle.v1
runId: synthetic-run-bundle-2026-06-02t10-00-00-000z-proof
mode: dry-run
simCount: 1
createdAt: "2026-06-02T10:00:00.000Z"
artifactRoot: .mimetic/runs/synthetic-run-bundle-2026-06-02t10-00-00-000z-proof
source:
  packageName: fixture-app
  mimeticSource: present
  git:
    schema: mimetic.git-state.v1
    status: clean
    capturedAt: "2026-06-02T10:00:00.000Z"
    head:
      shortSha: null
      refState: unknown
    changes:
      staged: 0
      unstaged: 0
      untracked: 0
      total: 0
    note: public-safe synthetic fixture
persona:
  id: synthetic-maintainer
  name: Synthetic Maintainer
  source: mimetic/personas/synthetic-maintainer.yaml
  sourceDigest: synthetic
scenario:
  id: first-run-smoke
  title: First-run smoke
  goal: Prove setup and verification without private data.
  source: mimetic/scenarios/first-run-smoke.yaml
  sourceDigest: synthetic
lifecycle:
  - at: "2026-06-02T10:00:00.000Z"
    event: run.created
    message: Created synthetic contract fixture.
redaction:
  status: passed
  notes: Synthetic fixture only.
artifacts:
  run: run.json
  reviewJson: review.json
  reviewMarkdown: review.md
  observerData: observer/observer-data.json
  events: events.ndjson
review:
  schema: mimetic.review.v1
  verdict: contract_proof_only
  summary: Synthetic contract fixture generated.
  gaps: []
feedbackCandidates: []
```

## Shared-World Evidence

The shared-world topology (#164) is the DECLARED override of the per-lane-worlds
default: N distinct actor ROLES drive ONE provisioned, mutable service plane (one
app + one seeded DB) so their actions interact through shared state. A shared-world
bundle adds TWO additive, optional fields to `mimetic.run-bundle.v1` (absent on
every other bundle, so they stay byte-stable):

- `attributionClass: isolated | shared-world` — a new, ORTHOGONAL honesty axis
  ("how well did the run attribute INTERACTION?"), distinct from the persona-sampling
  evidence classes ("how representative is the actor?"). Absent == `isolated`.
- `sharedWorld` (`mimetic.shared-world.v1`): TWO variants discriminated by
  `topologyMode: "sequential" | "concurrent"` (validateSharedWorldEvidence branches on
  it FIRST; unknown/missing or a mismatched shape fails closed). Common fields:
  - `topology: shared-world`
  - `topologyMode: sequential | concurrent`
  - `roleCount` — the DECLARED number of role/persona seats.
  - `plane: { commit?, seedDigest, envNames, hostDigest?, exposure? }` — the ONE
    shared-plane provenance. `seedDigest` is the sha256-16 of the ordered seed-step
    command digests (the seed RECIPE identity, not the runtime state); `envNames` are
    NAMES only. `hostDigest`/`exposure` are CONCURRENT-only (below).
  - `attributionLimits: [...]` — the verify-enforced attribution ceiling (the set
    differs per `topologyMode`, below).

  SEQUENTIAL shape (`topologyMode: sequential`, #164 PR1):
  - `sequence: [roleId, …]` — the role ids that actually took a turn, in declared order.
  - `timeline: (checkpoint | turn)[]` — a harness-clocked, strictly alternating
    timeline that starts `cp-baseline`, alternates checkpoint → turn → checkpoint,
    and ends on a checkpoint:
    - checkpoint = `{ kind: checkpoint, name, digest, deltaFromPrev }` — `digest` is
      sha256-16(scrub+redact(probe stdout)); the record is DIGEST-ONLY (no
      value-shaped field). `deltaFromPrev` is true when the observed state changed
      across the intervening turn.
    - turn = `{ kind: turn, roleId, simId, streamId, commit?, seedDigest }` — references
      a real RunSimulation/RunStream; carries the plane provenance it observed
      (identical across turns by construction — the single-plane proof).
  - Sequential `attributionLimits` MUST contain `sequential-only`, `no-concurrent-races`,
    and `delta-attributed-to-turn-not-action`.

  CONCURRENT shape (`topologyMode: concurrent`, #164 phase 2 — N personas drive ONE
  getHost-exposed plane AT ONCE; NO `timeline`/`sequence`):
  - `plane.hostDigest` — sha256-16 of the harness-minted `getHost` ORIGIN every actor
    drove (a first-class provisioned-subject target — invariant 2). A DIGEST, not the raw
    URL: a getHost URL embeds the live sandbox id and matches the publish-safety e2b-URL
    redaction, so it never lands raw in a published bundle (the raw tokenless URL is
    surfaced only on the ephemeral lab result). The orchestrator confirms the URL is
    TOKENLESS (no authKey — invariant 1) before digesting.
  - `plane.exposure: synthetic` — the REQUIRED author attestation that the subject behind
    the internet-reachable getHost URL is synthetic seeded data (author-trust + a
    provenance gate, NOT a no-real-data guarantee).
  - `laneWindows: [{ roleId, simId, streamId, startedAt, endedAt, verdict, routeHostDigest,
    commit?, seedDigest }]` — one harness-clocked window per actor; OVERLAPPING windows
    prove ≥2 personas were active simultaneously. `routeHostDigest` == `plane.hostDigest`
    (every actor drove exactly the harness-minted host).
  - `stateSeries: [{ timestamp, digest }]` — cadence digests of the shared world under
    load (baseline + periodic + final). DIGEST-ONLY: the allowed-keys tripwire permits
    ONLY `timestamp` + `digest` (no per-delta→actor field — causation under concurrency is
    structurally inexpressible).
  - `outcomes: [{ roleId, simId, streamId, status, completionReason?, ok }]` — per-persona
    OUTCOME (the "M of N succeeded" headline).
  - Concurrent `attributionLimits` MUST contain `concurrent`,
    `best-effort-causal-attribution`, `non-deterministic-shared-state`,
    `window-and-snapshot-granularity`, `contention-observed-not-proven-safe`,
    `state-change-not-isolated-to-actors`, and MUST NOT contain `sequential-only` or
    `no-concurrent-races` (a sequential guarantee on a concurrent run is an overclaim).

The `shared-world evidence` check in `mimetic verify` is fail-closed (live runs only;
dry-run contract bundles are skipped). It dispatches on `topologyMode` FIRST.
SEQUENTIAL: the timeline must be well-formed (start `cp-baseline`, strictly alternate,
end on a checkpoint, turn order == sequence, sequence length == roleCount == turn
count, no `laneWindows`); every turn's simId/streamId resolves; every checkpoint digest
is sha256-16 with NO value-shaped field; all turns share ONE plane provenance; the
mandatory limits are present; and a PASSED run shows ≥1 checkpoint `deltaFromPrev` (the
delta-on-pass gate). CONCURRENT: no `timeline`; laneWindows + stateSeries + outcomes
cover exactly roleCount; the required limits are present AND the forbidden ones absent;
`plane.hostDigest` present and every `routeHostDigest` equals it (invariant 2);
`plane.exposure == synthetic` AND `subject.state.provenance == seeded` (the
synthetic-subject gate); stateSeries snapshots are digest-only (allowed-keys tripwire);
all laneWindows share ONE plane provenance; and the CONCURRENCY-ON-PASS gate — a PASSED
run MUST show ≥2 overlapping laneWindows AND a stateSeries delta whose timestamp is
AT/AFTER an overlap interval start (otherwise it was not actually concurrent, or the
world never changed under load). The per-role no-engagement guard applies to both.
Checkpoints / stateSeries persist digest-only by DEFAULT until the #108 PII/PHI
detector lands.

WHAT THE BUNDLE CAN / CANNOT CLAIM. SEQUENTIAL: each role's own behavior at full
fidelity; the OBSERVED system outcome as an ordered DIGEST sequence; and the
SEQUENCED-INTERACTION proof (role B entered a world already containing role A's mutation
— the checkpoint after A strictly precedes B's turn). It CANNOT claim action-granular
causation, concurrency/races (sequential-only), or exact-state determinism. CONCURRENT:
each persona's own behavior at full fidelity; per-persona OUTCOME against the contended
world ("M of N"); PROVEN CONCURRENCY (overlapping windows); and system-state evolution
under load (the stateSeries) with best-effort temporal correlation. It CANNOT claim
strict causal attribution of a delta to an actor (concurrent ⇒ ambiguous), determinism
of exact state, per-action granularity, or concurrency-SAFETY (races are OBSERVED, never
PROVEN absent). HONESTY: the deterministic $0 gate proves the plumbing + the attribution
contract; the concurrency CAPABILITY at scale is backed only by a separately-authorized
live receipt.

## Adapter

Adapters describe target-specific affordances without changing core contracts.

Core-owned fields:

- `schema`
- `id`
- normalized route/reference shape
- public-safety validation of adapter references

Adapter-owned fields:

- `name`
- `routes`
- route descriptions
- target-specific commands, paths, milestones, and vocabulary

Synthetic fixture:

```yaml
schema: mimetic.adapter.v1
id: synthetic-cli-adapter
name: Synthetic CLI Adapter
routes:
  - id: help
    path: synthetic-cli --help
    description: Public-safe command discovery.
  - id: dry-run
    path: synthetic-cli run --dry-run --json
    description: Generate a synthetic run bundle.
```

## Persona And Scenario

Personas and scenarios define trial intent. They are adapter-owned source
documents that core copies into run bundles by digest and id.

Core-owned fields:

- schema naming rules
- id/source/sourceDigest references inside run bundles
- redaction gates before persona/scenario text can appear in public feedback

Adapter-owned fields:

- persona traits
- scenario goals
- steps and expectations
- accessibility or workflow constraints

Synthetic fixture:

```yaml
persona:
  schema: mimetic.persona.v1
  id: synthetic-maintainer
  name: Synthetic Maintainer
  summary: Privacy-safe maintainer evaluating first-run clarity.
  constraints:
    - Do not use real personal data.
    - Treat credentials as env var names only.
scenario:
  schema: mimetic.scenario.v1
  id: first-run-smoke
  title: First-run smoke
  persona: synthetic-maintainer
  goal: Prove setup, dry-run evidence, verification, and feedback drafting.
  mode: dry-run
  steps:
    - name: Inspect help
      expectation: Help explains setup and verification commands.
    - name: Verify bundle
      expectation: Verification passes without private data.
```

## Actor Trace

Actors execute or simulate the trial. Actor evidence is the provider-neutral
`mimetic.actor-trace.v1` (`src/actor-contract.ts`): Codex app-server items,
Claude Agent SDK blocks, pi events, computer-use cycles, scripted browser
steps, and in-sandbox terminal-agent exec output all map onto one `ActorTrace`.
Registered actors live in
`src/actor-registry.ts` (`codex-app-server`, `pi-agent-core`,
`claude-agent-sdk`, `openai-computer-use`, `scripted-browser`, `codex-exec`).
There is no `mimetic.actor.v1`; that name never shipped.

Core-owned fields:

- `schema`
- `provider` / `providerVersion`
- `protocol` (`json-rpc` | `json-stream` | `in-process-sdk` | `cua-loop` |
  `scripted-steps` | `terminal-exec`)
- `lane` (`code` | `app` | `computer-use` | `scripted-browser` | `terminal`)
- `persona` (`id`, `traitsApplied`, `promptDigest`)
- `capabilities.keyPlacement` (`external` | `in-sandbox-command-scoped`): WHERE
  the actor's runtime key lives — registry metadata the engine enforces. The
  terminal agent declares `in-sandbox-command-scoped` (the agent-under-test runs
  inside the sandbox); every other actor is `external` (absent === external).
- `redaction` (`status`, `screenshots: n/a|raw|blurred|ocr_scrubbed`, `notes`)
- `startedAt` / `completedAt` / `durationMs`
- `status` / `completionReason` / `reason` (`completionReason` includes
  `step_failed`: a deterministic scripted step/expectation evaluated false —
  the subject failed the script while the harness executed faithfully)
- `ids`, `counts`, `items[]`, optional `diagnostic`, optional `tokenUsage`,
  `capabilities`

`diagnostic` is only for unexpected actor-loop failures. It is public-safe
evidence, not a crash dump: redacted message, coarse phase, optional error name,
last normalized UI action, and last screenshot reference. It must not carry raw
stacks, env values, target URLs, or unredacted provider payloads.

Adapter-owned fields:

- the prompt, mission, persona text, and lane focus that produced the trace
- product-specific acceptance notes

Synthetic fixture (abridged; see `src/actor-contract.ts` for the full type):

```yaml
schema: mimetic.actor-trace.v1
provider: codex-app-server
protocol: json-rpc
lane: code
persona:
  id: synthetic-maintainer
  traitsApplied: []
  promptDigest: synthetic
redaction:
  status: passed
  screenshots: n/a
  notes: Synthetic fixture only.
startedAt: "2026-06-02T10:00:00.000Z"
completedAt: "2026-06-02T10:00:01.000Z"
durationMs: 1000
status: passed
completionReason: turn_completed
reason: Synthetic dry-run fixture completed.
ids: {}
counts: {}
items: []
```

## Substrate

Reserved: `mimetic.substrate.v1` is named here for layering intent but has
never shipped — no code emits or validates it. Substrate truth today lives
inside run bundles (per-stream transport and status) and lab execution config
(`execution.target: local | e2b-desktop`). Do not emit this schema.

## Terminal Cost Ledger And No-Spend Proof

The terminal-product lane (`src/e2b-terminal-lab.ts`) places a real provider key
INSIDE the sandbox, so the no-spend claim must be REAL — derived from a ledger,
never asserted. The live run writes both to `terminal-ledgers.json` (a `cost`
block + a `noSpendProof` block, additive to `mimetic.terminal-ledgers.v1`).

The cost ledger (`mimetic.terminal-cost-ledger.v1`) has one line per category —
`product`, `media`, `payment`, `provider` — and follows a strict **null
discipline** that distinguishes three states and never conflates them:

- `usd: 0` — **known zero**: the category was metered and billed nothing.
- `usd: null` — **not measured**: no spend signal exists for the category this
  slice. `null` is written explicitly (never `undefined`-omitted, never guessed
  to `0`). A line with `null` says "this category exists but we did not measure
  it"; the no-spend proof reports it as unmeasured and does NOT claim it is zero.
- line **absent** — **not applicable** (n/a) to the lane/run.

`knownTotalUsd` sums ONLY the non-null lines (a `null` line contributes nothing
and is never coerced to `0`); `fullyMeasured` is true only when no line is null.
This slice meters only the `provider` line, populated from the actor trace's
`tokenUsage.costUsd` when present (else `null`); `product`/`media`/`payment` are
`null` until the SLICE-4 adapter supplies them.

```yaml
schema: mimetic.terminal-cost-ledger.v1
currency: usd
lines:
  product: { usd: null, count: null, source: unmeasured, note: "…no signal yet…" }
  media: { usd: null, count: null, source: unmeasured, note: "…no signal yet…" }
  payment: { usd: null, count: null, source: unmeasured, note: "…no signal yet…" }
  provider: { usd: null, source: unmeasured, note: "…no tokenUsage.costUsd this run…" }
knownTotalUsd: 0
fullyMeasured: false
```

The no-spend proof (`mimetic.terminal-no-spend-proof.v1`) is DERIVED from the
ledger. It vouches only for what it measured: `knownZeroLines` (proven zero),
`knownNonZeroLines` (break `satisfied`), and `unmeasuredLines` (the `null` lines
it explicitly CANNOT vouch for). `satisfied` is true only when every KNOWN line
is within `maxUsd` (for a no-spend run, `maxUsd: 0` ⇒ every known line is `0`);
unmeasured lines never make it satisfied. A proof never claims zero on a `null`
line — verification fails closed if it does.

```yaml
schema: mimetic.terminal-no-spend-proof.v1
maxUsd: 0
satisfied: true
knownZeroLines: []
knownNonZeroLines: []
unmeasuredLines: [product, media, payment, provider]
knownTotalUsd: 0
statement: "No-spend proof SATISFIED for maxUsd=0: every MEASURED spend line is zero…"
```

**Full caps enforcement (fail-closed, not advisory).** `scenario.caps.maxUsd`
is enforced against the ledger: if the observed KNOWN spend exceeds `maxUsd`, the
run fails closed (`MIMETIC_TERMINAL_LAB_CAPS_EXCEEDED`); `maxJobs` likewise when
a known job count is present; `maxMinutes` is the wall-clock kill (unchanged).
Unknowns (`null`) never trip a cap (we cannot claim a violation we did not
measure) and never grant a green pass (they surface as unmeasured). `verifyRun`
fails closed when a live bundle lacks the cost ledger or no-spend proof, when the
proof claims zero on a `null` line, or when known spend exceeds the declared cap.

## Product-Adapter Extension Seam

The terminal-product and browser/computer-use lanes let an adopter attach
product-specific scoring + feedback as a THIN in-repo extension WITHOUT forking
core. The seam is the EXPORTED contract types plus DI hooks:
`TerminalProductLabHooks` for terminal-product runs, and the browser adapter
hooks inherited by `CuaActorLabHooks` / `SharedWorldLabHooks` for CUA,
sequential shared-world, and concurrent shared-world runs. This is never a
built-in product scorer (the adopter's scorecard lives in the adopter's repo).

Three product-agnostic carriers keep core's nouns closed while letting the adapter
record its own:

- **Adapter score** (`mimetic.adapter-score.v1`, `RunBundle.adapterScore`).
  A namespaced summary the adapter's `score` hook returns: `{ schema, namespace,
  status, score, summary, data? }`. Core never reads `data` — the adopter's
  component rubric rides there; `namespace` (an adopter slug) scopes the whole
  record so a future inert-field audit never misfires.
- **Namespaced product-noun block** (`RunFeedbackCandidate.adapter`). The
  adapter's `deriveFeedback` hook returns feedback candidates that satisfy core's
  feedback-candidate shape; product-specific concepts (public CLI/product command
  observed, hosted product success-or-blocker, feedback id/draft, media/job/asset
  ids, explicit no-media/no-provider-spend proof, defection/friction risk) are
  recorded ONLY under `adapter: { namespace, data }` — never as core enums. Core
  validates the SHAPE (a non-empty `namespace` + a `data` record); the keys inside
  `data` are the adapter's.
- **Adapter artifacts** (`mimetic.adapter-artifact.v1`,
  `RunBundle.adapterArtifacts[]`). A namespaced list of local relative artifact
  references the adapter's `deriveArtifacts` hook returns after writing
  product/state proof files under the ignored run directory. Core validates only
  schema/namespace/label/path/kind/note and local-path safety, Observer links the
  artifacts, and `verifyRun` fails closed if a referenced file is missing.

```yaml
# RunBundle.adapterScore (namespaced; data is the adopter's, core never reads it)
schema: mimetic.adapter-score.v1
namespace: adopter-slug
status: pass
score: 88
summary: Product study scored by the adopter's own rubric.
data: { productRubric: { discovery: 1, firstImage: 1 }, hostedProductSucceeded: true }
```

```yaml
# RunFeedbackCandidate.adapter — product nouns stay NON-core under the namespace
adapter:
  namespace: adopter-slug
  data:
    publicCommandObserved: "product generate --prompt '…'"
    hostedProductOutcome: success
    feedbackId: null
    mediaJobIds: []
    noMediaSpendProof: { mediaUsd: null, providerUsd: 0 }
    defectionFrictionRisk: low
```

```yaml
# RunBundle.adapterArtifacts — product/state proof payloads stay adapter-owned
- schema: mimetic.adapter-artifact.v1
  namespace: adopter-slug
  label: Product state readback
  path: adapter/product-state-readback.json
  kind: state
  note: Adapter-owned product/state proof.
```

Acceptance semantics are route-specific:

- Terminal-product runs keep the mission-based `review` verdict unchanged; the
  adapter score is additive because the route is a public-product study lane.
- Browser/computer-use runs treat `adapterScore.status: fail` as product-red:
  the bundle keeps the adapter score, `review.verdict` becomes `fail` when it
  was pass-like, a generic adapter gap is appended, and the route result returns
  `ok: false`. This closes the false-positive class where a generic actor reaches
  a terminal session but an adopter scorer finds no product-visible completion
  evidence.

The `e2b-terminal` substrate is added to `RunFeedbackCandidate.substrate` so a
terminal-agent candidate names its substrate honestly; browser candidates use
the existing `e2b-desktop` substrate. Lanes invoke hooks over FULLY-ASSEMBLED,
redacted evidence (`TerminalProductScoringContext` or
`BrowserLabScoringContext`: `bundle`, runtime-only `runDir`, run identifiers,
actor/backend metadata; all exported public types), scrub+redact returned
payloads, and DROP any malformed score, candidate, or artifact reference with a
warning so a bad extension never poisons a verifiable bundle. Default behavior
(no hook) is unchanged. `verifyRun` re-checks the surviving shapes fail-closed,
including existence for referenced adapter artifacts.

## Evidence Streams

Reserved: `mimetic.evidence-stream.v1` has never shipped as a standalone
schema, and streams are not standalone artifacts. They are the `streams` array
inside `mimetic.run-bundle.v1`, normalizing UI, browser, terminal, TUI,
code-agent UI, artifact, and summary lanes — each with transport, terminal
tail, completion, meaningful-use verdicts, and artifact pointers. See
[`run-bundle.md`](run-bundle.md#completion-and-meaningful-use-verdicts) for
the stream shape, the meaningful-use rubric, and hard-failure rules.

## Review

Review summarizes whether evidence supports the claim. It does not replace
verification or maintainer acceptance.

Core-owned fields:

- `schema`
- `verdict`
- `summary`
- `gaps`

Adapter-owned fields:

- vocabulary labels
- milestone names
- product-specific gap language

Synthetic fixture:

```yaml
schema: mimetic.review.v1
verdict: contract_proof_only
summary: Synthetic dry-run proves bundle shape, not product behavior.
gaps:
  - Live product behavior was not exercised.
```

## Verification

Verification checks bundles and evidence pointers. It fails closed when schema,
redaction, or artifacts are missing.

Core-owned fields:

- `schema`
- `ok`
- `run`
- `bundlePath`
- check names
- check booleans
- `warnings` (advisory postures, e.g. raw screenshots; never flip `ok`)
- machine-readable error codes

Adapter-owned fields:

- optional target-specific checks
- acceptance proof commands
- coverage-specific check names

Synthetic fixture:

```yaml
schema: mimetic.verify-result.v1
ok: true
run: synthetic-run-bundle-2026-06-02t10-00-00-000z-proof
bundlePath: .mimetic/runs/synthetic-run-bundle-2026-06-02t10-00-00-000z-proof/run.json
checks:
  - name: run.json exists
    ok: true
    message: run.json present
  - name: redaction passed
    ok: true
    message: redaction status must be passed
```

## Policy

Policy names boundaries before an actor runs or feedback is promoted.
`mimetic.policy.v1` exists today only as an adapter fixture shape
(`adapters/fixtures/`); the engine does not validate it. The committed policy
source files scaffolded by `mimetic init` use `mimetic.redaction-policy.v1`,
`mimetic.network-policy.v1`, and `mimetic.credentials-policy.v1`.

Core-owned fields:

- `schema`
- policy kind
- default action
- validation outcome
- redaction status
- no-secret-value persistence rules

Adapter-owned fields:

- allowed env var names
- allowed public hosts
- app-specific credential manifest
- network allowlist
- scenario-specific authority

Synthetic fixture:

```yaml
schema: mimetic.policy.v1
kind: public-safety
default: deny_sensitive_material
deny:
  - pii
  - phi
  - secrets
  - tokens
  - raw_private_transcripts
  - private_screenshots
allow:
  - synthetic_personas
  - synthetic_fixtures
  - env_var_names
credentialManifest:
  - envName: OPENAI_API_KEY
    valuePersisted: false
network:
  default: local_only
  allowedHosts:
    - localhost
```

## Feedback

Feedback turns verified evidence into public-safe issue draft material. The
default public CLI prints issue text or a prefilled URL; it does not mutate
GitHub.

Core-owned fields:

- `schema`
- run/source/evidence pointers
- redaction status
- idempotency key
- proposed next state
- failure owner enum
- public issue eligibility gates

Adapter-owned fields:

- adapter id
- scenario id
- persona id
- expected/actual language
- target-specific reproduction steps
- acceptance proof commands

Synthetic fixture:

```yaml
schema: mimetic.feedback.v1
run_id: synthetic-run-bundle-2026-06-02t10-00-00-000z-proof
adapter_id: synthetic-cli-adapter
scenario_id: first-run-smoke
persona_id: synthetic-maintainer
actor: synthetic-dry-run
substrate: local-filesystem
failure_owner: harness
summary: Synthetic user needed clearer verification instructions.
expected: Verification command is visible and public-safe.
actual: Dry-run review noted missing live behavior proof.
source_bundle: .mimetic/runs/synthetic-run-bundle-2026-06-02t10-00-00-000z-proof/run.json
evidence:
  - path: .mimetic/runs/synthetic-run-bundle-2026-06-02t10-00-00-000z-proof/review.md
    kind: review
    note: Public-safe synthetic review.
redaction:
  status: passed
  notes: Synthetic fixture only.
idempotency_key: synthetic-cli-adapter:first-run-smoke:verification-instructions
proposed_next_state: watch
acceptance_proof:
  - pnpm mimetic -- verify --run latest --json
```

## Contract Stop Conditions

Do not promote a contract fixture when:

- it needs private artifact data to make sense;
- it contains credential values instead of env var names;
- it embeds raw hosted stream URLs or auth-bearing links;
- it uses product-specific private nouns in a core-owned schema;
- it implies GitHub mutation without explicit maintainer authority;
- it cannot be proven with `git diff --check` and public-surface scanning.
