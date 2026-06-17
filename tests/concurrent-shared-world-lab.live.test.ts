import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";
import { runLab } from "../src/lab-engine.js";
import { verifyRun } from "../src/run.js";

// The LIVE rung for the CONCURRENT shared-world topology (#164 phase 2). WRITTEN + gated, NOT run
// in the autonomous proof: it needs (1) MIMETIC_LIVE_SHARED_WORLD=1 (the spend opt-in), (2)
// OPENAI_API_KEY + E2B_API_KEY, AND (3) a REAL STATEFUL SEEDED app (synthetic data) that serves on
// 0.0.0.0 so getHost can reach it and whose checkpoint probes observe concurrent mutations. The
// repo/serve/seed/checkpoint below are PLACEHOLDERS for that authorized receipt — a generic
// multi-role app with a migrated+seeded DB. This rung is DEFERRED to a separately-authorized
// receipt (per the goal packet's Provider Spend Policy): the deterministic fake-substrate proof
// (the rendezvous latch) in concurrent-shared-world-lab.test.ts is the merge gate at $0, and it
// proves the PLUMBING + the honesty contract — NOT "we ran many concurrent users at scale", which
// only this live receipt backs.
const LIVE = process.env.MIMETIC_LIVE_SHARED_WORLD === "1"
  && Boolean(process.env.OPENAI_API_KEY)
  && Boolean(process.env.E2B_API_KEY);

describe.skipIf(!LIVE)("concurrent shared-world topology (LIVE, spend-gated — deferred to an authorized receipt)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "mimetic-concurrent-sw-live-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("provisions one getHost-exposed plane, runs >=3 personas at once, proves overlap + state evolution", { timeout: 1_200_000 }, async () => {
    // PLACEHOLDER subject: replace repos/serve/seed/checkpoint with a real synthetic seeded app for
    // the authorized live receipt. DATABASE_URL is supplied via --env-file (never persisted).
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "concurrent-shared-world-live-proof",
      title: "Concurrent shared-world live proof",
      subject: {
        source: "clone",
        topology: "shared-world",
        exposure: "synthetic",
        repos: ["example-org/collab-notes-app"], // PLACEHOLDER: a real synthetic seeded app
        env: ["DATABASE_URL"],
        serve: {
          install: "pnpm install --frozen-lockfile",
          build: "pnpm build",
          start: "pnpm start -H 0.0.0.0", // bind all interfaces so getHost can route to it
          url: "http://127.0.0.1:3000/",
          readyTimeoutMs: 180_000
        },
        state: {
          seed: [
            { name: "db-migrate", command: "pnpm db:migrate", when: "before-start" },
            { name: "seed-baseline", command: "pnpm db:seed", when: "before-start" }
          ],
          checkpoint: [
            { name: "notes-count", command: "psql \"$DATABASE_URL\" -tAc \"select count(*) from notes\"" },
            { name: "reviews-count", command: "psql \"$DATABASE_URL\" -tAc \"select count(*) from reviews\"" }
          ]
        }
      },
      actors: [
        {
          type: "openai-computer-use",
          mission: "You are one of many concurrent users of a shared app. Accomplish your role's task, then stop.",
          lanes: [
            { id: "persona-author", persona: "contributor", entry: "/compose", instruction: "Create and publish a note." },
            { id: "persona-reviewer", persona: "reviewer", entry: "/inbox", instruction: "Open the newest note and review it." },
            { id: "persona-skimmer", persona: "impatient-skimmer", device: "mobile", entry: "/feed", instruction: "Skim the feed and react to the newest note." }
          ]
        }
      ],
      execution: { target: "e2b-desktop", timeoutMs: 180_000, concurrency: 3 },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);

    const outcome = await runLab(parsed.config, { cwd, dryRun: false });
    expect(outcome.backend).toBe("concurrent-shared-world");
    if (outcome.backend !== "concurrent-shared-world") return;
    const result = outcome.result;

    // ONE subject sandbox torn down by id (the actor sandboxes are torn down inside runCuaLane).
    expect(result.subjectSandbox?.killed).toBe(true);
    // Proven concurrency: ≥2 actor windows overlapped on the one clock.
    expect(result.overlapProven).toBe(true);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.attributionClass).toBe("shared-world");
    expect(bundle.sharedWorld.topologyMode).toBe("concurrent");
    // The shared world changed under concurrent load (a real stateSeries delta).
    const series = bundle.sharedWorld.stateSeries as Array<{ digest: string }>;
    expect(series.some((s, i) => i > 0 && s.digest !== series[i - 1]!.digest)).toBe(true);
  });
});
