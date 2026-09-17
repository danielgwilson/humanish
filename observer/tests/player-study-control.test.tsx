// @vitest-environment jsdom
import { Tooltip } from "@base-ui-components/react/tooltip";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import live from "../../tests/golden/observer-data/live.json";
import { Player } from "../components/player";
import type { ObserverData } from "../lib/observer-data";
import { buildPlayerModel } from "../lib/player-model";
import type { StudyPlayerControl } from "../lib/use-study-playback";

const data = structuredClone(live) as unknown as ObserverData;
const stream = data.streams[0]!;
stream.status = "complete";
stream.viewport = { width: 800, height: 600 };
stream.actor!.items = [
  { id: "capture-a", kind: "screenshot", lifecycle: "completed", title: "First capture", at: "2026-09-01T10:00:00.000Z", screenshotRef: { path: "screenshots/a.png", redaction: "none" } },
  { id: "past", kind: "ui_action", lifecycle: "completed", title: "Recorded past click", at: "2026-09-01T10:00:00.100Z", coord: { x: 10, y: 10 } },
  { id: "future", kind: "ui_action", lifecycle: "completed", title: "Recorded future click", at: "2026-09-01T10:00:00.900Z", coord: { x: 20, y: 20 } },
  { id: "capture-b", kind: "screenshot", lifecycle: "completed", title: "First duplicate", at: "2026-09-01T10:00:01.000Z", screenshotRef: { path: "screenshots/b.png", redaction: "none" } },
  { id: "capture-c", kind: "screenshot", lifecycle: "completed", title: "Second duplicate", at: "2026-09-01T10:00:01.000Z", screenshotRef: { path: "screenshots/c.png", redaction: "none" } },
  { id: "capture-d", kind: "screenshot", lifecycle: "completed", title: "Last capture", at: "2026-09-01T10:00:05.000Z", screenshotRef: { path: "screenshots/d.png", redaction: "none" } }
];
const model = buildPlayerModel(stream)!;
let container: HTMLDivElement;
let root: Root;

function control(index = 1, overrides: Partial<StudyPlayerControl> = {}): StudyPlayerControl {
  return {
    moment: { kind: "capture", frame: model.frames[index]!, ageMs: 0, coverage: "within" },
    reviewing: true, playing: false, eventId: null,
    onSeekFrame: vi.fn(), onToggle: vi.fn(), onLive: vi.fn(), ...overrides
  };
}

async function render(studyPlayback: StudyPlayerControl, extra: Partial<Parameters<typeof Player>[0]> = {}) {
  await act(async () => {
    root.render(<Tooltip.Provider><div className="main"><Player data={data} stream={stream} model={model} studyPlayback={studyPlayback} {...extra} />
      <div data-study-dock="" /></div></Tooltip.Provider>);
  });
}

