# Goal: complete proof-roadmap layers 1–2 (state, scripted actor, fan-out)

Status: ratified 2026-06-11. Decisions below came from a four-design adversarial pass
(two competing fan-out designs scored and synthesized by a judge; all designs audited by
a doctrine critic against `docs/principles/invariants-and-defaults.md`). This packet is
the single ratification record the critic called for: the defaults-layer judgment calls
are settled HERE, once, not re-litigated per PR.

## The three slices and their merge order

Order is load-bearing: **state → scripted actor → fan-out (per-lane) → seed-fork**.
All three touch `parseLabConfig`'s cross-validation and `forwardDeclaredWarnings`;
both fan-out PRs rewrite `cua-actor-lab.ts`'s live block, so they land last. Each PR's
parse-matrix tests must assert the OTHER routes' warnings still fire (a de-warn or
rejection-lift landing without its consumer in a bad rebase is the failure mode).

### Slice 1 — `subject.state`: the seed/migrate/fixtures primitive (layer 1)

Clone subjects declare ordered state steps (`subject.state.seed[]`, each
`{name, command, when: before-build|before-start|after-ready, timeoutMs}`) executed by
the existing detached-step machinery inside `provisionCloneSubject`, plus
`subject.state.external[]` (env NAMES, must be ⊆ `subject.env`) declaring state the lab
does not control. Provenance lands as a structured bundle block: per-step records with
command DIGESTS (never command text), and a four-value state marker — `seeded`,
`unpinned`, `undeclared`, `declared-not-run` (dry-run). Steps are author-trusted (the
serve-commands trust class); failures fail closed with the existing
scrub-before-truncate tail chain.

Ratified with the critic's four fixes:
1. verify fails any LIVE bundle whose review verdict is `pass` while carrying a seed
   step record with `ok !== true` — regardless of marker (closes the hollow-seeded ×
   unpinned hole);
2. verify also rejects marker `seeded` on a dry-run bundle (symmetry: a contract bundle
   cannot claim executed state);
3. `GITHUB_TOKEN` is mechanically excluded from the "env provisioned but state
   undeclared" warning (the harness itself consumes that name for clone auth); the
   warning emits once per bundle, never per stream;
4. the four-value marker enum is ratified as-is (`declared-not-run` is a real fourth
   state; folding it into `undeclared` would be a claims-mechanism lie).

### Slice 2 — register the scripted browser driver as a real actor (layer 1)

Move-only extraction of the BrowserPersona driver out of `run.ts` into a leaf module
(forced by import topology: `run.ts` already imports from the registry), registered as
actor id `scripted-browser`, dispatched by capability lane (mirror of
`isCuaActorDescriptor`). New composition routes to a new backend: `subject.source:
app-url` (loopback-only, mechanical) × `execution.target: local` × scripted-browser
actor, with `scenario.ref` promoted from forward-declared to CONSUMED (names a
`humanish/scenarios/*.yaml`; no builtin fallback on the lab route — the steps ARE the
actor). `humanish run --app-url` behavior stays byte-identical.

Ratified trace-vocabulary additions to `humanish.actor-trace.v1` (additive, conformance
suite updated in the same PR): lane `"scripted-browser"`, protocol `"scripted-steps"`,
completionReason `"step_failed"` (the subject failed the script's predicate — distinct
from `actor_error`, where the harness failed to execute).

Ratified with the critic's fixes:
1. default surface count is **1** (the defaults table's single-lane row governs; a
   default of 2 would make fan-out the undeclared default). `count: 2` is the declared
   override;
2. path-style `scenario.ref` is clamped inside the target cwd, fail-closed (no
   `../../` escape recorded as repo-relative provenance);
3. `actors[0].count` now means three things across routes (synthetic simCount, scripted
   surface roster {1,2}, cua lane count post-fan-out) — documented in the lab-config
   HONEST SCOPE header in this PR, not later;
4. spend semantics as designed: scenario.mode `live` is required for real actuation
   even though provider spend is $0 (actuation against a running app deserves the
   affirmative declaration; dry-run produces the contract bundle), with the asymmetry
   vs `run --app-url` documented.

Out of scope, fail-closed: scripted actor inside e2b-desktop, scripted+LLM hybrid,
`allowPublicTargets`/`redactScreenshots` on this route (rejected, not ignored).

### Slice 3 — fan-out (layer 2): N personas × devices, per-lane worlds, two PRs

The judged synthesis governs. N lanes = N independent E2B desktop sandboxes in every
strategy; per-lane worlds is the only topology this layer.

