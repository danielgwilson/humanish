# Receipt: shared-world topology PR1 deterministic proof (sequential PoC, #164)

Date: 2026-06-17. Branch: `codex/shared-world-pr1` off `origin/main` @ cab4dd1
(#164). Operator: autonomous goal-mode session. Spend: **$0 by mechanism** (fake
E2B substrate via the `sharedWorldHooks` DI seam + dry-run). No provider/E2B calls
were made.

## Commands

- `pnpm check` (typecheck + vitest + build) — **exit 0**, 660 passed / 9 skipped.
- `node scripts/public-surface-scan.mjs` — **exit 0** (367 text files, 1 binary asset).
- `mimetic/labs/shared-world-demo.yaml` parses → routes to the `shared-world`
  backend → dry-run `verifyRun` ok.

## The doctrine (the load-bearing part)

A shared-world override is honest ONLY because the bundle declares, in
VERIFIED fields, that per-role attribution is weaker and states its ceiling:

- `RunBundle.attributionClass: "isolated" | "shared-world"` — a new, ORTHOGONAL
  honesty axis (absent == `isolated`, so every existing bundle is byte-stable).
- `RunBundle.sharedWorld` (`mimetic.shared-world.v1`): `{ topology, roleCount,
  plane: { commit?, seedDigest, envNames }, sequence[], timeline: (checkpoint |
  turn)[], attributionLimits[] }`. checkpoint = `{ kind, name, digest,
  deltaFromPrev }`; turn = `{ kind, roleId, simId, streamId, commit?, seedDigest }`
  (the per-turn plane provenance is what makes "all turns share one plane"
  verifiable, and the divergence overclaim injectable).
- Mandatory `attributionLimits` (verify fail-closed if any absent):
  `sequential-only`, `no-concurrent-races`, `delta-attributed-to-turn-not-action`.

## What the deterministic ladder proves, by construction

Parser matrix (`tests/lab-config.test.ts`): shared-world routing; the fail-closed
cross-validation (missing serve / roster < 2 / wrong source / wrong target /
missing checkpoint / non-same-origin entry each REJECT); `resolveSeatUrl`
same-origin behavior; checkpoint shape validation (missing command / duplicate
name / value-shaped redact reject); topology/entry/checkpoint warn inert off-route;
and EVERY existing route (synthetic / smoke / meta / scripted / terminal, plus the
same composition WITHOUT `topology` staying `cua` per-lane-worlds) still
parses/routes/warns unchanged.

Dry-run: `shared-world-demo.yaml` → ONE `mimetic.run-bundle.v1`, mode `dry-run`,
`attributionClass: shared-world`, the `sharedWorld` block with the mandatory
`attributionLimits` and a well-formed declared timeline; `verifyRun` ok at $0.

Live-with-FAKE-substrate (the load-bearing rung, $0) — REAL orchestration through
`runSharedWorldLab` (and `runLab`) against a fake `@e2b/desktop` module that records
create/kill BY id and exposes NO `list` method + a fake `runSession` + stateful
checkpoint stdout:

- **ONE sandbox** created (metadata `topology=shared-world`, `roleCount=2`) and
  torn down BY its exact id — the killed-set equals `{createdId}`. The fake module
  has NO `list`, so enumerate-and-kill is impossible by construction (the
  2026-06-16 prod-incident rail).
- **Plane provisioned ONCE**: `provisionCloneSubject` runs exactly once (one
  `git clone` wrapper script written), one shared commit + seed recipe — not N.
- **Sequential seats, DISTINCT profiles**: `--user-data-dir=/tmp/seat-role-author`
  launches strictly BEFORE `--user-data-dir=/tmp/seat-role-reviewer` (per-seat
  identity isolation; new plumbing over the bare `desktop.launch`).
- **THE INTERACTION PROOF**: a checkpoint at baseline + after each turn; the
  checkpoint after role-author carries `deltaFromPrev == true` AND appears strictly
  BEFORE role-reviewer's turn in the one harness clock — the proof a per-lane swarm
  structurally cannot make.
- **Fail-fast vs data**: a role HARNESS error blocks the REMAINING roles (`blocked`
  + a pinned reason + a `shared-world.fail-fast` event); a role MISSION failure does
  NOT trip fail-fast (every role still runs).
- **Literal scrub**: a provisioned value (an opaque DATABASE_URL credential)
  injected into a forced error is literal-scrubbed before it persists — absent from
  run.json/review.json/review.md/events.ndjson.
- **verifyRun ok** on the good bundle, and **fail-closed** on each of 6 hand-mutated
  overclaims: (a) `attributionLimits` missing `no-concurrent-races`; (b) a
  value-shaped (non-sha256-16) checkpoint field; (c) divergent plane provenance
  across turns; (d) a dropped role (sequence length != roleCount); (e) a PASSED run
  with no checkpoint delta (hollow interaction); (f) a role with `goal_satisfied` +
  zero engagement.

## Honest gaps (NOT required for PR1)

- The concurrent (`getHost`) N+1 topology — the full swarm with race attribution —
  is the named PR2+ phase.
- Per-action causation (a delta attributes to the TURN, not a specific action).
- The LIVE rung is WRITTEN + gated (`tests/shared-world-lab.live.test.ts`,
  `MIMETIC_LIVE_SHARED_WORLD=1` + keys) but NOT run — deferred to a
  separately-authorized receipt (it also needs a real stateful seeded app whose
  checkpoint probes observe role mutations).
