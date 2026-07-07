# Goal: a state-driven executor seam (issue #148)

Status: ratified 2026-06-15. Decisions below came from a four-design adversarial
pass (two competing scopings — library-minimal vs config-complete — judged for
synthesis, audited by a doctrine critic, and feasibility-checked by an agent who
wrote and typechecked the actual pixel-bae adapter against the repo's strict
flags). This packet is the ratification record; it governs where the issue text
and the designs differ.

## The ask (issue #148)

Drive an already-running local web app through its in-process `window.*` JS
contract (`getState`/`sendChat`/`dispatch`/`navigate`) via a custom, state-driven
`CuaExecutor` — keeping homun's composition (personas, Observer, `ActorTrace`
bundle, redaction, friction loop) — **without** the clone + E2B-desktop path and
**without** screenshot vision. The progress signal is `getState()`, not pixels.

## The knot, resolved

A genuinely non-vision flow must swap **both** the executor (the JS contract) and
the provider (a brain reasoning over app state — the OpenAI computer-use provider
is vision-based and would get a blank frame), and the lab must **skip E2B**. The
clean resolution: both are injectable at the lab via new hooks; the lab takes a
no-desktop branch; `actors[0].type` keeps using the registered
`openai-computer-use` slot as the dispatch key while the trace's `provider`
string comes from the injected provider's `id`. No new registered lane is needed
for the library path.

## Scope — PR1 (ship now)

- **A — `buildExecutor` + `buildProvider` lab hooks + full E2B skip.** When
  `hooks.buildExecutor` is set, `runCuaActorLab` takes a branch that never calls
  `loadDesktopModule` / `Sandbox.create` / `prepareDesktop` /
  `provisionCloneSubject` / `desktop.open` / `stream.start`. `sandboxId`/
  `streamUrl` stay undefined, so `result.sandbox` is omitted — the verifiable
  "no E2B SDK call" proof. The bundle/Observer/redaction/scrubText/
  writeScreenshot/persona/friction composition below the session call is
  desktop-agnostic and runs unchanged.
- **`buildProvider` is REQUIRED alongside `buildExecutor`** — boot-time
  `HOMUN_CUA_LAB_EXECUTOR_NO_PROVIDER`, emitted in the early fail-closed block
  before key-gating. (`buildProvider` alone is allowed — a model swap on the
  normal E2B route.) The default OpenAI provider is vision-based and cannot drive
  a state-only executor.
- **D — `CuaObservation.screenshot` becomes optional; add `appState?`.** The loop
  guards both `recordScreenshot` call sites; when absent, the existing
  `counts.screenshots === 0` branch resolves `redaction.screenshots` to `"n/a"`.
  No fabricated `Buffer.alloc(0)` reaches disk. Friction prefers a deterministic
  sorted-key, depth/length-capped projection of `appState` as the progress key
  (`stableProgressKey`), falling back to `stateSignature`. Vision executors set no
  `appState` → byte-for-byte current behavior.
- **The blank-frame crash is fixed twice.** `CuaProvider.requiresFrame` (set true
  by the OpenAI provider) drives a per-turn fail-closed `harness_error` in the
  loop when a frame is required but absent; `buildCallOutput`'s param widens to
  `Buffer | undefined` with a defensive throw. A vision provider MUST set
  `requiresFrame: true` (recorded provider-authoring contract).
