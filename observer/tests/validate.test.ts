import { describe, expect, it } from "vitest";

import firstRun from "../../tests/golden/observer-data/first-run.json";
import live from "../../tests/golden/observer-data/live.json";
import oss from "../../tests/golden/observer-data/oss.json";
import { isObserverData } from "../lib/validate";

/** Alter one consumed field in a real contract golden rather than inventing a bundle shape. */
function changed(field: string, value: unknown): unknown {
  const fixture: unknown = structuredClone(live);
  const segments = field.split(".");
  let current = fixture as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (next === null || typeof next !== "object") current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
  return fixture;
}

describe("Observer admission at the untrusted JSON boundary", () => {
  it.each([["first run", firstRun], ["OSS", oss], ["live", live]])("accepts the unchanged %s contract golden", (_name, fixture) => {
    expect(isObserverData(fixture)).toBe(true);
  });

  it.each([
    ["streams.0.desktopGeometry", {}],
    ["streams.0.desktopGeometry", { screen: {} }],
    ["streams.0.desktopGeometry", { screen: { requested: { width: 360, height: 800 }, verified: null } }],
    ["streams.0.desktopGeometry", { screen: { requested: { width: 0, height: 800 } } }],
    ["streams.0.desktopGeometry", { screen: { requested: { width: 360, height: 800 }, verified: { width: 360, height: {} } } }],
    ["streams.0.actor.affordanceUse", {}],
    ["streams.0.actor.affordanceUse", { counts: null, shortcutTotal: 0 }],
    ["streams.0.actor.affordanceUse", { counts: [], shortcutTotal: 0 }],
    ["streams.0.actor.affordanceUse", { counts: { keyboard: {} }, shortcutTotal: 0 }],
    ["streams.0.actor.affordanceUse", { counts: {}, shortcutTotal: {} }],
    ["streams.0.actor.estimatedCost", { estimatedCostUsd: 1, ratesAsOf: {} }],
    ["streams.0.actor.estimatedCost", { estimatedCostUsd: {}, ratesAsOf: "2026-09-08" }],
    ["streams.0.actor.estimatedCost", { estimatedCostUsd: Infinity, ratesAsOf: "2026-09-08" }],
    ["streams.0.actor.items.0.screenshotRef", { path: "screenshots/frame.png", redaction: {} }],
    ["streams.0.actor.items.0.screenshotRef", { path: {} }],
    ["streams.0.actor.items.0.status", {}],
    ["streams.0.actor.items.0.text", {}],
    ["streams.0.actor.items.0.coord", { x: Infinity, y: 0 }],
    ["streams.0.actor.ids.model", {}],
    ["streams.0.actor.redaction.screenshots", {}],
    ["streams.0.sim.currentStep", {}],
    ["streams.0.sim.mode", {}],
    ["streams.0.transport", {}],
    ["streams.0.updatedAt", {}],
    ["streams.0.ui.intent", {}],
    ["streams.0.embed", { kind: "iframe", url: {} }],
    ["streams.0.embed", { kind: "iframe", title: {} }],
    ["streams.0.liveEnded", "true"],
    ["streams.0.liveActor", { updatedAt: "2026-09-08T00:00:00Z", items: [{ id: "partial", kind: "screenshot", title: "Partial frame", screenshotRef: { path: "screenshots/partial.png", redaction: {} } }] }],
    ["run.participantsLine", {}],
    ["run.tasksLine", {}],
    ["publicSafety.note", {}],
    ["publicSafety.publishable", "false"],
    ["publicSafety.share", { status: "invented-safe", verifiedAt: "2026-09-08", reasons: [] }],
    ["runtime", { state: "running", observedAt: "invalid", source: "local-run-status" }],
    ["runtime", { state: "invented", observedAt: "2026-09-08T00:00:00Z", source: "local-run-status" }],
    ["runtime", { state: "running", observedAt: "2026-09-08T00:00:00Z", source: "unverified" }],
    ["cost", { estimatedTotalUsd: 1, ratesAsOf: "2026-09-08", placeholder: {} }]
  ])("rejects malformed consumed field %s (%j)", (field, value) => {
    expect(isObserverData(changed(field as string, value))).toBe(false);
  });

  it.each([
    ["streams.0.desktopGeometry", { screen: { requested: { width: 360, height: 800 } } }],
    ["streams.0.desktopGeometry", { screen: { requested: { width: 360, height: 800 }, verified: { width: 360, height: 800, source: "xdpyinfo" } } }],
    ["streams.0.actor.affordanceUse", { counts: {}, shortcutTotal: 0 }],
    ["streams.0.actor.affordanceUse", { counts: { keyboard: 2 }, shortcutTotal: 1 }],
    ["streams.0.actor.estimatedCost", { estimatedCostUsd: null, ratesAsOf: null }],
    ["streams.0.actor.estimatedCost", { estimatedCostUsd: 1.25, ratesAsOf: "2026-09-08" }],
    ["streams.0.actor.items.0.screenshotRef", { path: "screenshots/frame.png" }],
    ["streams.0.actor.items.0.at", undefined],
    ["streams.0.actor.completionReason", "future-completion-reason"],
    ["streams.0.futureEvidence", { unrelated: [null, {}, "additive field"] }],
    ["runtime", { state: "unknown", observedAt: "2026-09-08T00:00:00Z", source: "local-run-status" }]
  ])("retains compatible optional and additive field %s (%j)", (field, value) => {
    expect(isObserverData(changed(field as string, value))).toBe(true);
  });

  it("rejects duplicate participant identities", () => {
    const fixture = structuredClone(live);
    fixture.streams.push(structuredClone(fixture.streams[0]!));
    expect(isObserverData(fixture)).toBe(false);
  });

  it("never throws on primitive or incomplete JSON values", () => {
    for (const input of [null, true, "", 1, [], {}, { schema: "humanish.observer-data.v1" }]) {
      expect(() => isObserverData(input)).not.toThrow();
      expect(isObserverData(input)).toBe(false);
    }
  });
});
