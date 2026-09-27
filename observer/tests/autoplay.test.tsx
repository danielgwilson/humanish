// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import live from "../../tests/golden/observer-data/live.json";
import { App } from "../app";
import { parseAutoplay, sidebarClosedByUrl } from "../lib/autoplay";
import type { ObserverData, ObserverStream } from "../lib/observer-data";

const feed = vi.hoisted(() => ({ data: null as ObserverData | null }));
vi.mock("../lib/use-observer-feed", async () => {
  const { NO_ANALYSIS } = await import("../lib/study-analysis");
  return { useObserverFeed: () => ({ data: feed.data, analysis: NO_ANALYSIS, history: null,
    connection: { state: "offline", lastReceivedAt: 0 }, retry: () => undefined }) };
});

const origin = Date.parse("2026-09-01T10:00:00.000Z");
let container: HTMLDivElement;
let root: Root;

function lane(id: string, offsets: number[]): ObserverStream {
  const stream = structuredClone((live as unknown as ObserverData).streams[0]!);
  stream.id = id;
  stream.actor!.items = offsets.map((offset, index) => ({
    id: `${id}-${index}`, kind: "screenshot", lifecycle: "completed", title: `Capture ${index}`,
    at: new Date(origin + offset).toISOString(),
    screenshotRef: { path: `screenshots/${id}-${index}.png`, redaction: "none" }
  }));
  return stream;
}
function study(): ObserverData {
  const data = structuredClone(live) as unknown as ObserverData;
  data.streams = [lane("early", [0, 3000, 9000]), lane("late", [1000, 6000])];
  return data;
}
async function render(search: string) {
  window.history.replaceState(null, "", `${window.location.pathname}${search}`);
  feed.data = study();
  await act(async () => root.render(<App data={feed.data} snapshot />));
}
const pauseButton = () => container.querySelector('[aria-label="Pause study"]');
const playButton = () => container.querySelector('[aria-label="Play study"]');

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => undefined;
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.useRealTimers();
  window.history.replaceState(null, "", window.location.pathname);
});

describe("parseAutoplay", () => {
  it("is off without the parameter and defaults to 8x with it", () => {
    expect(parseAutoplay("")).toBeNull();
    expect(parseAutoplay("?loop=1")).toBeNull();
    expect(parseAutoplay("?autoplay")).toEqual({ speed: 8, loop: false, sidebarClosed: false });
    expect(parseAutoplay("?autoplay=on&loop=1&sidebar=closed")).toEqual({ speed: 8, loop: true, sidebarClosed: true });
  });
  it("reads the sidebar switch with or without autoplay", () => {
    expect(sidebarClosedByUrl("?sidebar=closed")).toBe(true);
    expect(sidebarClosedByUrl("?autoplay=8&sidebar=closed")).toBe(true);
    expect(sidebarClosedByUrl("?sidebar=open")).toBe(false);
    expect(sidebarClosedByUrl("")).toBe(false);
  });
  it("clamps the speed to 1..64 and ignores a zero", () => {
    expect(parseAutoplay("?autoplay=4")?.speed).toBe(4);
    expect(parseAutoplay("?autoplay=0.5")?.speed).toBe(1);
    expect(parseAutoplay("?autoplay=500")?.speed).toBe(64);
    expect(parseAutoplay("?autoplay=0")?.speed).toBe(8);
    expect(parseAutoplay("?autoplay=8&loop=0")?.loop).toBe(false);
  });
});

describe("Autoplay from the URL", () => {
  it("does not play by itself without the parameter", async () => {
    await render("");
    expect(playButton()).not.toBeNull(); expect(pauseButton()).toBeNull();
  });

  it("starts the study transport at the requested speed and stops at the end", async () => {
    vi.useFakeTimers();
    await render("?autoplay=4");
    expect(pauseButton()).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(1000));
    const scrub = container.querySelector<HTMLInputElement>('[aria-label="Seek study recording"]')!;
    expect(Number(scrub.value)).toBeGreaterThanOrEqual(3900);
    await act(async () => vi.advanceTimersByTime(2000));
    expect(pauseButton()).toBeNull(); expect(playButton()).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(5000));
    expect(pauseButton()).toBeNull();
  });

  it("restarts two seconds after the end when loop is set, and stays paused after the visitor pauses", async () => {
    vi.useFakeTimers();
    await render("?autoplay=8&loop=1");
    await act(async () => vi.advanceTimersByTime(1500));
    expect(pauseButton()).toBeNull();
    await act(async () => vi.advanceTimersByTime(2100));
    expect(pauseButton()).not.toBeNull();
    await act(async () => pauseButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(playButton()).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(5000));
    expect(pauseButton()).toBeNull();
  });
});
