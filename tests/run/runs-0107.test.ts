// Runs saved by 0.107 (tests/fixtures/runs-0107) keep reading after run records gained `study`:
// the run index and stats name each one's study, verify passes, and a rerun still selects the
// fan-out's failed participant. They stay green through 0.109 and after.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveCuaRerunSelection } from "../../src/routes/computer-use/rerun-selection.js";
import { readRunIndex } from "../../src/run/run-index.js";
import { computeStats } from "../../src/run/stats.js";
import { studyProvenanceOf } from "../../src/run/study-provenance.js";
import { verifyRun } from "../../src/verify/verify.js";
import { syntheticPng1x1 } from "../image-fixtures.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/runs-0107", import.meta.url));
const RUNS = [
  "fanout-source",
  "fanout-rerun",
  "status-backed",
  "bundle-only",
  "source-convention-only",
];

let project: string;
beforeAll(async () => {
  project = await mkdtemp(path.join(tmpdir(), "humanish-runs-0107-"));
  const runs = path.join(project, ".humanish", "runs");
  for (const run of RUNS)
    await cp(path.join(FIXTURES, run), path.join(runs, run), { recursive: true });
  // The screenshots are not committed; verify needs a file at each path a bundle names.
  const screenshots = (await readFile(path.join(FIXTURES, "SCREENSHOTS.txt"), "utf8"))
    .split("\n")
    .filter(Boolean);
  for (const screenshot of screenshots) {
    await mkdir(path.dirname(path.join(runs, screenshot)), { recursive: true });
    await writeFile(path.join(runs, screenshot), syntheticPng1x1());
  }
});
afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("runs saved by 0.107", () => {
  it("name their study in the run index, from lab or from the source convention", async () => {
    const index = await readRunIndex(project);
    const byId = new Map(index.runs.map((run) => [run.runId, run]));
    const fanout = {
      id: "fanout-proof",
      path: "humanish/labs/fanout-proof.yaml",
      origin: "committed",
    };
    const preview = { id: "first-run", path: "humanish/labs/first-run.yaml", origin: "committed" };
    expect(Object.fromEntries(RUNS.map((run) => [run, byId.get(run)?.study]))).toEqual({
      "fanout-source": fanout,
      "fanout-rerun": fanout,
      "status-backed": preview,
      "bundle-only": preview,
      "source-convention-only": { id: "fanout-proof" },
    });
    expect(byId.get("bundle-only")?.derivedFrom).toBe("bundle");
    expect(index.unreadable).toEqual([]);
  });

  it("count under their study in stats", async () => {
    const stats = await computeStats(project);
    const filtered = await computeStats(project, { study: "first-run" });
    if (!stats.ok || !filtered.ok) throw new Error("stats failed");
    expect(Object.fromEntries(stats.studies.map((row) => [row.study, row.runs]))).toEqual({
      "fanout-proof": 3,
      "first-run": 2,
    });
    expect(filtered.studies.map((row) => row.study)).toEqual(["first-run"]);
  });

  it.each(RUNS)("%s verifies", async (run) => {
    expect((await verifyRun(project, run)).ok).toBe(true);
  });

  it("still select the fan-out's failed participant for a rerun", async () => {
    const lanes = ["mobile-newcomer", "small-skimmer", "desktop-power", "wide-researcher"];
    const selection = await resolveCuaRerunSelection({
      cwd: project,
      studyId: "fanout-proof",
      sandboxMs: 60_000,
      sourceRunId: "fanout-source",
      participantRuns: lanes.map((id) => ({ planned: { id } })) as never,
      participantPlan: { concurrency: 4, lanes: lanes.map((id) => ({ id })) } as never,
    });
    expect(selection.ok && selection.rerun).toEqual({
      sourceRunId: "fanout-source",
      selectedLaneIds: ["desktop-power"],
      previous: [
        {
          laneId: "desktop-power",
          streamId: "stream-003",
          status: "failed",
          reason: "transient actor transport failed",
        },
      ],
    });
  });
});

describe("a saved record's study", () => {
  const study = { id: "s", path: "humanish/studies/s.yaml", origin: "committed" as const };
  const lab = { id: "l", path: "humanish/labs/l.yaml", origin: "committed" as const };

  it("is study, then lab, then the study: or lab: source convention", () => {
    expect(studyProvenanceOf({ study, lab })).toEqual(study);
    expect(studyProvenanceOf({ lab })).toEqual(lab);
    expect(studyProvenanceOf({ study: { id: "" }, lab })).toEqual(lab);
    expect(studyProvenanceOf({ persona: { source: "study:from-study" } })).toEqual({
      id: "from-study",
    });
    expect(studyProvenanceOf({ scenario: { source: "lab:from-lab" } })).toEqual({ id: "from-lab" });
    expect(studyProvenanceOf({ persona: { source: "humanish/personas/p.yaml" } })).toBeUndefined();
  });

  it("keeps only the fields that are valid", () => {
    expect(studyProvenanceOf({ study: { id: "s", path: 3, origin: "elsewhere" } })).toEqual({
      id: "s",
    });
  });
});
