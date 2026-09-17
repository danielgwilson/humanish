// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import live from "../../tests/golden/observer-data/live.json";
import { App } from "../app";
import type { ObserverData, ObserverStream } from "../lib/observer-data";

const feed = vi.hoisted(() => ({ data: null as ObserverData | null, updating: false }));
vi.mock("../lib/use-observer-feed", async () => {
  const { NO_ANALYSIS } = await import("../lib/study-analysis");
  return { useObserverFeed: () => ({ data: feed.data, analysis: NO_ANALYSIS, history: null,
    connection: { state: feed.updating ? "current" : "offline", lastReceivedAt: 0 }, retry: () => undefined }) };
});

const origin = Date.parse("2026-09-01T10:00:00.000Z");
let container: HTMLDivElement;
let root: Root;

function lane(id: string, offsets: (number | null)[]): ObserverStream {
  const stream = structuredClone((live as unknown as ObserverData).streams[0]!);
  stream.id = id;
  stream.actor!.items = offsets.map((offset, index) => ({
    id: `${id}-${index}`, kind: "screenshot", lifecycle: "completed", title: `Capture ${index}`,
    ...(offset === null ? {} : { at: new Date(origin + offset).toISOString() }),
    screenshotRef: { path: `screenshots/${id}-${index}.png`, redaction: "none" }
  }));
  return stream;
}

