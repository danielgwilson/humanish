# Goal: multi-lane fan-out for the computer-use lab (#163)

## Objective

Ship multi-lane fan-out for the computer-use lab — N differentiated persona lanes
(per-lane persona / device / starting-surface) in ONE verified run bundle, with
bounded concurrency and `per-lane worlds` as the default — proven deterministically
at $0. This is proof-roadmap layer 2 and the prerequisite for the multi-actor
shared-state depth work.

## Source Of Truth

- Issue #163 (the capability + acceptance) and the epic #166.
- The already-ratified, adversarially-judged fan-out design:
  `docs/goals/proof-roadmap-layers-1-2/goal.md` (Slice 3 — per-lane-worlds the default,
  seed-fork an opt-in; lanes roster; bounded concurrency; pre-flight spend plan; honest
  result schema). Follow it; do not re-derive.
- `docs/principles/invariants-and-defaults.md` (the `per-lane worlds` default, the
  capture-vs-publish rule, claims-match-mechanism).
- The shipped lane patterns to mirror: `src/cua-actor-lab.ts` (orchestration template),
  `src/scripted-browser-lab.ts` / `src/e2b-terminal-lab.ts` (recent lane additions),
  `src/lab-config.ts` + `src/lab-engine.ts` (routing).

## Success Invariants

- A lab declares a roster of N differentiated lanes (each with its own persona, device
  preset, and per-lane starting surface) OR a homogeneous `count: N`, and produces ONE
  `humanish.run-bundle.v1` with N simulations/streams that passes `verifyRun`.
- `per-lane worlds` is the default: N independent sandboxes, each provisioned via the
  existing clone/serve + `subject.state` machinery. (Shared-world is #164, out of scope.)
- `execution.concurrency` bounds in-flight lanes; an env override may only LOWER the
  bound, never raise concurrent paid lanes (invariant 3 spirit).
- A pre-flight spend/lane plan is emitted (and recorded as a bundle event) BEFORE any
  sandbox or provider call; the identical plan appears in dry-run marked $0.
- Per-lane provenance, per-lane `verifyRun` coverage, and per-lane cleanup proof; one
  lane's harness error never silently passes the run (the no-engagement guard applies
  per lane).
- The N=1 path stays byte-stable against the existing golden (only the result projection
  changes if at all).
- The deterministic ($0) proof ladder is green and is the merge gate.

## Allowed Scope

- Read/write: `src/lab-config.ts`, `src/lab-engine.ts`, `src/cua-actor-lab.ts`, a new
  `src/concurrency.ts` (hoist `mapWithConcurrency` if the design calls for it),
  `src/run.ts` ONLY where the bundle/result genuinely needs it (additive), `src/index.ts`
  (exports), the lab fixture(s) under `humanish/labs/`, tests under `tests/`, docs under
  `docs/goals/multi-lane-fanout/` and `docs/contracts/schemas.md`.
