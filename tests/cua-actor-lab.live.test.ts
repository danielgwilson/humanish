import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA } from "../src/actor-contract.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";
import { runLab } from "../src/lab-engine.js";

// The single LIVE rung for the computer-use LAB: a real lab config dispatched through runLab to
// a real E2B desktop driven by the real OpenAI Computer Use loop. Spend-gated exactly like the
// actor-level live rung (tests/computer-use-actor.live.test.ts):
//   1. HUMANISH_LIVE_CUA=1 must be set explicitly (the spend opt-in),
//   2. OPENAI_API_KEY and E2B_API_KEY must both be present,
//   3. @e2b/desktop is loaded lazily inside the lab (never imported when skipped).
// The subject is a loopback page served INSIDE the sandbox, provisioned via the prepareDesktop
// hook — the documented seam for app-url subjects until clone+serve lands. Asserts only that a
// verified bundle with a terminal, conformant, redacted session came back — never task success.
// Fixture refreshes: additionally set HUMANISH_CUA_WIRE_CAPTURE_DIR to a gitignored dir (e.g.
// under .humanish/) to capture redacted RESPONSE wire bodies — see src/openai-responses-cu.ts.
const LIVE = process.env.HUMANISH_LIVE_CUA === "1"
  && Boolean(process.env.OPENAI_API_KEY)
  && Boolean(process.env.E2B_API_KEY);

const PROOF_HTML = [
  "<!doctype html><html><head><meta charset=utf-8></head>",
  "<body style=\"font-family:system-ui;padding:48px;background:#fff\">",
  "<h1 style=\"font-size:48px\">Humanish CUA Lab Live Proof</h1>",
  "<p style=\"font-size:24px\">Served from loopback inside the sandbox; the lab dispatched this run from a config.</p>",
  "</body></html>"
].join("");

describe.skipIf(!LIVE)("cua-actor-lab (LIVE, spend-gated)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-lab-live-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("dispatches a lab config to a real desktop session and persists a verified bundle", { timeout: 360_000 }, async () => {
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-live-proof",
      title: "CUA lab live proof",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:8000/proof.html" },
      actors: [{
        type: "openai-computer-use",
        persona: "synthetic-new-user",
        mission: "Look at the page on screen, scroll down once to see the rest of it, then in your final message state the main heading text exactly and stop. Do not navigate anywhere else."
      }],
      execution: { target: "e2b-desktop", timeoutMs: 120_000 },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);

    const outcome = await runLab(parsed.config, {
      cwd,
      cuaHooks: {
        prepareDesktop: async (desktop) => {
          await desktop.files.write("/home/user/www/proof.html", PROOF_HTML);
          // setsid -f fully detaches the server from the command's process tree — a plain `&`
          // leaves E2B's command runner waiting on the child until its own deadline fires.
          await desktop.commands.run(
            "setsid -f python3 -m http.server 8000 --directory /home/user/www >/dev/null 2>&1 < /dev/null",
            { timeoutMs: 20_000 }
          );
          // Readiness probe: the subject must answer on loopback before the browser opens.
          await desktop.commands.run(
            "for i in $(seq 1 20); do curl -sf http://127.0.0.1:8000/proof.html >/dev/null && exit 0; sleep 0.5; done; exit 1",
            { timeoutMs: 20_000 }
          );
        }
      }
    });
    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;

    // Verified bundle + terminal session + reclaimed sandbox + the actor ENGAGED (>=1 action or
    // message — so a blank/loading screen no-op cannot pass as a live proof). We never assert
    // task SUCCESS (flaky against a live model), only that it perceived and drove the app.
    expect(["passed", "failed", "blocked", "timed_out"]).toContain(result.session?.status);
    expect(result.session?.completionReason).not.toBe("harness_error");
    expect(result.observer?.ok).toBe(true);
    expect(result.sandbox?.killed).toBe(true);
    const liveBundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    const liveCounts = liveBundle.streams[0].actor.counts;
    expect((liveCounts.actions ?? 0) + (liveCounts.messages ?? 0)).toBeGreaterThan(0);

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.schema).toBe(ACTOR_TRACE_SCHEMA);
    expect(bundle.streams[0].actor.redaction.status).toBe("passed");
    expect(["blurred", "ocr_scrubbed", "n/a"]).toContain(bundle.streams[0].actor.redaction.screenshots);
    expect(bundle.cwd).toBe("[target-cwd]");
  });
});
