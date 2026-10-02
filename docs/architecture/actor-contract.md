# Actor Contract

Part of this contract ships and part is still open. Shipped: the evidence schema
`humanish.actor-trace.v1` (`src/actors/contract.ts`) and a closed first-party registry of five
descriptors (`src/actors/registry.ts`: `codex-app-server`, `openai-computer-use`, `local-agent`,
`scripted-browser`, `codex-exec`). `actors[0].type` is a real dispatch key on the computer-use,
scripted-browser, and terminal-product routes. Product scoring, feedback, and artifact hooks are
extension seams, but public out-of-tree actor registration and its conformance certification are not
shipped. Also not shipped: the full `Actor.run(input)` interface, `ApprovalPolicy`,
`StagehandCuaActor`, and the `persona-fidelity` verify check. `RedactionHooks` ships in
`src/evidence/redaction.ts`, and the computer-use loop takes it; the other adapters do not take it
yet. Of the capabilities, routing checks `lanes` and `producesScreenshots` (`src/lab/routing.ts`):
an actor that declares no screenshots cannot run on the computer-use or scripted-browser route.
Decision 6's capture-time screenshot stance was recanted in 0.6.0; see the inline notes and the
capture-vs-publish rule in
[`docs/principles/invariants-and-defaults.md`](../principles/invariants-and-defaults.md).

`codex-exec` is a real dispatch key for terminal-product labs, but the exported
descriptor `runSession` is a fail-closed compatibility entry. Live execution is
owned by `runTerminalProductLab`, which coordinates sandbox creation,
command-scoped runtime auth, evidence, caps, and by-id cleanup.

#955 removed the `pi-agent-core` and `claude-agent-sdk` descriptors, the `app` run kind and
the `in-process-sdk` protocol. No lab route dispatched either descriptor, and a
lab that names one now fails to parse. A signed-in Claude Code drives computer-use studies
through `local-agent`, which plugs into the provider-neutral `CuaProvider` port
(`src/actors/computer-use/loop/types.ts`, re-exported from `loop.ts`).

## Context

> Historical context: this section describes the world as it stood when the
> design was accepted (one real actor, hardcoded dispatch). The current state is
> the five-descriptor first-party registry described in the status note above.

An actor is the thing that drives a persona scenario and produces evidence. At
design time humanish had exactly one real actor: the local Codex integration in
`src/actors/codex/app-server.ts` (plus the `codex-exec` and `codex-tui` variants in
`src/run/`). The actor selection is a hardcoded `if (actor === ...)` dispatch,
`RunStream.codex` is Codex-shaped, and the evidence schema is
`humanish.codex-app-server-trace.v1`.

That is a ceiling. humanish's value is being a public-safe harness for persona and
agent user-studies, and our users actually run several agent harnesses:
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
   reference adapter. `pi-agent-core` was planned as the first in-process-SDK
   adapter to prove both shapes early; it shipped only as a trace mapper with no
   route, and #955 removed it.

2. **One normalized evidence schema: `humanish.actor-trace.v1`.** Four producers map
   their records onto one `ActorTrace` with a typed `items[]`:
   - Codex app-server `item/*` events, protocol `json-rpc`: `codexResultToActorTrace`
     (`src/actors/codex/app-server-actor-trace.ts`).
   - Computer-use loop turns, protocol `cua-loop`, whether the provider returned an OpenAI
     `computer_call` or a local agent's JSON actions: `loopResult`
     (`src/actors/computer-use/loop/trace.ts`).
   - Scripted-browser steps, protocol `scripted-steps`: `projectScriptedActorTrace`
     (`src/actors/scripted-browser/actor.ts`).
   - The terminal route's command log and terminal events, protocol `terminal-exec`:
     `buildTerminalActorTrace` (`src/routes/terminal/trace.ts`).

   The Codex app-server still writes its own `humanish.codex-app-server-trace.v1` record
   (`CodexAppServerTrace` in `src/actors/codex/app-server-trace.ts`), which
   `codexResultToActorTrace` converts. The Claude Agent SDK `ToolUse`/`ToolResult` and pi
   `tool_execution_*` mappers went with their adapters in #955.

