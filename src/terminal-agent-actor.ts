// The terminal agent actor: a real autonomous coding agent (Codex) discovering and using a
// CLI/product from PUBLIC SURFACES ONLY, running INSIDE an E2B shell with command-scoped runtime
// auth, capturing its non-interactive exec output (stdin disabled) as a redacted event stream +
// normalized transcript. This is the registry seam for the terminal-product lane.
//
// SLICE 1 SCOPE (honest): this module declares the session CONTRACT — the option/result shapes
// and the registry-facing `runTerminalAgentSession` entry — but the LIVE session is NOT
// implemented here yet. The dry-run lab path (src/e2b-terminal-lab.ts) never invokes runSession;
// it builds a contract-only bundle. A live (non-dry-run) call into the engine returns a
// structured "not yet implemented in this slice" failure, and calling runSession directly throws
// the same fail-closed marker. SLICE 2 implements the real create -> inject (command-scoped) ->
// run `codex exec --json` -> capture -> teardown session on the @e2b/desktop commands.run surface.

import type { ActorPersonaRef, ActorStatus, ActorCompletionReason, ActorTrace } from "./actor-contract.js";

/** The fail-closed marker a SLICE-1 live invocation surfaces (never a raw crash). */
export const TERMINAL_AGENT_NOT_IMPLEMENTED_CODE = "MIMETIC_TERMINAL_AGENT_NOT_IMPLEMENTED" as const;

/**
 * Options the engine hands the terminal agent session. The transport is the captured
 * non-interactive exec stream (stdin disabled), NOT an interactive PTY — see ActorProtocol
 * "terminal-exec" and the goal packet's PTY ruling. Fields here are the SLICE-1 contract; SLICE 2
 * consumes them to drive the in-sandbox `codex exec` and capture its redacted output.
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
  /** Session wall-clock budget (also bounded by scenario.caps.maxMinutes in SLICE 2). */
  timeoutMs: number;
  /** Per-run verdict nonce: the agent must echo it so replayed text can't forge the verdict. */
  verdictNonce: string;
}

export interface TerminalAgentSessionResult {
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  /** The provider-neutral evidence projection (mimetic.actor-trace.v1, lane "terminal"). */
  trace: ActorTrace;
}

/**
 * Registry-facing session entry. SLICE 1: NOT yet live — the dry-run lab path never calls this,
 * and a live engine call fails closed with a structured error before reaching here. Calling it
 * directly throws the same fail-closed marker rather than pretending to drive a real agent.
 */
export async function runTerminalAgentSession(
  _options: TerminalAgentSessionOptions
): Promise<TerminalAgentSessionResult> {
  throw new Error(
    `${TERMINAL_AGENT_NOT_IMPLEMENTED_CODE}: the live terminal-agent session (in-sandbox Codex exec + command-scoped runtime auth) is implemented in SLICE 2. SLICE 1 only produces the dry-run contract bundle.`
  );
}
