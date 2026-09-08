// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import firstRun from "../../tests/golden/observer-data/first-run.json";
import { Player } from "../components/player";
import { buildPlayerModel, type PlayerModel } from "../lib/player-model";
import type { ObserverData, ObserverStream } from "../lib/observer-data";

const data = firstRun as unknown as ObserverData;
let root: Root;
let container: HTMLDivElement;
let stream: ObserverStream;
let model: PlayerModel;

async function render(props: Omit<ComponentProps<typeof Player>, "data" | "stream" | "model"> = {}) {
  await act(async () => root.render(<Player data={data} stream={stream} model={model} {...props} />));
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}
async function key(value: string, target: EventTarget = window) {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
}
function counter() { return container.querySelector(".counter")?.textContent; }
function appendFrame() {
  model = { ...model, frames: [...model.frames, { index: model.frames.length, itemId: `frame-${model.frames.length}`, title: "Later capture", href: `../screenshots/later-${model.frames.length}.png`, atMs: 30_000 }] };
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  stream = { ...data.streams[0]!, id: "participant", label: "Synthetic participant", status: "running", embed: { kind: "iframe", url: "https://live.example/desktop" } } as ObserverStream;
  model = { paced: "recorded", avgFrameMs: 1000, rows: [], frames: Array.from({ length: 3 }, (_, index) => ({ index, itemId: `frame-${index}`, href: `../screenshots/frame-${index}.png`, title: `Capture ${index}`, atMs: 10_000 + index * 7000 })) };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); window.history.replaceState(null, "", "/"); vi.restoreAllMocks(); });

