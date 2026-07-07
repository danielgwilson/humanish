# Receipt: CONCURRENT shared-world live rung (#164 phase 2)

Date: 2026-06-17. Operator: maintainer session, dedicated danielgwilson-team E2B key (not a
production key). Bounded by the goal packet's Provider Spend Policy. This is the FIRST live proof
of the north-star capability: MANY personas against ONE shared mutable service, AT ONCE.

Lab: `homun/labs/shared-world-concurrent-live.yaml` (clones this public repo, serves the
synthetic `homun/fixtures/shared-world-app` task board on 0.0.0.0, seeds it, exposes it via
getHost; 3 personas drive that one URL concurrently). Run via `runLab(config, { dryRun: false })`
with `HOMUN_LIVE_SHARED_WORLD=1`. The gated test `tests/concurrent-shared-world-lab.live.test.ts`
passed (1/1, 30.9s); this receipt is from a parallel persisted capture of the same lab.

## What the run proves (real environment-state evidence)

- **`ok: true`, `verifyRun` ok** over `homun.run-bundle.v1` (attributionClass `shared-world`,
  `sharedWorld.topologyMode: concurrent`, roleCount 3).
- **3 personas, all `passed`** (planner / coordinator / mobile) — each reached its goal (added a
  task) against the ONE shared plane.
- **Genuine simultaneity:** 3 `laneWindows`, and **all 3 lane-pairs overlapped** on the real
  orchestrator clock (span ~21.9s) — ≥2 personas were always in-flight against the one service.
- **Shared state evolved under load:** the `stateSeries` (18 cadence snapshots) moved through **3
  distinct digests** — the shared task board genuinely changed as the concurrent actors added
  tasks (the digest-only delta signal; the concurrency-on-pass gate, which verify enforces, ties a
  delta to the concurrent window).
- **Honest limits carried + verify-enforced:** `attributionLimits` =
  `concurrent`, `best-effort-causal-attribution`, `non-deterministic-shared-state`,
  `window-and-snapshot-granularity`, `contention-observed-not-proven-safe`,
  `state-change-not-isolated-to-actors`. (`sequential-only`/`no-concurrent-races` are forbidden
  here and absent.)
- **N+1 = 4 sandboxes (1 subject + 3 actors) ALL reclaimed BY id** (`killed: true` for each); no
  `Sandbox.list`/account-wide op at any point (the 2026-06-16 prod-incident rail).
- **Public-safe by construction:** the plane records `hostDigest` (sha256-16) — the raw
  internet-reachable getHost URL is NEVER persisted to the bundle (only on the ephemeral result);
  the subject is `exposure: synthetic` + `state.provenance == seeded`.

## Two live-wiring fixes the receipt loop surfaced (deterministic logic was already green)

1. The E2B desktop image ships **python3 but no node** — the fixture was ported to python3 stdlib
   (PR #176). 2. `@e2b`'s `getHost(port)` returns a **bare host** (no scheme) — normalized to
   `https://` before the tokenless check, and the deterministic fake aligned to return a bare host
   so the $0 test regression-covers it (PR #177). Each surfaced as a ~5s fast-fail + a one-sandbox
   diagnostic probe (created + killed by id).

## Spend (within contract)

Providers: E2B (team key) + OpenAI (computer-use). Max concurrent paid resources: 4 sandboxes
(1 subject + 3 actors, concurrency 3). Wall-clock: ~30s per run (well under the 20-min cap). A
handful of short runs total (2 fast-fails + 2 one-sandbox probes + 1 passing test + 1 persisted
capture). Every sandbox reclaimed by id; no account-wide operations.

## Honest scope (one trial = phase-change proof, not platform readiness)

This proves the concurrent shared-world MECHANISM works live: N personas, one getHost-exposed
shared plane, genuine overlap, observed shared-state evolution, by-id reclamation, verified bundle.
It is ONE trial against a synthetic fixture — NOT a claim of scale, reliability across many trials,
or per-action causal attribution (explicitly disclaimed). The deterministic rendezvous-latch test
remains the merge gate; this is the kept live receipt that the mechanism works against real E2B +
a real model. The next step is the real downstream sim migration (a synthetic-seeded multi-role
app in the adopter's domain).
