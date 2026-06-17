# Goal: CONCURRENT shared-world — many personas, one shared service, at once (#164, phase 2)

Status: ratified 2026-06-17. This is the NORTH-STAR-CRITICAL capability: simulate MANY
concurrent personas of all kinds hitting ONE shared, mutable service plane SIMULTANEOUSLY
(the actual leverage of a sim), with honest attribution. Builds on the sequential PoC
(`goal.md`, merged in PR #171). Design authored by the tech lead (the adversarial design
workshop died on an API overload); a focused doctrine pass runs before/with implementation,
and the deterministic merge gate + critic review of the implementation PR are the backstop.

## Objective

Run N persona lanes against ONE provisioned, mutable service plane CONCURRENTLY, producing a
bundle that honestly reports per-persona outcomes, the shared world's evolution under load, and
proven concurrency — declaring (verify-enforced) exactly what it cannot attribute.

## Topology (a recomposition of shipped pieces + one new wrapper)

- **One SUBJECT sandbox:** `provisionCloneSubject` ONCE (clone+install+build+seed), serve the
  app on a port, and expose it via **`getHost(port)`** → a reachable URL. The subject sandbox
  runs no GUI seat (it is the headless service host).
- **N ACTOR desktop sandboxes:** fan-out's EXISTING `runCuaLane` machinery (bounded by
  `execution.concurrency`, per-lane device/persona from the roster, by-id teardown), each running
  a browser pointed at the subject's `getHost` URL — driving the shared service AT THE SAME TIME.
- **Selection:** `subject.topology: shared-world` (shipped) + `execution.concurrency: N`. N=1 ⇒
  the sequential PoC (one sandbox, turns); **N>1 ⇒ this concurrent path** (1 subject + N actor
  sandboxes). The concurrency knob picks the substrate; the attributionLimits set differs
  accordingly.
- **Teardown:** ALL N+1 sandboxes killed BY exact id in a finally — NEVER `Sandbox.list` (the
  2026-06-16 prod incident). The pre-flight spend plan extends fan-out's: "1 subject + N actors,
  max C concurrent, worst-case sandbox-minutes."

## The `getHost` wrapper + its doctrine

Surface `getHost(port: number): string` on `E2BDesktopSandbox` (src/e2b-desktop-launch.ts) — the
base `e2b` SDK v2.27.0 already implements it; the wrapper just exposes it. The URL is
harness-minted and the actors only ever drive THAT URL (invariant 2 holds). Doctrine point:
a `getHost` URL is INTERNET-REACHABLE for the run's duration, so the concurrent shared-world
route is **synthetic-seeded-subjects ONLY** (no real data ever behind a getHost URL), the URL is
ephemeral (dies with the subject sandbox), and the bundle records that the subject was a
synthetic seeded plane. This is stated as a route invariant + a verify note.

## Attribution under concurrency (the crux — what is HONEST)

Sequential gave strict ordering ("B acted on A's world"). Concurrency destroys that: N actors
mutate one DB at once. The honest evidence model:

CAN claim (decision-grade, mechanically backed):
- **Per-persona behavior at full fidelity** — each actor's own trace (its session is isolated;
  only the service is shared). Unchanged from a fan-out lane.
- **Per-persona OUTCOME against the contended world** — did each of the N concurrent users reach
  its goal? The headline sim signal ("M of N succeeded; K hit contention/errors").
- **Proven concurrency** — a harness-clocked `laneWindow` per actor (start/end on one clock);
  OVERLAPPING windows mechanically prove ≥2 personas were active against the one plane
  simultaneously. ("We simulated MANY concurrent users" is backed, not asserted.)
- **System-state evolution under load** — a background prober runs the `checkpoint` digest probe
  against the subject DB on a cadence (baseline + periodic + final) → a `stateSeries` of digests
  showing the shared world changing under concurrent pressure.
- **Best-effort TEMPORAL correlation** — an actor's window vs an observed delta (overlap in
  time), explicitly NOT strict causation.

