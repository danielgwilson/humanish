import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCuaCostSummary } from "../src/cua-actor-lab.js";
import { observeDesktopResources } from "../src/e2b-desktop-resources.js";
import { estimateAllocatedDesktopCost } from "../src/pricing.js";

const captured = JSON.parse(readFileSync(new URL("./fixtures/e2b-desktop-resources/observed-resources.json", import.meta.url), "utf8")) as Array<{ cpuCount: number; memoryMB: number }>;
afterEach(() => vi.useRealTimers());

describe("observed desktop resources", () => {
  it("replays both retained SDK resource observations through the run cost builder", async () => {
    expect(captured).toHaveLength(2);
    const desktops = await Promise.all(captured.map(async (info, index) => ({
      laneId: `participant-${index + 1}`,
      minutes: 1,
      observation: await observeDesktopResources({ getInfo: async () => info }),
      lifetimeComplete: true
    })));
    const cost = buildCuaCostSummary({ lanes: [], desktops })!;
    expect(cost.estimatedTotalUsd).toBe(0.01776);
    expect(cost.desktopMinutes).toBe(2);
    expect(cost.fullyEstimated).toBe(true);
    expect(cost.placeholder).toBe(false);
    expect(cost.breakdown).toHaveLength(2);
    for (const line of cost.breakdown) {
      expect(line).toMatchObject({ estimatedCostUsd: 0.00888, ratesAsOf: "2026-09-05", source: "e2b.dev/pricing",
        desktop: { resources: { cpuCount: 8, memoryMiB: 8192 }, resourceSource: "e2b.getInfo", durationBasis: "host-acquired-to-cleanup" } });
    }
  });

  it("prices mixed custom sizes per allocation and keeps unknown lanes out of the known subtotal", async () => {
    const observed = await observeDesktopResources({ getInfo: async () => captured[0]! });
    const cost = buildCuaCostSummary({ lanes: [], desktops: [
      { laneId: "stock", minutes: 2, observation: observed, lifetimeComplete: true },
      // Explicit synthetic variation of the captured field shape.
      { laneId: "custom", minutes: 3, observation: await observeDesktopResources({ getInfo: async () => ({ cpuCount: 2, memoryMB: 1024 }) }), lifetimeComplete: true },
      { laneId: "unknown", minutes: 1, observation: { reason: "metadata_unavailable" }, lifetimeComplete: true }
    ] })!;
    expect(cost.estimatedTotalUsd).toBe(0.02361); // 120*.000148 + 180*(.000028+.0000045)
    expect(cost.fullyEstimated).toBe(false);
    expect(cost.breakdown[2]).toMatchObject({ laneId: "unknown", estimatedCostUsd: null, reason: "no_desktop_resources", ratesAsOf: null });
    expect(cost.note).toContain("LOWER BOUND");
  });

  it("keeps the observed span but records unknown remaining lifetime after unconfirmed cleanup", () => {
    const cost = buildCuaCostSummary({ lanes: [], desktops: [{ laneId: "kept", minutes: 1,
      observation: { resources: { cpuCount: 8, memoryMiB: 8192 }, source: "e2b.getInfo" }, lifetimeComplete: false }] })!;
    expect(cost.estimatedTotalUsd).toBe(0.00888);
    expect(cost.fullyEstimated).toBe(false);
    expect(cost.breakdown[1]).toEqual({ kind: "desktop-minutes", laneId: "kept", estimatedCostUsd: null, reason: "desktop_lifetime_incomplete", ratesAsOf: null });
  });

  it.each([undefined, -1, Infinity, NaN])("does not price an unavailable/non-finite duration (%s)", minutes => {
    expect(estimateAllocatedDesktopCost(minutes, { cpuCount: 8, memoryMiB: 8192 })).toMatchObject({ estimatedCostUsd: null, reason: "no_duration" });
  });

  it("does not extrapolate the public sheet to a larger enterprise allocation", () => {
    expect(estimateAllocatedDesktopCost(1, { cpuCount: 16, memoryMiB: 16384 })).toMatchObject({ estimatedCostUsd: null, reason: "no_rate_for_desktop", resources: { cpuCount: 16, memoryMiB: 16384 } });
  });

  it("keeps no-allocation previews absent and a legacy helper assumption labeled", () => {
    expect(buildCuaCostSummary({ lanes: [], desktops: [] })).toBeUndefined();
    const legacy = buildCuaCostSummary({ lanes: [], desktopMinutes: 1 })!;
    expect(legacy.estimatedTotalUsd).toBe(0.00888);
    expect(legacy.placeholder).toBe(true);
    expect(legacy.breakdown[0]!.source).toContain("planning assumption");
  });

  it.each([{}, { cpuCount: 0, memoryMB: 8192 }, { cpuCount: 8, memoryMB: NaN }, { cpuCount: 1.5, memoryMB: 1024 }])("rejects malformed resource quantities (%j)", async info => {
    expect(await observeDesktopResources({ getInfo: async () => info })).toEqual({ reason: "metadata_invalid" });
  });

  it("never throws or persists raw metadata/errors from an unavailable getter", async () => {
    expect(await observeDesktopResources({})).toEqual({ reason: "metadata_unavailable" });
    expect(await observeDesktopResources({ getInfo: async () => { throw new Error("synthetic private connection details"); } })).toEqual({ reason: "metadata_unavailable" });
    expect(await observeDesktopResources({ get getInfo(): never { throw new Error("bad accessor"); } })).toEqual({ reason: "metadata_unavailable" });
  });

  it("bounds a hung getInfo, aborts its request, and observes late rejection", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    let signal: AbortSignal | undefined;
    const pending = observeDesktopResources({ getInfo: async options => {
      signal = options?.signal;
      return new Promise((_resolve, fail) => { reject = fail; });
    } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({ reason: "metadata_timeout" });
    expect(signal?.aborted).toBe(true);
    reject(new Error("late error observed"));
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
