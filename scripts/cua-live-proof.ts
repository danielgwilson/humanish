// Live proof (real E2B desktop + real OpenAI Computer Use, spend-gated by env). Validates that
// runCuaActorSession drives a real desktop end-to-end and returns a conformant ActorTrace.
// Run: source env first, then `npx tsx scripts/cua-live-proof.ts`. Network-free target: writes a
// local HTML file into the desktop and opens it via file:// (no public site, no serving).
import { Sandbox } from "@e2b/desktop";

import { runCuaActorSession } from "../src/computer-use-actor.js";
import type { E2BDesktopLike } from "../src/e2b-desktop-executor.js";
import type { FetchLike } from "../src/openai-responses-cu.js";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error("OPENAI_API_KEY required for the live CUA proof.");
}

// Debug-only fetch: logs the response body on non-2xx so we can see the 400 detail. (The
// provider deliberately never surfaces the body; this is a throwaway proof script, not shipped.)
const debugFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init as RequestInit);
  const text = await res.text();
  if (!res.ok) {
    console.log("[live] HTTP", res.status, "body:", text.slice(0, 1200));
  }
  return { ok: res.ok, status: res.status, text: async () => text, json: async () => JSON.parse(text) };
};

const html = [
  "<!doctype html><html><head><meta charset=utf-8></head>",
  "<body style=\"font-family:system-ui;padding:48px;background:#fff\">",
  "<h1 id=hd style=\"font-size:48px\">Mimetic CUA Live Proof</h1>",
  "<p style=\"font-size:24px\">If you can read this heading, the computer-use actor is driving a real desktop.</p>",
  "</body></html>"
].join("");

async function main(): Promise<void> {
  console.log("[live] creating E2B desktop...");
  const desktop = await Sandbox.create();
  console.log("[live] sandbox:", desktop.sandboxId);
  try {
    await desktop.files.write("/home/user/proof.html", html);
    await desktop.open("file:///home/user/proof.html");
    await desktop.wait(3000);

    console.log("[live] running CUA actor (real OpenAI Computer Use loop)...");
    const result = await runCuaActorSession({
      instructions: "Look at the page on screen. In your final message, state the main heading text exactly, then stop. Do not navigate anywhere else.",
      persona: { id: "synthetic-new-user", traitsApplied: [], promptDigest: "live-proof" },
      timeoutMs: 120_000,
      idleSteps: 4,
      noProgressSteps: 5,
      openai: { apiKey, fetchFn: debugFetch, display: { width: 1280, height: 800, environment: "browser" }, reasoningEffort: "low" },
      desktop: desktop as unknown as E2BDesktopLike,
      now: () => Date.now()
    });

    console.log("[live] RESULT status:", result.status, "| completionReason:", result.completionReason);
    console.log("[live] trace lane/protocol/provider:", result.trace.lane, "/", result.trace.protocol, "/", result.trace.provider);
    console.log("[live] screenshots:", result.trace.counts?.screenshots, "| trace items:", result.trace.items.length);
    console.log("[live] redaction.screenshots:", result.trace.redaction?.screenshots);
    console.log("[live] reason:", result.reason);
    console.log("[live] schema:", result.trace.schema);
  } finally {
    console.log("[live] killing sandbox...");
    await desktop.kill().catch((error: unknown) => console.log("[live] kill error:", (error as Error)?.message));
  }
}

main().catch((error) => {
  console.error("[live] FAILED:", error);
  process.exit(1);
});