3. **A run is multi-turn within one trace; it stops on goal, abandonment, unrecoverable
   failure, or a wall-clock safety timeout, never on a turn cap.** Turn count is explicitly
   rejected as a stop signal: many turns usually means legitimate complex progress, so a
   turn budget truncates real work and rewards early quitting (it is a proxy for "too
   complex," not for "this user would quit"). Patience is modeled as **friction
   tolerance**, not a budget (see Persona section). The only hard runaway guard is the
   existing `timeoutMs`. One `ActorRunResult` covers a multi-step scenario. (Since then,
   declared spend caps also end a computer-use session with `budget_reached`; neither guard
   counts turns.)

4. **Redaction is injected once, never re-implemented per adapter.** Every
   adapter receives `RedactionHooks` (the shared secret/path/prompt-digest
   redaction, plus screenshot redaction) and must route all persisted evidence
   through it. This is also where the remaining consolidation of #107 lands.

5. **The registry refuses capability mismatches.** Each adapter declares
   `ActorCapabilities`. A scenario that needs `producesScreenshots` (a GUI
   flow) will not be dispatched to a code-only actor that would fake success
   via the shell.

6. **Computer-use is one route behind one adapter.** The shipped computer-use
   actor is `openai-computer-use` (fronting the OpenAI Responses adapter); a
   `StagehandCuaActor` fronting the other raw-pixel providers (Anthropic
   computer-use, Gemini) is not-yet-shipped roadmap. Screenshots are the
   largest new public-safety surface, and the original stance here
   (field-blurred plus OCR-scrubbed before any public artifact, fail-closed)
   enforced a default at capture-time; 0.6.0 recanted it. Current policy:
   frames are retained raw and full-fidelity by default in the gitignored
   `.humanish/` tree (never emitted by a publish command; this repo's CI
   binary-asset scan also blocks them from commit), and
   `policies.redactScreenshots: true` blurs at capture for share-as-is
   bundles. See the capture-vs-publish rule in
   [`docs/principles/invariants-and-defaults.md`](../principles/invariants-and-defaults.md).

## The contract

The excerpt below shows the central contract fields; exported source types are
authoritative.

```ts
export const ACTOR_TRACE_SCHEMA = "humanish.actor-trace.v1";

export type ActorStatus =
  | "passed"
  | "abandoned" // the participant gave up in character
  | "incomplete" // time or a budget ended the session before the goal
  | "blocked"
  | "timed_out"
  | "failed"; // the HARNESS failed

export type ActorCompletionReason =
  | "goal_satisfied" // scenario success predicate met
  | "turn_completed" // harness saw an explicit done signal, no predicate
  | "gave_up" // persona abandoned in character: friction exceeded its tolerance
  | "blocked_approval" // an action was auto-declined and the actor could not proceed
  | "timed_out" // wall-clock deadline hit with ZERO material progress → still a FAILURE
  | "budget_reached" // a time, spend, adapter or token limit ended the session before a
  // natural endpoint → ActorStatus "incomplete", even after productive
  // activity; distinct from goal_satisfied (no goal was claimed)
  | "actor_error"
  | "step_failed" // a deterministic scripted step/expectation evaluated false: the
  // SUBJECT failed the script; the harness executed faithfully
  // (distinct from actor_error/harness_error)
  | "harness_error";

// One normalized evidence row. Codex item/*, computer-use cycles, scripted
// browser steps and terminal-agent exec output all collapse onto this.
export interface ActorTraceItem {
  id: string;
  kind:
    | "message"
    | "reasoning"
    | "tool_call"
    | "command"
    | "file_change"
    | "approval"
    | "screenshot"
    | "ui_action"
    | "plan"
    | "notice";
  lifecycle: "started" | "completed";
  status?: string;
  title: string; // redacted, <= 120 chars
  tool?: { server?: string; name?: string };
  command?: { text?: string; cwd?: string; exitCode?: number; outputTail?: string };
  screenshotRef?: { path: string; redaction: "blurred" | "ocr_scrubbed" | "none" };
  text?: string; // redacted
}

export interface ActorCapabilities {
  headless: boolean;
  structuredTrace: boolean;
  lanes: Array<"code" | "computer-use" | "scripted-browser" | "terminal">;
  producesScreenshots: boolean;
  byoModel: boolean;
  preGrantableApprovals: boolean; // can run unattended without a human prompt
  inProcessTools: boolean; // can inject product tools without a subprocess
  license: "open" | "source-available" | "proprietary";
  keyPlacement?: "external" | "in-sandbox-command-scoped";
}

export interface ActorTrace {
  schema: typeof ACTOR_TRACE_SCHEMA;
  provider: string; // e.g. "codex-app-server" | "openai-responses-cu" | "browser-persona" | "codex"
  providerVersion?: string;
  protocol: "json-rpc" | "json-stream" | "cua-loop" | "scripted-steps" | "terminal-exec";
  lane: "code" | "computer-use" | "scripted-browser" | "terminal";
  persona: { id: string; traitsApplied: string[]; promptDigest: string }; // proves traits were threaded
  // "raw" = full-fidelity frames retained (valid for LOCAL use; redact before
  // publishing); "blurred"/"ocr_scrubbed" = publish-safe; "n/a" = none captured.
  redaction: {
    status: "passed";
    screenshots: "n/a" | "raw" | "blurred" | "ocr_scrubbed";
    notes: string;
  };
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  ids: { sessionId?: string; threadId?: string; turnId?: string; model?: string };
  counts: Record<string, number>;
  items: ActorTraceItem[];
  tokenUsage?: { input?: number; output?: number; total?: number; costUsd?: number };
  estimatedCost?: ActorEstimatedCost; // humanish.actor-estimated-cost.v1 (additive)
  capabilities: ActorCapabilities;
}

export interface ApprovalPolicy {
  mode: "auto-decline" | "pre-grant-allowlist" | "deny-all";
  allow?: string[]; // e.g. ["read:*", "bash:git diff *", "mcp__browser__*"]
  onRequest(req: ApprovalRequest): ApprovalDecision; // adapter calls; harness records every call
}

export interface RedactionHooks {
  redactText(text: string): string;
  publicPath(value: string, rootCwd: string): string;
  redactScreenshot(
    buffer: Buffer | Uint8Array,
    meta?: ScreenshotMeta,
  ): Promise<{ buffer: Buffer; method: "blurred" | "ocr_scrubbed" }>;
  promptForLog(raw: string): { placeholder: string; digest: string; length: number };
}

export interface ActorRunInput {
  cwd: string;
  runRoot: string; // where the adapter writes events/summary/transcript
  timeoutMs: number;
  persona: ResolvedPersona; // FULL traits, not just {id, name}
  scenario: { id: string; title: string; goal: string; successText?: string[] };
  laneFocus?: { id: string; label: string; instruction: string };
  approval: ApprovalPolicy;
  redaction: RedactionHooks;
  model?: string;
  actorCommand?: string[]; // override binary / transport
  signal: AbortSignal;
}

export interface ActorRunResult {
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  durationMs: number;
  trace: ActorTrace;
  transcriptPath: string;
  tracePath: string;
  eventsPath: string;
  tail: string;
}

export interface Actor {
  readonly id: string; // "codex-app-server"
  capabilities(): ActorCapabilities;
  run(input: ActorRunInput): Promise<ActorRunResult>;
}
```

### Contract semantics (every adapter must guarantee)

- **Lifecycle.** connect/spawn, initialize, apply persona + scenario as system or
  turn input, drive a bounded turn loop honoring `timeoutMs` and `signal`, emit a
  single explicit `completionReason`, tear down. No adapter may block waiting on a
  human.
- **Evidence.** Write redacted events, the `ActorTrace` and a human transcript so the
  run-bundle wiring is provider-agnostic. The artifact names differ by route: the Codex
  app-server adapter writes `events.ndjson`, `summary.json` and `transcript.txt`; a
  computer-use participant writes its trace to `actor.json` or `actors/<streamId>.json`; the
  terminal route writes `terminal-events.ndjson` and `terminal-transcript.txt`. Analysis quotes
  only `message` and `reasoning` items, so they carry the participant's own words. The terminal
  route reads them from the Codex `agent_message` and `reasoning` items in the raw exec JSON
  stream, in memory, before source redaction can break a line's JSON. It removes verdict marker
  lines, then scrubs and redacts the decoded text. The trace keeps the last 200 items within
  128 KiB and adds a `notice` item when it leaves older ones out. The stream's last 2000
  characters stay in the `command` item's `outputTail`.
- **Approvals.** Call `approval.onRequest`; never embed adapter-local decline
  strings. Every call is recorded as an `items[kind=approval]`.
- **Redaction.** Use the injected `RedactionHooks`. Never re-implement redaction
  per adapter.
- **Diagnostics.** Unexpected actor-loop failures are recorded as
  `items[kind=notice,status=error]`, not raw crash dumps. Keep diagnostic notices
  public-safe: redacted message, coarse loop phase, last normalized UI action,
  and last screenshot reference only. Do not persist raw stacks, env values,
  target URLs, or unredacted provider payloads in the trace.
- **Capabilities.** Declare them honestly. Routing refuses an actor whose `lanes` or
  `producesScreenshots` do not fit the route; the other capabilities are not checked.
- **Cost (estimate vs. charge).** `tokenUsage.costUsd` stays RESERVED for a
  real, provider-returned charge (the codex path); a bare `costUsd`
  always means "the provider billed this". The optional `estimatedCost`
  (`humanish.actor-estimated-cost.v1`) is a SEPARATE, differently-named field: a
  token-derived rate-table multiply from the operator-editable `src/run/pricing.ts`,
  labeled honestly as an estimate and projected up into `RunBundle.cost` (see
  [`../contracts/schemas.md`](../contracts/schemas.md) → Run Cost Summary And
  Estimated Actor Cost). The CUA lab computes and attaches `estimatedCost` at the
  lab boundary before persisting the trace, so the pure computer-use loop never
  depends on the pricing table. An unknown model yields
  `estimatedCostUsd: null` + a `reason`, never a guessed charge.

## The scripted-browser route (shipped)

`scripted-browser` is the deterministic, model-free browser-actuation route, distinct from
`computer-use` (raw pixels + a model deciding actions). The registered
`scripted-browser` actor (`src/actors/scripted-browser/`) replays a committed scenario's
browser steps with playwright against a loopback app; the steps ARE the behavior, so
`byoModel: false` means there is NO model, and `tokenUsage` records zeros as an affirmative
$0 declaration that is true by mechanism (no provider client is importable from that code
path). Its trace keeps the concrete driver name `provider: "browser-persona"` (matching the
native `humanish.browser-persona-trace.v1` it also emits) with `protocol: "scripted-steps"`.

Completion semantics: `goal_satisfied` means the scenario's `expect` blocks (the success
predicate) all held ("the app still affords this exact flow", nothing about user behavior);
`step_failed` means a deterministic step or expectation evaluated false (the subject failed
the script; the harness ran faithfully); `timed_out` is the replay hitting its wall-clock
budget, however many steps ran (a failure); `harness_error` is a browser that could not
launch. `gave_up` and `blocked_approval` are unreachable, because a deterministic replay
has no persona patience and no approvals.

