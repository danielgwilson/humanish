import { describe, expect, it } from "vitest";
import live from "../../tests/golden/observer-data/live.json";
import { historyRunHref, observerArtifactHref, runArtifactHref, screenshotHref } from "../lib/artifact-href";
import { comparisonFrame, frameTimes } from "../lib/comparison";
import { ageLabel, liveEmbedSandbox, liveEmbedUrl, sourceUpdatedAt } from "../lib/live";
import type { ObserverData, ObserverStream } from "../lib/observer-data";
import { buildPlayerModel } from "../lib/player-model";
import { isMoments, isStringList } from "../lib/preferences";
import { formatHash } from "../lib/route";
import { savedEntryLabels } from "../lib/saved-entry-labels";
import { signalFor } from "../lib/signal";

const data = live as unknown as ObserverData;
it("saved entries distinguish repeated actions even with identical or unavailable timestamps", () => {
  const stream = structuredClone(data.streams[0]!);
  const original = stream.actor!.items[0]!;
  stream.actor!.items = [
    { ...original, id: "a", title: "keypress TAB", at: "2026-09-09T06:26:37.760Z" },
    { ...original, id: "b", title: "keypress TAB", at: "2026-09-09T06:26:37.760Z" },
    { ...original, id: "c", title: "keypress TAB", at: "invalid" },
    { ...original, id: "d", title: "keypress TAB", at: "invalid" },
  ];
  const labels = savedEntryLabels([stream]);
  expect(new Set(labels.values()).size).toBe(4);
  expect(labels.get(`${stream.id}/a`)).toBe("keypress TAB · 06:26:37.760 UTC · entry 1");
  expect(labels.get(`${stream.id}/c`)).toBe("keypress TAB · time unavailable · entry 3");
});
describe("Review links preserve filenames without permitting navigation escapes", () => {
  it.each(["../secret", "x/../../secret", "/secret", "//example.test/x", "https://example.test/x", "javascript:alert(1)", "x\\y", "%2e%2e/secret", "%252e%252e/secret", "x%2fy", "x/%00y", "x/./y", "x//y"])("rejects %s", (path) => {
    expect(runArtifactHref(path)).toBeNull();
  });
  it("encodes actual filesystem names once and limits parent steps", () => {
    expect(runArtifactHref("screenshots/a #?.png")).toBe("../screenshots/a%20%23%3F.png");
    expect(observerArtifactHref("../review.json")).toBe("../review.json");
    expect(observerArtifactHref("../../review.json")).toBeNull();
    expect(observerArtifactHref("data:text/html,hello")).toBeNull();
    expect(historyRunHref("../other")).toBeNull();
    expect(historyRunHref("run 1")).toBe("/_humanish/runs/run%201/observer/index.html");
  });
  it("rejects ill-formed Unicode identifiers without throwing", () => {
    expect(runArtifactHref("screenshots/\ud800.png")).toBeNull();
    expect(historyRunHref("\ud800")).toBeNull();
    expect(formatHash("\ud800", 0)).toBe("");
    expect(runArtifactHref("screenshots/🌿.png")).toBe("../screenshots/%F0%9F%8C%BF.png");
  });
  it("keeps origin access restricted to cross-origin runtime desktops", () => {
    const stream = { ...data.streams[0]!, embed: { kind: "iframe" as const, title: "Desktop", url: "https://desktop.example.test/" } };
    expect(liveEmbedSandbox(stream, "https://observer.example.test")).toBe("allow-scripts");
    const attached = { ...stream, embed: { ...stream.embed, runtimeDesktop: true as const } };
    expect(liveEmbedSandbox(attached, "https://observer.example.test")).toBe("allow-scripts allow-same-origin");
    expect(liveEmbedSandbox(attached, "https://desktop.example.test")).toBe("allow-scripts");
    expect(liveEmbedSandbox(attached, "null")).toBe("allow-scripts");
  });
  it("permits only raster exports and HTTP desktop sources", () => {
    expect(screenshotHref("data:image/png;base64,YQ==")).toBe("data:image/png;base64,YQ==");
    expect(screenshotHref("data:image/svg+xml;base64,YQ==")).toBeNull();
    for (const url of ["javascript:alert(1)", "data:text/html,hello", "//example.test/desktop", "https://user:password@example.test/", "https://example.test/\n"]) {
      expect(liveEmbedUrl({ ...data.streams[0]!, embed: { kind: "iframe", url, title: "test" } })).toBeNull();
    }
  });
});

describe("Comparison shows only evidence already captured at the cursor", () => {
  it("distinguishes before, between, duplicate and after timestamps", () => {
    expect(comparisonFrame([100, 300, 300, 700], 99)).toEqual({ index: -1, ageMs: 0, coverage: "before" });
    expect(comparisonFrame([100, 300, 300, 700], 299)).toEqual({ index: 0, ageMs: 199, coverage: "within" });
    expect(comparisonFrame([100, 300, 300, 700], 300)?.index).toBe(2);
    expect(comparisonFrame([100, 300, 300, 700], 800)).toEqual({ index: 3, ageMs: 100, coverage: "after" });
    expect(comparisonFrame([], 100)).toBeNull();
  });
  it("does not pretend descending or missing timestamps are a shared clock", () => {
    const model = buildPlayerModel(data.streams[0]!)!;
    expect(model).not.toBeNull();
    const frame = model.frames[0]!;
    const descending = { ...model, frames: [{ ...frame, index: 0, atMs: 300 }, { ...frame, index: 1, atMs: 100 }] };
    expect(frameTimes(descending, "shared")).toBeNull();
    expect(frameTimes(descending, "elapsed")).toEqual([0, model.avgFrameMs]);
    const { atMs: _timestamp, ...unstamped } = frame;
    const missing = { ...model, frames: [unstamped] };
    expect(frameTimes(missing, "shared")).toBeNull();
    expect(frameTimes(missing, "elapsed")).toEqual([0]);
  });
});

it("future completion names cannot resolve inherited object properties", () => {
  const stream = data.streams[0]!;
  for (const completionReason of ["__proto__", "constructor", "toString"]) {
    const signal = signalFor({ ...stream, actor: { ...stream.actor!, completionReason, reason: "A recorded reason" } } as ObserverStream);
    expect(typeof signal.label).toBe("string");
  }
});

it("freshness uses activity timestamps rather than reserialization time", () => {
  expect(sourceUpdatedAt({ ...data, generatedAt: "2099-01-01T00:00:00Z" })).toBe(sourceUpdatedAt(data));
  expect(ageLabel(null, Date.now())).toBe("time unavailable");
});

it("local saved moments admit bounded identifiers rather than arbitrary payloads", () => {
  const moment = { runId: "study", streamId: "lane", itemId: "capture", frame: 0, savedAt: "2026-09-08T00:00:00Z" };
  expect(isMoments([moment])).toBe(true);
  expect(isMoments([{ ...moment, frame: -1 }])).toBe(false);
  expect(isMoments(Array(51).fill(moment))).toBe(false);
  expect(isStringList(["x".repeat(257)])).toBe(false);
});
