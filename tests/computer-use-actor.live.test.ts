import { describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA } from "../src/actor-contract.js";
import { runCuaActorSession } from "../src/computer-use-actor.js";
import type { E2BDesktopLike } from "../src/e2b-desktop-executor.js";

// The single LIVE rung for the computer-use actor: a real E2B desktop driven by the real OpenAI
// Computer Use loop. Spend-gated three ways — it never runs in CI or by accident:
//   1. MIMETIC_LIVE_CUA=1 must be set explicitly (the spend opt-in),
//   2. OPENAI_API_KEY and E2B_API_KEY must both be present,
//   3. @e2b/desktop is imported lazily inside the gated body (never loaded when skipped).
// The target is a local file:// page written INTO the sandbox (network-free, public-safe).
// Deliberately asserts only "a conformant, redacted trace with a terminal status came back" —
// never task success, which would be flaky against a live model.
const LIVE = process.env.MIMETIC_LIVE_CUA === "1"
  && Boolean(process.env.OPENAI_API_KEY)
  && Boolean(process.env.E2B_API_KEY);

const PROOF_HTML = [
  "<!doctype html><html><head><meta charset=utf-8></head>",
  "<body style=\"font-family:system-ui;padding:48px;background:#fff\">",
  "<h1 style=\"font-size:48px\">Mimetic CUA Live Proof</h1>",
  "<p style=\"font-size:24px\">If you can read this heading, the computer-use actor is driving a real desktop.</p>",
  "</body></html>"
].join("");

describe.skipIf(!LIVE)("openai-computer-use actor (LIVE, spend-gated)", () => {
  it("drives a real E2B desktop and returns a conformant redacted trace", { timeout: 300_000 }, async () => {
    const { Sandbox } = await import("@e2b/desktop");
    const desktop = await Sandbox.create();
    try {
      await desktop.files.write("/home/user/proof.html", PROOF_HTML);
      await desktop.open("file:///home/user/proof.html");
      await desktop.wait(3000);

      const result = await runCuaActorSession({
        instructions: "Look at the page on screen. In your final message, state the main heading text exactly, then stop. Do not navigate anywhere else.",
        persona: { id: "synthetic-new-user", traitsApplied: [], promptDigest: "live-proof" },
        timeoutMs: 120_000,
        idleSteps: 4,
        noProgressSteps: 5,
        openai: { apiKey: process.env.OPENAI_API_KEY as string, reasoningEffort: "low" },
        desktop: desktop as unknown as E2BDesktopLike,
        now: () => Date.now()
      });

      // Terminal + conformant + redacted; never asserts the model "succeeded".
      expect(["passed", "failed", "blocked", "timed_out"]).toContain(result.status);
      expect(result.trace.schema).toBe(ACTOR_TRACE_SCHEMA);
      expect(result.trace.lane).toBe("computer-use");
      expect(result.trace.protocol).toBe("cua-loop");
      expect(result.trace.provider).toBe("openai-responses-cu");
      const shots = result.trace.items.filter((item) => item.kind === "screenshot");
      expect(shots.length).toBeGreaterThan(0);
      expect(shots.every((item) => item.screenshotRef?.redaction === "blurred")).toBe(true);
    } finally {
      await desktop.kill().catch(() => undefined);
    }
  });
});
