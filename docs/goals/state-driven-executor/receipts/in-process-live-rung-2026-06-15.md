# Receipt: in-process state-driven executor live rung (#148 PR1)

Date: 2026-06-15. Tree: main @ e40d4f0 (#150 merged). Operator: maintainer session.

Command: `MIMETIC_LIVE_CUA=1 npx vitest run tests/cua-actor-lab.state-executor.live.test.ts`
Result: **1 passed / 0 failed, 747ms.**

## Why this receipt exists

PR1 of issue #148 lets a library caller drive an already-running local app through a
custom state-driven `CuaExecutor`, with NO E2B desktop and NO screenshot vision, while
keeping mimetic's composition (persona, Observer, `ActorTrace` bundle, redaction, the
friction loop). The deterministic merge-gate rungs prove the wiring; this rung proves the
**real `runComputerUseLoop`** drives the new in-process route end-to-end. Per AGENTS.md,
the kept receipt is this file plus the asserted live test committed in #150.

## What the rung proves, by construction

- **$0 by mechanism.** No E2B sandbox and no provider spend: it needs neither
  `OPENAI_API_KEY` nor `E2B_API_KEY`. The subject is a real already-running local app (a
  Node http server on loopback) exposing a `window.app.*`-style state contract; a real
  `CuaExecutor` reads `getState()` and returns **no screenshot**; a fake-but-real-shaped
  NON-vision provider (`requiresFrame` falsey) reasons over `appState` and maps intents to
  the contract.
- **The real loop, no E2B.** The run goes through `runLab` → the cua backend's in-process
  branch → the real `runComputerUseLoop`. The test asserts `result.sandbox === undefined`
  (the verifiable "no E2B SDK call" proof) — backed by the deterministic RUNG 4, where a
  `Sandbox.create` probe records `created.length === 0`.
- **Progress from state, not pixels.** The loop reaches `goal_satisfied` driven by
  `getState()` deltas through `stableProgressKey` — the appState-preferred friction key,
  not a screenshot signature. Zero frames were written; `trace.redaction.screenshots` is
  `"n/a"` and `redaction.notes` declares that app state drove progress detection and was
  not persisted.
- **The bundle verifies independently.** `verifyRun` returns ok on the produced bundle —
  the hollow-run net (action-bearing run passes; a no-op would fail) holds on the new
  route with no change to the guard.

## Honest scope

The test's provider is a deterministic fake of the correct shape (not a hosted model) —
this rung proves the SEAM and the loop integration at $0, exactly as the goal packet
scoped it. A real model-over-state run is the library caller's to wire (pixel-bae supplies
its own `buildProvider`); the seam is what PR1 delivers. The config-only lane and the
in-process contract-module loader remain deferred (issue #149).
