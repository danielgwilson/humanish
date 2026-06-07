# Actor Contract

Date: 2026-06-06

Status: accepted design; implementation staged behind this document.

## Context

An actor is the thing that drives a persona scenario and produces evidence. Today
Mimetic has exactly one real actor: the local Codex integration in
`src/codex-app-server.ts` (plus the `codex-exec` and `codex-tui` variants in
`src/run.ts`). The actor selection is a hardcoded `if (actor === ...)` dispatch,
`RunStream.codex` is Codex-shaped, and the evidence schema is
`mimetic.codex-app-server-trace.v1`.

That is a ceiling. Mimetic's value is being a public-safe harness for persona and
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

2. **One normalized evidence schema: `mimetic.actor-trace.v1`.** Codex `item/*`
   events, Claude `ToolUse`/`ToolResult` blocks, pi `tool_execution_*` events,
   and computer-use `computer_call` cycles all map onto one `ActorTrace` with a
   typed `items[]`. `mimetic.codex-app-server-trace.v1` remains a back-compat
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

6. **Computer-use is one lane behind one adapter.** A single `StagehandCuaActor`
   fronts the volatile raw-pixel providers (OpenAI computer-use, Anthropic
   computer-use, Gemini). Screenshots are the largest new public-safety surface
   and are field-blurred plus OCR-scrubbed before any public artifact; full
   frames stay in the gitignored `.mimetic/` tree.

## The contract

```ts
export const ACTOR_TRACE_SCHEMA = "mimetic.actor-trace.v1";

export type ActorStatus = "passed" | "failed" | "blocked" | "timed_out";

export type ActorCompletionReason =
  | "goal_satisfied"      // scenario success predicate met
  | "turn_completed"      // harness saw an explicit done signal, no predicate
  | "gave_up"             // persona abandoned in character: friction exceeded its tolerance
  | "blocked_approval"    // an action was auto-declined and the actor could not proceed
  | "timed_out"
  | "actor_error"
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
  lanes: Array<"code" | "app" | "computer-use">;
  producesScreenshots: boolean;
  byoModel: boolean;
  preGrantableApprovals: boolean;   // can run unattended without a human prompt
  inProcessTools: boolean;          // can inject product tools without a subprocess
  license: "open" | "source-available" | "proprietary";
}

export interface ActorTrace {
  schema: typeof ACTOR_TRACE_SCHEMA;
  provider: string;              // "codex-app-server" | "pi-agent-core" | "claude-agent-sdk" | "stagehand-cua"
  providerVersion?: string;
  protocol: "json-rpc" | "json-stream" | "in-process-sdk" | "cua-loop";
  lane: "code" | "app" | "computer-use";
  persona: { id: string; traitsApplied: string[]; promptDigest: string };  // proves traits were threaded
  redaction: { status: "passed"; screenshots: "n/a" | "blurred" | "ocr_scrubbed"; notes: string };
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
- **Capabilities.** Declare them honestly; the registry uses them to refuse
  unsuitable dispatch.

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

## Capability matrix (target adapters)

| Adapter | headless | structured trace | sandbox | BYO model | license | actor fit |
| --- | --- | --- | --- | --- | --- | --- |
| codex-app-server (reference) | yes (stdio JSON-RPC) | typed item/* | OS Seatbelt/seccomp + approvalPolicy | OpenAI-first | Apache-2.0 | code |
| pi-agent-core (first new) | yes (SDK + rpc/json) | event stream + session JSONL + token/cost | BYO container + hook gating | 15+ providers, local | MIT | code, app |
| claude-agent-sdk | yes (SDK + `-p` stream-json) | typed ToolUse/ToolResult + cost | OS sandbox + dontAsk/allowedTools | Anthropic-centric | SDK MIT (CLI proprietary) | code, app |
| stagehand-cua | yes (SDK, mode:'cua') | structured results + replay | Playwright/Browserbase isolation | OpenAI/Anthropic/Google | MIT | computer-use |

## Sequencing

1. This document.
2. Shared `RedactionHooks` module (completes the remaining #107 criterion) plus
   the `Actor` contract types, with the Codex integration refactored to implement
   `Actor` and emit `ActorTrace` behind the back-compat alias. Add an
   `actorRegistry`; generalize `RunStream.codex` to `RunStream.actor`.
3. Personas load-bearing: `ResolvedPersona`, `personaToDirectives`, harness turn
   budget, and the `persona-fidelity` verify check.
4. `pi-agent-core` adapter (proves the contract against a non-Codex protocol;
   local-model dogfood for ~$0).
5. `claude-agent-sdk` adapter (the `app` lane).
6. `stagehand-cua` computer-use lane plus `redactScreenshot`.
7. Cross-harness conformance test: one persona x scenario through every adapter,
   asserting identical trace shape, completion vocabulary, and redaction status.
8. The proof point: run the harness-plural loop against popular OSS repos and turn
   real, merged issues into the receipt.

## Risks

- Protocol/version drift across four moving harnesses. Pin every binary/SDK and
  assert the init handshake; the registry refuses an actor whose declared
  capabilities do not satisfy the scenario.
- Screenshot PII in the computer-use lane. Pixel frames never reach a public
  surface unredacted; the default fails closed to a redacted thumbnail.
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