### The time budget vs. a stuck timeout (`budget_reached`)

`execution.timeoutMs` is a GENEROUS wall-clock SAFETY cap, not a goal. An open-ended
"watch it play" session has no success predicate, because productive play is the outcome. So
the computer-use loop distinguishes two ways to hit the cap:

- **`budget_reached`**: the deadline was reached AFTER at least one material (non-idle)
  action, or a spend, adapter or token limit ended the session. This maps to `ActorStatus:
"incomplete"`: the participant did not reach the goal, and the harness did not fail.
  `participantOutcomeOk` is false, the verdict is `fail`, and the CLI exits `2`. The trace
  `reason` and optional `stopCause` say which limit ended the session.
- **`timed_out`**: the deadline was reached with ZERO material actions (a hung provider, an
  idle-only stall). This maps to `ActorStatus: "timed_out"`, `participantOutcomeOk` is false, the
  verdict is `timed_out`, and the CLI exits `2`.

Earlier, `budget_reached` mapped to `passed` and `ActorStatus` had four members. It gained
`abandoned` and `incomplete` so participant outcomes are not reported as harness failures.
`statusForCompletionReason` (`src/actors/computer-use/loop/trace.ts`) is an exhaustive
switch with no default, so a new completion reason forces a compile-time decision about its
status. ~30 min (`1_800_000`) is a reasonable default for open-ended watch; the persona
still stops early on `goal_satisfied`/`gave_up`/`stopWhen`.