describe("player review controls", () => {
  it("all seeks leave live; pausing the newest capture stays paused when frames arrive", async () => {
    await render();
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(window.location.hash).toBe("#/lane/participant/live");
    await key("ArrowLeft");
    expect(container.querySelector("iframe")).toBeNull();
    expect(counter()).toBe("2 / 3");
    await click("Next frame");
    appendFrame(); await render();
    expect(counter()).toBe("3 / 4");
    await click("Jump to live");
    expect(counter()).toBe("4 / 4");
    appendFrame(); await render();
    expect(counter()).toBe("5 / 5");
  });
  it("honors same-participant route props and a repeated hash address after local scrubbing", async () => {
    await render({ initialFrame: 0 });
    await render({ initialFrame: 2 });
    expect(counter()).toBe("3 / 3");
    await click("Previous frame");
    expect(counter()).toBe("2 / 3");
    await act(async () => { window.history.replaceState(null, "", "#/lane/participant/f/3"); window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(counter()).toBe("3 / 3");
    await render({ initialFrame: null, initialMode: "live" });
    expect(container.querySelector("iframe")).not.toBeNull();
  });
  it("does not restart recorded playback timing on every unchanged data poll", async () => {
    vi.useFakeTimers();
    try {
      await render({ initialFrame: 0 });
      await click("Play");
      await act(async () => { vi.advanceTimersByTime(5000); });
      model = structuredClone(model);
      await render({ initialFrame: 0 });
      await act(async () => { vi.advanceTimersByTime(2100); });
      expect(counter()).toBe("2 / 3");
    } finally { vi.useRealTimers(); }
  });
  it("reports actual selection during playback and does not repeat unchanged snapshot updates", async () => {
    const onViewChange = vi.fn();
    vi.useFakeTimers();
    try {
      await render({ initialFrame: 0, onViewChange });
      expect(onViewChange).toHaveBeenLastCalledWith({ frame: 0, mode: "replay", playing: false });
      await click("Play");
      expect(onViewChange).toHaveBeenLastCalledWith({ frame: 0, mode: "replay", playing: true });
      await act(async () => { vi.advanceTimersByTime(7100); });
      expect(onViewChange).toHaveBeenLastCalledWith({ frame: 1, mode: "replay", playing: true });
      expect(window.location.hash).toBe("#/lane/participant/f/1");
      const calls = onViewChange.mock.calls.length;
      model = structuredClone(model);
      await render({ initialFrame: 0, onViewChange });
      expect(onViewChange).toHaveBeenCalledTimes(calls);
      await click("Pause");
      expect(onViewChange).toHaveBeenLastCalledWith({ frame: 1, mode: "replay", playing: false });
    } finally { vi.useRealTimers(); }
  });
  it("reports a missing addressed frame as null", async () => {
    const onViewChange = vi.fn();
    await render({ initialFrame: 100, onViewChange });
    expect(onViewChange).toHaveBeenLastCalledWith({ frame: null, mode: "replay", playing: false });
  });
  it("keeps offline running snapshots historical and freezes a source that becomes static", async () => {
    const onViewChange = vi.fn();
    await render({ updating: true, onViewChange });
    expect(onViewChange).toHaveBeenLastCalledWith({ frame: 2, mode: "live", playing: false });
    await render({ updating: false, onViewChange });
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".player-mode strong")?.textContent).toBe("Offline recording");
    expect(container.textContent).toContain("participant status at capture");
    expect(container.querySelector('[aria-label="Jump to live"]')).toBeNull();
    expect(onViewChange).toHaveBeenLastCalledWith({ frame: 2, mode: "replay", playing: false });
    appendFrame(); await render({ updating: false, onViewChange });
    expect(counter()).toBe("3 / 4");
  });
  it("does not attach a desktop through an explicit live address on an offline snapshot", async () => {
    await render({ updating: false, initialMode: "live" });
    expect(container.querySelector("iframe")).toBeNull();
    expect(counter()).toBe("3 / 3");
    expect(window.location.hash).toBe("#/lane/participant/f/3");
  });
  it("does not steal native control or editable keyboard actions", async () => {
    await render({ initialFrame: 1 });
    await key("ArrowLeft", container.querySelector('input[type="range"]')!);
    await key(" ", container.querySelector('button[aria-label="Play"]')!);
    const editor = document.createElement("div"); editor.contentEditable = "true"; editor.setAttribute("contenteditable", "true"); container.appendChild(editor);
    await key("ArrowLeft", editor);
    expect(counter()).toBe("2 / 3");
  });
  it("handles missing images, clipboard refusal, and fullscreen refusal without hiding evidence", async () => {
    await render({ initialFrame: 0 });
    await act(async () => container.querySelector(".stage-box img")!.dispatchEvent(new Event("error")));
    expect(container.textContent).toContain("This recorded image could not be loaded");
    await click("Retry image");
    expect(container.querySelector(".stage-box")?.getAttribute("data-image-state")).toBe("loading");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    await click("Copy moment link");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Moment link"]')?.value).toContain("#/lane/participant/f/1");
    await click("Fullscreen");
    expect(container.textContent).toContain("Fullscreen is unavailable");
    expect(counter()).toBe("1 / 3");
  });
  it("reloads only the desktop iframe and retains the recorded selection", async () => {
    await render();
    const before = container.querySelector("iframe");
    const address = window.location.hash;
    await click("Reload stream");
    const after = container.querySelector("iframe");
    expect(after).not.toBe(before);
    expect(after?.getAttribute("src")).toBe(before?.getAttribute("src"));
    expect(after?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(counter()).toBe("3 / 3");
    expect(window.location.hash).toBe(address);
    expect(container.textContent).toContain("does not restart the participant");
  });
  it("does not grant clipboard access or keyboard focus to read-only desktop iframes", async () => {
    await render();
    const iframe = container.querySelector("iframe");
    expect(iframe?.tabIndex).toBe(-1);
    expect(iframe?.getAttribute("allow")).toBeNull();
    expect(container.textContent).toContain("connection health is managed by the provider");
  });
  it("keeps a preparing participant distinct from a finished recording", async () => {
    stream = { ...stream, status: "preparing", embed: { kind: "placeholder" } };
    model = { ...model, frames: [] };
    await render();
    expect(container.textContent).toContain("Preparing · Latest capture");
    expect(container.textContent).toContain("participant is preparing");
    expect(container.textContent).not.toContain("Finished");
  });
  it("names unavailable addresses and ended screenshot-free streams honestly", async () => {
    await render({ initialFrame: 100 });
    expect(container.textContent).toContain("addressed frame is unavailable");
    expect(container.querySelector(".stage-box img")).toBeNull();
    stream = { ...stream, status: "passed", liveEnded: true };
    model = { ...model, frames: [] };
    await render({ initialMode: "live" });
    expect(container.querySelector("iframe")).toBeNull();
    expect(counter()).toBe("0 / 0");
    expect(container.textContent).toContain("ended without a recorded screenshot");
    expect(container.textContent).toContain("Finished · Recording");
  });
  it("bounds long feeds and filmstrips while retaining navigation to all original entries", async () => {
    stream = { ...stream, status: "passed" };
    model = { ...model, frames: Array.from({ length: 1000 }, (_, index) => ({ index, itemId: `frame-${index}`, href: `../screenshots/${index}.png`, title: `Frame ${index}`, atMs: index * 1000 })), rows: Array.from({ length: 3000 }, (_, index) => ({ id: `action-${index}`, title: `Action ${index}`, kind: "ui_action", isFrame: false, frameIndex: Math.floor(index / 3) })) };
    await render({ initialFrame: 500 });
    expect(container.querySelectorAll(".filmstrip .fs")).toHaveLength(40);
    expect(container.querySelectorAll(".arow")).toHaveLength(100);
    expect(container.textContent).toContain("Earlier entries");
    expect(container.textContent).toContain("Later entries");
    await click("Later entries");
    expect(container.querySelectorAll(".arow")).toHaveLength(100);
    expect(counter()).toBe("501 / 1000");
  });
  it("maps desktop click coordinates using the verified screen, not the CSS viewport", async () => {
    stream = { ...stream, viewport: { width: 414, height: 740 }, desktopGeometry: { screen: { requested: { width: 500, height: 896 }, verified: { width: 500, height: 896, source: "xdpyinfo" } } } };
    model = { ...model, rows: [{ id: "click-center", title: "click (250, 448)", kind: "ui_action", isFrame: false, frameIndex: 0, coord: { x: 250, y: 448 } }] };
    await render({ initialFrame: 0 });
    const pin = container.querySelector<HTMLElement>(".pins .spin");
    expect(pin?.style.left).toBe("50%");
    expect(pin?.style.top).toBe("50%");
  });
  it("places edge click labels toward the available image area", async () => {
    stream = { ...stream, viewport: { width: 390, height: 844 } };
    model = { ...model, rows: [{ id: "click-edge", title: "click (380, 820)", kind: "ui_action", isFrame: false, frameIndex: 0, coord: { x: 380, y: 820 } }] };
    await render({ initialFrame: 0 });
    const pin = container.querySelector<HTMLElement>(".pins .spin");
    expect(pin?.dataset.tipSide).toBe("left");
    expect(pin?.dataset.tipVertical).toBe("above");
    expect(pin?.textContent).toContain("click (380, 820)");
  });
  it("projects legacy unstamped evidence without requiring new schema fields", () => {
    const legacy = { ...stream, actor: { items: [{ id: "a", kind: "screenshot", lifecycle: "completed", title: "Capture", screenshotRef: { path: "screenshots/old.png", redaction: "none" } }], durationMs: 5000 } } as ObserverStream;
    expect(buildPlayerModel(legacy)?.paced).toBe("avg");
  });
});
