import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";
import { runLab } from "../src/lab-engine.js";
import { verifyRun } from "../src/run.js";

// The LIVE rung for subject.state: a seed step that PROVES itself through the readiness
// probe. The probe target (serve.url) is a file that exists ONLY because the before-start
// seed step wrote it — readiness cannot pass unless the seed ran, and the real actor then
// reads the seeded sentinel on screen. Spend-gated exactly like the other live rungs:
//   1. HOMUN_LIVE_CUA=1 must be set explicitly (the spend opt-in),
//   2. OPENAI_API_KEY and E2B_API_KEY must both be present,
//   3. @e2b/desktop is loaded lazily inside the lab (never imported when skipped).
// Asserts a verified bundle with state.provenance "seeded", the step's commandDigest, and a
// terminal session — never task success.
const LIVE = process.env.HOMUN_LIVE_CUA === "1"
  && Boolean(process.env.OPENAI_API_KEY)
  && Boolean(process.env.E2B_API_KEY);

const SEED_COMMAND = "printf '<h1>SEEDED-7f3a</h1>' > seeded.html";

describe.skipIf(!LIVE)("cua-actor-lab subject.state (LIVE, spend-gated)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "homun-cua-state-live-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("seeds in-sandbox state that the readiness probe and the real actor both depend on", { timeout: 420_000 }, async () => {
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-clone-seeded-live-proof",
      title: "Clone subject with seeded state (live proof)",
      subject: {
        source: "clone",
        repos: ["mdn/beginner-html-site-styled"],
        serve: {
          start: "python3 -m http.server 8000",
          // The served file EXISTS only because the seed step ran: probe == seed proof.
          url: "http://127.0.0.1:8000/seeded.html",
          readyTimeoutMs: 60_000
        },
        state: {
          seed: [{ name: "write-fixture-page", command: SEED_COMMAND, when: "before-start" }]
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

    // Terminal session without a harness error; sandbox reclaimed. We do NOT assert task
    // success — the lab's evidence claim is "seeded state served and driven", not "passed".
    expect(["passed", "failed", "blocked", "timed_out"]).toContain(result.session?.status);
    expect(result.session?.completionReason).not.toBe("harness_error");
    expect(result.observer?.ok).toBe(true);
    expect(result.sandbox?.killed).toBe(true);

    // State provenance: marker seeded, the step ran ok, digest pins the exact command.
    const expectedDigest = createHash("sha256").update(SEED_COMMAND).digest("hex").slice(0, 16);
    expect(result.subject?.state.provenance).toBe("seeded");
    expect(result.subject?.state.seed).toHaveLength(1);
    expect(result.subject?.state.seed?.[0]).toMatchObject({
      name: "write-fixture-page",
      when: "before-start",
      commandDigest: expectedDigest,
      ok: true
    });

    // The persisted bundle carries the same story and verifies independently.
    const runDir = path.join(cwd, ".homun", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.subject.state.provenance).toBe("seeded");
    expect(bundle.subject.state.seed[0].commandDigest).toBe(expectedDigest);
    // Digest only — the command text never persists in evidence (the sentinel itself may
    // legitimately appear in actor narration; the printf invocation must not).
    expect(JSON.stringify(bundle)).not.toContain("printf '<h1>");
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((check) => check.name === "subject state provenance")?.ok).toBe(true);
  });
});
