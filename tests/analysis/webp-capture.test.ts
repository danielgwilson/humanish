import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { ActorTraceItem } from "../../src/actors/contract.js";
import { captureEvidence, validateAnalysisEvidence } from "../../src/analysis/evidence.js";
import { prepareRunArtifactPaths, type PreparedRunArtifactPaths } from "../../src/run/paths.js";
import { pngToWebp } from "../helpers/webp.js";
import { syntheticArtifact } from "./fixtures.js";

let cwd: string;
let prepared: PreparedRunArtifactPaths;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "humanish-webp-capture-"));
  prepared = await prepareRunArtifactPaths(cwd, "webp-capture");
  await fs.mkdir(path.join(prepared.physicalRunRoot, "screenshots"));
});
afterEach(() => fs.rm(cwd, { recursive: true, force: true }));

it("sends a lossless WebP capture as image/webp and checks it back as one", async () => {
  const image = new PNG({ width: 4, height: 4 });
  image.data.fill(80);
  const webp = await pngToWebp(PNG.sync.write(image));
  await fs.writeFile(path.join(prepared.physicalRunRoot, "screenshots", "p01-0.webp"), webp);
  const items: ActorTraceItem[] = [
    {
      id: "p01-0",
      kind: "screenshot",
      lifecycle: "completed",
      title: "Capture 0",
      screenshotRef: { path: "screenshots/p01-0.webp", redaction: "none" },
    },
  ];
  const source = Buffer.from(
    JSON.stringify({
      schema: "humanish.run-bundle.v1",
      runId: "webp-capture",
      streams: [
        {
          id: "p01",
          simId: "p01",
          label: "p01",
          status: "passed",
          assignment: { mission: "Inspect the synthetic p01 interface." },
          actor: {
            lane: "computer-use",
            status: "passed",
            completionReason: "turn_completed",
            items,
          },
        },
      ],
      events: [],
    }),
  );
  await fs.writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
  const input = await captureEvidence(prepared, source);
  expect(input.evidence.find((entry) => entry.capture)?.capture).toMatchObject({
    path: "screenshots/p01-0.webp",
    mimeType: "image/webp",
  });
  expect(input.images).toEqual([
    expect.objectContaining({ dataUrl: `data:image/webp;base64,${webp.toString("base64")}` }),
  ]);
  await expect(
    validateAnalysisEvidence(prepared, syntheticArtifact(input), source),
  ).resolves.toBeUndefined();
  // A capture that claims a type its file does not have is refused.
  const mislabelled = syntheticArtifact(input);
  for (const entry of mislabelled.evidence)
    if (entry.capture) entry.capture = { ...entry.capture, mimeType: "image/png" };
  await expect(validateAnalysisEvidence(prepared, mislabelled, source)).rejects.toThrow(
    "ANALYSIS_CAPTURE_REFERENCE_INVALID",
  );
});
