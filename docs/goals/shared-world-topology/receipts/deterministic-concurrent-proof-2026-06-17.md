# Receipt: CONCURRENT shared-world deterministic proof (#164 phase 2)

Date: 2026-06-17. Branch: `codex/concurrent-shared-world` off `origin/main` @ 7f64a0d
(#164 phase 2; builds on the merged sequential PoC #171). Operator: autonomous
goal-mode session. Spend: **$0 by mechanism** (fake N+1 E2B substrate via the
`sharedWorldHooks` DI seam + dry-run). No provider/E2B calls were made.

## Commands

- `pnpm check` (typecheck + vitest + build) — **exit 0**.
- `node scripts/public-surface-scan.mjs` — **exit 0** (own exit code checked directly).
- `mimetic/labs/shared-world-concurrent-demo.yaml` parses → routes to the
  `concurrent-shared-world` backend → dry-run `verifyRun` ok.
- `tests/concurrent-shared-world-lab.test.ts` — **14 passed**, run 3× to confirm
  determinism (no flakiness).

## The capability

N persona lanes drive ONE provisioned, mutable service plane CONCURRENTLY. Topology:
ONE subject sandbox (`provisionCloneSubject` ONCE + serve on `0.0.0.0` + `getHost`-expose)
+ N actor desktop sandboxes (the fan-out `runCuaLane` machinery, bounded by
`execution.concurrency`) each driving the ONE getHost URL at once. Selected by
`subject.topology: shared-world` + `execution.concurrency > 1` (N=1 stays the sequential
PoC).

## The 11 binding doctrine-audit fixes — addressed point-by-point

- **FIX-1 (overlap is PRODUCED, not believed):** the heart test uses a RENDEZVOUS LATCH
  — the fake `runSession` blocks until all N actors have entered, so N lane fns are
  genuinely in-flight while the REAL orchestrator clock (`Date.now`, NOT overridden)
  measures the wrapped `[start,end]` `laneWindows`. The windows overlap because the lanes
  genuinely overlapped, not because a timestamp was injected. The PR/docs/bundle state
  plainly that the concurrency CAPABILITY at scale is backed only by the deferred live
  receipt; the $0 gate proves the plumbing + the honesty contract.
- **FIX-2 (first-class getHost target):** `getHost(port)` added to `E2BDesktopSandbox`; a
  dedicated provisioned-subject target (not loopback, not `allowPublicTargets`). The
  orchestrator confirms the URL is TOKENLESS before use; verify confirms every actor's
  `routeHostDigest` equals `plane.hostDigest`. The raw URL embeds the live sandbox id +
  matches the e2b-URL publish redaction, so the bundle records **sha256-16 of the getHost
  origin** (digest, not raw URL); the raw tokenless URL is surfaced only on the ephemeral
  result.
- **FIX-3 (synthetic-subject = verify mechanism):** verify fail-closes unless
  `subject.state.provenance == "seeded"` AND `plane.exposure == "synthetic"` (a REQUIRED
  author attestation, parse + verify enforced). Docs state plainly: author-trust + a
  provenance gate, NOT a no-real-data guarantee.
- **FIX-4 (serve bind 0.0.0.0):** parse + engine require `subject.serve.start` to bind all
  interfaces (`0.0.0.0`); the readiness probe stays loopback.
- **FIX-5 (corrected limit sets):** required `concurrent`,
  `best-effort-causal-attribution`, `non-deterministic-shared-state`,
  `window-and-snapshot-granularity`, `contention-observed-not-proven-safe`,
  `state-change-not-isolated-to-actors`; forbidden `sequential-only`/`no-concurrent-races`.
  Verify runs BOTH a required-set and a forbidden-set check.
- **FIX-6 (gate ties delta to the concurrent period):** the concurrency-on-pass gate
  requires ≥2 overlapping `laneWindows` AND a `stateSeries` delta whose timestamp is
  AT/AFTER an overlap interval start.
- **FIX-7 (causation structurally inexpressible):** `laneWindows` and `stateSeries` are
  independent series with NO per-delta→actor field; `SHARED_WORLD_STATESERIES_KEYS`
  permits ONLY `{timestamp, digest}` and verify rejects any other key.
- **FIX-8 (discriminator + fail-closed dispatch):** the discriminator is `topologyMode:
  "sequential" | "concurrent"` (renamed off `RunBundle.mode`); verify branches on it
  FIRST; missing/unknown → fail closed; a sequential `timeline` on a concurrent bundle
  (or `laneWindows` on a sequential one) → fail closed.
- **FIX-9 (N+1 by-id teardown + timers):** the +1 subject sandbox is torn down BY id in an
  outermost `finally`; the prober timer is cleared in `finally`; `subject.clone.keep` is
  rejected on this route.
- **FIX-10 (actor sandboxes get NO subject creds):** actor-lane deps set `cloneRoute=false`
  + `subjectEnvNames=[]`; the test asserts only the subject sandbox create carries `envs`.
- **FIX-11 (independent actors, not the fan-out gate):** `runCuaLane` + `mapWithConcurrency`
  WITHOUT the pipeline-gate/fail-fast coupling; one actor's harness error neither blocks
  the swarm nor suppresses the overlap (the test injects a mid-run throw and asserts all N
  windows + outcomes survive, 2/3 reach their goal).

## What the deterministic ladder proves, by construction

Parser matrix (`tests/lab-config.test.ts`): `shared-world` + `concurrency > 1` routes to
`concurrent-shared-world`; the same config with `concurrency: 1`/absent stays SEQUENTIAL;
the fail-closed extras (missing synthetic attestation / non-0.0.0.0 serve / `clone.keep` /
roster < 2 / missing checkpoint) each REJECT; `exposure` is enum-validated + warns inert
off-route; existing routes (incl. a plain cua fan-out with `concurrency > 1`) stay
byte-stable.

The heart (`tests/concurrent-shared-world-lab.test.ts`, fake N+1 substrate + rendezvous
latch, $0): ONE subject sandbox + N actor sandboxes, ALL torn down BY id
(killed-set == created-set, N+1; the fake exposes NO `list`); `provisionCloneSubject`
EXACTLY once; subject creds in the subject sandbox only; every actor opened the SAME
getHost origin; REAL overlapping `laneWindows`; a `stateSeries` delta under load;
per-persona `outcomes`; and `verifyRun` FAILS CLOSED on each overclaim (a non-overlap
"concurrent", a missing required limit, a forbidden limit present, a value-shaped
stateSeries field, divergent plane provenance, a no-delta pass, per-lane no-engagement, a
smuggled sequential timeline, and an actor on a foreign host). A provisioned value forced
into an error is literal-scrubbed before persist; the raw getHost URL never appears in
`run.json`.

## Honest gaps (NOT required for this PR)

- The concurrency CAPABILITY at scale ("we ran many concurrent users") is backed ONLY by
  the deferred, separately-authorized live receipt. The $0 gate proves the plumbing + the
  attribution/honesty contract.
- Strict causal attribution of a delta to an actor is structurally inexpressible under
  concurrency (declared + schema-enforced).
- The LIVE rung (`tests/concurrent-shared-world-lab.live.test.ts`,
  `MIMETIC_LIVE_SHARED_WORLD=1` + keys) is WRITTEN + gated, NOT run — it needs a real
  synthetic seeded app served on `0.0.0.0`.
