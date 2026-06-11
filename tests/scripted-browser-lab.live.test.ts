import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA } from "../src/actor-contract.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";
import { runLab } from "../src/lab-engine.js";
import { verifyRun } from "../src/run.js";

// The single LIVE rung for the scripted-browser LAB: the committed scenario dispatched through
// runLab to real playwright-core against an in-test loopback http.Server. Provider spend is $0
// BY MECHANISM (no model exists on this lane); the env gate exists for real-browser ACTUATION
// + environment dependence (a local Chrome/Chromium must be installed), mirroring the
// MIMETIC_LIVE_CUA convention:
//   MIMETIC_LIVE_SCRIPTED=1 must be set explicitly (the actuation opt-in); the browser binary
//   resolves via MIMETIC_BROWSER_COMMAND or the usual chrome/chromium PATH candidates.
const LIVE = process.env.MIMETIC_LIVE_SCRIPTED === "1";

// A tiny app that satisfies mimetic/scenarios/scripted-first-run.yaml: a <main> landing page
// with an email input and a submit button whose click renders the "Welcome" success state.
const PROOF_HTML = [
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Scripted live proof</title></head>",
  "<body><main>",
  "<h1>Scripted live proof</h1>",
  "<form id=\"signup\"><input type=\"email\" name=\"email\"><button type=\"submit\">Sign up</button></form>",
  "<p id=\"status\"></p>",
  "<script>document.getElementById('signup').addEventListener('submit', (event) => {",
  "  event.preventDefault();",
  "  document.getElementById('status').textContent = 'Welcome aboard';",
  "});</script>",
  "</main></body></html>"
].join("");

describe.skipIf(!LIVE)("scripted-browser-lab (LIVE, actuation-gated; $0 by mechanism)", () => {
  let cwd: string;
  let server: Server;
  let appUrl: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "mimetic-scripted-live-"));
    const scenario = await readFile(path.resolve("mimetic", "scenarios", "scripted-first-run.yaml"), "utf8");
    await mkdir(path.join(cwd, "mimetic", "scenarios"), { recursive: true });
    await writeFile(path.join(cwd, "mimetic", "scenarios", "scripted-first-run.yaml"), scenario, "utf8");
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(PROOF_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    appUrl = `http://127.0.0.1:${port}/`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  });

  it("replays the committed scenario with real playwright on both surfaces and persists a verified bundle", { timeout: 180_000 }, async () => {
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "scripted-live-proof",
      title: "Scripted lab live proof",
      subject: { source: "app-url", appUrl },
      actors: [{ type: "scripted-browser", persona: "synthetic-new-user", count: 2 }],
      scenario: { ref: "scripted-first-run", mode: "live" },
      execution: { target: "local", timeoutMs: 60_000 }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);

    const outcome = await runLab(parsed.config, { cwd });
    expect(outcome.backend).toBe("scripted");
    if (outcome.backend !== "scripted") return;
    const result = outcome.result;

    // The subject affords the journey on BOTH surfaces; the bundle verifies independently.
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.sessions.map((session) => session.completionReason)).toEqual(["goal_satisfied", "goal_satisfied"]);

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.cwd).toBe("[target-cwd]");

    for (const surface of ["desktop", "mobile"]) {
      const stream = bundle.streams.find((entry: { id: string }) => entry.id === `scripted-${surface}-stream`);
      expect(stream.actor.schema).toBe(ACTOR_TRACE_SCHEMA);
      expect(stream.actor.completionReason).toBe("goal_satisfied");
      // Affirmative $0 declaration survives a real browser run.
      expect(stream.actor.tokenUsage).toEqual({ input: 0, output: 0, total: 0, costUsd: 0 });
      expect(stream.actor.redaction.screenshots).toBe("raw");
      // Non-empty raw step screenshots for every step.
      for (const item of stream.actor.items) {
        expect(item.screenshotRef?.path).toBeDefined();
        const stats = await stat(path.join(runDir, item.screenshotRef.path));
        expect(stats.size).toBeGreaterThan(0);
      }
    }

    // Sanitized loopback URLs in ALL text artifacts: origin+path only, never query/hash.
    for (const file of ["run.json", "review.md", "events.ndjson", "traces/desktop.json", "traces/mobile.json", "actor-desktop.json", "actor-mobile.json"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("?access_token");
      expect(text, file).not.toContain(cwd);
    }
  });
});
