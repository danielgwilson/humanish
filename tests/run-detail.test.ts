import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readRunDetail } from "../src/run-detail.js";

// Shapes here mirror what a REAL run writes (`humanish.actor-trace.v1` under `stream.actor`, and
// `stream.liveActor` mid-flight), read off an actual computer-use run rather than invented.

const ACTOR_TRACE = {
  schema: "humanish.actor-trace.v1",
  persona: { id: "synthetic-new-user", traitsApplied: ["patience:medium", "skill:medium", "constraints:3"] },
  status: "passed",
  completionReason: "goal_satisfied",
  counts: { turns: 26, actions: 68, reasonings: 15 },
  estimatedCost: { estimatedCostUsd: 0.629308 },
  items: [
    { id: "screenshot-001", kind: "screenshot", lifecycle: "completed", title: "turn-00-start" },
    { id: "reasoning-001", kind: "reasoning", lifecycle: "completed", title: "reasoning turn 1", text: "**Starting out**\n\nFirst I will look at the page.", at: "2026-08-19T22:49:20.000Z" },
    { id: "reasoning-002", kind: "reasoning", lifecycle: "completed", title: "reasoning turn 25", text: "**Connecting fields for relationships**\n\nI'm thinking about connecting fields.", at: "2026-08-19T22:51:00.000Z" }
  ]
};

async function writeBundle(cwd: string, runId: string, bundle: unknown): Promise<void> {
  const dir = path.join(cwd, ".humanish", "runs", runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "run.json"), JSON.stringify(bundle, null, 2), "utf8");
}

describe("what one run's participants are doing (#455)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-detail-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("reads the participant, their traits, and their latest thought verbatim", async () => {
    await writeBundle(cwd, "run-a", {
      schema: "humanish.run-bundle.v1",
      runId: "run-a",
      streams: [{ id: "stream-001", label: "CUA browser — observer-live-check", status: "passed", actor: ACTOR_TRACE }]
    });

    const detail = await readRunDetail(cwd, "run-a");
    const participant = detail?.participants[0];
    expect(participant?.label).toBe("CUA browser — observer-live-check");
    expect(participant?.personaId).toBe("synthetic-new-user");
    // The abbreviated persona: who is struggling, which a name alone does not say.
    expect(participant?.traits).toEqual(["patience:medium", "skill:medium", "constraints:3"]);
    expect(participant?.turns).toBe(26);
    expect(participant?.estimatedCostUsd).toBeCloseTo(0.629308);
    // The LATEST thought, quoted exactly as the provider wrote it — markdown lead included, because
    // normalizing it is the surface's job and paraphrasing it is nobody's.
    expect(participant?.thought?.text).toContain("Connecting fields for relationships");
    expect(participant?.thought?.title).toBe("reasoning turn 25");
  });

  it("prefers the live flush over the finished trace while a run is in flight", async () => {
    // Both exist during the window where a run has just completed; the live one is the newer
    // account, and a screen that showed the older would go backwards as the run ends.
    await writeBundle(cwd, "run-b", {
      runId: "run-b",
      streams: [
        {
          id: "stream-001",
          label: "lane",
          actor: { ...ACTOR_TRACE, items: [{ kind: "reasoning", lifecycle: "completed", text: "stale" }] },
          liveActor: {
            persona: { id: "p", traitsApplied: [] },
            status: "running",
            items: [{ kind: "reasoning", lifecycle: "completed", text: "current" }]
          }
        }
      ]
    });
    const detail = await readRunDetail(cwd, "run-b");
    expect(detail?.participants[0]?.thought?.text).toBe("current");
    expect(detail?.participants[0]?.status).toBe("running");
  });

  it("skips a thought still being written rather than quoting half of one", async () => {
    await writeBundle(cwd, "run-c", {
      runId: "run-c",
      streams: [
        {
          id: "s1",
          liveActor: {
            items: [
              { kind: "reasoning", lifecycle: "completed", text: "finished thinking" },
              { kind: "reasoning", lifecycle: "in_progress", text: "half a th" }
            ]
          }
        }
      ]
    });
    const detail = await readRunDetail(cwd, "run-c");
    // Quoting a partial thought would attribute to the participant something they had not said.
    expect(detail?.participants[0]?.thought?.text).toBe("finished thinking");
  });

  it("reports every lane of a multi-participant run, separately", async () => {
    await writeBundle(cwd, "run-d", {
      runId: "run-d",
      streams: [
        { id: "sim-01-ui", label: "UI journey", status: "contract_proof_only" },
        { id: "sim-02-terminal", label: "CLI actor", status: "contract_proof_only" }
      ]
    });
    const detail = await readRunDetail(cwd, "run-d");
    expect(detail?.participants.map((p) => p.label)).toEqual(["UI journey", "CLI actor"]);
    // No trace at all is not an error: these lanes simply recorded no thinking.
    expect(detail?.participants[0]?.thought).toBeUndefined();
    expect(detail?.participants[0]?.traits).toEqual([]);
  });

  it("counts the thoughts, so a live participant shows progress before counts exist", async () => {
    // The mid-run flush carries trace ITEMS but no `counts` block, so a live lane has no turn
    // number. Counting the recorded thoughts is a true statement about progress; inferring a turn
    // number from the shape of the trace would not be.
    await writeBundle(cwd, "run-live", {
      runId: "run-live",
      streams: [
        {
          id: "s1",
          liveActor: {
            status: "running",
            items: [
              { kind: "screenshot", lifecycle: "completed" },
              { kind: "reasoning", lifecycle: "completed", text: "one" },
              { kind: "reasoning", lifecycle: "completed", text: "two" }
            ]
          }
        }
      ]
    });
    const detail = await readRunDetail(cwd, "run-live");
    expect(detail?.participants[0]?.thoughts).toBe(2);
    expect(detail?.participants[0]?.turns).toBeUndefined();
  });

  it("a run with no bundle yet is null, not a failure — that is a run that just started", async () => {
    expect(await readRunDetail(cwd, "nope")).toBeNull();
  });

  it("never coerces an unrecorded cost to zero", async () => {
    await writeBundle(cwd, "run-e", {
      runId: "run-e",
      streams: [
        { id: "a", actor: { estimatedCost: { estimatedCostUsd: null } } },
        { id: "b", actor: {} }
      ]
    });
    const detail = await readRunDetail(cwd, "run-e");
    // Declared absent, and never recorded at all: different facts, neither of them 0.
    expect(detail?.participants[0]?.estimatedCostUsd).toBeNull();
    expect(detail?.participants[1]?.estimatedCostUsd).toBeUndefined();
  });
});
