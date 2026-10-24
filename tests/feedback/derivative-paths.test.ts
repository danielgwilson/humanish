import { expect, it } from "vitest";

import { derivedBundle } from "../../src/feedback/derivative-text.js";
import type { RunBundle } from "../../src/run/bundle.js";

/** The run.json fields derivedBundle reads, with a screenshot cited under two spellings. */
function bundle(): RunBundle {
  return {
    redaction: { status: "passed", notes: "Synthetic." },
    streams: [
      {
        artifacts: [
          { kind: "screenshot", label: "frame (raw)", path: "screenshots/frame.png" },
          { kind: "screenshot", label: "frame (raw)", path: "screenshots/./frame.png" },
          { kind: "screenshot", label: "later (raw)", path: "screenshots/./later.webp" },
        ],
      },
    ],
    feedbackCandidates: [
      { evidence: [{ path: "screenshots/later.webp", kind: "screenshot", note: "Synthetic." }] },
    ],
  } as unknown as RunBundle;
}

it("keeps the spelling of a cite whose frame keeps its path, and renames a WebP frame's", () => {
  const derived = derivedBundle(
    bundle(),
    new Map([
      ["screenshots/frame.png", "screenshots/frame.png"],
      ["screenshots/later.webp", "screenshots/later.png"],
    ]),
  );
  expect(derived.streams[0]!.artifacts.map((artifact) => artifact.path)).toEqual([
    "screenshots/frame.png",
    "screenshots/./frame.png",
    "screenshots/later.png",
  ]);
  expect(derived.feedbackCandidates[0]!.evidence[0]!.path).toBe("screenshots/later.png");
});