- **B — `subject.source: local-app`, fail-closed/library-assisted.** A real,
  parse-validated source (loopback `appUrl`, computer-use actor only,
  `execution.target` local/absent, clone-only fields rejected) that routes to the
  cua backend and returns `HOMUN_CUA_LAB_LOCAL_APP_NO_EXECUTOR` when no
  `buildExecutor` hook is present — a structured error, never a desktop attempt.
  Shareable YAML; honest unsupported-combo error (acceptance #2's letter).
- **E — docs.** `docs/architecture/state-driven-executor.md` (the `CuaExecutor`
  port, deriving `stateSignature`/`appState`, optional screenshot, the non-vision
  provider requirement, both entry points, the appState-runtime-only stance, the
  `appState` typing-ergonomics note) + a link from `actor-contract.md` + a README
  Adapters pointer.

## Ratified doctrine fixes (all four implemented in PR1)

1. **`redaction.notes` self-describes appState handling.** On the non-vision
   path, append to the artifact's `redaction.notes` that app state was observed
   each turn to drive progress detection and was **not** written to the trace —
   so the bundle declares how it handled a surface it touched (invariant 6).
2. **`stableProgressKey` is correctness-load-bearing.** Sorted-key deterministic
   stringify, depth- and length-capped, never throws on a cyclic or huge
   `appState` (degrades to a bounded value). Proven by tests: shuffled key order =
   no progress; constant `stateSignature` + changed `appState` = progressed;
   oversized/cyclic = bounded, not a crash.
3. **`requiresFrame` is a provider-authoring contract.** Documented: a vision
   provider MUST set `requiresFrame: true`; default-false is a known
   third-party-author footgun this slice accepts (only one vision provider
   exists) but records.
4. **`LOCAL_APP_NO_EXECUTOR` precedes key-gating.** Emitted in the same early
   fail-closed engine block as the other re-enforcement guards, so a CLI
   invocation never emits the misleading `KEYS_MISSING` error first.

## appState ruling (doctrine critic)

Runtime-only, never persisted. The published-evidence scan catches only
secret-shaped patterns; a structured app blob (ids, free-form state, possibly
user chat or shapeless tokens) is exactly the "value has no shape" gap. appState
is an in-memory progress-comparison input (like `stateSignature`, which is itself
never written as text). The only derived value — the progress key — is coarse and
never emitted as a trace item. A future "appState in evidence" slice must route a
stringified projection through `redactNarration` (scrubText ∘ redactText) AND
cap/whitelist fields — pattern+literal redaction alone cannot sanitize an
arbitrary blob; the docs say so.

## Deferred (named, with gates)

- **PR2 — config-only deterministic lane (proposals B-full + C).** A registered,
  model-free `state-contract` lane driving a built-in `window.app.*` bridge over
  the existing `ScriptedPageLike.evaluate` primitive + a YAML step program,
  $0-by-mechanism, `scenario.mode: live` gating actuation. It must NOT overclaim
  friction-loop reuse (it would be deterministic step replay, not
  `runComputerUseLoop`) and must re-enforce the loopback wall in its backend. Note
  for the implementer: `ScriptedPageLike.evaluate(string)` has no arg slot, so a
  default arg-bearing bridge needs the port widened to pass the value as a cloned
  positional argument (never string-interpolated into the evaluate source).
- **PR3 — `subject.contract.ref` JS-module loader.** A config-referenced module
  loaded and run **in-process with full harness privileges** is a genuinely NEW
  trust surface with NO precedent in this repo (the scripted lane loads only
  declarative YAML data; serve commands run isolated inside the disposable E2B
  sandbox). It earns its place only behind its own clamping/trust/digest-pinning
  design (cwd-clamp per the scenario.ref precedent; provenance digest of the
  module; author-trusted framing stated plainly as arbitrary-code execution). Not
  needed by pixel-bae (a library caller builds the bridge in their own trusted
  code). Tracked separately.

## Proof ladder (PR1)

Deterministic rungs are the merge gate ($0):
1. `lab-config`: `local-app` + computer-use actor parses, `selectLabBackend` =
   "cua"; rejects `local-app` + non-cua actor, + `e2b-desktop`, + clone-only
   fields.
2. `computer-use`: a no-screenshot executor with distinct `appState` per turn —
   zero frames written, `redaction.screenshots === "n/a"`, redaction.notes states
   the appState stance; an appState delta drives `progressed` even with a constant
   `stateSignature` (and the inverse trips the backstop); shuffled-key-order =
   no progress; oversized/cyclic appState = bounded, no throw.
3. `computer-use`: a `requiresFrame:true` provider against a screenshot-less
   observation ends `harness_error` with the named reason (not a crash, not a
   silent pass).
4. (load-bearing) `cua-actor-lab` live mode with `buildExecutor` (real loop, fake
   state executor) + `buildProvider` (fake state brain) + a `loadDesktopModule`
   whose `Sandbox.create` pushes to a `created[]` array: assert
   `created.length === 0`, `result.sandbox === undefined`, AND a full bundle that
   passes `verifyRun` (not just that it was written — proves the hollow-pass net).
5. `cua-actor-lab`: `buildExecutor` without `buildProvider` →
   `EXECUTOR_NO_PROVIDER`; `local-app` with no hooks → `LOCAL_APP_NO_EXECUTOR`,
   before any key check.

One live, keys-gated rung (NOT a merge gate, kept as a receipt under this
packet's `receipts/`): the pixel-bae library snippet against a real local app +
a real non-vision provider — `goal_satisfied` via `getState()`, no E2B sandbox
created (`result.sandbox === undefined`).
