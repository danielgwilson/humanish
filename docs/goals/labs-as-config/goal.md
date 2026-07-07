# Goal: labs are config, not hardcoded kinds

## Why

Homun's thesis is "install once, configure a reusable user-study (lab) per project" — not
rebuild a bespoke sim per project. The lab system contradicted that: `LabKind` was a closed
enum (`synthetic | oss-meta | oss-smoke`), each kind routed to a bespoke engine, and the OSS
actor's task was a hardcoded mission string. Every hardcoded kind was a bespoke sim smuggled
into the framework.

## What changed (PR #1 — structural, behavior-preserving)

- **`homun.lab.v2`** (`src/lab-config.ts`): a lab is a composition — `subject` × `actors[]` ×
  `execution` × `scenario` × `policies` × `review`. There is **no `kind`**. `actors[].type` is
  resolved against the registries at dispatch, not enumerated in the schema, so new actors
  extend the lab vocabulary by registering. **No v1 back-compat** (v1 had zero real users).
- **One engine** (`src/lab-engine.ts`, `runLab`): routes by `subject.source × execution.target`
  to the three execution backends (synthetic dry/browser, clone smoke, clone+E2B-desktop meta).
  The backends are genuinely distinct execution substrates and stay as proven primitives; the
  closed enum + kind switch + three per-kind command functions are deleted.
- The three built-ins are now example v2 configs (`homun/labs/*.yaml`); `homun init`
  scaffolds v2.

## Proof ladder

Merge gate = rungs 1–3 (deterministic, zero-spend):

1. **Necessity** (`tests/lab-structural.test.ts`): `LabKind`, `isLabKind`, the
   `switch (resolved.manifest.kind)`, the three `run*LabCommand` fns, and the `homun.lab.v1`
   schema are all asserted absent from `src/`. One path, by construction.
2. **Faithfulness** (`tests/lab-golden.test.ts` + `scripts/capture-lab-goldens.mjs`): `first-run`
   and `oss` v2 configs reproduce the pre-refactor golden bundles byte-for-byte (normalizing
   timestamps + ambient git working-tree state). Plus the full suite stays green (342 tests).
3. **Expressiveness** (`tests/lab-structural.test.ts`): a brand-new clone+e2b migration
   composition parses and routes config-only with zero engine edits, AND a behavioral test
   proves the engine *consumes* config (actor count → simCount), not merely routes a label.

Capstone (post-merge, paid): rung 4 = three real private bespoke sims re-expressed as config
(matrix below); rung 5 = one live E2B run.

## Capability matrix (rung-4 census)

Distinct capabilities exercised by three real, structurally-different private bespoke sims —
Project A (desktop computer-use), Project B (LLM-vs-LLM conversation), Project C (coding-agent
study) — vs homun primitives:

| Capability | homun today | Status |
|---|---|---|
| Headless coding agent in sandbox | `codex-app-server`, `claude-agent-sdk` registry actors | covered |
| Headed desktop computer-use actor | `computer-use.ts` + `e2b-desktop-executor.ts` engine | **MISSING: not registered as an actor (PR #2)** |
| Browser persona over real app (scripted) | Playwright `BrowserPersona` (`run.ts`) | covered (scripted) |
| LLM-vs-LLM conversation actor | — | MISSING (Project B; later) |
| E2B fanout / parallel sandboxes | `oss-meta-lab` desktops | covered |
| Nested / mission-control Observer | `observer*.ts` | covered |
| Personas (typed traits) | `persona.ts` + `personas/*.yaml` | covered |
| Branching scenario grammar | linear `steps[]` only | MISSING (later) |
| Scoring / eval rubric | `oss-meta-lab-scoring.ts` | covered (per-lab pluggable: later) |
| Cost / spend-cap ledger | — | MISSING (later) |
| Control arm / A-B baseline | — | MISSING (later) |

## Deferred to PR #2 (live-tested there)

- Thread per-actor `mission`/`laneFocus.instruction` (already in the v2 schema) into the live E2B
  bootstrap (3 in-sandbox prompt sites) — the "configurable mission" last mile.
- **Wire the OpenAI Computer Use loop as a registered `computer-use` actor** — required for
  homun to replace a computer-use bespoke sim. Then a live migration sim against an authorized
  private app (redacted label).
- Re-introduce `app-url` as a lab subject + restore the safety policy fields (`approval`/`noPush`/
  etc.) once they are actually enforced — both removed from v2 here to avoid shipping unenforced
  surface (see expert review).

## Honest scope note

PR #1 is a behavior-preserving structural unification; the three execution backends remain as
internal primitives (not micro-decomposed). The deeper extraction of `runOssMetaLab` into ~11
micro-primitives is an optional later pure-cleanup; it was deliberately NOT done here to avoid
risking the proven live-E2B orchestration (the golden oracle proves output faithfulness but
cannot prove a from-scratch rewrite of live-desktop behavior).