function study(streams = [lane("early", [0, 3000, 9000]), lane("late", [1000, 6000])]): ObserverData {
  const data = structuredClone(live) as unknown as ObserverData;
  data.streams = streams;
  return data;
}
async function render(data = study()) {
  feed.data = data;
  await act(async () => root.render(<App data={data} snapshot />));
}
async function click(selector: string) {
  const element = container.querySelector<HTMLElement>(selector);
  expect(element).not.toBeNull();
  await act(async () => element!.click());
}
const scrub = () => container.querySelector<HTMLInputElement>('[aria-label="Seek study recording"]')!;
async function seek(value: number) {
  const input = scrub(); expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const playerImage = () => container.querySelector<HTMLImageElement>(".evidence-stage img")?.getAttribute("src");

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => undefined;
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
beforeEach(() => {
  feed.updating = false;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.useRealTimers();
  window.history.replaceState(null, "", window.location.pathname);
});

describe("One study playback clock across views", () => {
  it("opens halfway without snapping to the held capture, then returns every lane at one-third", async () => {
    await render();
    await seek(4500);
    expect(scrub().value).toBe("4500");
    await click('[data-stream-id="early"] .open-overlay');
    expect(scrub().value).toBe("4500");
    expect(playerImage()).toBe("../screenshots/early-1.png");
    expect(container.querySelectorAll('[aria-label="Study playback"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="Seek recording time"]')).toBeNull();
    await seek(3000);
    await click('[aria-label="Back to participants"]');
    expect(scrub().value).toBe("3000");
    expect(container.querySelector('[data-stream-id="early"] .keyframe')?.getAttribute("src")).toBe("../screenshots/early-1.png");
    expect(container.querySelector('[data-stream-id="late"] .keyframe')?.getAttribute("src")).toBe("../screenshots/late-0.png");
    expect(container.querySelector('[aria-label="Pause study"]')).toBeNull();
  });

  it("keeps playing through participant paging and return without restarting the clock", async () => {
    vi.useFakeTimers();
    await render(); await seek(4500);
    await click('[aria-label="Play study"]');
    await click('[data-stream-id="early"] .open-overlay');
    expect(container.querySelector('[aria-label="Pause study"]')).not.toBeNull();
    await click('[aria-label="Next participant"]');
    expect(scrub().value).toBe("4500");
    expect(playerImage()).toBe("../screenshots/late-0.png");
    await click('[aria-label="Back to participants"]');
    await act(async () => vi.advanceTimersByTime(1000));
    expect(scrub().value).toBe("5500");
    expect(container.querySelector('[aria-label="Pause study"]')).not.toBeNull();
  });

  it("treats internal history as view navigation and external frame/event links as exact seeks", async () => {
    const early = lane("early", [0, 3000, 3000, 9000]);
    early.actor!.items.splice(2, 0, { id: "action", kind: "ui_action", lifecycle: "completed", title: "click (25, 30)", at: new Date(origin + 3500).toISOString() });
    await render(study([early, lane("late", [1000, 6000])]));
    await seek(4500); await click('[data-stream-id="early"] .open-overlay');
    const internalState: unknown = window.history.state;
    await seek(5000);
    await act(async () => {
      window.history.replaceState(internalState, "", "#/lane/late/f/1");
      window.dispatchEvent(new PopStateEvent("popstate", { state: internalState }));
    });
    expect(scrub().value).toBe("5000");
    expect(playerImage()).toBe("../screenshots/late-0.png");
    await act(async () => {
      window.history.replaceState(null, "", "#/lane/early/f/2/e/action");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(scrub().value).toBe("3000");
    expect(playerImage()).toBe("../screenshots/early-1.png");
    expect(container.querySelector('[aria-label="Selected evidence"]')?.textContent).toContain("click (25, 30)");
    expect(window.location.hash).toBe("#/lane/early/f/2/e/action");
  });

  it("shows no future capture before a lane starts and leaves untimed playback independent", async () => {
    await render(study([lane("early", [0, 9000]), lane("late", [6000, 9000]), lane("old", [null, null])]));
    await seek(3000);
    await click('[data-stream-id="late"] .open-overlay');
    expect(playerImage()).toBeUndefined();
    expect(scrub().value).toBe("3000");
    expect(window.location.hash).toBe("#/lane/late/replay");
    await click('[aria-label="Back to participants"]');
    await click('[data-stream-id="old"] .open-overlay');
    expect(container.querySelector('[aria-label="Study playback"]')).toBeNull();
    expect(container.querySelector('[aria-label="Seek recording time"]')).not.toBeNull();
    await click('[aria-label="Back to participants"]');
    expect(scrub().value).toBe("3000");
  });

  it("enters live only through latest intent and freezes a source that becomes static", async () => {
    const active = lane("active", [0, 9000]);
    active.status = "running"; active.statusLabel = "Running";
    active.embed = { kind: "iframe", title: "Active desktop", url: "https://desktop.example.test/" };
    feed.updating = true;
    await render(study([active]));
    await click('[data-stream-id="active"] .open-overlay');
    expect(container.querySelector(".evidence-stage iframe")).not.toBeNull();
    await seek(3000);
    expect(container.querySelector(".evidence-stage iframe")).toBeNull();
    expect(playerImage()).toBe("../screenshots/active-0.png");
    await click('[aria-label="Jump to live"]');
    expect(container.querySelector(".evidence-stage iframe")).not.toBeNull();
    feed.updating = false;
    await render(study([active]));
    expect(container.querySelector(".evidence-stage iframe")).toBeNull();
    expect(playerImage()).toBe("../screenshots/active-1.png");
    const appended = lane("active", [0, 9000, 12_000]);
    appended.status = "running";
    await render(study([appended]));
    expect(playerImage()).toBe("../screenshots/active-1.png");
    expect(scrub().value).toBe("9000");
  });

  it("keeps an untimed exact frame local through timestamp recovery until deliberate navigation", async () => {
    window.history.replaceState(null, "", "#/lane/old/f/2");
    await render(study([lane("old", [null, null, null]), lane("other", [0, 12_000])]));
    expect(playerImage()).toBe("../screenshots/old-1.png");
    expect(container.querySelector('[aria-label="Study playback"]')).toBeNull();

    await render(study([lane("old", [0, 3000, 9000]), lane("other", [0, 12_000])]));
    expect(playerImage()).toBe("../screenshots/old-1.png");
    expect(window.location.hash).toBe("#/lane/old/f/2");
    expect(container.querySelector('[aria-label="Study playback"]')).toBeNull();

    await act(async () => {
      window.history.replaceState(null, "", "#/lane/old/f/2");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(scrub().value).toBe("3000");
    expect(playerImage()).toBe("../screenshots/old-1.png");
  });

  it("keeps a shared clock when refreshed participant timing disappears rather than revealing stale local state", async () => {
    await render(study([lane("early", [0, 3000, 9000]), lane("other", [0, 12_000])]));
    await seek(4500);
    await click('[data-stream-id="early"] .open-overlay');
    expect(playerImage()).toBe("../screenshots/early-1.png");

    await render(study([lane("early", [null, null, null]), lane("other", [0, 12_000])]));
    expect(playerImage()).toBeUndefined();
    expect(container.querySelector(".evidence-empty")?.textContent).toContain("Capture timing is unavailable");
    expect(scrub().value).toBe("4500");
    expect(container.querySelector('[aria-label="Seek recording time"]')).toBeNull();

    await render(study([lane("early", [0, 3000, 9000]), lane("other", [0, 12_000])]));
    expect(playerImage()).toBe("../screenshots/early-1.png");
    expect(scrub().value).toBe("4500");
  });

  it("retains an explicitly addressed frame if its timestamp disappears without inventing capture age", async () => {
    window.history.replaceState(null, "", "#/lane/early/f/2");
    await render(study([lane("early", [0, 3000, 9000]), lane("other", [0, 12_000])]));
    expect(playerImage()).toBe("../screenshots/early-1.png");
    await render(study([lane("early", [null, null, null]), lane("other", [0, 12_000])]));
    expect(playerImage()).toBe("../screenshots/early-1.png");
    expect(scrub().value).toBe("3000");
    expect(window.location.hash).toBe("#/lane/early/f/2");
    expect(container.querySelector(".player-evidence-note")?.textContent).toContain("Capture time unavailable");
    expect(container.querySelector(".player-evidence-note")?.textContent).not.toContain("before study cursor");
  });

  it("does not replace an unavailable incoming frame address with the initial latest projection", async () => {
    window.history.replaceState(null, "", "#/lane/early/f/999");
    await render();
    expect(playerImage()).toBeUndefined();
    expect(container.querySelector(".evidence-empty")?.textContent).toContain("addressed frame is unavailable");
    expect(window.location.hash).toBe("#/lane/early/f/999");
  });

  it("does not follow an active desktop while resolving an unavailable replay address", async () => {
    const active = lane("active", [0, 9000]);
    active.status = "running"; active.statusLabel = "Running";
    active.embed = { kind: "iframe", title: "Active desktop", url: "https://desktop.example.test/" };
    feed.updating = true;
    window.history.replaceState(null, "", "#/lane/active/f/999");
    await render(study([active]));
    expect(playerImage()).toBeUndefined();
    expect(container.querySelector(".evidence-stage iframe")).toBeNull();
    expect(container.querySelector(".evidence-empty")?.textContent).toContain("addressed frame is unavailable");
    expect(window.location.hash).toBe("#/lane/active/f/999");
  });

  it("applies an addressed frame when a queued lane receives its first recording", async () => {
    window.history.replaceState(null, "", "#/lane/queued/f/2");
    const queued = lane("queued", []);
    queued.kind = "browser";
    queued.status = "queued";
    delete queued.embed;
    await render(study([queued, lane("other", [0, 12_000])]));
    expect(playerImage()).toBeUndefined();
    await render(study([lane("queued", [0, 3000, 9000]), lane("other", [0, 12_000])]));
    expect(playerImage()).toBe("../screenshots/queued-1.png");
    expect(scrub().value).toBe("3000");
    expect(window.location.hash).toBe("#/lane/queued/f/2");
  });
});