CANNOT claim (declared, verify-enforced):
- Strict causal attribution of a delta to a specific actor (concurrent ⇒ ambiguous).
- Determinism / reproducibility of exact state (concurrent + LLM + live DB).
- Per-action granularity (no `onTurn` core-loop hook; turn/window + snapshot-cadence granularity).
- Concurrency-SAFETY: races/lost-updates are OBSERVED as findings, never PROVEN absent.

## Doctrine deliverable (extends the sequential PoC's, does not replace it)

- `RunBundle.attributionClass: "shared-world"` (already shipped) — now carried by concurrent runs.
- The `mimetic.shared-world.v1` block gains a concurrent shape: `laneWindows[]` (per-actor
  start/end + verdict), `stateSeries[]` (cadence checkpoints, digest-only), and `outcomes[]`
  (per-persona goal result). `timeline` (the strict alternating one) is the SEQUENTIAL shape;
  concurrent uses `laneWindows` + `stateSeries`. Both are valid `shared-world.v1` variants
  discriminated by a `mode: "sequential" | "concurrent"` field.
- **Concurrent `attributionLimits`** (verify FAIL-CLOSED if absent): `concurrent`,
  `best-effort-causal-attribution`, `non-deterministic-shared-state`,
  `turn-and-snapshot-granularity`, `contention-observed-not-proven-safe`. (Replaces the
  sequential set; a concurrent bundle that keeps `sequential-only` or omits
  `best-effort-causal-attribution` is overclaiming → fail.)
- **The concurrency-on-pass gate:** a PASSED concurrent shared-world run MUST show genuine
  overlap (≥2 `laneWindows` overlapping in time) AND a real `stateSeries` delta — otherwise it
  was not actually concurrent, or the shared world never changed under load (a hollow concurrent
  claim) → verify fails closed. This is the concurrent analogue of the sequential delta-on-pass
  gate, and it is the load-bearing honesty check.

## Credential / redaction

