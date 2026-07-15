# Actor Contract

Date: 2026-06-06 (current-state note updated 2026-07-14)

Status: accepted contract with a partially open extension surface. Shipped:
the evidence schema `humanish.actor-trace.v1` (`src/actor-contract.ts`) and a
closed first-party registry of six descriptors (`src/actor-registry.ts`:
`codex-app-server`, `pi-agent-core`, `claude-agent-sdk`,
`openai-computer-use`, `scripted-browser`, `codex-exec`). `actors[0].type` is a
real dispatch key on the computer-use, scripted-browser, and terminal-product
routes. Product scoring, feedback, and artifact hooks are extension seams, but
public out-of-tree actor registration and its conformance certification are not
shipped. Also not shipped: the full `Actor.run(input)` interface,
`RedactionHooks` injection, `ApprovalPolicy`, `StagehandCuaActor`, and the
`persona-fidelity` verify check. Decision 6's capture-time screenshot stance
was recanted in 0.6.0; see the inline notes and the capture-vs-publish rule in
[`docs/principles/invariants-and-defaults.md`](../principles/invariants-and-defaults.md).

`codex-exec` is a real dispatch key for terminal-product labs, but the exported
descriptor `runSession` is a fail-closed compatibility entry. Live execution is
owned by `runTerminalProductLab`, which coordinates sandbox creation,
command-scoped runtime auth, evidence, caps, and by-id cleanup.

## Context

> Historical context: this section describes the world as it stood when the
> design was accepted (one real actor, hardcoded dispatch). The current state is
> the six-descriptor first-party registry described in the status note above.

An actor is the thing that drives a persona scenario and produces evidence. At
design time Humanish had exactly one real actor: the local Codex integration in
`src/codex-app-server.ts` (plus the `codex-exec` and `codex-tui` variants in
`src/run.ts`). The actor selection is a hardcoded `if (actor === ...)` dispatch,
`RunStream.codex` is Codex-shaped, and the evidence schema is
`humanish.codex-app-server-trace.v1`.

That is a ceiling. Humanish's value is being a public-safe harness for persona and
agent user-studies, and the agent harnesses our users actually run are plural:
OpenAI Codex, the pi stack (`@earendil-works/pi-agent-core`, `pi-coding-agent`,
OpenClaw), Claude Code and the Claude Agent SDK, and computer-use models that
drive a real screen. A neutral, public-safe way to run the same persona scenario
across these harnesses, and to compare how each fares against a product, is an
unoccupied position. To get there, the actor must become a pluggable contract,
not a hardcoded branch.

This document defines that contract and the decisions behind it. It is the API
surface the adapters depend on, so it is treated as durable: proof artifacts are
API surface.

## Decisions

1. **Transport-agnostic contract; Codex stays the reference implementation.** The
   contract describes lifecycle and evidence, not transport. An adapter may be a
   subprocess protocol (Codex stdio JSON-RPC, `pi --mode rpc`, `claude -p
   --output-format stream-json`) or an in-process SDK (`pi-agent-core`, Claude
   Agent SDK, Stagehand). The existing Codex app-server integration is the
   reference adapter; `pi-agent-core` is the first in-process-SDK adapter, chosen
   to prove both shapes early.

2. **One normalized evidence schema: `humanish.actor-trace.v1`.** Codex `item/*`
   events, Claude `ToolUse`/`ToolResult` blocks, pi `tool_execution_*` events,
   and computer-use `computer_call` cycles all map onto one `ActorTrace` with a
   typed `items[]`. `humanish.codex-app-server-trace.v1` remains a back-compat
   alias during migration.

3. **A run is multi-turn within one trace; it stops on goal, abandonment,
   unrecoverable failure, or a wall-clock safety timeout, never on a turn cap.**
   Turn count is explicitly rejected as a stop signal: many turns usually means
   legitimate complex progress, so a turn budget truncates real work and rewards
   early quitting (it is a proxy for "too complex," not for "this user would
   quit"). Patience is modeled as **friction tolerance**, not a budget (see
   Persona section). The only hard runaway guard is the existing `timeoutMs`.
   One `ActorRunResult` covers a multi-step scenario.

