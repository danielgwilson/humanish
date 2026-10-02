# Receipt: multi-lane fan-out deterministic proof (Slice 3, PR-1 per-lane worlds)

Date: 2026-06-17. Branch: `codex/fanout-per-lane-v2` off `origin/main` @ 91bc1ed
(#163 / epic #166). Operator: autonomous goal-mode session. Spend: **$0 by mechanism**
(fake E2B substrate via the DI seam + dry-run). No provider/E2B calls were made.

## Commands

- `pnpm check` (typecheck + vitest + build) — **exit 0**, 636 passed / 8 skipped.
- `node scripts/public-surface-scan.mjs` — **exit 0** (356 text files, 1 binary asset).
- `pnpm homun -- lab run fanout-demo --dry-run --json --no-open` then
  `pnpm homun -- verify --run latest --json` — **ok: true** (4-stream bundle).

## What the deterministic ladder proves, by construction

Parser matrix (`tests/lab-config.test.ts`): count XOR lanes, lanes XOR laneFocus,
device XOR raw resolution, 16-lane cap, unique lane ids, `allowPublicTargets`+N>1
rejected (named as shared-world / layer 7), `clone.fanout` REJECTED on the cua route
(declared behavior change), `execution.concurrency` consumed on cua + still inert
elsewhere; the OTHER routes' rules + warnings still fire (regression guarded).

Dry-run (`tests/cua-actor-lab.fanout.test.ts`): a 4-lane roster → ONE
`homun.run-bundle.v1`, `simCount 4`, per-lane persona/device/viewport, the
`cua-lab.fanout.plan` event, contract statuses; `verifyRun` ok. `resolveCuaLanePlan`
is pure (default concurrency `min(N,3)`; env `HOMUN_CUA_MAX_CONCURRENCY` only LOWERS).

Live-with-FAKE-substrate (the load-bearing rung, $0) — REAL orchestration at N=4,
concurrency 2 through `runLab`/`runCuaActorLab`:
- 4 sandboxes created, each with per-lane metadata (`laneId`/`laneIndex`/`laneCount`)
  and the lane's device resolution; the actor key never entered any sandbox.
- bounded concurrency: peak in-flight lanes == 2 (genuinely parallel AND bounded).
- per-lane teardown kills ONLY each lane's own sandbox BY its exact id — the killed set
  equals the created set; the fake module exposes NO `list`, so enumerate-and-kill is
  impossible by construction.
- pipeline gate: a lane-1 provisioning failure ⇒ the remaining lanes never create a
  sandbox (only 1 sandbox created; the others reported `blocked`).
- a lane HARNESS error ⇒ in-flight lanes finish, queued lanes are skipped (`blocked`)
  with a pinned reason + a `cua-lab.fanout.fail-fast` event; run `ok=false`; completed
  evidence intact; the bundle still PASSES `verifyRun`.
- a hollow lane (zero actions/messages) ⇒ run `ok=false` AND `verifyRun` fails the
  `actor engagement` check for that stream.
- geometry mismatch (xdpyinfo reports the wrong dimensions) ⇒
  `HOMUN_CUA_LAB_DEVICE_GEOMETRY`, sandbox still reclaimed by id.
- per-lane secret scrub holds: an actor-key value echoed by a lane's harness error never
  reaches run.json / review.* / events.ndjson / per-lane `actors/*.json`.

Engine guards: multi-lane on the in-process route (buildExecutor) and engine-side
`clone.fanout` both fail closed with `HOMUN_CUA_LAB_FANOUT_INVALID`.

N=1 byte-stability: the entire pre-existing cua-actor-lab suite (single-lane bundle,
result.subject/sandbox/session, clone provenance, subject.state, in-process route) stays
green unchanged — the N=1 run bundle is byte-identical; only the result projection grew
(schema v2, `plan`/`lanes`/`laneSummary`).

## Honest scope

- The deterministic ladder is the merge gate. The LIVE fan-out rung
  (`tests/cua-actor-lab.fanout.live.test.ts`, gated by `HOMUN_LIVE_CUA=1`) is WRITTEN
  but NOT run — it is a separately-authorized paid receipt per the goal packet's Provider
  Spend Policy.
- `subject.clone.provisioning: seed-fork` is the deferred PR-2 (the field does not exist).
- In-process-route fan-out and shared-world topology (#164) are out of scope.
