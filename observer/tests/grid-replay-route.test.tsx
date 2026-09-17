// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import live from "../../tests/golden/observer-data/live.json";
import { App } from "../app";
import type { ObserverData, ObserverStream } from "../lib/observer-data";
import { formatHash, parseHash } from "../lib/route";

const feed = vi.hoisted(() => ({ data: null as ObserverData | null }));
vi.mock("../lib/use-observer-feed", async () => {
  const { NO_ANALYSIS } = await import("../lib/study-analysis");
  return { useObserverFeed: () => ({
    data: feed.data, analysis: NO_ANALYSIS, history: null,
    connection: { state: "current", lastReceivedAt: 0 }, retry: () => undefined
  }) };
});

let container: HTMLDivElement;
let root: Root;
const origin = Date.parse("2026-09-01T10:00:00.000Z");

function captures(offsets: number[]): NonNullable<ObserverStream["liveActor"]>["items"] {
  return offsets.map((offset) => ({
    id: `capture-${offset}`, kind: "screenshot", lifecycle: "completed", title: `Capture ${offset}`,
    at: new Date(origin + offset).toISOString(),
    screenshotRef: { path: `screenshots/capture-${offset}.png`, redaction: "none" }
  }));
}

function snapshot(offsets: number[] = []): ObserverData {
  const data = structuredClone(live) as unknown as ObserverData;
  const recording = structuredClone(data.streams[0]!);
  recording.id = "recorded";
  recording.actor!.items = captures([0, 20_000]);
  const active = structuredClone(data.streams[0]!);
  active.id = "awaiting-capture";
  active.kind = "browser";
  active.status = "running";
  active.statusLabel = "Running";
  active.embed = { kind: "iframe", title: "Active desktop", url: "https://desktop.example.test/" };
  active.liveActor = { schema: "humanish.live-actor.v1", updatedAt: active.updatedAt, items: captures(offsets) };
  delete active.actor;
  data.streams = [recording, active];
  return data;
}

async function render(data: ObserverData) {
  feed.data = data;
  await act(async () => { root.render(<App data={data} />); });
}

async function click(selector: string) {
  const target = container.querySelector(selector);
  expect(target).not.toBeNull();
  await act(async () => { target!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => undefined;
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  localStorage.clear();
  window.history.replaceState(null, "", window.location.pathname);
});

describe("Explicit replay without an invented frame", () => {
  it("round-trips replay intent while preserving existing live, frame and event addresses", () => {
    expect(formatHash("lane/one", null, "replay")).toBe("#/lane/lane%2Fone/replay");
    expect(parseHash(formatHash("lane/one", null, "replay"))).toEqual({ laneId: "lane/one", frame: null, mode: "replay" });
    expect(formatHash("lane", 0, "replay")).toBe("#/lane/lane/f/1");
    expect(formatHash("lane", 0, "replay", "action")).toBe("#/lane/lane/f/1/e/action");
    expect(formatHash("lane", null, "replay", "action")).toBe("#/lane/lane/e/action");
    expect(parseHash(formatHash("lane", null, "live"))).toEqual({ laneId: "lane", frame: null, mode: "live" });
    expect(parseHash("#/lane/%E0%A4%A/replay")).toEqual({ laneId: null, frame: null });
    expect(parseHash("#/lane/lane/replay/f/1")).toEqual({ laneId: null, frame: null });
  });

  it("opens a frameless active participant from grid replay paused, including after reload", async () => {
    const data = snapshot();
    await render(data);
    const scrub = container.querySelector('[aria-label="Seek study recording"]');
    expect(scrub).not.toBeNull();
    await act(async () => { scrub!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
    expect(container.querySelector('[data-stream-id="awaiting-capture"] .keyframe')).toBeNull();
    await click('[data-stream-id="awaiting-capture"] .open-overlay');

    expect(window.location.hash).toBe("#/lane/awaiting-capture/replay");
    expect(container.querySelector(".player")).not.toBeNull();
    expect(container.querySelector(".evidence-stage iframe")).toBeNull();
    expect(container.querySelector(".evidence-stage img")).toBeNull();
    expect(container.querySelector('[aria-label="Jump to live"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Play"]')?.disabled).toBe(true);

    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render(data);
    expect(window.location.hash).toBe("#/lane/awaiting-capture/replay");
    expect(container.querySelector(".evidence-stage iframe")).toBeNull();
    expect(container.querySelector(".evidence-stage img")).toBeNull();
    expect(container.querySelector('[aria-label="Jump to live"]')).not.toBeNull();
  });

  it("receives its first capture and later evidence without switching to live or advancing", async () => {
    window.history.replaceState(null, "", "#/lane/awaiting-capture/replay");
    await render(snapshot());
    await render(snapshot([1000]));
    expect(container.querySelector(".evidence-stage img")?.getAttribute("src")).toBe("../screenshots/capture-1000.png");
    expect(window.location.hash).toBe("#/lane/awaiting-capture/f/1");

    await render(snapshot([1000, 10_000]));
    expect(container.querySelector(".evidence-stage img")?.getAttribute("src")).toBe("../screenshots/capture-1000.png");
    expect(container.querySelector(".evidence-stage iframe")).toBeNull();
    expect(container.querySelector('[aria-label="Pause"]')).toBeNull();
    expect(container.querySelector('[aria-label="Jump to live"]')).not.toBeNull();

    await click('[aria-label="Jump to live"]');
    expect(container.querySelector(".evidence-stage iframe")?.getAttribute("src")).toBe("https://desktop.example.test/");
    expect(window.location.hash).toBe("#/lane/awaiting-capture/live");
  });
});
