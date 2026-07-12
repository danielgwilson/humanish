# Goal: shared-world (shared-service) topology (#164)

Status: ratified 2026-06-17. From a 2-design adversarial workshop (isolation-preserving vs
interaction-first) + a doctrine critic + a dedicated attribution deep-dive, plus a tech-lead
substrate correction. This packet is the source of truth; layer 7 of the proof roadmap and the
gateway to a multi-actor-shared-state sim replacement.

## Objective

Let a lab declare a SHARED-WORLD topology — N distinct actor roles driving ONE provisioned,
mutable service plane (one app + one seeded DB) so their actions interact through shared state —
as a DECLARED override of the `per-lane worlds` default, producing HONEST, verify-enforced,
decision-grade evidence about the interaction (not just that N sessions ran).

## The substrate reality (tech-lead correction to the workshop)

The workshop concluded concurrent multi-seat is "impossible" — but it only inspected humanish's
wrapper (`src/e2b-desktop-launch.ts`). The base `e2b` SDK (v2.27.0) DOES expose
`getHost(port): string` (`sandbox.getHost(3000)` → a reachable URL). So there are TWO honest
shared-world topologies, and concurrent IS buildable:

- **Sequential (one sandbox):** one sandbox provisions the plane and hosts the app on loopback;
  N role SEATS (isolated Chrome `--user-data-dir` profiles + identities) take turns IN DECLARED
  ORDER against the shared DB. One GUI seat per sandbox forces sequential turns. Simplest;
  proves the interaction/handoff; CANNOT speak to concurrency.
- **Concurrent (N+1 sandboxes, via `getHost`):** one subject sandbox serves the app and exposes
  it via `getHost(port)`; N SEPARATE desktop sandboxes each run a browser hitting that URL — a
  genuine concurrent N-actor swarm against one shared service. Requires wrapping `getHost` + N+1
  orchestration, and the hard part is attribution UNDER concurrency (races/lost-updates become
  real and must be handled honestly). This is the full layer-7 swarm target.

Both topologies share the SAME doctrine + evidence mechanism below; sequential is the foundation
the concurrent version builds on. **This packet's PR1 ships the sequential PoC.** Concurrent
(`getHost`) is the named next phase (PR2+), and the sim-parity question ("does the target need
concurrent swarm, or is sequential interaction enough?") is flagged for the maintainer.

## The doctrine deliverable (the load-bearing part)

A shared-world override is honest ONLY if the bundle declares, in a VERIFIED field, that per-role
attribution is weaker and states its ceiling — verify FAILS CLOSED if the ceiling is absent:

- **`RunBundle.attributionClass?: "isolated" | "shared-world"`** — a new orthogonal honesty axis
  (absent == `isolated`, so every existing bundle is byte-stable). It answers "how well did the
  run attribute INTERACTION?" — ORTHOGONAL to the persona-sampling evidence classes
  (user-census/plausible-use/coverage-floor, which answer "how representative is the actor?"). A
  shared-world LLM-persona run is `plausible-use` (sampling) AND `shared-world` (attribution).
  We use a self-contained field (not a new evidence-class-in-schema) because evidence-classes-
  in-schema is layer 8 (unbuilt); when it lands, `attributionClass` composes as the orthogonal
  axis. Conflating the two would itself be dishonest (invariant 6).
- **`RunBundle.sharedWorld?` (schema `humanish.shared-world.v1`)** — additive block: `topology`,
  `roleCount`, the ONE shared-plane provenance (commit + seedDigest + envNames), the declared
  executed `sequence` of role identities, and a harness-clocked alternating `timeline`
  (`cp-baseline → turn → cp → turn → … → cp`) where each `turn` references a real
  RunSimulation/RunStream/actor-trace and each checkpoint carries `{name, digest, deltaFromPrev}`,
  plus a pinned `attributionLimits[]`.
- **Mandatory `attributionLimits` (verify fail-closed if absent):** `sequential-only`,
  `no-concurrent-races`, `delta-attributed-to-turn-not-action`. The disclaimer is enforced by
  code, not prose. (The concurrent topology will carry a different limit set — e.g. it drops
  `sequential-only` and adds `race-attribution-best-effort` — established when PR2 lands.)
- **The delta-on-pass gate:** a PASSED shared-world run must show a non-empty checkpoint
  `deltaFromPrev` somewhere in the timeline — otherwise the roles never actually interacted
  through shared state and the interaction claim is hollow (verify rejects it). This is the
  minimal honest "the interaction actually occurred" check.

## The attribution model (what the bundle can/cannot claim)

CAN (decision-grade, mechanically backed): each role's own behavior at full fidelity (isolated
seat → unchanged actor-trace attribution); the OBSERVED system outcome as an ordered,
harness-clocked sequence of state-slice DIGEST changes; the SEQUENCED-INTERACTION proof — role B
demonstrably entered a world that already contained role A's mutation (the checkpoint after A's
turn strictly precedes B's turn-start in one clock) — the proof a per-lane swarm structurally
cannot make.

CANNOT (declared, verify-enforced): action-granular causation (a delta attributes to the TURN it
followed, not a specific action — correlation, not causation); concurrency/races/lost-updates
(sequential-only); sub-checkpoint granularity; determinism of exact state (digests, not values).

## The checkpoint primitive (the attribution mechanism)

