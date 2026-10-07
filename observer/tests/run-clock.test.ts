import { describe, expect, it } from "vitest";

import live from "../../tests/golden/labs/live.json";
import { buildObserverData } from "../../src/observer/data";
import type { RunBundle } from "../../src/run/bundle";
import { runClock } from "../../src/run/notes";
import { buildGridRecording } from "../lib/grid-recording";

// A note's time counts from the run clock the producer computes from run.json, and the Observer
// places it on the study timeline it computes from the same evidence. The two must agree.
const origin = Date.parse("2026-09-01T10:00:00.000Z");

function timed(offsets: number[][], recording?: { startOffset: number; durationMs: number }) {
  const bundle = structuredClone(live) as unknown as RunBundle;
  const [template] = bundle.streams;
  bundle.streams = offsets.map((times, lane) => ({
    ...structuredClone(template!),
    id: `lane-${lane}`,
    actor: {
      ...structuredClone(template!.actor!),
      items: times.map((offset, index) => ({
        id: `lane-${lane}-${index}`,
        kind: "screenshot" as const,
        lifecycle: "completed" as const,
        title: "screenshot",
        at: new Date(origin + offset).toISOString(),
        screenshotRef: { path: `screenshots/${lane}-${index}.png`, redaction: "blurred" as const },
      })),
    },
    ...(lane === 0 && recording
      ? {
          recording: {
            path: "recordings/lane-0.mp4",
            startedAt: new Date(origin + recording.startOffset).toISOString(),
            durationMs: recording.durationMs,
            bytes: 1,
          },
        }
      : {}),
  })) as RunBundle["streams"];
  return bundle;
}

describe("the run clock", () => {
  it.each([
    [
      "two timed participants",
      timed([
        [0, 3000, 9000],
        [1000, 6000],
      ]),
    ],
    [
      "a participant whose stamps go back",
      timed([
        [0, 3000],
        [5000, 4000, 8000],
      ]),
    ],
    [
      "a desktop video that starts first",
      timed([[2000, 4000]], { startOffset: 500, durationMs: 9000 }),
    ],
  ])("matches the Observer's study timeline with %s", (_name, bundle) => {
    const recording = buildGridRecording(buildObserverData(bundle).streams);

    expect(runClock(bundle)).toEqual({ startMs: recording.startMs, endMs: recording.endMs });
  });
});