4. **Redaction is injected once, never re-implemented per adapter.** Every
   adapter receives `RedactionHooks` (the shared secret/path/prompt-digest
   redaction, plus screenshot redaction) and must route all persisted evidence
   through it. This is also where the remaining consolidation of #107 lands.

5. **The registry refuses capability mismatches.** Each adapter declares
   `ActorCapabilities`. A scenario that needs `producesScreenshots` (a GUI
   journey) will not be dispatched to a code-only actor that would fake success
   via the shell. Coverage honesty over green-by-construction.

6. **Computer-use is one lane behind one adapter.** The shipped computer-use
   actor is `openai-computer-use` (fronting the OpenAI Responses adapter); a
   `StagehandCuaActor` fronting the other raw-pixel providers (Anthropic
   computer-use, Gemini) is not-yet-shipped roadmap. Screenshots are the
   largest new public-safety surface, and the original stance here
   (field-blurred plus OCR-scrubbed before any public artifact, fail-closed)
   enforced a default at capture-time; 0.6.0 recanted it. Current policy:
   frames are retained raw and full-fidelity by default in the gitignored
   `.humanish/` tree (never emitted by a publish command; this repo's CI
   binary-asset scan additionally blocks them from commit), and
   `policies.redactScreenshots: true` blurs at capture for share-as-is
   bundles. See the capture-vs-publish rule in
   [`docs/principles/invariants-and-defaults.md`](../principles/invariants-and-defaults.md).

## The contract

The excerpt below shows the central contract fields; exported source types are
authoritative.

```ts
export const ACTOR_TRACE_SCHEMA = "humanish.actor-trace.v1";

export type ActorStatus = "passed" | "failed" | "blocked" | "timed_out";

export type ActorCompletionReason =
  | "goal_satisfied"      // scenario success predicate met
  | "turn_completed"      // harness saw an explicit done signal, no predicate
  | "gave_up"             // persona abandoned in character: friction exceeded its tolerance
  | "blocked_approval"    // an action was auto-declined and the actor could not proceed
  | "timed_out"
  | "actor_error"
  | "step_failed"         // a deterministic scripted step/expectation evaluated false: the
                          // SUBJECT failed the script; the harness executed faithfully
                          // (distinct from actor_error/harness_error)
  | "harness_error";

// One normalized evidence row. Codex item/*, Claude ToolUse/ToolResult,
// pi tool_execution_*, and computer_call cycles all collapse onto this.
export interface ActorTraceItem {
  id: string;
  kind:
    | "message" | "reasoning" | "tool_call" | "command" | "file_change"
    | "approval" | "screenshot" | "ui_action" | "plan" | "notice";
  lifecycle: "started" | "completed";
  status?: string;
  title: string;                 // redacted, <= 120 chars
  tool?: { server?: string; name?: string };
  command?: { text?: string; cwd?: string; exitCode?: number; outputTail?: string };
  screenshotRef?: { path: string; redaction: "blurred" | "ocr_scrubbed" | "none" };
  text?: string;                 // redacted
}

export interface ActorCapabilities {
  headless: boolean;
  structuredTrace: boolean;
  lanes: Array<"code" | "app" | "computer-use" | "scripted-browser" | "terminal">;
  producesScreenshots: boolean;
  byoModel: boolean;
  preGrantableApprovals: boolean;   // can run unattended without a human prompt
  inProcessTools: boolean;          // can inject product tools without a subprocess
  license: "open" | "source-available" | "proprietary";
  keyPlacement?: "external" | "in-sandbox-command-scoped";
}

export interface ActorTrace {
  schema: typeof ACTOR_TRACE_SCHEMA;
  provider: string;              // e.g. "codex-app-server" | "pi-agent-core" | "claude-agent-sdk" | "openai-responses-cu" | "browser-persona" | "codex"
  providerVersion?: string;
  protocol: "json-rpc" | "json-stream" | "in-process-sdk" | "cua-loop" | "scripted-steps" | "terminal-exec";
  lane: "code" | "app" | "computer-use" | "scripted-browser" | "terminal";
  persona: { id: string; traitsApplied: string[]; promptDigest: string };  // proves traits were threaded
  // "raw" = full-fidelity frames retained (valid for LOCAL use; redact before
  // publishing); "blurred"/"ocr_scrubbed" = publish-safe; "n/a" = none captured.
  redaction: { status: "passed"; screenshots: "n/a" | "raw" | "blurred" | "ocr_scrubbed"; notes: string };
  startedAt: string; completedAt: string; durationMs: number;
  status: ActorStatus; completionReason: ActorCompletionReason; reason: string;
  ids: { sessionId?: string; threadId?: string; turnId?: string; model?: string };
  counts: Record<string, number>;
  items: ActorTraceItem[];
  tokenUsage?: { input?: number; output?: number; total?: number; costUsd?: number };
  capabilities: ActorCapabilities;
}

export interface ApprovalPolicy {
  mode: "auto-decline" | "pre-grant-allowlist" | "deny-all";
  allow?: string[];                                  // e.g. ["read:*", "bash:git diff *", "mcp__browser__*"]
  onRequest(req: ApprovalRequest): ApprovalDecision; // adapter calls; harness records every call
}

export interface RedactionHooks {
  redactText(s: string): string;
  publicPath(p: string, root: string): string;
  redactScreenshot(buf: Buffer, meta: ScreenshotMeta): Promise<{ buf: Buffer; method: "blurred" | "ocr_scrubbed" }>;
  promptForLog(raw: string): { placeholder: string; digest: string; length: number };
}

export interface ActorRunInput {
  cwd: string;
  runRoot: string;                  // where the adapter writes events/summary/transcript
  timeoutMs: number;
  persona: ResolvedPersona;         // FULL traits, not just {id, name}
  scenario: { id: string; title: string; goal: string; successText?: string[] };
  laneFocus?: { id: string; label: string; instruction: string };
  approval: ApprovalPolicy;
  redaction: RedactionHooks;
  model?: string;
  actorCommand?: string[];          // override binary / transport
  signal: AbortSignal;
}

export interface ActorRunResult {
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  durationMs: number;
  trace: ActorTrace;
  transcriptPath: string; tracePath: string; eventsPath: string;
  tail: string;
}

export interface Actor {
  readonly id: string;             // "codex-app-server"
  capabilities(): ActorCapabilities;
  run(input: ActorRunInput): Promise<ActorRunResult>;
}
```

