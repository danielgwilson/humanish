# State-driven executor (the `CuaExecutor` port)

Date: 2026-06-15

Status: shipped (PR1 of issue #148). The library path (a custom executor + a
non-vision provider, driven through the lab with NO E2B and NO vision) is
implemented and proven. A config-only deterministic lane and a
`subject.contract.ref` JS-module loader are deferred (see "Deferred", below).

## What this is

The computer-use (CUA) loop in [`src/computer-use.ts`](../../src/computer-use.ts)
is provider- and substrate-agnostic by design: the model lives behind a
`CuaProvider` port and the thing being driven lives behind a `CuaExecutor` port.
You do not have to drive a screen with a vision model. You can point the loop at
**an already-running local app** and drive it through that app's **in-process
JavaScript automation contract** (e.g. `window.app.getState()`,
`sendChat(text)`, `dispatch(action)`, `navigate(target)`), using `getState()` as
the progress signal instead of a quantized screenshot — keeping homun's
composition (personas, the Observer, the normalized `ActorTrace` evidence
bundle, redaction, and the friction / no-progress loop).

This is the "plural harnesses / transport-agnostic" intent of
[`actor-contract.md`](./actor-contract.md), made into a supported seam.

## The port

```ts
interface CuaExecutor {
  observe(): Promise<CuaObservation>;   // capture current state
  execute(action: CuaAction): Promise<void>; // perform one action
}

interface CuaObservation {
  screenshot?: Buffer;                  // OPTIONAL — a state executor omits it
  stateSignature: string;              // REQUIRED — the fallback progress key
  appState?: Record<string, unknown>;  // structured state; preferred for progress
}
```

- **`screenshot` is optional.** A non-vision (state) executor omits it. The loop
  persists no screenshot that turn; `counts.screenshots` stays 0, so the trace's
  `redaction.screenshots` resolves to `"n/a"`. No fabricated `Buffer.alloc(0)`
  ever reaches disk. (A vision executor still returns a frame, exactly as before.)
- **`stateSignature` is still required.** Derive it from your own state — e.g.
  `JSON.stringify({ route, turn, modal })`. It is the canonical fallback progress
  key when `appState` is absent. It is never written to the trace as text.
- **`appState` is the preferred progress input.** When present, the loop's
  friction / no-progress detection keys off a deterministic, sorted-key,
  depth/length-capped projection of it (`stableProgressKey`) rather than the
  signature. So a route change drives "progress" even when a quantized signature
  would not, and key insertion order can never fabricate a delta.

### `stateSignature` vs `appState`

Either is enough on its own. `appState` is preferred because `getState()` is a
far more reliable progress signal than a quantized screenshot signature on a
graphically dense (pixel-art) UI. `stableProgressKey(appState)`:

- sorts object keys (order-independent — shuffled keys ARE NOT progress);
- caps depth, key count, array length, string length, and total output;
- never throws on a cyclic or huge `appState` — it degrades to a bounded value
  (cycles become `"[Circular]"`, over-cap nodes become markers). This is
  correctness-load-bearing: a hostile or merely large state blob cannot crash the
  loop.

## You need a NON-vision provider too

Swapping the executor is not enough. The default OpenAI computer-use provider is
**vision-based**: it sends the screenshot as the `computer_call_output`, so a
screenshot-less observation would crash it. A genuinely non-vision flow swaps
**both** the executor (the state contract) **and** the provider (a brain that
reasons over app state).

**Provider-authoring contract:**

- A **vision** provider MUST set `requiresFrame: true` (the OpenAI provider does).
  When a `requiresFrame: true` provider is handed a screenshot-less observation,
  the loop fails closed with a structured `harness_error` per turn — not a silent
  crash, not a false pass.
- A **state-reasoning** provider omits `requiresFrame` (defaults falsey) and reads
  `req.observation.appState`.

`requiresFrame` defaulting to falsey is a known third-party-author footgun (a
vision provider that forgets to set it would get a blank-frame crash instead of a
clean verdict). This slice accepts it because only one vision provider exists
today, and records it here.

## `appState` is RUNTIME-ONLY (not evidence, in this slice)

`appState` is an in-memory progress-comparison input, exactly like
`stateSignature` (which is itself never written as text). It is **never** copied
into any `ActorTraceItem`, reason, id, or count, and is **never** persisted to the
trace. Only the derived progress key is computed in-memory and discarded.

Why: the published-evidence scan catches only secret-*shaped* patterns. A
structured app blob (ids, free-form state, possibly user chat or shapeless
tokens) is exactly the "value has no shape" gap that pattern redaction cannot
close. So this slice does not treat `appState` as an evidence surface at all.

The bundle is self-describing about it (invariant 6): when a state executor
surfaces `appState`, the trace's `redaction.notes` declares that app state was
observed each turn to drive progress detection and was NOT written to the trace.

