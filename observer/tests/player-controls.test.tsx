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
async function filterActivity(value: string) {
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Filter activity"]')!;
  await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
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
  it("shows only this participant's recorded assignment and keeps older absence explicit", async () => {
    stream = { ...stream, assignment: { mission: "Add two tasks <script>not markup</script>", focus: "Use only the keyboard", tasks: [{ id: "rename", goal: "Rename the first task" }] } };
    await render({ initialFrame: 0 });
    const assignment = container.querySelector(".participant-assignment")!;
    expect(assignment.textContent).toContain("Use only the keyboard");
    expect(assignment.textContent).toContain("Rename the first task");
    expect(assignment.querySelector("script")).toBeNull();
    await act(async () => assignment.querySelector("summary")!.click());
    expect(assignment.hasAttribute("open")).toBe(true);
    await click("Hide inspector");
    expect(container.querySelector(".participant-assignment")?.hasAttribute("open")).toBe(true);
    delete stream.assignment;
    await render({ initialFrame: 0 });
    expect(container.querySelector(".participant-assignment")).toBeNull();
    expect(container.querySelector(".assignment-missing")?.textContent).toBe("Assigned task not recorded for this participant.");
    expect(container.querySelector(".assignment-missing")?.textContent).not.toContain(data.run.scenario.goal);
  });
  function intervalEntries() {
    // The two-click shape was captured in a retained drawDB run: two distinct
    // actions share one preceding screenshot and require distinct selections.
    model = { ...model, rows: [
      { id: "capture", kind: "screenshot", title: "Capture", frameIndex: 0, isFrame: true, atMs: 10_000 },
      { id: "ui_action-016", kind: "ui_action", title: "click (720, 348)", frameIndex: 0, isFrame: false, atMs: 15_000, coord: { x: 720, y: 348 } },
      { id: "ui_action-017", kind: "ui_action", title: "click (999, 686)", frameIndex: 0, isFrame: false, atMs: 15_500, coord: { x: 999, y: 686 } },
      { id: "thought", kind: "reasoning", title: "Reported plan", text: "I will open the menu.", frameIndex: 1, isFrame: false, atMs: 20_000 }
    ] };
    stream = { ...stream, viewport: { width: 1280, height: 800 } };
  }
  async function entry(id: string) {
    const row = container.querySelector<HTMLElement>(`[data-entry-id="${id}"]`)!;
    await act(async () => row.click());
  }
  it("distinguishes two actions after one capture and retains the chosen action across polls", async () => {
    intervalEntries();
    await render({ initialFrame: 0 });
    expect(container.querySelectorAll(".pins .spin")).toHaveLength(2);
    await entry("ui_action-016");
    expect(counter()).toBe("1 / 3");
    expect(container.querySelector('[aria-label="Selected evidence"]')?.textContent).toContain("Recorded action · 00:05click (720, 348)");
    expect(container.querySelector('[aria-label="Selected evidence"]')?.textContent).toContain("Capture 00:00 · 5s before entry");
    expect(container.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    expect(container.querySelector(".pins .spin .tip")?.textContent).toBe("click (720, 348)");
    await entry("ui_action-017");
    expect(counter()).toBe("1 / 3");
    expect(container.querySelectorAll(".pins .spin")).toHaveLength(1);
    expect(container.querySelector(".pins .spin .tip")?.textContent).toBe("click (999, 686)");
    expect(window.location.hash).toBe("#/lane/participant/f/1/e/ui_action-017");
    model = structuredClone(model);
    await render({ initialFrame: 0 });
    expect(container.querySelector('[aria-current="true"]')?.getAttribute("data-entry-id")).toBe("ui_action-017");
    await click("Show capture interval");
    expect(container.querySelectorAll(".pins .spin")).toHaveLength(2);
    expect(window.location.hash).toBe("#/lane/participant/f/1");
  });
  it("Next action visits each recorded action within one capture interval", async () => {
    intervalEntries();
    await render({ initialFrame: 0 });
    await click("Next action");
    expect(window.location.hash).toContain("/e/ui_action-016");
    await click("Next action");
    expect(window.location.hash).toContain("/e/ui_action-017");
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Next action")?.disabled).toBe(true);
    await click("Next frame");
    expect(window.location.hash).toBe("#/lane/participant/f/2");
    expect(container.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
  });
  it("restores event addresses and does not substitute another event when evidence disappears", async () => {
    intervalEntries();
    await render({ initialFrame: 0, initialEventId: "ui_action-017" });
    expect(container.querySelector(".pins .tip")?.textContent).toBe("click (999, 686)");
    model = { ...model, rows: model.rows.filter((row) => row.id !== "ui_action-017") };
    await render({ initialFrame: 0, initialEventId: "ui_action-017" });
    expect(container.querySelector('[aria-label="Selected evidence"]')?.textContent).toContain("selected entry is unavailable");
    expect(container.querySelectorAll(".pins .spin")).toHaveLength(0);
    expect(container.querySelectorAll('[data-on]')).toHaveLength(1); // filmstrip only
    expect(window.location.hash).toContain("/e/ui_action-017");
    await render({ initialFrame: 0, initialEventId: null, navigationRevision: 1 });
    expect(window.location.hash).toBe("#/lane/participant/f/1");
  });
  it("labels selected narration and unknown event time without inventing action coordinates", async () => {
    intervalEntries();
    delete model.rows[3]!.atMs;
    await render({ initialFrame: 1, initialEventId: "thought" });
    const context = container.querySelector('[aria-label="Selected evidence"]')!;
    expect(context.textContent).toContain("Reported thinking · Time unavailable");
    expect(context.textContent).toContain("I will open the menu.");
    expect(container.querySelectorAll(".pins .spin")).toHaveLength(0);
  });
  it("shows explicitly requested thinking while retaining the All evidence preference", async () => {
    model = { ...model, rows: [
      { id: "narration", kind: "reasoning", title: "Recorded narration", text: "I will inspect the next screen.", isFrame: false, frameIndex: 0 },
      { id: "action", kind: "ui_action", title: "click (100, 100)", isFrame: false, frameIndex: 0 }
    ] };
    await render({ initialFrame: 0 });
    const thinking = [...container.querySelectorAll("label")].find((label) => label.textContent?.trim() === "Thinking")!.querySelector<HTMLInputElement>("input")!;
    await act(async () => thinking.click());
    expect(container.querySelector(".thought-detail")).toBeNull();
    await filterActivity("thoughts");
    expect(container.querySelector(".thought-detail")?.textContent).toContain("I will inspect the next screen.");
    expect(container.querySelector(".feed-empty")).toBeNull();
    expect([...container.querySelectorAll("label")].some((label) => label.textContent?.trim() === "Thinking")).toBe(false);
    await filterActivity("all");
    expect(container.querySelector(".thought-detail")).toBeNull();
    expect(container.querySelector(".arow")?.textContent).toContain("click (100, 100)");
    expect(counter()).toBe("1 / 3");
  });
  it("shows run/setup warnings separately without inventing a capture or timestamp", async () => {
    stream = { ...stream, timeline: [
      { id: "setup", at: "2026-09-09T00:00:00.000Z", type: "setup.warning", level: "warn", message: "Browser bounds were corrected before participant entry." },
      { id: "legacy", at: "unknown", type: "run.error", level: "error", message: "A run notice with no usable timestamp." },
      { id: "informational", at: "2026-09-09T00:00:00.000Z", type: "run.info", level: "info", message: "An ordinary progress update." }
    ] };
    await render({ initialFrame: 1 });
    const address = window.location.hash;
    await filterActivity("findings");
    const notices = container.querySelector('[aria-label="Run and setup notices"]')!;
    expect(notices.textContent).toContain("Run and setup notices (2)");
    expect(notices.textContent).toContain("separate from participant trace findings");
    expect(notices.textContent).toContain("Browser bounds were corrected");
    expect(notices.textContent).toContain("Time unavailable");
    expect(notices.textContent).not.toContain("An ordinary progress update");
    expect(notices.querySelector("time")?.dateTime).toBe("2026-09-09T00:00:00.000Z");
    expect(notices.querySelectorAll("button, a")).toHaveLength(0);
    expect(container.querySelector(".feed-empty")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[title^="Frame-linked trace findings"]')?.disabled).toBe(true);
    expect(model.rows).toHaveLength(0);
    expect(window.location.hash).toBe(address);
    expect(counter()).toBe("2 / 3");
  });
  it("pages long run notices without moving the recorded frame or losing notices", async () => {
    stream = { ...stream, timeline: Array.from({ length: 95 }, (_, index) => ({
      id: `setup-${index}`, at: "unknown", type: "setup.warning", level: "warn" as const, message: `Recorded setup notice ${index + 1}.`
    })) };
    await render({ initialFrame: 1 });
    await filterActivity("findings");
    const entries = () => [...container.querySelectorAll(".player-run-notices li")].map((entry) => entry.textContent);
    expect(entries()).toHaveLength(40);
    expect(entries()[0]).toContain("Recorded setup notice 1.");
    await click("Next notices");
    expect(entries()).toHaveLength(40);
    expect(entries()[0]).toContain("Recorded setup notice 41.");
    await click("Next notices");
    expect(entries()).toHaveLength(15);
    expect(entries().at(-1)).toContain("Recorded setup notice 95.");
    await click("Previous notices");
    expect(entries()[0]).toContain("Recorded setup notice 41.");
    expect(counter()).toBe("2 / 3");
    expect(window.location.hash).toBe("#/lane/participant/f/2");
  });
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
  it("revisits the original saved address after local seeking without remounting", async () => {
    await render({ initialFrame: 1, navigationRevision: 0 });
    await click("Next frame");
    expect(counter()).toBe("3 / 3");
    await render({ initialFrame: 1, navigationRevision: 1 });
    expect(counter()).toBe("2 / 3");
    expect(window.location.hash).toBe("#/lane/participant/f/2");
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
      expect(window.location.hash).toBe("#/lane/participant/f/2");
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
    expect(container.querySelector(".player-mode strong")?.textContent).toBe("Saved recording");
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
    expect(counter()).toBe("1 / 3");
    await key("ArrowRight", container.querySelector('input[type="range"]')!);
    expect(counter()).toBe("2 / 3");
    await key(" ", container.querySelector('button[aria-label="Play"]')!);
    const editor = document.createElement("div"); editor.contentEditable = "true"; editor.setAttribute("contenteditable", "true"); container.appendChild(editor);
    await key("ArrowLeft", editor);
    expect(counter()).toBe("2 / 3");
  });
  it("moves the focused time scrubber through real captures in both directions", async () => {
    await render({ initialFrame: 0 });
    const slider = container.querySelector('input[type="range"]')!;
    await key("ArrowRight", slider);
    expect(counter()).toBe("2 / 3");
    await key("ArrowLeft", slider);
    expect(counter()).toBe("1 / 3");
    await key("End", slider);
    expect(counter()).toBe("3 / 3");
    await key("Home", slider);
    expect(counter()).toBe("1 / 3");
    expect(window.location.hash).toBe("#/lane/participant/f/1");
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
