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
//   1. HUMANISH_LIVE_CODEX=1 must be set explicitly (the live opt-in);
//   2. CODEX_API_KEY or OPENAI_API_KEY, plus E2B_API_KEY, must be present (operator-side; the
//      runtime key is injected ONLY into the command-scoped codex invocation, never
//      sandbox-global). CODEX_API_KEY is preferred (it is the documented single-invocation
//      `codex exec` auth channel); when only OPENAI_API_KEY is set, the lane injects its value
//      under BOTH names, so either is sufficient here too.
//   3. @e2b/desktop is the lazily-loaded substrate.
// Asserts the safety contract holds against a real agent: real sandbox created + reclaimed,
// runtime auth command-scoped (never in metadata), no banned creds in artifacts, the bundle
// verifies (incl. the terminal-product evidence check). NEVER asserts task success.
const LIVE = process.env.HUMANISH_LIVE_CODEX === "1"
  && (Boolean(process.env.CODEX_API_KEY) || Boolean(process.env.OPENAI_API_KEY))
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
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-tp-livereal-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("runs a real Codex agent in an E2B shell with a command-scoped key and a verified bundle", { timeout: 600_000 }, async () => {
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false });

    // Real sandbox created + reclaimed BY EXACT ID (cleanup proven; never a Sandbox.list call).
    expect(result.sandbox?.sandboxId).toBeTruthy();
    expect(result.sandbox?.killed).toBe(true);
    expect(result.sandbox?.remaining).toBe(0);
    expect(["passed", "blocked", "failed", "timed_out"]).toContain(result.session?.status);

    // The bundle verifies independently, including the terminal-product evidence check.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((c) => c.name === "terminal-product evidence")?.ok).toBe(true);

    // No credential VALUE in evidence: neither real key (whichever the operator exported, or both
    // if the lane dual-injected OPENAI_API_KEY under CODEX_API_KEY too) ever appears in any artifact.
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const realKeys = [process.env.CODEX_API_KEY, process.env.OPENAI_API_KEY]
      .map((value) => (value ?? "").trim())
      .filter((value) => value.length >= 8);
    for (const file of ["run.json", "terminal-events.ndjson", "terminal-transcript.txt", "terminal-ledgers.json", "actor.json"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      for (const realKey of realKeys) {
        expect(text.includes(realKey)).toBe(false);
      }
    }
    // Interventions ledger present + empty (stdin disabled, no assisted input).
    const ledgers = JSON.parse(await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8"));
    expect(Array.isArray(ledgers.interventions)).toBe(true);
    expect(ledgers.interventions.length).toBe(0);
  });
});
