// Registry contract for the terminal-product lane. The shipped live implementation is
// intentionally route-owned by `runTerminalProductLab` in `e2b-terminal-lab.ts`: that route must
// coordinate sandbox creation, command-scoped runtime auth, caps, evidence capture, and by-id
// cleanup as one fail-closed lifecycle.
//
// `runTerminalAgentSession` remains exported because it was part of the public actor-descriptor
// shape before the route-owned lifecycle shipped. Its options cannot carry the host/provider
// controls needed to enforce that lifecycle, so direct calls are intentionally unsupported and
// fail closed. Use `runTerminalProductLab` (or `runLab` with a terminal-product config) for both
// dry-run and live execution.

import type { ActorPersonaRef, ActorStatus, ActorCompletionReason, ActorTrace } from "./actor-contract.js";

/**
 * Backward-compatible fail-closed marker for the intentionally unsupported direct runner.
 * The name is retained because it is already exported public API.
 */
export const TERMINAL_AGENT_NOT_IMPLEMENTED_CODE = "HUMANISH_TERMINAL_AGENT_NOT_IMPLEMENTED" as const;

/**
 * Options the engine hands the terminal agent session. The transport is the captured
 * non-interactive exec stream (stdin disabled), NOT an interactive PTY — see ActorProtocol
 * "terminal-exec" and the goal packet's PTY ruling. This compatibility shape documents the
 * descriptor boundary; the route-owned live implementation composes equivalent inputs with the
 * additional provider, policy, cap, and cleanup controls it needs.
 */
export interface TerminalAgentSessionOptions {
  /** Where the session writes its native trace/transcript/event-stream artifacts. */
  artifactRoot: string;
  /** The composed prompt the agent runs (mission + persona + public-surface manifest). */
  prompt: string;
  /** Public-safe persona reference (id + composed-prompt digest); no plaintext beyond the mission. */
  persona: ActorPersonaRef;
  /** The product's declared PUBLIC surfaces (http(s) URLs / refs) — the only world the agent sees. */
  publicSurfaces: string[];
  /** Session wall-clock budget (the route also requires scenario.caps.maxMinutes). */
  timeoutMs: number;
  /** Per-run verdict nonce: the agent must echo it so replayed text can't forge the verdict. */
  verdictNonce: string;
}

export interface TerminalAgentSessionResult {
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  /** The provider-neutral evidence projection (humanish.actor-trace.v1, lane "terminal"). */
  trace: ActorTrace;
}

/**
 * Backward-compatible registry entry. Direct execution is intentionally unsupported: only the
 * terminal-product lab route owns enough context to enforce command-scoped auth, caps, evidence
 * capture, and by-id cleanup together. Fail closed instead of implying that the descriptor method
 * itself runs the shipped live route.
 */
export async function runTerminalAgentSession(
  _options: TerminalAgentSessionOptions
): Promise<TerminalAgentSessionResult> {
  throw new Error(
    `${TERMINAL_AGENT_NOT_IMPLEMENTED_CODE}: direct runTerminalAgentSession calls are intentionally unsupported. Terminal execution is route-owned so the lab can enforce command-scoped runtime auth, caps, evidence capture, and by-id cleanup together. Use runTerminalProductLab or runLab with a terminal-product config.`
  );
}