Unchanged + the concurrent surfaces: the actor (model) key stays OUTSIDE every sandbox (the
model drives via getHost from outside — fan-out's placement); the subject's env names are
provisioned only into the SUBJECT sandbox (values never persisted); `stateSeries` digests are
sha256-16 of scrub+redacted stdout (never raw values; verify rejects value-shaped fields, reusing
the sequential PoC's tripwire); the getHost URL is harness-minted + synthetic-subject-only.

## Scope — the first concurrent PR

- `src/e2b-desktop-launch.ts`: add `getHost(port)` to the `E2BDesktopSandbox` structural port.
- `src/lab-config.ts`: route `topology: shared-world` + `concurrency > 1` to the concurrent
  backend; validate (subject serves a port; roster ≥ 2; synthetic-subject note). The
  concurrency knob already exists (fan-out).
- `src/shared-world-lab.ts` (extend, or a sibling `runConcurrentSharedWorld`): provision the ONE
  subject sandbox + getHost-expose; launch N actor sandboxes via the fan-out `runCuaLane`
  machinery bounded by concurrency, each browser → the getHost URL; run the background
  `stateSeries` prober on a cadence; collect `laneWindows` + `outcomes`; teardown N+1 by id.
- `src/run.ts`: the concurrent `shared-world.v1` shape (mode/laneWindows/stateSeries/outcomes) +
  `validateSharedWorldEvidence` concurrent branch (the concurrency-on-pass gate, the concurrent
  limit set, digest-only state series, one-plane provenance, per-lane no-engagement).
- Fixture + docs + state/receipt.

## Proof (deterministic, $0, the merge gate)

- Parser matrix: concurrency>1 + shared-world routes to concurrent; synthetic-subject validation;
  existing routes byte-stable.
- The heart (fake substrate, N+1 fakes): exactly ONE subject sandbox provisioned ONCE + N actor
  sandboxes created, ALL torn down BY id (killed-set == created-set, N+1 entries); each actor's
  browser opened the SAME getHost URL (one shared plane); **proven concurrency** — the fake
  scheduler runs lanes with overlapping windows and the bundle's `laneWindows` show overlap; the
  `stateSeries` shows a delta under load; per-persona `outcomes` recorded; and `verifyRun` FAILS
  CLOSED on each overclaim — (a) a "concurrent" bundle whose laneWindows DON'T overlap (not
  actually concurrent), (b) missing `best-effort-causal-attribution`, (c) a value-shaped
  stateSeries field, (d) divergent plane provenance, (e) a no-delta passed run, (f) per-lane
  no-engagement.
- Live rung WRITTEN + gated (`MIMETIC_LIVE_SHARED_WORLD=1` + keys), NOT run in the autonomous
  build — a separately-authorized receipt on the team E2B key: a real seeded app + ≥3 concurrent
  personas, N+1 sandboxes all reclaimed by id, real overlap + state evolution, verify ok.

## Autonomy rails / spend / stop-and-ask

By-id teardown of ALL N+1 sandboxes (NEVER account-wide). Deterministic proof is the merge gate;
NO live spend in the autonomous run (pause for the spend contract: 1 subject + N actors, bounded
by concurrency, team E2B key, by-id cleanup, usage receipt). Commit identity
daniel@danielgwilson.com (model only in the Co-Authored-By trailer). Public-safe (no
codenames/domains/values; generic roles + synthetic fixture). PR open; maintainer (me, per the
max-autonomy grant) reviews + merges.

## Completion audit

Map each invariant to evidence: the dry-run concurrent shared-world bundle + verifyRun ok; the
fake-substrate heart test (N+1 by-id, one getHost plane, proven overlap, stateSeries delta,
per-persona outcomes, the concurrency-on-pass gate + the overclaim-fails-closed matrix); existing
routes byte-stable; green required CI; state/receipt current. The live rung is a
separately-authorized receipt, NOT required for this PR's completion — say so explicitly.

## Doctrine-audit fixes — BINDING (incorporated 2026-06-17)

A focused doctrine audit returned SHIP-WITH-FIXES. These 11 fixes are BINDING and SUPERSEDE any
inline detail above they correct (notably the attributionLimits list and the `mode` discriminator
name). The implementation must satisfy every one.

- **FIX-1 (the load-bearing one): prove overlap is PRODUCED, not just believed.** The $0 gate as
  first written proves only the validator (overlap *detection*), not that the real runner produces
  overlap — injected timestamps make it circular. The deterministic heart test MUST use a
  **rendezvous latch**: fake lane A's `runSession` blocks until lane B's has entered, so two lane
  fns are genuinely in-flight and the REAL orchestrator clock measures the wrapped `[start,end]`
  windows → deterministically proves the real `mapWithConcurrency` + window-wrapping overlap, at
  $0, no flakiness. AND the PR/docs/bundle MUST state plainly that the concurrency *capability* is
  backed only by the deferred live receipt; the $0 gate proves the plumbing + the honesty
  contract, never "we proved many concurrent users."
- **FIX-2 (invariant 2): a first-class getHost target class.** A `getHost` URL is neither loopback
  nor an `allowPublicTargets` target, so the existing `entryTargetSafe` gate REJECTS it. Add a
  dedicated "provisioned-subject getHost" entry-target class (authorized by invariant 2's
  "provisioned subject" clause). Do NOT reuse loopback; do NOT require `allowPublicTargets`. verify
  confirms every actor lane drove EXACTLY the harness-minted getHost URL recorded in the plane.
  Confirm getHost returns a TOKENLESS host (`https://<port>-<sandboxId>.e2b.app`) before persisting
  it (unlike `stream.getUrl`, no authKey may be recorded — invariant 1).
- **FIX-3 (synthetic-subject = verify mechanism, NOT a "route invariant").** Mimetic can't tell
  synthetic from real data, so enforce: (a) verify FAIL-CLOSED that `subject.state.provenance ==
  "seeded"` on the getHost route (reject external/unpinned/undeclared — real/external data behind
  an internet-reachable URL is the hazard, and this IS checkable); (b) a REQUIRED author
  attestation field (e.g. `subject.exposure: synthetic`) recorded in the bundle, verify fails
  closed if absent; (c) docs say plainly this is author-trust + a provenance gate, NOT a
  no-real-data guarantee.
- **FIX-4 (serve bind host).** `provisionCloneSubject` serves on loopback; `getHost` only routes
  to a port bound on `0.0.0.0`. The subject's `serve.start` must bind all interfaces (`-H 0.0.0.0`
  or equiv) or actors get 502. Readiness probe stays loopback. Preflight + doc it.
