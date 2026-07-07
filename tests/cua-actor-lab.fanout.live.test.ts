import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA } from "../src/actor-contract.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";
import { runLab } from "../src/lab-engine.js";
import { verifyRun } from "../src/run.js";

// The single LIVE rung for multi-lane FAN-OUT (#163). WRITTEN, gated, and NOT run in the
// deterministic suite — it is a separately-authorized paid receipt (see the goal packet's
// Provider Spend Policy). Gated exactly like the other live rungs:
//   1. HOMUN_LIVE_CUA=1 must be set explicitly (the spend opt-in),
//   2. OPENAI_API_KEY and E2B_API_KEY must both be present,
//   3. @e2b/desktop is loaded lazily inside the lab (never imported when skipped).
// Two PER-LANE WORLDS (mobile + desktop), each serving a neutral loopback page INSIDE its own
// sandbox via the per-lane prepareDesktop hook — never a shared public target (allowPublicTargets
// + N>1 is rejected; that is the shared-world topology, layer 7 / #164). Max concurrent paid
// desktops is the execution.concurrency bound (the spend control). Asserts only that TWO DISTINCT
// sandboxes came back, both terminal + engaged, both reclaimed BY ID, and the bundle verifies —
// never task success.
const LIVE = process.env.HOMUN_LIVE_CUA === "1"
  && Boolean(process.env.OPENAI_API_KEY)
  && Boolean(process.env.E2B_API_KEY);

const PROOF_HTML = [
  "<!doctype html><html><head><meta charset=utf-8></head>",
  "<body style=\"font-family:system-ui;padding:48px;background:#fff\">",
  "<h1 style=\"font-size:48px\">Homun Fan-out Live Proof</h1>",
  "<p style=\"font-size:24px\">Served from loopback inside THIS lane's own sandbox (per-lane worlds).</p>",
  "</body></html>"
].join("");

describe.skipIf(!LIVE)("cua-actor-lab fan-out (LIVE, spend-gated)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "homun-cua-fanout-live-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("fans out two per-lane worlds (mobile + desktop) to two distinct desktops, both reclaimed by id", { timeout: 600_000 }, async () => {
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-fanout-live-proof",
      title: "CUA fan-out live proof",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:8000/proof.html" },
      actors: [{
        type: "openai-computer-use",
        mission: "Look at the page on screen, scroll down once, then in your final message state the main heading text exactly and stop. Do not navigate anywhere else.",
        lanes: [
          { id: "mobile", persona: "synthetic-new-user", device: "mobile" },
          { id: "desktop", persona: "synthetic-new-user", device: "desktop" }
        ]
      }],
      // concurrency 2 = at most two concurrent PAID desktops (the spend bound).
      execution: { target: "e2b-desktop", timeoutMs: 120_000, concurrency: 2 },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);

    const outcome = await runLab(parsed.config, {
      cwd,
      cuaHooks: {
        // Per-lane prepareDesktop: serve the neutral page inside EACH lane's own sandbox.
        prepareDesktop: async (desktop) => {
          await desktop.files.write("/home/user/www/proof.html", PROOF_HTML);
          await desktop.commands.run(
            "setsid -f python3 -m http.server 8000 --directory /home/user/www >/dev/null 2>&1 < /dev/null",
            { timeoutMs: 20_000 }
          );
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

    // Two lanes, both terminal + engaged, each its own DISTINCT sandbox, all reclaimed by id.
    expect(result.lanes).toHaveLength(2);
    const sandboxIds = (result.lanes ?? []).map((lane) => lane.sandbox?.sandboxId);
    expect(new Set(sandboxIds).size).toBe(2);
    for (const lane of result.lanes ?? []) {
      expect(["passed", "failed", "blocked", "timed_out"]).toContain(lane.status);
      expect(lane.session?.completionReason).not.toBe("harness_error");
      expect(lane.sandbox?.killed).toBe(true);
    }

    const runDir = path.join(cwd, ".homun", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.simCount).toBe(2);
    for (const stream of bundle.streams) {
      expect(stream.actor.schema).toBe(ACTOR_TRACE_SCHEMA);
      expect(stream.actor.redaction.status).toBe("passed");
      const counts = stream.actor.counts;
      expect((counts.actions ?? 0) + (counts.messages ?? 0)).toBeGreaterThan(0);
    }
    expect(bundle.cwd).toBe("[target-cwd]");

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });
});