**PR-1 (per-lane strategy, the default):**
- `actors[0].lanes[]` roster (`{id?, persona?, device?, instruction?}`) XOR
  `actors[0].count` (homogeneous); lanes XOR `laneFocus`; `lanes[].device` XOR raw
  `execution.desktop.resolution`; hard cap **16** lanes; `subject.clone.fanout`
  REJECTED on the cua route (was inert-warned — declared behavior change);
- `execution.concurrency` promoted to consumed on the cua route: default
  `min(laneCount, 3)`; env `HUMANISH_CUA_MAX_CONCURRENCY` may only LOWER the effective
  bound (an env var must never raise concurrent paid lanes — invariant 3);
- app-url fan-out: loopback + N lanes ALLOWED (each sandbox is its own world,
  provisioned per-lane via the widened `prepareDesktop(desktop, {laneId, laneIndex,
  laneCount})`); `allowPublicTargets` + N>1 REJECTED naming shared-world as layer 7;
- preflight: lane table + strategy + concurrency/waves + per-lane budgets + worst-case
  sandbox-minutes printed to stderr BEFORE any sandbox or provider call; identical plan
  in dry-run marked $0; recorded as a `cua-lab.fanout.plan` bundle event;
- per-lane xdpyinfo geometry assertion (fail-closed `HUMANISH_CUA_LAB_DEVICE_GEOMETRY`)
  — the per-lane device claim is verified in-sandbox, never assumed;
- pipeline gate (lane 1 provisions before others start) + session fail-fast on HARNESS
  errors only (skipped lanes = status `blocked` with a pinned reason string; mission
  verdicts never trip fail-fast);
- `execution.timeoutMs` becomes the PER-LANE session budget (semantics change on an
  existing field — release-notes line required); no run-level wall clock (emergent
  bound, printed in preflight);
- evidence: run bundle stays `humanish.run-bundle.v1` (N streams; verify/Observer
  untouched — verified N-ary already); result bumps honestly to
  `humanish.cua-lab-result.v2` with `lanes[]` ALWAYS present (length 1 at N=1; N=1
  mechanism stays today's path verbatim); per-lane commits with unanimity-gated
  top-level commit + divergence warning; `mapWithConcurrency` hoists to
  `src/concurrency.ts`;
- ok = observer.ok ∧ no skipped lane ∧ all lanes terminal ∧ no harness error ∧ no
  hollow lane.

**PR-2 (seed-fork, declared opt-in):** `subject.clone.provisioning: "per-lane" |
"seed-fork"`, default **per-lane** until seed-fork's gated live rung is green with a
kept receipt (then the default flips via one-liner + doc note). Seed-fork = provision
once → `Sandbox.createSnapshot` (feature-detected; absent → `FORK_UNSUPPORTED` naming
both remedies) → kill seed → N forks on fresh `display: ":1"` with per-lane resolution
→ readiness probe with serve-restart fallback (`worldOrigin: fork | fork-restarted`) →
phase barrier: zero provider tokens until every world is proven up → sessions in waves
→ teardown kills all + always deletes the snapshot (deterministic `humanish-<runId>`
name; host-crash leak documented).

**State × fork interaction (decided now, not when the bug ships):** `after-ready`
state steps run on the seed before the snapshot; clean forks inherit that state and the
provenance event records "after-ready ran on seed pre-snapshot". A `fork-restarted`
lane has lost in-memory after-ready state, so it RE-RUNS `after-ready` steps after the
serve restart and records that; if a re-run fails, that lane fails closed. Per-lane
strategy simply runs all state steps per lane (N× cost, recorded per lane).

## Deferred seams (named, not built)

Layer 5: snapshot reuse across runs (`retain: true` + commit/source/env fingerprint as
the cache key). Layer 6: per-lane budgets/ledger, per-lane model, `failFast: false`.
Layer 7: shared-world topology declaration (the `allowPublicTargets`+N>1 rejection
message names it). `RunSimulationStatus` gains no `skipped` value this layer. No
`HUMANISH_MAX_LANES` escape above 16 until a reference panel demands it.

## Proof discipline (every PR)

Deterministic rungs are the merge gate ($0): parse matrix incl. other-routes-warnings
regression, real-engine dry-run bundles, live-with-fakes orchestration (call order,
fail-fast, teardown, scrub-on-every-lane). Exactly one spend-gated live rung per slice
(`HUMANISH_LIVE_CUA=1`), run manually, asserting ENGAGEMENT (actions+messages>0, read
the trace — the 0.6.1 landmine rule) and, where shipped, geometry and teardown
(zero sandboxes, zero snapshots left). Every live-proven claim cites a kept receipt
under this packet's `receipts/`.
