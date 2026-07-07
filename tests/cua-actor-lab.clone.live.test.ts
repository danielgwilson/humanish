import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA } from "../src/actor-contract.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";
import { runLab } from "../src/lab-engine.js";

// The LIVE rung for the clone subject provider: a config-only lab that clones a small public
// static-site repo INTO a real E2B desktop, serves it with the declared command, probes
// readiness, and lets the real actor drive it. Spend-gated exactly like the other live rungs:
//   1. HOMUN_LIVE_CUA=1 must be set explicitly (the spend opt-in),
//   2. OPENAI_API_KEY and E2B_API_KEY must both be present,
//   3. @e2b/desktop is loaded lazily inside the lab (never imported when skipped).
// The subject repo is a tiny, long-stable MDN sample site (public, no build step). Asserts a
// verified bundle with provenance and a terminal session — never task success.
// Fixture refreshes: additionally set HOMUN_CUA_WIRE_CAPTURE_DIR to a gitignored dir (e.g.
// under .homun/) to capture redacted RESPONSE wire bodies — see src/openai-responses-cu.ts.
const LIVE = process.env.HOMUN_LIVE_CUA === "1"
  && Boolean(process.env.OPENAI_API_KEY)
  && Boolean(process.env.E2B_API_KEY);

describe.skipIf(!LIVE)("cua-actor-lab clone subject (LIVE, spend-gated)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "homun-cua-clone-live-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("clones, serves, probes, and drives a real repo from config alone", { timeout: 420_000 }, async () => {
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-clone-live-proof",
      title: "CUA clone subject live proof",
      subject: {
        source: "clone",
        repos: ["mdn/beginner-html-site-styled"],
        serve: {
          start: "python3 -m http.server 8000",
          url: "http://127.0.0.1:8000/",
          readyTimeoutMs: 60_000
        }
      },
      actors: [{
        type: "openai-computer-use",
        persona: "synthetic-new-user",
        mission: "Look at the page on screen. In your final message, state the main heading text exactly, then stop. Do not navigate anywhere else."
      }],
      execution: { target: "e2b-desktop", timeoutMs: 120_000 },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);

    const outcome = await runLab(parsed.config, { cwd });
    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;

    // The bundle verified, the sandbox is reclaimed, and the session reached a terminal verdict
    // without a harness error. We do NOT assert result.ok===true: ok additionally requires the
    // actor to have ENGAGED (>=1 action or message — the no-engagement honesty guard), which a
    // trivial "look and report" mission against a static page may not elicit. Engagement is
    // asserted explicitly below so a blank-screen no-op cannot masquerade as a live proof.
    expect(["passed", "failed", "blocked", "timed_out"]).toContain(result.session?.status);
    expect(result.session?.completionReason).not.toBe("harness_error");
    expect(result.observer?.ok).toBe(true);
    expect(result.sandbox?.killed).toBe(true);

    // Provenance: the bundle says exactly what was driven.
    expect(result.subject?.source).toBe("clone");
    expect(result.subject?.repo).toBe("mdn/beginner-html-site-styled");
    expect(result.subject?.commit).toMatch(/^[0-9a-f]{40}$/);

    const runDir = path.join(cwd, ".homun", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.schema).toBe(ACTOR_TRACE_SCHEMA);
    // Engagement: the actor must have actually perceived/driven the app (>=1 action or message),
    // not stopped on a blank/loading screen. This is what makes the run a real proof.
    const counts = bundle.streams[0].actor.counts;
    expect((counts.actions ?? 0) + (counts.messages ?? 0)).toBeGreaterThan(0);
    const provenance = bundle.events.find((event: { type: string }) => event.type === "cua-lab.subject.provenance");
    expect(provenance?.message).toContain("mdn/beginner-html-site-styled@");
    expect(bundle.cwd).toBe("[target-cwd]");
  });
});