### Contract semantics (every adapter must guarantee)

- **Lifecycle.** connect/spawn, initialize, apply persona + scenario as system or
  turn input, drive a bounded turn loop honoring `timeoutMs` and `signal`, emit a
  single explicit `completionReason`, tear down. No adapter may block waiting on a
  human.
- **Evidence.** Write the same three artifacts (`events.ndjson` redacted
  envelopes, `summary.json` = `ActorTrace`, `transcript.txt` human view) so the
  run-bundle wiring is provider-agnostic.
- **Approvals.** Call `approval.onRequest`; never embed adapter-local decline
  strings. Every call is recorded as an `items[kind=approval]`.
- **Redaction.** Use the injected `RedactionHooks`. Never re-implement redaction
  per adapter.
- **Diagnostics.** Unexpected actor-loop failures are recorded as
  `items[kind=notice,status=error]`, not raw crash dumps. Keep diagnostic notices
  public-safe: redacted message, coarse loop phase, last normalized UI action,
  and last screenshot reference only. Do not persist raw stacks, env values,
  target URLs, or unredacted provider payloads in the trace.
- **Capabilities.** Declare them honestly; the registry uses them to refuse
  unsuitable dispatch.

## The scripted-browser lane (shipped)

`scripted-browser` is the deterministic, model-free browser-actuation lane — distinct from
`computer-use` (raw pixels + a model deciding actions) and `app`. The registered
`scripted-browser` actor (`src/scripted-browser-actor.ts`) replays a committed scenario's
browser steps with playwright against a loopback app; the steps ARE the behavior, so
`byoModel: false` means there is NO model, and `tokenUsage` records zeros as an affirmative
$0 declaration that is true by mechanism (no provider client is importable from that code
path). Its trace keeps the concrete driver name `provider: "browser-persona"` (matching the
native `humanish.browser-persona-trace.v1` it also emits) with `protocol: "scripted-steps"`.

