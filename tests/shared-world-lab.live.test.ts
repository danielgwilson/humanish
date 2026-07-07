import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";
import { runLab } from "../src/lab-engine.js";
import { verifyRun } from "../src/run.js";

// The LIVE rung for the shared-world topology (#164). WRITTEN + gated, NOT run in the autonomous
// proof: it needs (1) HOMUN_LIVE_SHARED_WORLD=1 (the spend opt-in), (2) OPENAI_API_KEY +
// E2B_API_KEY, AND (3) a REAL STATEFUL SEEDED APP whose checkpoint probes observe role mutations.
// The fixture repo/serve/seed/checkpoint below are PLACEHOLDERS for that authorized receipt — a
// generic multi-role app with a migrated+seeded DB and read-only digest probes. This rung is
// DEFERRED to a separately-authorized receipt (per the goal packet's Provider Spend Policy): the
// deterministic fake-substrate proof in shared-world-lab.test.ts is the merge gate at $0.
const LIVE = process.env.HOMUN_LIVE_SHARED_WORLD === "1"
  && Boolean(process.env.OPENAI_API_KEY)
  && Boolean(process.env.E2B_API_KEY);

describe.skipIf(!LIVE)("shared-world topology (LIVE, spend-gated — deferred to an authorized receipt)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "homun-shared-world-live-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("provisions one seeded plane, runs 2 roles sequentially, and proves the after-A-before-B delta", { timeout: 900_000 }, async () => {
    // PLACEHOLDER subject: replace repos/serve/seed/checkpoint with a real stateful seeded app for
    // the authorized live receipt. The DATABASE_URL value is supplied via --env-file (never persisted).
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "shared-world-live-proof",
      title: "Shared-world live proof",
      subject: {
        source: "clone",
        topology: "shared-world",
        repos: ["example-org/collab-notes-app"], // PLACEHOLDER: a real seeded multi-role app
        env: ["DATABASE_URL"],
        serve: {
          install: "pnpm install --frozen-lockfile",
          build: "pnpm build",
          start: "pnpm start",
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
          mission: "Use the shared app to accomplish your role's task, then stop.",
          lanes: [
            { id: "role-author", persona: "contributor", entry: "/compose", instruction: "Create and publish a note titled \"Launch checklist\"." },
            { id: "role-reviewer", persona: "reviewer", entry: "/inbox", instruction: "Open the most recent published note and leave one review comment." }
          ]
        }
      ],
      execution: { target: "e2b-desktop", timeoutMs: 180_000 },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);

    const outcome = await runLab(parsed.config, { cwd, dryRun: false });
    expect(outcome.backend).toBe("shared-world");
    if (outcome.backend !== "shared-world") return;
    const result = outcome.result;

    // ONE sandbox, torn down by id (never enumerated).
    expect(result.sandbox?.killed).toBe(true);

    // verifyRun fail-closed over the produced bundle (the timeline well-formedness, single-plane,
    // digest-only checkpoints, the mandatory attributionLimits, and the delta-on-pass gate).
    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".homun", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.attributionClass).toBe("shared-world");
    // The interaction proof: the checkpoint after role-author shows a delta and precedes role-reviewer.
    const timeline = bundle.sharedWorld.timeline as Array<{ kind: string; name?: string; deltaFromPrev?: boolean; roleId?: string }>;
    const cpAfterAuthor = timeline.findIndex((e) => e.kind === "checkpoint" && e.name === "cp-after-role-author");
    const reviewerTurn = timeline.findIndex((e) => e.kind === "turn" && e.roleId === "role-reviewer");
    expect(timeline[cpAfterAuthor]?.deltaFromPrev).toBe(true);
    expect(cpAfterAuthor).toBeLessThan(reviewerTurn);
  });
});
