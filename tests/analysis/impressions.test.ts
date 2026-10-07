import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActorTrace, ActorTraceItem } from "../../src/actors/contract.js";
import { captureEvidence, validateAnalysisEvidence } from "../../src/analysis/evidence.js";
import { checkAnalysisResult } from "../../src/analysis/validation.js";
import { prepareRunArtifactPaths, type PreparedRunArtifactPaths } from "../../src/run/paths.js";
import { syntheticArtifact, syntheticResult } from "./fixtures.js";

// A pharmacist's session, synthetic: a long run of narration, the closing account, then two
// impressions recorded as messages the way the computer-use loop records them.
const UNLIKE =
  "On the paper form I write the dose next to the drug name; here the dose is on another tab.";
const UNCLEAR = "The two Save buttons looked the same, so I was not sure which one kept the dose.";

const item = (id: string, kind: ActorTraceItem["kind"], text: string): ActorTraceItem => ({
  id,
  kind,
  lifecycle: "completed",
  title: id,
  text,
});

function pharmacist(): { items: ActorTraceItem[]; impressions: ActorTrace["impressions"] } {
  const items: ActorTraceItem[] = [
    {
      id: "screenshot-001",
      kind: "screenshot",
      lifecycle: "completed",
      title: "dose form",
      screenshotRef: { path: "screenshots/dose-form.png", redaction: "none" },
    },
    ...Array.from({ length: 30 }, (_, index) =>
      item(`message-${index + 2}`, "message", `Step ${index}: I read the next field.`),
    ),
    item("message-040", "message", "I entered the dose and saved it."),
    item("message-041", "message", `Impression (unlike my work): ${UNLIKE}`),
    item("message-042", "message", `Impression (unclear): ${UNCLEAR}`),
    item("notice-043", "notice", "participant debrief completed"),
  ];
  return {
    items,
    impressions: {
      status: "collected",
      items: [
        { kind: "unlike_my_work", text: UNLIKE, messageId: "message-041" },
        { kind: "unclear", text: UNCLEAR, messageId: "message-042" },
      ],
    },
  };
}

describe("participant impressions in the analysis evidence packet", () => {
  let cwd: string;
  let prepared: PreparedRunArtifactPaths;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "humanish-impressions-evidence-"));
    prepared = await prepareRunArtifactPaths(cwd, "impressions-fixture");
    await fs.mkdir(path.join(prepared.physicalRunRoot, "screenshots"));
    const image = new PNG({ width: 4, height: 4 });
    image.data.fill(80);
    await fs.writeFile(
      path.join(prepared.physicalRunRoot, "screenshots/dose-form.png"),
      PNG.sync.write(image),
    );
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  const save = async () => {
    const { items, impressions } = pharmacist();
    const bytes = Buffer.from(
      JSON.stringify({
        schema: "humanish.run-bundle.v1",
        runId: "impressions-fixture",
        streams: [
          {
            id: "pharmacist",
            simId: "pharmacist",
            label: "Pharmacist",
            status: "passed",
            assignment: { mission: "Record a dose on the synthetic form." },
            actor: {
              lane: "computer-use",
              status: "passed",
              completionReason: "goal_satisfied",
              items,
              impressions,
            },
          },
        ],
        events: [],
      }),
    );
    await fs.writeFile(path.join(prepared.physicalRunRoot, "run.json"), bytes);
    return bytes;
  };

  it("packs every impression as a quotable statement of its participant under a tight evidence limit", async () => {
    const source = await save();
    const input = await captureEvidence(prepared, source, { evidence: 5 });
    const impressions = input.evidence.filter((entry) =>
      ["message-041", "message-042"].includes(entry.eventId),
    );
    expect(impressions).toEqual([
      expect.objectContaining({ streamId: "pharmacist", kind: "message", quoteEligible: true }),
      expect.objectContaining({ streamId: "pharmacist", kind: "message", quoteEligible: true }),
    ]);
    await expect(
      validateAnalysisEvidence(prepared, syntheticArtifact(input), source),
    ).resolves.toBeUndefined();
  });

  it("lets an impression with the capture of its screen support a design finding, and alone a finding about what was said", async () => {
    const input = await captureEvidence(prepared, await save(), { evidence: 5 });
    const capture = input.evidence.find((entry) => entry.capture !== null)!;
    const unlike = input.evidence.find((entry) => entry.eventId === "message-041")!;

    const design = syntheticResult(input);
    design.designFindings![0]!.evidenceIds = [capture.id, unlike.id];
    expect(checkAnalysisResult(input, design).ok).toBe(true);

    const alone = syntheticResult(input);
    alone.designFindings![0]!.evidenceIds = [unlike.id];
    expect(checkAnalysisResult(input, alone)).toEqual({
      ok: false,
      errors: ["ANALYSIS_DESIGN_WITHOUT_CAPTURE", "ANALYSIS_DESIGN_MEMBERSHIP_INVALID"],
    });

    const said = syntheticResult(input);
    said.findings[0]!.observations = [
      {
        claim: "The pharmacist said the dose sits on another tab from the drug name.",
        basis: "participant_statement",
        evidenceIds: [unlike.id],
        limitation: "One participant's opinion.",
      },
    ];
    said.participants[0]!.feedback = [{ evidenceId: unlike.id, text: UNLIKE }];
    expect(checkAnalysisResult(input, said).ok).toBe(true);
  });
});
