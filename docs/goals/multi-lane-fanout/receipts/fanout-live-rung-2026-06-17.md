# Receipt: multi-lane fan-out live rung (#163)

Date: 2026-06-17. Tree: main @ 6b5e524 (#168 merged). Operator: maintainer session, on the
dedicated danielgwilson-team E2B key (not a production key). Bounded by the goal packet's
Provider Spend Policy.

Command: `MIMETIC_LIVE_CUA=1 npx vitest run tests/cua-actor-lab.fanout.live.test.ts`
Result: **1 passed / 0 failed, 33.4s** (real E2B + real OpenAI computer-use).

## What ran

A 2-lane fan-out, `per-lane worlds`, against a neutral loopback page served inside each lane's
own sandbox via `prepareDesktop`:

```
mimetic cua fan-out plan (cua-fanout-live-proof): 2 lane(s), strategy per-lane-worlds,
concurrency 2, 1 wave(s).  per-lane session budget 120s; worst-case ~24 sandbox-minutes total.
  - mobile:  persona=synthetic-new-user device=mobile  414x896
  - desktop: persona=synthetic-new-user device=desktop 1440x950
```

## What the rung proves

- **N differentiated lanes ran for real, concurrently** — two lanes at distinct device
  viewports (414×896 and 1440×950) in one run, bounded by `execution.concurrency: 2` (the spend
  control), one wave.
- **Per-lane worlds:** two DISTINCT E2B sandboxes (one per lane), each driven by a real OpenAI
  computer-use session to a terminal verdict with engagement (not a hollow pass).
- **Teardown is by-id only:** both sandboxes were reclaimed by their own sandboxId; no
  account-wide `Sandbox.list`/kill was performed at any point (E2B has no project isolation —
  bulk operations are forbidden). The test asserts killed-set == created-set.
- **The bundle verifies:** `verifyRun` ok over the N-stream bundle.

## Spend

Bounded by mechanism: max 2 concurrent paid desktops, 120s/lane, one wave (~minutes of
desktop time + two short computer-use sessions). The pre-flight plan printed the worst-case
ceiling before any sandbox was created. No account-wide operations; only this run's two
sandboxes were created and reclaimed.

## Honest scope

The rung asserts the fan-out mechanism + per-lane-worlds + by-id reclamation + a verified
bundle — never task success (model behavior against a live page is not asserted). The
deterministic fake-substrate test (`tests/cua-actor-lab.fanout.test.ts`) remains the merge gate;
this is the kept live receipt that the mechanism works against real E2B + a real model.
