import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { ActorTraceItem } from "../../src/actors/contract.js";
import { captureEvidence, validateAnalysisEvidence } from "../../src/analysis/evidence.js";
import { prepareRunArtifactPaths, type PreparedRunArtifactPaths } from "../../src/run/paths.js";
import { syntheticArtifact } from "./fixtures.js";

// The analyst's evidence holds what a participant read from the desktop: a zoom's image is a
// capture it can cite, and a pointer read's entry says where the pointer was.

let cwd: string;
let prepared: PreparedRunArtifactPaths;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "humanish-zoom-capture-"));
  prepared = await prepareRunArtifactPaths(cwd, "zoom-capture");
  await fs.mkdir(path.join(prepared.physicalRunRoot, "screenshots"));
});
afterEach(() => fs.rm(cwd, { recursive: true, force: true }));

async function frame(name: string, width: number, height: number): Promise<string> {
  const image = new PNG({ width, height });
  image.data.fill(120);
  await fs.writeFile(
    path.join(prepared.physicalRunRoot, "screenshots", name),
    PNG.sync.write(image),
  );
  return `screenshots/${name}`;
}

it("offers a zoom's image as a capture and says where a pointer read found the pointer", async () => {
  const items: ActorTraceItem[] = [
    {
      id: "s0",
      kind: "screenshot",
      lifecycle: "completed",
      title: "turn-00-start",
      screenshotRef: { path: await frame("turn-00-start.png", 16, 10), redaction: "none" },
    },
    {
      id: "z1",
      kind: "ui_action",
      lifecycle: "completed",
      title: "zoom 8x2 at (4, 6)",
      region: { x: 4, y: 6, width: 8, height: 2 },
      screenshotRef: { path: await frame("zoom-001.png", 8, 2), redaction: "none" },
    },
    {
      id: "p1",
      kind: "ui_action",
      lifecycle: "completed",
      title: "read pointer",
      pointer: { x: 3, y: 5 },
    },
  ];
  const source = Buffer.from(
    JSON.stringify({
      schema: "humanish.run-bundle.v1",
      runId: "zoom-capture",
      streams: [
        {
          id: "p01",
          simId: "p01",
          label: "p01",
          status: "passed",
          assignment: { mission: "Read the synthetic reference." },
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
  expect(input.evidence.find((entry) => entry.eventId === "z1")?.capture).toMatchObject({
    path: "screenshots/zoom-001.png",
    mimeType: "image/png",
  });
  expect(input.images).toHaveLength(2);
  expect(input.evidence.find((entry) => entry.eventId === "p1")?.text).toBe(
    "read pointer\npointer at (3, 5)",
  );
  await expect(
    validateAnalysisEvidence(prepared, syntheticArtifact(input), source),
  ).resolves.toBeUndefined();
});
