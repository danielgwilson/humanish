# Goal: register the OpenAI Computer Use actor (live-proven)

## Why

The computer-use engine (the CUA loop in `src/computer-use.ts`, the OpenAI Responses provider in
`src/openai-responses-cu.ts`, and the E2B desktop executor in `src/e2b-desktop-executor.ts`)
shipped as tested-but-unwired primitives: nothing registered them as an actor, nothing exported
them, and no lab could reach them. A browser/GUI user is essential for replacing bespoke
UI sims, so the lane has to become a first-class registered actor.

## What shipped (this slice)

- **Shared E2B substrate** (`src/e2b-desktop-launch.ts`): the optional-peer loader + structural
  Sandbox interfaces, hoisted out of `oss-meta-lab.ts` (which re-imports them byte-for-byte).
- **`runCuaActorSession`** (`src/computer-use-actor.ts`): the registry-facing wrapper that
  constructs the OpenAI provider + E2B executor behind DI seams (tests inject fakes; zero spend).
- **Registry entry**: `openai-computer-use` in `actorRegistry` — `runSession`-only, since the
  loop already returns a finished `mimetic.actor-trace.v1`; capabilities reuse
  `OPENAI_RESPONSES_CU_CAPABILITIES` so the registry never drifts from what the trace reports.
- **Public surface**: the full CUA API exported from `src/index.ts` (previously unexported).
- **A live-API bug fix found by real testing**: the Responses `computer` tool must be exactly
  `{ "type": "computer" }` — the previously shipped provider sent `display_width`/`display_height`/
  `environment`, which the live API rejects with 400 `unknown_parameter`. The model infers
  resolution from the screenshots it is sent. The now-dead `display` provider option was removed
  rather than left as a parse-then-no-op lie.

## Proof

- **Deterministic (CI, no spend)** — `tests/computer-use-actor.test.ts`: six tests prove the
  registered descriptor drives the real provider (fake transport) and the real executor (fake
  desktop) end-to-end: the model's click lands on the desktop, the trace is conformant
  (`computer-use` / `cua-loop` / `openai-responses-cu`), typed secrets and API keys never reach
  the trace, every screenshot ref is `blurred`, and safety checks fail closed (`blocked_approval`).
- **Live (spend-gated)** — `tests/computer-use-actor.live.test.ts`: triple-gated
  (`MIMETIC_LIVE_CUA=1` + both API keys + lazy peer import). A real E2B desktop showing a local
  `file://` page, driven by the real OpenAI Computer Use loop, returned
  `status=passed / goal_satisfied` with a conformant redacted trace (run 2026-06-09; the run that
  surfaced and then verified the tool-schema fix).

## Deliberately deferred (next slice)

- **Lab-config dispatch**: making `actors[].type` a real routing key, the `app-url` subject, a
  CUA lab path (`runCuaActorLab` + a bundle builder filling `RunStream.actor`), and Observer
  surfacing. The `app-url` schema re-add was *reverted* from this slice: with no route consuming
  it, an app-url lab would have silently downgraded to a synthetic dry-run — the exact
  silent-downgrade failure mode the labs-as-config review flagged.
- Multi-actor fan-out, approval policy beyond the fail-closed default, `ocr_scrubbed` redaction.

## Public-safety notes

- Screenshots are redacted inside the loop before persistence (`redactScreenshot`, fail-closed);
  typed text is recorded as `type [N chars]`; the API key lives only in the request header.
- The live test's target is a file written into the disposable sandbox — no public site is
  driven, nothing is served, and the sandbox is killed in `finally`.
- The blur-thumbnail redaction bar is documented in `src/redaction.ts` (coarse layout can remain
  visible; `ocr_scrubbed` is the reserved hardening).
