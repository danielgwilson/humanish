import { describe, expect, it } from "vitest";

import { detectAgentSession } from "../src/agent-session.js";

// Every marker here was OBSERVED in a live session, never guessed: a marker that is wrong refuses
// a person for no reason. Claude Code was read off a running session; Codex off the study sandbox
// by a names-only `env | cut -d= -f1` probe that never touched a value.

describe("who is driving this terminal", () => {
  it("names the runner and the variable that gave it away", () => {
    expect(detectAgentSession({ CODEX_SESSION_ID: "s" })).toEqual({ runner: "Codex", marker: "CODEX_SESSION_ID" });
    expect(detectAgentSession({ CLAUDECODE: "1" })).toEqual({ runner: "Claude Code", marker: "CLAUDECODE" });
    expect(detectAgentSession({ AI_AGENT: "1" })?.marker).toBe("AI_AGENT");
  });

  it("lets a named runner win attribution over the generic marker", () => {
    // Both are set on the machine this was written on; "Claude Code" is the more useful thing to
    // print back at someone.
    expect(detectAgentSession({ AI_AGENT: "1", CLAUDECODE: "1" })?.runner).toBe("Claude Code");
  });

  it("says nothing when nothing claims to be an agent", () => {
    expect(detectAgentSession({})).toBeUndefined();
    expect(detectAgentSession({ TERM: "xterm-256color", SHELL: "/bin/bash" })).toBeUndefined();
  });

  it("treats a blank or zeroed marker as absent", () => {
    // A wrapper that unsets a marker by blanking it means it, and refusing a person on the strength
    // of an empty string would be the worst kind of false positive.
    expect(detectAgentSession({ CLAUDECODE: "" })).toBeUndefined();
    expect(detectAgentSession({ CLAUDECODE: "   " })).toBeUndefined();
    expect(detectAgentSession({ AI_AGENT: "0" })).toBeUndefined();
  });

  it("does not claim absence is proof of a person", () => {
    // Documented, not enforced: undefined means no runner ANNOUNCED itself. The refusal is written
    // to match — it says what was detected, never "you are a human".
    expect(detectAgentSession({ SOME_UNKNOWN_AGENT: "1" })).toBeUndefined();
  });
});