- **FIX-5 (attributionLimits — CORRECTED set).** Required: `concurrent`,
  `best-effort-causal-attribution`, `non-deterministic-shared-state`,
  **`window-and-snapshot-granularity`** (renamed from `turn-…`; concurrent has no per-turn
  resolution), `contention-observed-not-proven-safe`, **`state-change-not-isolated-to-actors`**
  (NEW — a getHost URL is unauthenticated/writable, so deltas aren't provably actor-caused).
  FORBIDDEN (verify FAIL-CLOSED if present): `sequential-only`, `no-concurrent-races`. verify needs
  BOTH a required-set AND a forbidden-set check (presence-only lets a union pass incoherently).
- **FIX-6 (gate ties delta to the concurrent period).** "overlap AND a delta" is insufficient
  (could overlap at the end, delta at the start from one early actor). Require ≥1 `stateSeries`
  delta whose snapshot timestamp is AT/AFTER the start of an overlap interval.
- **FIX-7 (causation structurally inexpressible).** `laneWindows` and `stateSeries` are INDEPENDENT
  series with NO per-delta→actor field. Extend the value-shape/allowed-keys tripwire to
  `stateSeries`: define `SHARED_WORLD_STATESERIES_KEYS` (permit a numeric timestamp + the sha256-16
  digest; reject all else). "Not causation" is enforced by schema, not just disclaimed.
- **FIX-8 (validator dispatch fail-closed + discriminator rename).** Rename the discriminator —
  `sharedWorld.mode` collides with `RunBundle.mode` (dry-run|live); use **`topologyMode:
  "sequential" | "concurrent"`**. Branch on it FIRST; a concurrent bundle has no `timeline` and a
  sequential one has no `laneWindows`. Unknown/missing `topologyMode` → FAIL CLOSED; mismatched
  shape (timeline on concurrent, or laneWindows on sequential) → FAIL CLOSED.
- **FIX-9 (teardown edges, N+1 by id).** Outermost by-id `finally` for the +1 subject sandbox
  (it's provisioned OUTSIDE `runCuaLane`). `subject.clone.keep` currently would keep ACTOR
  sandboxes too (server-timeout, not by-id) — disallow `keep` on this route or document it
  explicitly. Clear any orchestrator-side prober interval/timer in finally.
- **FIX-10 (invariant 1: actor sandboxes get NO subject creds).** Actor-lane deps MUST set
  `cloneRoute=false` and `subjectEnvNames=[]` so the subject DB creds (provisioned into the SUBJECT
  sandbox only) never enter any actor sandbox (`runCuaLane` provisions `envs` from
  `subjectEnvNames`). The actor (model) key stays outside all sandboxes (unchanged).
- **FIX-11 (independent actors, not fan-out's pipeline gate).** Fan-out's lane-0-provisions-first
  gate does NOT map here (the world is the separately pre-provisioned subject). Reusing
  `runCuaLanes` VERBATIM mis-couples actors: one actor's browser-open failure would block the swarm
  AND suppress the overlap being proven. Actor lanes must be INDEPENDENT — one actor's harness
  error must NOT block the others (it would corrupt the `outcomes[]` "M of N" claim). Reuse
  `runCuaLane` (single-lane) + `mapWithConcurrency`, but NOT the fan-out pipeline-gate/fail-fast
  coupling.