A future "appState in evidence" slice MUST route a stringified projection through
`redaction.redactText` (and the lab's `scrubText`) AND cap / whitelist fields
before persisting — pattern + literal redaction alone cannot sanitize an
arbitrary blob.

## Provenance is honestly UNPINNED (invariant 5)

An already-running local dev server cannot be commit-pinned. The bundle does not
silently omit a subject block — it DECLARES the absence: `subject.source:
app-url` with `state.provenance: "undeclared"` (the app-url "absence declared"
marker), and a `cua-lab.subject.declared` event that states the entry is a local
dev server driven in-process, caller-provisioned and UNPINNED, with no E2B
desktop created.

## Two entry points

### 1. Bare `runComputerUseLoop` (lowest level)

Implement `CuaExecutor.observe()/execute()`, derive `stateSignature`/`appState`
from your own state, pair it with a non-vision `CuaProvider`, and call
`runComputerUseLoop`. You own the bundle/redaction wiring.

### 2. `runLab` + `buildExecutor` / `buildProvider` (keeps the composition)

The supported library path. It keeps personas, the Observer, the evidence
bundle, redaction, and the friction loop, while skipping E2B entirely:

```ts
import { runLab, parseLabConfig, type CuaExecutor, type CuaProvider } from "homun";

// local-app YAML (shareable; fails closed without hooks):
//   schema: homun.lab.v2
//   id: pixel-bae-state
//   subject: { source: local-app, appUrl: http://localhost:5173 }
//   actors: [{ type: openai-computer-use, persona: pixel-pat, mission: "…" }]
//   scenario: { mode: live }
const parsed = parseLabConfig(yaml);
if (!parsed.ok) throw new Error(parsed.error.message);

const outcome = await runLab(parsed.config, {
  cwd: process.cwd(),
  dryRun: false,
  cuaHooks: {
    buildExecutor: async ({ appUrl }) => createAppContractExecutor(bridge, appUrl),
    buildProvider: async () => createStateBrain(),
  },
});
// outcome.backend === "cua"; outcome.result.sandbox === undefined (NO E2B); the
// trace's provider id is the injected brain's id.
```

When `cuaHooks.buildExecutor` is set, `runCuaActorLab` takes a branch that NEVER
loads the E2B module, creates a sandbox, runs `prepareDesktop`, provisions a
clone, opens a browser, or starts a stream. `sandboxId`/`streamUrl` stay
undefined, so `result.sandbox` is omitted — the verifiable "no E2B SDK call"
proof.

Two boot-time fail-closed guards (both BEFORE any key check, so a CLI invocation
never sees a misleading `KEYS_MISSING` first):

- `HOMUN_CUA_LAB_EXECUTOR_NO_PROVIDER` — `buildExecutor` without `buildProvider`
  (a state executor MUST be paired with a non-vision provider). `buildProvider`
  ALONE is allowed — that is just a model swap on the normal E2B route.
- `HOMUN_CUA_LAB_LOCAL_APP_NO_EXECUTOR` — a `subject.source: local-app` config
  run with no `buildExecutor` hook (there is no built-in in-process driver yet).
  A structured error, never a desktop attempt.

Key gating is route-aware: the in-process route uses the caller's OWN model and
executor, so no `OPENAI_API_KEY`/`E2B_API_KEY` is required.

## A note on `appState` typing

`CuaObservation.appState` is `Record<string, unknown> | undefined` under the
repo's strict flags (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`).
A value typed as an `interface` does NOT satisfy `Record<string, unknown>`
(interfaces have no implicit index signature), and a direct `as Record<...>` cast
on an interface-typed value is rejected. Use one of:

- a `type` alias for your state shape (type aliases get the index signature);
- a spread into a fresh object literal (`{ ...state }`); or
- `as unknown as Record<string, unknown>`.

Read every optional field defensively, and spread-omit optional fields
(`...(x === undefined ? {} : { x })`) rather than assigning `undefined`.

## Deferred (tracked, not shipped here)

- **PR2 — a config-only deterministic `state-contract` lane.** A registered,
  model-free lane driving a built-in `window.app.*` bridge over the existing
  `ScriptedPageLike.evaluate` primitive + a YAML step program, `scenario.mode:
  live` gating actuation. It would be deterministic step replay, NOT
  `runComputerUseLoop`, and must not overclaim friction-loop reuse.
- **PR3 — a `subject.contract.ref` JS-module loader.** A config-referenced module
  loaded and run in-process with full harness privileges is a genuinely NEW trust
  surface with no precedent in this repo (the scripted lane loads only declarative
  YAML; serve commands run isolated inside the disposable E2B sandbox). It earns
  its place only behind its own clamping / trust / digest-pinning design.
  pixel-bae does not need it: a library caller builds the bridge in their own
  trusted code (entry point 2 above).