Completion semantics: `goal_satisfied` means the scenario's `expect` blocks — the success
predicate — all held ("the app still affords this exact journey", nothing about user
behavior); `step_failed` means a deterministic step or expectation evaluated false (the
subject failed the script; the harness ran faithfully); `timed_out` is the journey wall-clock
budget; `harness_error` is a browser that could not launch. `gave_up` and `blocked_approval`
are unreachable — no persona patience, no approvals exist on a deterministic replay.

Actuation-vs-spend gate: on the scripted lab route `scenario.mode: live` is still required
even though provider spend is $0 by mechanism. The gate's justification there is ACTUATION,
not cost — a live scripted run drives a real browser against a real running app
(state-mutating effects on the operator's app), which deserves the same affirmative
declaration as spend. "Live" on this route must never silently come to mean "costs money";
this paragraph is the record of that decision.

## The state-driven executor seam (shipped — the transport-agnostic intent, made real)

The `CuaExecutor` / `CuaProvider` ports are the concrete realization of the "plural harnesses /
transport-agnostic" intent above: the computer-use loop does not require a screen or a vision
model. A library caller can drive an **already-running local app** through its in-process JS
contract (`window.app.getState()` etc.) with a custom `CuaExecutor` (screenshot optional,
`appState` as the progress signal) paired with a **non-vision** `CuaProvider` (`requiresFrame`
falsey), keeping the whole lab composition with NO E2B desktop and NO clone. See
[`state-driven-executor.md`](./state-driven-executor.md) for the port, both entry points
(`runComputerUseLoop` and `runLab` + `buildExecutor`/`buildProvider`), the `subject.source:
local-app` config surface, the `requiresFrame` provider-authoring contract, and the
appState-is-runtime-only stance.

## The product-adapter extension seam (shipped — terminal-product lane, layer 6)

The terminal-product lane carries the proof-roadmap layer-6 deliverable: a product
adopter attaches product-specific scoring + feedback as a THIN in-repo extension
WITHOUT forking core. The seam is exported contract types (`RunBundle`,
`RunFeedbackCandidate`, `RunAdapterScore`, `RunMeaningfulUseScore`, `ActorTrace`,
the terminal-lane `TerminalProductScoringContext` / `TerminalLedgers` / ...) plus a
registrable `score` / `deriveFeedback` DI hook on `TerminalProductLabHooks` (mirror
of the `CuaActorLabHooks` DI seam). The adapter records its product nouns ONLY under
an adapter-NAMESPACED block (`RunFeedbackCandidate.adapter` /
`RunAdapterScore.{namespace,data}`), so core's enums stay product-agnostic — no
adopter noun is hardcoded into a core enum. Default (no hook) behavior is unchanged.
See [`terminal-product-lane.md`](./terminal-product-lane.md#slice-4--the-product-adapter-extension-seam-layer-6)
for the full seam and the thin-adapter conformance proof.

## Making personas load-bearing

The bug, grounded in code: `loadDryRunSelection` (`src/run.ts`) parses persona
YAML down to `{ id, name, source, sourceDigest }` and discards `summary`,
`traits.{patience, technical_confidence, accessibility_needs}`, and `constraints`.
The prompt builders then inject one line: `Persona: ${name}`. The persona is a
label.

Plan:

1. **Parse the whole persona** into a `ResolvedPersona`:
   `{ id, name, summary, goals[], traits: { patience, skill, accessibilityNeeds? }, constraints[], sourceDigest }`
   (map `technical_confidence` to `skill`).
2. **Compile traits into actor-neutral directives**, not prose, via a pure
   `personaToDirectives(p)`:
   - patience -> `frictionTolerance`: how much failure, dead-end, or
     no-forward-progress the persona absorbs before abandoning the task in
     character. Expressed as an instruction the actor embodies ("you are
     impatient: if you hit repeated friction or stop making progress toward your
     goal, stop and report exactly what blocked you"), not a turn or tool-call
     count.
   - skill -> tool/strategy bias (low-skill avoids CLI/flags and narrates
     confusion at ambiguous UI; high-skill uses shortcuts and recovery paths).
   - accessibilityNeeds -> concrete behavior (keyboard_first navigates by
     keyboard and fails a step that is mouse-only; clear_terminal_output flags
     noisy output as a defect).
   - goals + constraints become explicit success / forbidden lists for the
     scenario predicate.
3. **Abandonment is persona-judged, harness-corroborated, never a counter.** The
   persona-actor (an LLM embodying that user) decides in character when the
   friction is no longer worth it and stops with `completionReason: "gave_up"`,
   citing the specific friction. The harness corroborates with objective signals
   it already sees in the stream (consecutive failed/blocked actions,
   repeated-identical-action looping, no progress toward the success predicate)
   and annotates the abandonment friction as a feedback candidate. The harness
   imposes no turn cap; its only hard stop is the wall-clock `timeoutMs`.
4. **Bind the same directives per harness**: pi (`systemPrompt` +
   `beforeToolCall` allow rules), Claude (`system_prompt`/`--append-system-prompt`
   + `allowedTools`), Codex (prepend to `turn/start` input), Stagehand (agent
   context + action policy). Each binds the friction-tolerance, skill, and
   accessibility directives identically; none uses a `max_turns`-style cap as the
   persona stop condition.
5. **Prove it.** `ActorTrace.persona.traitsApplied` lists the injected
   directives; a `persona-fidelity` verify check asserts that the friction and
   accessibility directives reached the actor input and that a `gave_up` run
   cites a concrete friction reason (not a turn count). "Did the persona drive
   the run" becomes a verifiable artifact, not an assertion.
   (Status 2026-06-11: `personaToDirectives` shipped in `src/persona.ts` and
   `traitsApplied` is threaded on the codex routes, but the `persona-fidelity`
   verify check is not-yet-shipped roadmap, and the computer-use route stubs
   `persona.traitsApplied` to `[]` today — see `src/cua-actor-lab.ts`.)

## Decision: how abandonment is adjudicated

"When does a synthetic persona give up?" has no obvious best answer, so the
choice is recorded here rather than left implicit and silently re-litigated.

Options considered:

1. **Persona-judged only** (the LLM decides in character, uncorroborated).
   Truest embodiment, but LLM stop behavior is erratic (often too stubborn,
   sometimes too eager), non-reproducible, and hard to verify. A purely
   model-judged stop can also run uselessly to the wall-clock timeout.
2. **Harness-adjudicated from objective signals only** (no-progress,
   repeated-failure, looping); the persona just sets a numeric threshold.
   Deterministic and reproducible, but mechanical, misses the subjective "this
   is not worth it" judgment that is the whole point of a persona, and a fixed
   threshold quietly drifts back toward a disguised counter.
3. **Persona-judged primary, harness-corroborated backstop.** The actor decides
   in character and emits `gave_up` with the friction; the harness independently
   tracks objective signals and (a) annotates the friction as a feedback
   candidate, and (b) force-ends only on unambiguous pathology (e.g. repeated
   identical failed actions = a loop, or no progress past a wall-clock
   checkpoint) so a too-stubborn model cannot waste the entire timeout.

**Decision: option 3.** It keeps the behavior emergent and persona-faithful (the
value) while the objective backstop adds reproducibility and bounds a stubborn
model. Every backstop signal is progress- or friction-based, never a turn or
tool-call count.

Non-obvious tradeoffs to revisit with real-run data:

- The backstop thresholds (what counts as "looping" or "no progress") are
  themselves judgment calls. Start conservative (fire only on unambiguous
  pathology) and tune against real runs, logging when the backstop fires versus
  when the persona self-abandons, so the split stays mostly persona-judged.
- Friction tolerance per patience level is qualitative in the prompt, not a
  number. If "impatient" proves too soft, escalate by feeding the actor explicit
  running friction context ("you have hit 3 dead-ends"), still never a turn
  count.
- `persona-fidelity` treats a `gave_up` with no cited friction as a fidelity
  failure, not an accepted stop, so the model cannot quietly quit for no reason.

This keeps patience load-bearing and reproducible without ever using elapsed
turns as a stop signal.

## Capability matrix (target adapters)

| Adapter | headless | structured trace | sandbox | BYO model | license | actor fit |
| --- | --- | --- | --- | --- | --- | --- |
| codex-app-server (reference) | yes (stdio JSON-RPC) | typed item/* | OS Seatbelt/seccomp + approvalPolicy | OpenAI-first | Apache-2.0 | code |
| pi-agent-core (first new) | yes (SDK + rpc/json) | event stream + session JSONL + token/cost | BYO container + hook gating | 15+ providers, local | MIT | code, app |
| claude-agent-sdk | yes (SDK + `-p` stream-json) | typed ToolUse/ToolResult + cost | OS sandbox + dontAsk/allowedTools | Anthropic-centric | SDK MIT (CLI proprietary) | code, app |
| stagehand-cua (roadmap, not shipped; `openai-computer-use` is the shipped computer-use actor) | yes (SDK, mode:'cua') | structured results + replay | Playwright/Browserbase isolation | OpenAI/Anthropic/Google | MIT | computer-use |

## Sequencing

1. This document.
2. Shared `RedactionHooks` module (completes the remaining #107 criterion) plus
   the `Actor` contract types, with the Codex integration refactored to implement
   `Actor` and emit `ActorTrace` behind the back-compat alias. Add an
   `actorRegistry`; generalize `RunStream.codex` to `RunStream.actor`.
3. Personas load-bearing: `ResolvedPersona`, `personaToDirectives`, harness turn
   budget, and the `persona-fidelity` verify check.
4. `pi-agent-core` adapter (proves the contract against a non-Codex protocol;
   local-model dogfood for ~$0). Landed in two slices: first the pure
   `piSessionToActorTrace` mapper + registry generalization (discriminated
   `ActorDescriptor` union + `getActor` overloads) + a fixture conformance test,
   with no pi dependency and no model key required (proves the evidence contract
   is provider-neutral); then a follow-up live SDK shim behind a DI seam, deferred
   until the package identity (`@earendil-works/pi-agent-core` vs
   `@mariozechner/pi-coding-agent`) and the Node `>=22.19` vs engines `>=20` gap
   are pinned against an installed build.
5. `claude-agent-sdk` adapter (the `app` lane).
6. Computer-use lane. (Shipped as `openai-computer-use` — registered 0.3.0,
   lab-dispatched 0.4.0; `stagehand-cua` as a multi-provider front remains
   not-yet-shipped roadmap.)
7. Cross-harness conformance test: one persona x scenario through every adapter,
   asserting identical trace shape, completion vocabulary, and redaction status.
8. The proof point: run the harness-plural loop against popular OSS repos and turn
   real, merged issues into the receipt.

## Risks

- Protocol/version drift across four moving harnesses. Pin every binary/SDK and
  assert the init handshake; the registry refuses an actor whose declared
  capabilities do not satisfy the scenario.
- Screenshot PII in the computer-use lane. Redaction binds the PUBLISH
  boundary, not capture (0.6.0): raw frames stay local in gitignored
  `.humanish/` and are never emitted by a publish command (this repo's CI
  binary-asset scan additionally blocks them from commit);
  `policies.redactScreenshots: true` blurs at capture for share-as-is
  bundles. The earlier fail-closed redacted-thumbnail default was recanted —
  see the capture-vs-publish rule in
  [`docs/principles/invariants-and-defaults.md`](../principles/invariants-and-defaults.md).
- Persona directives regressing into decoration. Friction tolerance and
  accessibility must demonstrably reach the actor input and change step pass/fail,
  enforced by the `persona-fidelity` check; a `gave_up` run must cite a concrete
  friction, never an elapsed-turn count.
- License contamination. Proprietary harnesses (Claude CLI, Cursor) sit behind
  adapters; only their open SDKs are depended on directly.

## References

- Self-driving harness principles: `docs/principles/self-driving-harness.md`.
- Observer architecture: `docs/architecture/observer.md`.
- Related issues: shared redaction module (#107), PII/PHI detector (#108).