A `subject.state.checkpoint[]`: author-trusted, READ-ONLY, AGGREGATE/DIGEST probe commands
(counts, max-timestamps, hashes) reusing the existing `runDetachedStep` + `commandDigest`
(sha256-16) machinery. Run at baseline and after each role's turn. **Digest-only by DEFAULT**
(only `sha256-16(scrubbed stdout)` persists, never the raw value) until the #108 PII/PHI detector
lands; verify REJECTS any value-shaped (non-sha256-16) field in a checkpoint record (reusing the
existing value-shape tripwire). Same lockdown as the seed-step surface.

## PR1 scope — the sequential deterministic PoC (this goal)

- **Config (`src/lab-config.ts`):** `subject.topology?: "per-lane-worlds" | "shared-world"`
  (absent == default; every existing lab byte-stable). `routesToSharedWorld(config)` predicate
  (mirror `routesToComputerUse`). Fail-closed cross-validation: shared-world REQUIRES
  `subject.source: clone` + `execution.target: e2b-desktop` + a `subject.serve` block + an
  `actors[0].lanes` roster of length ≥ 2 (REUSE the lanes roster as the role roster — no parallel
  `roles[]`). Add `LabActorLane.entry?` (per-role loopback route, same-origin with `serve.url`,
  validated at parse AND re-enforced in engine). Add `LabSubjectState.checkpoint?[]` (reuse the
  seed-step validation shape). Forward-declared warnings so topology/entry/checkpoint warn as
  inert off the shared-world route (invariant 6).
- **Orchestration (new `src/shared-world-lab.ts`):** `runSharedWorldLab`. ONE `Sandbox.create`
  (metadata.topology = shared-world). `provisionCloneSubject` ONCE (reuse verbatim; one shared
  provenance). One baseline checkpoint via `runDetachedStep`. Then the sequential per-role loop:
  fresh Chrome `--user-data-dir=/tmp/seat-<identity>` per role, open `serve.url + entry`,
  `runSession` (reuse), then a checkpoint. Fail-fast: a role HARNESS error blocks the REMAINING
  roles (`blocked` + pinned reason — the shared-state premise is broken); a role MISSION failure
  is data, never trips fail-fast. ONE teardown BY exact `sandboxId` in a finally — NEVER
  `Sandbox.list` (the prod-incident rail). `selectLabBackend` routes `routesToSharedWorld` to it.
- **Evidence (`src/run.ts`):** `RunBundle.attributionClass` + `RunBundle.sharedWorld`
  (`humanish.shared-world.v1`). `validateSharedWorldEvidence` wired into `verifyRun` (mirror
  `validateTerminalProductEvidence`): timeline well-formed (starts baseline, alternates, ends on
  a checkpoint, order == sequence); every turn sim/stream resolves; every checkpoint digest
  matches `COMMAND_DIGEST_PATTERN` and carries NO value-shaped field; `attributionLimits` contains
  the mandatory entries (omission == overclaim == fail); single-plane provenance (all turns share
  one commit/seedDigest); the delta-on-pass gate; the per-role no-engagement guard still applies.
- New error codes as needed; new public exports from `src/index.ts`.

## Non-goals (named seams)

Concurrent topology via `getHost` (PR2+ — the full swarm; harder attribution). Per-action
timeline / an `onTurn` core-loop hook. Handoff/barrier grammar (justified only by concurrency).
Real per-role login (adopter/seed concern). The #108 PII/PHI detector. The downstream domain
adapter (roles/personas/rubric stay in the adopter's repo).

## Proof (PR1 — deterministic, $0, the merge gate)

- Parser matrix (`tests/lab-config.test.ts`): topology routing + the fail-closed cross-validation
  + entry same-origin + checkpoint validation + forward-declared warnings off-route + every
  existing route byte-stable.
- Dry-run: one `run-bundle.v1` with the `sharedWorld` block + `attributionClass: shared-world` +
  `attributionLimits` at $0; `verifyRun` ok.
- The heart (`tests/shared-world-lab.test.ts`, fake desktop + fake runSession + fake checkpoint
  stdout): ONE sandbox created + torn-down-by-id; plane provisioned ONCE; seats sequential with
  distinct profile dirs; checkpoint baseline + after each turn with the after-A delta PRECEDING
  B's turn (the interaction proof); harness-error fail-fast; and `verifyRun` catches every
  injected overclaim — missing `no-concurrent-races`, a value-shaped checkpoint field, divergent
  plane provenance, a phantom/dropped role, a hollow (no-delta) passed run, a per-role hollow lane.

Live rung: WRITTEN + gated, NOT run (a separately-authorized receipt; a shared operator E2B key
is safe here since teardown is by exact created id and never enumerates the account; the live
shared-world rung also needs a real stateful seeded app, so it is deferred).

## Autonomy rails / spend / stop-and-ask

Same as the fan-out packet: by-id teardown only (NEVER account-wide E2B ops — the 2026-06-16 prod
incident); commit identity `daniel@danielgwilson.com` (model only in the Co-Authored-By trailer);
deterministic proof is the merge gate, no live spend in the autonomous run (pause for the spend
contract — bounded, by-id, team key); public-safe (no codenames/domains/values); PR open, the
maintainer (now me, per the max-autonomy grant) reviews + merges.

## Completion audit

Map each PR1 invariant to evidence: the dry-run sharedWorld bundle + `verifyRun` ok; the
fake-substrate interaction-proof test (one sandbox, provision-once, sequential by-id seats,
after-A-delta-before-B, fail-fast, the overclaim-fails-closed matrix incl. the hollow-no-delta
gate); the byte-stable existing routes; green required CI; state/receipt current. The live rung
and the concurrent (`getHost`) topology are NOT required for PR1 completion — say so explicitly.