Actuation-vs-spend gate: on the scripted lab route `scenario.mode: live` is still required
even though provider spend is $0 by mechanism. The gate's justification there is actuation,
not cost: a live scripted run drives a real browser against a real running app
(state-mutating effects on the operator's app), which deserves the same affirmative
declaration as spend. "Live" on this route must never silently come to mean "costs money";
this paragraph is the record of that decision.

## Optional closing report

`CuaProvider.debrief` is an optional read-only request after a structured
`stopWhen` or dwell stop. It returns a `CuaTurn` with `closingReport` containing
`summary` and `frictionReports`; an empty friction list is valid. The loop rejects
actions, pending safety checks, and invalid report shapes. It redacts accepted
reports, records them in `ActorTrace.debrief`, and projects one readable message
without invoking action or communication callbacks.

This request uses the final observation and retained provider history. It does
not expose the hidden stop criterion or change the original task outcome. It is
skipped before any participant turn, after natural completion, without provider
support, or without remaining time and known budget. An attempted request's
unreported usage remains an unknown cost line. `counts.debriefCalls` is separate
from interaction turns, and reported usage contributes to aggregate cost.

The OpenAI implementation makes one request with tools disabled and structured
output; no HTTP or policy retries. Stateless/ZDR mode does not offer retrospective
reporting because it does not retain the required session history. The
[paired live receipt](https://github.com/danielgwilson/humanish/blob/main/docs/evidence/computer-use/structured-closing-report-2026-09-05.md)
records both report recovery and control failures in the separate legacy parser.

## The state-driven executor seam (shipped)

The `CuaExecutor` / `CuaProvider` ports are the concrete realization of the "plural harnesses /
transport-agnostic" intent above: the computer-use loop does not require a screen or a vision
model. A library caller can drive an **already-running local app** through its in-process JS
contract (`window.app.getState()` etc.) with a custom `CuaExecutor` (screenshot optional,
`appState` as the progress signal) paired with a **non-vision** `CuaProvider` (`requiresFrame`
falsey), keeping the whole lab composition with NO E2B desktop and NO clone. See
[`state-driven-executor.md`](./state-driven-executor.md) for the port, both entry points
(`runComputerUseLoop` and `runLab` + `inProcess`/`createProvider`), the `subject.source:
local-app` config surface, the `requiresFrame` provider-authoring contract, and the
appState-is-runtime-only stance.

## The product-adapter extension seam (shipped in the terminal-product route, layer 6)

The terminal-product route carries the proof-roadmap layer-6 deliverable: a product adopter
attaches product-specific scoring + feedback as a THIN in-repo extension WITHOUT forking
core. The seam is exported contract types (`RunBundle`, `RunFeedbackCandidate`,
`RunAdapterScore`, `ActorTrace`, `AdapterScorerModule` and the terminal-route
`TerminalProductScoringContext`) plus a registrable scorer module, `RunLabOptions.scorer`,
with optional `score` and `deriveFeedback`. The older `terminalHooks` and `cuaHooks` bags were
removed from `RunLabOptions`. The adapter records its product nouns ONLY
under an adapter-NAMESPACED block (`RunFeedbackCandidate.adapter` /
`RunAdapterScore.{namespace,data}`), so core's enums stay product-agnostic: no adopter noun
is hardcoded into a core enum. Default (no hook) behavior is unchanged. See
[`terminal-product-route.md`](./terminal-product-route.md#slice-4-the-product-adapter-extension-seam-layer-6)
for the full seam and the thin-adapter conformance proof.

## Making personas load-bearing

The original bug, now fixed: `loadDryRunInputs` (`src/run/dry-run-inputs.ts`) parsed
persona YAML down to `{ id, name, source, sourceDigest }` and discarded `summary`,
`traits.{patience, technical_confidence, accessibility_needs}`, and `constraints`. The
prompt builders then injected one line: `Persona: ${name}`. The persona was a label. It now
returns the full `resolvedPersona` from `parseResolvedPersona`.

Plan:

1. **Parse the whole persona** into a `ResolvedPersona`: `{ id, name, summary, goals[],
traits: { patience, skill, accessibilityNeeds? }, constraints[], sourceDigest }` (map
   `technical_confidence` to `skill`). The shipped shape in `src/lab/persona.ts` has no
   `goals`, adds `background`, and makes every trait optional.
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
   - accessibilityNeeds -> concrete behavior (keyboard_first moves through the UI
     by keyboard and fails a step that is mouse-only; clear_terminal_output flags
     noisy output as a defect).
   - goals + constraints become explicit success / forbidden lists for the
     scenario predicate.
3. **Abandonment is persona-judged, harness-corroborated, never a counter.** The
   persona-actor (an LLM embodying that user) decides in character when the friction is no
   longer worth it and stops with `completionReason: "gave_up"`, citing the specific
   friction. The harness corroborates with objective signals it already sees in the stream
   (consecutive failed/blocked actions, repeated-identical-action looping, no progress
   toward the success predicate) and annotates the abandonment friction as a feedback
   candidate. The harness imposes no turn cap; its hard stops are the wall-clock
   `timeoutMs` and declared spend caps.
4. **Bind the same directives per harness.** `renderPersonaPromptSection`
   (`src/lab/persona.ts`) renders the directives as one prompt section, and each harness puts
   that section where its model reads standing instructions:
   - Computer use: `composeParticipantInstructions`
     (`src/routes/computer-use/participant-prompt.ts`) opens the participant instructions
     with it. `openai-computer-use` sends those instructions as each Responses request's
     `instructions`. A local-agent Codex runs as a restricted app-server participant and
     receives them as thread/start `baseInstructions` (`threadStartParams` in
     `src/actors/codex/restricted-launch.ts`), on an ephemeral read-only thread whose only
     dynamic tool is `humanish_ui`. A local-agent Claude Code runs one `claude -p`
     stream-json session with `--allowedTools Read`; the instructions open its first user
     message (`promptFor` in `src/actors/local-agent/cli.ts`), and later turns rely on the
     session's memory. `HUMANISH_LOCAL_AGENT_ONE_SHOT` instead spawns one `claude -p` per
     turn, which resends the instructions every turn.
   - Terminal: the section opens the `codex exec` prompt (`composeLivePrompt` in
     `src/routes/terminal/session.ts`).
   - The scripted-browser route replays declared steps with no model, so it binds no
     directives and records an empty `traitsApplied`. The Codex app-server session behind
     `humanish codex app-server` and the `codex-app-server` registry descriptor binds none
     either: it sends the operator's prompt to turn/start as given.
   - Stagehand remains roadmap. This rule once planned a pi binding (`systemPrompt` +
     `beforeToolCall`) and a Claude Agent SDK one (`systemPrompt` + `allowedTools`). pi
     shipped only as a trace mapper, the Claude Agent SDK descriptor never had a route, and
     #955 removed both.

   None of these uses a `max_turns`-style cap as the persona stop condition.

5. **Prove it.** `ActorTrace.persona.traitsApplied` lists the injected directives; a
   `persona-fidelity` verify check asserts that the friction and accessibility directives
   reached the actor input and that a `gave_up` run cites a concrete friction reason (not a
   turn count). "Did the persona drive the run" becomes a verifiable artifact. (Status
   2026-06-11: `personaToDirectives` shipped in `src/lab/persona.ts` and `traitsApplied` is
   threaded on the codex-exec terminal route, but the `persona-fidelity` verify check is
   not-yet-shipped roadmap. The computer-use route records `persona.traitsApplied` from the
   resolved persona in `src/routes/computer-use/participant-prompt.ts`.)

## Decision: how abandonment is adjudicated

"When does a synthetic persona give up?" has no obvious best answer, so the
choice is recorded here so it is not silently re-litigated.

Options considered:

1. **Persona-judged only** (the LLM decides in character, uncorroborated).
   Truest embodiment, but LLM stop behavior is erratic (often too stubborn,
   sometimes too eager), non-reproducible, and hard to verify. A purely
   model-judged stop can also run uselessly to the wall-clock timeout.
2. **Harness-adjudicated from objective signals only** (no-progress,
   repeated-failure, looping); the persona just sets a numeric threshold.
   Deterministic and reproducible, but mechanical. It misses the subjective "this
   is not worth it" judgment a persona exists to make, and a fixed threshold
   quietly drifts back toward a disguised counter.
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

| Adapter                                                                                       | headless                     | structured trace                          | sandbox                              | BYO model               | license                   | actor fit    |
| --------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------- | ------------------------------------ | ----------------------- | ------------------------- | ------------ |
| codex-app-server (reference)                                                                  | yes (stdio JSON-RPC)         | typed item/*                              | OS Seatbelt/seccomp + approvalPolicy | OpenAI-first            | Apache-2.0                | code         |
| pi-agent-core (removed)                                                                       | yes (SDK + rpc/json)         | event stream + session JSONL + token/cost | BYO container + hook gating          | 15+ providers, local    | MIT                       | code, app    |
| claude-agent-sdk (removed)                                                                    | yes (SDK + `-p` stream-json) | typed ToolUse/ToolResult + cost           | OS sandbox + dontAsk/allowedTools    | Anthropic-centric       | SDK MIT (CLI proprietary) | code, app    |
| stagehand-cua (roadmap, not shipped; `openai-computer-use` is the shipped computer-use actor) | yes (SDK, mode:'cua')        | structured results + replay               | Playwright/Browserbase isolation     | OpenAI/Anthropic/Google | MIT                       | computer-use |

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
   are pinned against an installed build. The live shim never landed, and #955
   removed the mapper-only descriptor because no route dispatched it.
5. `claude-agent-sdk` adapter (the `app` run kind). It shipped as a descriptor with
   a live session but no route, and #955 removed it along with the `app` run kind.
6. Computer-use route. (Shipped as `openai-computer-use`: registered 0.3.0,
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
- Screenshot PII in the computer-use route. Redaction binds the PUBLISH
  boundary, not capture (0.6.0): raw frames stay local in gitignored
  `.humanish/` and are never emitted by a publish command (this repo's CI
  binary-asset scan also blocks them from commit);
  `policies.redactScreenshots: true` blurs at capture for share-as-is
  bundles. The earlier fail-closed redacted-thumbnail default was recanted;
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
