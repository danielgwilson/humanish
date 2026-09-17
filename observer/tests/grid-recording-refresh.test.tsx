// @vitest-environment jsdom
import { Tooltip } from "@base-ui-components/react/tooltip";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import live from "../../tests/golden/observer-data/live.json";
import { StudyGrid } from "../components/study-grid";
import type { ObserverData } from "../lib/observer-data";

const origin = Date.parse("2026-09-01T10:00:00.000Z");
const selected = origin + 5000;
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
  await act(async () => {
    root.render(<Tooltip.Provider><StudyGrid data={data} streams={data.streams} onOpen={() => undefined} updating={false}
      initialReview={{ atMs: selected, reviewing: true, speed: 1, page: 0 }} /></Tooltip.Provider>);
  });
}

const image = () => container.querySelector<HTMLImageElement>(".card .keyframe");
const caption = () => container.querySelector(".card-capture-time")?.getAttribute("title");
const play = () => container.querySelector<HTMLButtonElement>('[aria-label="Play study"]');

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
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