async function click(selector: string) {
  const element = container.querySelector(selector);
  expect(element).not.toBeNull();
  await act(async () => { element!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

const frameSource = () => container.querySelector(".evidence-stage img")?.getAttribute("src");

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => undefined;
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
  vi.useRealTimers();
});

describe("Player projects the shared study clock", () => {
  it("keeps exact duplicate-frame identity and delegates playback instead of rendering a second transport", async () => {
    const onViewChange = vi.fn();
    const playback = control(1, { playing: true });
    await render(playback, { initialFrame: 3, initialEventId: "future", onViewChange });
    expect(frameSource()).toBe("../screenshots/b.png");
    expect(container.querySelector(".transport")).toBeNull();
    expect(container.querySelector('[aria-label="Seek recording time"]')).toBeNull();
    expect(container.querySelector('[aria-label="Playback speed"]')).toBeNull();
    expect(container.textContent).not.toContain("Skip waits");
    expect(onViewChange).toHaveBeenLastCalledWith({ frame: 1, mode: "replay", playing: true });

    await click('[aria-label="Next frame"]');
    expect(playback.onSeekFrame).toHaveBeenLastCalledWith(2);
    expect(frameSource()).toBe("../screenshots/b.png");
    await click('[aria-label^="Frame 4,"]');
    expect(playback.onSeekFrame).toHaveBeenLastCalledWith(3);
    await click('[data-entry-id="future"]');
    expect(playback.onSeekFrame).toHaveBeenLastCalledWith(0, "future");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })); });
    expect(playback.onToggle).toHaveBeenCalledOnce();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect(playback.onSeekFrame).toHaveBeenLastCalledWith(0);
  });

  it("does not advance independently or consume controller-owned route ingress", async () => {
    vi.useFakeTimers();
    const onViewChange = vi.fn();
    const playback = control(0, { playing: true });
    await render(playback, { onViewChange });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(frameSource()).toBe("../screenshots/a.png");
    expect(onViewChange).toHaveBeenLastCalledWith({ frame: 0, mode: "replay", playing: true });
    window.history.replaceState(null, "", `#/lane/${stream.id}/f/4`);
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(frameSource()).toBe("../screenshots/a.png");
    expect(playback.onSeekFrame).not.toHaveBeenCalled();
    expect(playback.onToggle).not.toHaveBeenCalled();
  });

  it("renders before-first and missing frames honestly without stopping the shared clock", async () => {
    const onViewChange = vi.fn();
    await render(control(0, { moment: { kind: "before-first" }, playing: true }), { onViewChange });
    expect(frameSource()).toBeUndefined();
    expect(container.querySelector(".evidence-empty")?.textContent).toContain("No capture had been recorded");
    expect(window.location.hash).toBe(`#/lane/${stream.id}/replay`);
    expect(onViewChange).toHaveBeenLastCalledWith({ frame: null, mode: "replay", playing: true });

    const missingHash = `#/lane/${stream.id}/f/99`;
    window.history.replaceState(null, "", missingHash);
    await render(control(0, { moment: { kind: "no-captures" }, unavailableFrame: true }), { onViewChange });
    expect(frameSource()).toBeUndefined();
    expect(container.querySelector(".evidence-empty")?.textContent).toContain("addressed frame is unavailable");
    expect(window.location.hash).toBe(missingHash);
    expect(onViewChange).toHaveBeenLastCalledWith({ frame: null, mode: "replay", playing: false });
  });

  it("labels held-frame age and excludes future action pins until explicitly selected", async () => {
    const playback = control(0, { moment: { kind: "capture", frame: model.frames[0]!, ageMs: 500, coverage: "within" } });
    await render(playback);
    expect(container.querySelector(".pins")?.textContent).toContain("Recorded past click");
    expect(container.querySelector(".pins")?.textContent).not.toContain("Recorded future click");
    await render(control(3, { moment: { kind: "capture", frame: model.frames[3]!, ageMs: 4000, coverage: "after-last" } }));
    expect(container.querySelector(".player-evidence-note")?.textContent).toContain("Last capture · 00:04 before study cursor");

    const onViewChange = vi.fn();
    await render({ ...playback, eventId: "future" }, { onViewChange });
    expect(container.querySelector(".pins")?.textContent).toContain("Recorded future click");
    expect(onViewChange).toHaveBeenLastCalledWith({ frame: 0, mode: "replay", playing: false, eventId: "future" });
    expect(window.location.hash).toBe(`#/lane/${stream.id}/f/1/e/future`);
    await render(playback, { onViewChange });
    expect(container.querySelector('[aria-label="Selected evidence"]')).toBeNull();
    expect(onViewChange).toHaveBeenLastCalledWith({ frame: 0, mode: "replay", playing: false });
  });

  it("only follows live by controller intent and never turns an offline snapshot live", async () => {
    const active = { ...stream, status: "running" as const, embed: { kind: "iframe" as const, title: "Desktop", url: "https://desktop.example.test/" } };
    const playback = control(0);
    await render(playback, { stream: active });
    await click('[aria-label="Jump to live"]');
    expect(playback.onLive).toHaveBeenCalledOnce();
    expect(container.querySelector(".evidence-stage iframe")).toBeNull();
    await render({ ...playback, reviewing: false }, { stream: active });
    expect(container.querySelector(".evidence-stage iframe")).not.toBeNull();
    await render({ ...playback, reviewing: false }, { stream: active, updating: false });
    expect(container.querySelector(".evidence-stage iframe")).toBeNull();
    expect(frameSource()).toBe("../screenshots/a.png");
  });

  it("requests fullscreen on the shared shell that contains the global dock", async () => {
    await render(control());
    const main = container.querySelector<HTMLElement>(".main")!;
    const request = vi.fn().mockResolvedValue(undefined);
    main.requestFullscreen = request;
    await click('[aria-label="Fullscreen"]');
    expect(request).toHaveBeenCalledOnce();
    expect(main.querySelector("[data-study-dock]")).not.toBeNull();
  });
});