- Commands: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build`,
  `node scripts/public-surface-scan.mjs`, `pnpm humanish -- lab ...` (dry-run only), `gh`.

## Non-Goals

- Multi-actor shared-world / shared-service topology (#164).
- Adapter scoring/feedback hook on the computer-use route (#165).
- Flipping the default provisioning to `seed-fork` (its mechanism may land per the
  design, but making it the DEFAULT requires its live rung — deferred).
- Any live provider spend in the autonomous run (see Provider Spend Policy — pause first).
- PII/PHI detector (#108); duplex-PTY work.

## Evaluation Plan

- Environment state that proves success: a dry-run lab with an N-lane roster produces
  one bundle with N streams/sims (correct per-lane persona/device/viewport), the plan
  event present, and `verifyRun` ok. A live-with-FAKE-substrate test (DI seam, $0) runs
  the REAL orchestration: N fake sandboxes created with per-lane metadata, bounded
  concurrency respected (wave order), per-lane cleanup proven (kill-by-id), a lane
  harness error skips remaining lanes without a green pass, and a hollow lane fails verify.
- Independent check: `verifyRun` over the produced bundle (not just that a file was
  written); the N=1 golden stays byte-stable.
- Failure / blocked / timeout: recorded with receipts; a lane that cannot prove its own
  cleanup fails closed.

## Proof Commands

- `pnpm check` (typecheck + vitest + build) — exit 0.
- `node scripts/public-surface-scan.mjs` — exit 0 (check its OWN exit code; do not pipe
  through `tail`, which masks it).
- `pnpm humanish -- lab run <fanout-fixture> --dry-run --json --no-open` then
  `pnpm humanish -- verify --run latest --json` — ok.

## Proof Artifacts

- The new deterministic fan-out test file(s) and their pass counts.
- A receipt under `docs/goals/multi-lane-fanout/receipts/` for the (separately-authorized)
  live rung, if and when it is run.
- The PR(s) with green required CI checks.

## Known Failure Modes

- Dry-run-only success claimed as live capability.
- A single lane masquerading as a swarm (N=1 dressed up).
- Transcript/assertion-only "it passed" without `verifyRun` over the bundle.
- Account-wide E2B `Sandbox.list`/kill (FORBIDDEN — see Autonomy Rails).
- A lane referencing an artifact it did not write (inherit `src/artifact-reference.ts`).
- Stale local main (the branch must be cut from current `origin/main`).

## Autonomy Rails

- Allowed: the scoped paths above; one squashed commit per PR; open the PR, do NOT merge
  (the maintainer reviews + merges).
- Forbidden: ANY account-wide E2B operation. A run may ONLY kill a sandbox IT created, BY
  its exact sandboxId, in a finally. E2B has no project/namespace isolation — every
  sandbox on the key is a flat global list, so enumerate-and-kill could destroy a
  teammate's or a production sandbox. Never enumerate-and-kill.
- Commit identity must be `daniel@danielgwilson.com` (author + committer); the model is
  named only in the `Co-Authored-By` trailer (the public-surface scan rejects unapproved
  commit emails).
- Checkpoint cadence: update `state.yaml` + a receipt after each meaningful slice.

## Provider Spend Policy

- The deterministic merge-gate proof is **$0 by mechanism** (a fake substrate via the DI
  seam + dry-run). No provider/E2B calls.
- The live rung is a SEPARATE, explicitly-authorized step, NOT part of the autonomous run.
  Before any paid run the goal must PAUSE and obtain authorization with: allowed providers
  (E2B desktop + OpenAI computer-use); a dollar cap; a wall-clock cap; **max concurrent
  paid desktops = the `execution.concurrency` bound** (the spend control, not a total
  run-count cap); cleanup/readback = each lane's sandbox killed by id in a finally + a
  post-run by-id confirmation that THIS run's sandboxes are gone (never a list, never a bulk kill);
  a usage receipt path under `receipts/`.
- A shared operator E2B key is safe: humanish reclaims and verifies only the exact sandbox ids
  it created, by id, and never enumerates the account (see the invariants doc). If the dollar
  or wall-clock cap is hit, stop and report.

## Stop And Ask

- Secrets or `.env` values; any account-wide E2B operation.
- Any live provider spend (pause for the spend contract above).
- PII/PHI, private screenshots, private transcripts, private repo names/source.
- Production data; deploys; public tunnels; payments; destructive git/filesystem ops.
- Scope expansion into shared-world (#164), the scorer hook (#165), or any other lane.

## Completion Audit

Before marking complete, map every Success Invariant to concrete environment-state
evidence: the dry-run N-stream bundle + its `verifyRun` result, the deterministic
fake-substrate test output (bounded concurrency, per-lane cleanup-by-id, fail-fast,
hollow-lane caught), the byte-stable N=1 golden, green required CI, and `state.yaml` +
receipts current. The live rung is NOT required for this goal's completion (it is a
separately-authorized follow-up); say so explicitly. Treat any unmapped invariant as
not complete.
