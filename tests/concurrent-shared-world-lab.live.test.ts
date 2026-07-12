import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseLabConfig } from "../src/lab-config.js";
import { runLab } from "../src/lab-engine.js";
import { verifyRun } from "../src/run.js";

// The LIVE rung for the CONCURRENT shared-world topology (#164 phase 2). WRITTEN + gated, NOT run
// in the autonomous proof: it needs (1) HUMANISH_LIVE_SHARED_WORLD=1 (the spend opt-in), (2)
// OPENAI_API_KEY + E2B_API_KEY.
//
// It drives the REAL committed synthetic fixture (no placeholders): the lab
// `humanish/labs/shared-world-concurrent-live.yaml` clones THIS public repo, serves the synthetic
// shared task board `humanish/fixtures/shared-world-app` on 0.0.0.0, seeds it, and probes it (a
// read-only aggregate). 3 concurrent personas each add a task to the shared board; the prober
// observes the task count GROW under load. The fixture must be on the cloned commit's default
// branch — so this rung is a separately-authorized receipt RUN AFTER this PR merges to main.
//
// The deterministic fake-substrate proof (the rendezvous latch) in
// concurrent-shared-world-lab.test.ts is the merge gate at $0; it proves the PLUMBING + the honesty
// contract — NOT "we ran many concurrent users at scale", which only this live receipt backs.
const LIVE = process.env.HUMANISH_LIVE_SHARED_WORLD === "1"
  && Boolean(process.env.OPENAI_API_KEY)
  && Boolean(process.env.E2B_API_KEY);

const REPO_ROOT = process.cwd();

describe.skipIf(!LIVE)("concurrent shared-world topology (LIVE, spend-gated — deferred to an authorized receipt)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-concurrent-sw-live-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("provisions one getHost-exposed plane, runs 3 personas at once, proves overlap + state evolution", { timeout: 1_200_000 }, async () => {
    // The REAL committed fixture lab — single source of truth (no inline placeholder). Flip the
    // (dry-run default) committed lab to a live run via the explicit dryRun override.
    const raw = parse(readFileSync(path.join(REPO_ROOT, "humanish/labs/shared-world-concurrent-live.yaml"), "utf8"));
    const parsed = parseLabConfig(raw);
    if (!parsed.ok) throw new Error(parsed.error.message);

    const outcome = await runLab(parsed.config, { cwd, dryRun: false });
    expect(outcome.backend).toBe("concurrent-shared-world");
    if (outcome.backend !== "concurrent-shared-world") return;
    const result = outcome.result;

    // ONE getHost-exposed subject plane; 3 personas.
    expect(result.roleCount).toBe(3);
    expect(result.host).toBeTruthy(); // the tokenless getHost URL (ephemeral, raw on the result only)
    // N+1 all reclaimed BY id: the subject sandbox + every actor sandbox killed.
    expect(result.subjectSandbox?.killed).toBe(true);
    const actorSandboxIds = result.roles.map((role) => role.sandbox?.sandboxId).filter(Boolean);
    expect(new Set(actorSandboxIds).size).toBe(3); // 3 distinct actor sandboxes
    expect(result.roles.every((role) => role.sandbox?.killed === true)).toBe(true);
    // Proven concurrency: >=2 actor windows overlapped on the one clock.
    expect(result.overlapProven).toBe(true);
    // Per-persona outcomes recorded (the "M of N" headline).
    expect(result.roles).toHaveLength(3);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.attributionClass).toBe("shared-world");
    expect(bundle.sharedWorld.topologyMode).toBe("concurrent");
    // The shared world changed under concurrent load (the task count grew → a real stateSeries delta).
    const series = bundle.sharedWorld.stateSeries as Array<{ digest: string }>;
    expect(series.some((snapshot, i) => i > 0 && snapshot.digest !== series[i - 1]!.digest)).toBe(true);
    // laneWindows overlap is recorded in the bundle too.
    const windows = bundle.sharedWorld.laneWindows as Array<{ startedAt: number; endedAt: number }>;
    expect(windows.some((a, i) => windows.some((b, j) => i !== j && a.startedAt < b.endedAt && b.startedAt < a.endedAt))).toBe(true);
  });
});
