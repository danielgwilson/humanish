// Is the terminal on the other end of this process a PERSON's, or an agent's?
//
// WHY THIS EXISTS: `humanish tui` refused a non-TTY, on the reasoning that an agent driving an
// interactive surface has asked for something that cannot exist. A study of that refusal
// (labs/handed-a-human-surface.yaml) found it never fires: `codex exec` allocates a PTY for the
// commands it runs, so both streams ARE terminals. The TUI launched, the agent navigated the labs
// list, opened one, and — its own words — "accidentally triggered a zero-cost dry run while
// navigating". A stray Enter on a live row is the same two keystrokes as a deliberate one.
//
// So a TTY is a real answer to the wrong question. It says a terminal exists; it does not say
// anyone is reading it. Agent runners announce themselves in the environment, which is the only
// signal available before the first keystroke, and is what `is-in-ci` has always done for CI.
//
// EVERY MARKER BELOW WAS OBSERVED, not guessed. Two runtimes are covered because two are what we
// could verify: Claude Code (read off a live session) and Codex (read off the study sandbox, by a
// names-only `env | cut -d= -f1` probe that never touched a value). Others certainly exist — add
// them the same way, from a real session, rather than from a plausible-looking guess. A marker
// that is wrong refuses a person for no reason.

export interface AgentSession {
  /** Human-readable runner name, for the refusal message. */
  runner: string;
  /** The environment variable that identified it — named so the reader can check us. */
  marker: string;
}

const MARKERS: ReadonlyArray<{ marker: string; runner: string }> = [
  { marker: "CLAUDECODE", runner: "Claude Code" },
  { marker: "CLAUDE_CODE_SESSION_ID", runner: "Claude Code" },
  { marker: "CODEX_SESSION_ID", runner: "Codex" },
  { marker: "CODEX_THREAD_ID", runner: "Codex" },
  // Generic, and set alongside the Claude Code markers on the machine this was written on. Kept
  // last so a named runner wins the attribution.
  { marker: "AI_AGENT", runner: "an AI agent runner" }
];

/**
 * The agent runner driving this process, when one identifies itself. `undefined` means nothing
 * claimed to be an agent — which is NOT proof a person is there, only the absence of a claim.
 */
export function detectAgentSession(env: NodeJS.ProcessEnv = process.env): AgentSession | undefined {
  for (const { marker, runner } of MARKERS) {
    const value = env[marker];
    // Presence is the signal, but an explicitly empty or "0" value is treated as absence: a
    // wrapper that unsets a marker by blanking it means it.
    if (value !== undefined && value.trim().length > 0 && value.trim() !== "0") {
      return { runner, marker };
    }
  }
  return undefined;
}
