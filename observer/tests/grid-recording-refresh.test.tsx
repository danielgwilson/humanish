// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import live from "../../tests/golden/observer-data/live.json";
import { App } from "../app";
import type { ObserverData } from "../lib/observer-data";

const feed = vi.hoisted(() => ({ data: null as ObserverData | null }));
vi.mock("../lib/use-observer-feed", async () => {
  const { NO_ANALYSIS } = await import("../lib/study-analysis");
  return { useObserverFeed: () => ({ data: feed.data, analysis: NO_ANALYSIS, history: null,
    connection: { state: "offline" }, retry: () => undefined }) };
});

const origin = Date.parse("2026-09-01T10:00:00.000Z");
let positioned = false;
let container: HTMLDivElement;
let root: Root;

function snapshot(offsets: number[]): ObserverData {
  const data = structuredClone(live) as unknown as ObserverData;
  const stream = data.streams[0]!;
  stream.id = "recorded-participant";
  stream.actor!.items = offsets.map((offset) => ({
    id: `capture-${offset}`, kind: "screenshot", lifecycle: "completed", title: `Capture ${offset}`,
    at: new Date(origin + offset).toISOString(),
    screenshotRef: { path: `screenshots/capture-${offset}.png`, redaction: "none" }
  }));
  data.streams = [stream];
  return data;
}

async function render(data: ObserverData) {
  feed.data = data;
  await act(async () => { root.render(<App data={data} snapshot />); });
  if (!positioned) {
    const scrub = container.querySelector<HTMLInputElement>('[aria-label="Seek study recording"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(scrub, "5000");
      scrub.dispatchEvent(new Event("input", { bubbles: true }));
      scrub.dispatchEvent(new Event("change", { bubbles: true }));
    });
    positioned = true;
  }
}

const image = () => container.querySelector<HTMLImageElement>(".card .keyframe");
const caption = () => container.querySelector(".card-capture-time")?.getAttribute("title");
const play = () => container.querySelector<HTMLButtonElement>('[aria-label="Play study"]');

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  positioned = false;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
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

describe("Paused whole-grid review survives same-run snapshot replacement", () => {
  it("does not advance a paused cursor when refreshed evidence starts later", async () => {
    await render(snapshot([0, 1000, 10_000]));
    expect(image()?.getAttribute("src")).toBe("../screenshots/capture-1000.png");
    await render(snapshot([8000, 10_000]));

    expect(image()).toBeNull();
    expect(caption()).toBe("No capture yet");
    expect(play()?.disabled).toBe(true);
    // A range thumb cannot represent this old absolute moment; disclose that
    // instead of displaying a new capture as though the reviewer had sought it.
    expect(container.querySelector('[aria-label="Seek study recording"]')?.getAttribute("aria-valuetext")).toMatch(/outside.*available/i);
  });

  it("does not rewind a paused cursor when refreshed evidence ends earlier", async () => {
    await render(snapshot([0, 1000, 10_000]));
    await render(snapshot([0, 1000]));

    expect(image()?.getAttribute("src")).toBe("../screenshots/capture-1000.png");
    expect(caption()).toBe("Last capture · 00:04 before cursor");
    expect(container.querySelector(".card-capture-age")?.textContent).toBe("4s ago");
    expect(play()?.disabled).toBe(true);
    expect(container.querySelector('[aria-label="Seek study recording"]')?.getAttribute("aria-valuetext")).toMatch(/outside.*available/i);
  });

  it("keeps the original cursor through temporary missing evidence and recovery", async () => {
    await render(snapshot([0, 1000, 10_000]));
    await render(snapshot([]));
    expect(image()).toBeNull();
    expect(caption()).toBe("No captured screens");
    expect(play()?.disabled).toBe(true);

    await render(snapshot([8000, 10_000]));
    expect(image()).toBeNull();
    expect(caption()).toBe("No capture yet");

    await render(snapshot([0, 1000, 10_000]));
    expect(image()?.getAttribute("src")).toBe("../screenshots/capture-1000.png");
    expect(caption()).toBe("Capture · 00:04 before cursor");
    expect(play()?.disabled).toBe(false);
  });

  it("does not follow appended captures while paused", async () => {
    await render(snapshot([0, 1000, 10_000]));
    await render(snapshot([0, 1000, 10_000, 20_000]));

    expect(image()?.getAttribute("src")).toBe("../screenshots/capture-1000.png");
    expect(caption()).toBe("Capture · 00:04 before cursor");
    expect(container.querySelector('[aria-label="Pause study"]')).toBeNull();
    expect(container.querySelector('[aria-label="Seek study recording"]')?.getAttribute("aria-valuetext")).toBe("00:05 of 00:20, recorded capture time");
  });
});
