import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LAB_CONFIG_SCHEMA, parseLabConfig, type LabConfig } from "../src/lab-config.js";
import { runTerminalProductLab } from "../src/e2b-terminal-lab.js";
import { verifyRun } from "../src/run.js";

// The LIVE rung for the terminal-product lane (#154 SLICE 2): a REAL E2B shell sandbox + a REAL
// `codex exec` agent studying a neutral public surface, command-scoped runtime auth, capped at
// no-spend. It exercises the credential-placement inversion against a real provider, so it is
// gated EXACTLY like the other live rungs (never run in CI) and kept as a receipt by the
// orchestrator post-merge:
//   1. MIMETIC_LIVE_CODEX=1 must be set explicitly (the live opt-in);
//   2. OPENAI_API_KEY and E2B_API_KEY must both be present (operator-side; the runtime key is
//      injected ONLY into the command-scoped codex invocation, never sandbox-global);
//   3. @e2b/desktop is the lazily-loaded substrate.
// Asserts the safety contract holds against a real agent: real sandbox created + reclaimed,
// runtime auth command-scoped (never in metadata), no banned creds in artifacts, the bundle
// verifies (incl. the terminal-product evidence check). NEVER asserts task success.
const LIVE = process.env.MIMETIC_LIVE_CODEX === "1"
  && Boolean(process.env.OPENAI_API_KEY)
  && Boolean(process.env.E2B_API_KEY);

function liveConfig(): LabConfig {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "terminal-product-live-proof",
    title: "Terminal-product live proof",
    subject: {
      source: "terminal-product",
      product: {
        name: "example-cli",
        // A neutral, stable public surface. The agent studies it from public materials only.
        publicSurfaces: ["https://example.com/", "https://example.com/index.html"]
      }
    },
    actors: [{
      type: "codex-exec",
      persona: "autonomous-creative-agent",
      mission: "Look at the public surfaces listed. In your final report, state in one sentence whether they describe a usable CLI product, then stop. Do not attempt any spend."
    }],
    execution: {
      target: "e2b-terminal",
      runtimeAuth: "openai-env",
      timeoutMs: 600_000,
      terminal: { transport: "exec-stream", stdin: "disabled" }
    },
    scenario: { mode: "live", caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 8 } },
    policies: {
      allowPrivateRepoAccess: false,
      allowProviderCredentials: false,
      allowPaymentCredentials: false,
      allowGitHubMutation: false
    }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe.skipIf(!LIVE)("terminal-product lane (LIVE, key-gated, E2B + Codex)", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "mimetic-tp-livereal-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("runs a real Codex agent in an E2B shell with a command-scoped key and a verified bundle", { timeout: 600_000 }, async () => {
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false });

    // Real sandbox created + reclaimed (cleanup proven). We do NOT assert task success.
    expect(result.sandbox?.sandboxId).toBeTruthy();
    expect(result.sandbox?.killed).toBe(true);
    expect(result.sandbox?.remaining === 0 || result.sandbox?.remaining === -1).toBe(true);
    expect(["passed", "blocked", "failed", "timed_out"]).toContain(result.session?.status);

    // The bundle verifies independently, including the terminal-product evidence check.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((c) => c.name === "terminal-product evidence")?.ok).toBe(true);

    // No credential VALUE in evidence: the real OPENAI_API_KEY value never appears in any artifact.
    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const realKey = (process.env.OPENAI_API_KEY ?? "").trim();
    for (const file of ["run.json", "terminal-events.ndjson", "terminal-transcript.txt", "terminal-ledgers.json", "actor.json"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      if (realKey.length >= 8) expect(text.includes(realKey)).toBe(false);
    }
    // Interventions ledger present + empty (stdin disabled, no assisted input).
    const ledgers = JSON.parse(await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8"));
    expect(Array.isArray(ledgers.interventions)).toBe(true);
    expect(ledgers.interventions.length).toBe(0);
  });
});
