// @vitest-environment jsdom
// Characterization of the comparison through the rendered component: its playback clock, the
// address it keeps in the hash, loading another run, and each participant's panel.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as fixtures from "../../scripts/observer-browser-fixtures.mjs";
import { Comparison } from "../components/comparison";
import type { HistoryIndex } from "../lib/live";
import type { ObserverData, ObserverStream } from "../lib/observer-data";
import { feed } from "./feed";
import { decodeInMicrotasks } from "./microtask-gunzip";

const RUN = "synthetic-observer-browser-proof";
const OTHER = "synthetic-other-study";
/** The fixtures' run clock origin: the run starts there and capture n is n × 7 s later. */
const START = Date.parse(fixtures.fixture().run.createdAt);
let container: HTMLDivElement;

decodeInMicrotasks();
let root: Root;
let data: ObserverData;
let opened: [string, number][];
let locations: string[];

const history: HistoryIndex = {
  runs: [
    { runId: RUN, href: "", status: "pass", mode: "live", streamCount: 3 },
    { runId: OTHER, href: "", status: "pass", mode: "live", streamCount: 3 },
  ],
} as unknown as HistoryIndex;

async function render(
  props: Partial<ComponentProps<typeof Comparison>> = {},
  streams: ObserverStream[] = data.streams.slice(0, 2),
): Promise<void> {
  await act(async () =>
    root.render(
      <Comparison
        data={data}
        streams={streams}
        history={null}
        onBack={() => undefined}
        onOpen={(id, frame) => opened.push([id, frame])}
        onLocationChange={(hash) => locations.push(hash)}
        {...props}
      />,
    ),
  );
}
function address(query: string): void {
  window.history.replaceState(null, "", `/#/compare?lane=lane-1&lane=lane-2&${query}`);
}
async function navigate(hash: string): Promise<void> {
  window.history.pushState(null, "", `/${hash}`);
  await act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")));
}
function find<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}
async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}
async function clickPrevented(element: HTMLElement, init: MouseEventInit = {}): Promise<boolean> {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  let prevented = false;
  // The window sees the click last: record the page's choice, then keep jsdom from navigating.
  const record = (seen: Event) => {
    prevented = seen.defaultPrevented;
    seen.preventDefault();
  };
  window.addEventListener("click", record, { once: true });
  await act(async () => element.dispatchEvent(event));
  return prevented;
}
async function choose(label: string, value: string): Promise<void> {
  await click(find(`[role="combobox"][aria-label="${label}"]`));
  const option = find(`.observer-select-option[data-value="${value}"]`);
  await act(async () => {
    const pointer = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(pointer, "pointerType", { value: "touch" });
    option.dispatchEvent(pointer);
    option.click();
  });
}
async function advance(ms: number): Promise<void> {
  await act(async () => vi.advanceTimersByTime(ms));
}
async function seekTo(value: number): Promise<void> {
  const seek = find<HTMLInputElement>('[aria-label="Seek comparison"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      seek,
      String(value),
    );
    seek.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const cursor = () => Number(find<HTMLInputElement>('[aria-label="Seek comparison"]').value);
const playButton = () => find('.compare-transport button[aria-label$="comparison"]');
const panel = (id: string) => find(`.compare-participant[data-stream-id="${id}"]`);
const statuses = () =>
  [...document.querySelectorAll('.comparison [role="status"]')].map((n) => n.textContent);
/** Removes screenshots from a participant's recording, by their 1-based capture number. */
function dropCaptures(stream: ObserverStream, numbers: number[]): void {
  const ids = numbers.map((number) => `${stream.id}-frame-${number}`);
  stream.actor!.items = stream.actor!.items.filter((item) => !ids.includes(item.id));
}
function moveCaptures(stream: ObserverStream, change: (at: string) => string | undefined): void {
  for (const item of stream.actor!.items)
    if (item.kind === "screenshot") {
      const at = change(item.at!);
      if (at === undefined) delete item.at;
      else item.at = at;
    }
}
function otherRun(): ObserverData {
  const other = fixtures.fixture();
  other.run.runId = OTHER;
  return other;
}

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => undefined;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
beforeEach(() => {
  data = fixtures.fixture();
  opened = [];
  locations = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  window.history.replaceState(null, "", window.location.pathname);
});

describe("the comparison clock", () => {
  it("plays 250 ms at a time from the cursor and stops at the end", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    address(`clock=shared&at=${START + 27_500}`);
    await render();
    expect(cursor()).toBe(START + 27_500);
    await click(playButton());
    expect(playButton().getAttribute("aria-label")).toBe("Pause comparison");
    await advance(250);
    expect(cursor()).toBe(START + 27_750);
    await advance(250);
    expect(cursor()).toBe(START + 28_000);
    expect(playButton().getAttribute("aria-label")).toBe("Play comparison");
    await advance(1000);
    expect(cursor()).toBe(START + 28_000);
    expect(window.location.hash).toBe(
      `#/compare?lane=lane-1&lane=lane-2&clock=shared&at=${START + 28_000}`,
    );
  });

  it("plays from the first capture when the cursor is at the end", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    address("clock=elapsed&at=21000");
    await render();
    expect(find(".compare-transport span").textContent).toBe("0:21 · 0:21 range");
    await click(playButton());
    expect(cursor()).toBe(0);
    expect(playButton().getAttribute("aria-label")).toBe("Pause comparison");
    await advance(250);
    expect(cursor()).toBe(250);
  });

  it("pauses when the seek control moves", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    address("clock=elapsed&at=0");
    await render();
    await click(playButton());
    await seekTo(9000);
    expect(playButton().getAttribute("aria-label")).toBe("Play comparison");
    await advance(500);
    expect(cursor()).toBe(9000);
    expect(locations.at(-1)).toBe("#/compare?lane=lane-1&lane=lane-2&clock=elapsed&at=9000");
  });

  it("moves to the start and pauses when the clock changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    address(`clock=shared&at=${START + 20_000}`);
    await render();
    await click(playButton());
    await choose("Comparison clock", "elapsed");
    expect(find('[aria-label="Comparison clock"]').textContent).toBe("Elapsed time");
    expect(cursor()).toBe(0);
    expect(playButton().getAttribute("aria-label")).toBe("Play comparison");
    expect(window.location.hash).toBe("#/compare?lane=lane-1&lane=lane-2&clock=elapsed&at=0");
  });

  it("follows a browser history move within the comparison and ignores one that leaves it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    address(`clock=shared&at=${START + 7000}`);
    await render();
    await click(playButton());
    await navigate("#/compare?lane=lane-1&lane=lane-2&clock=elapsed&at=14000");
    expect(cursor()).toBe(14_000);
    expect(find('[aria-label="Comparison clock"]').textContent).toBe("Elapsed time");
    expect(playButton().getAttribute("aria-label")).toBe("Play comparison");
    await navigate("#/lane/lane-1");
    expect(cursor()).toBe(14_000);
    expect(window.location.hash).toBe("#/lane/lane-1");
  });
});

describe("another run", () => {
  it("says a run outside the library is unavailable without asking for it", async () => {
    const fetch = vi.spyOn(window, "fetch");
    address("clock=elapsed&run=missing-study");
    await render({ history });
    expect(statuses()).toEqual(["That run is not in the available library."]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks for at most two participants before loading another run", async () => {
    const fetch = vi.spyOn(window, "fetch");
    address(`clock=elapsed&run=${OTHER}`);
    await render({ history }, data.streams);
    expect(statuses()).toEqual([
      "Keep at most two participants from this study to compare another run. Return to participants to change your selection.",
    ]);
    expect(find("#compare-limit").textContent).toBe(
      "Comparison holds up to three participants. Return to participants and remove one to add another run.",
    );
    expect(find('[aria-label="Comparison run"]').hasAttribute("data-disabled")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await navigate("#/compare?lane=lane-1&lane=lane-2&lane=lane-3&clock=elapsed");
    expect(statuses()).toEqual([]);
    expect(find('[aria-label="Comparison run"]').hasAttribute("data-disabled")).toBe(true);
  });

  it("loads another run as recorded evidence and opens its frames in that run's page", async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetch = vi
      .spyOn(window, "fetch")
      .mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
    address(`clock=shared&at=${START + 7000}`);
    await render({ history });
    await choose("Comparison run", OTHER);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0] as string).toBe(
      `/_humanish/runs/${OTHER}/observer/observer-feed.json`,
    );
    expect(find('[aria-label="Comparison clock"]').textContent).toBe("Elapsed time");
    expect(statuses()).toEqual(["Loading recorded evidence…"]);
    await act(async () => answer(new Response(feed(otherRun()))));
    expect(statuses()).toEqual(["Other run loaded as recorded evidence."]);
    const panels = [...document.querySelectorAll<HTMLElement>(".compare-participant")];
    expect(panels).toHaveLength(3);
    const last = panels[2]!;
    expect(last.querySelector(".compare-run")?.textContent).toBe(OTHER);
    expect(last.querySelector("h2")?.textContent).toBe(otherRun().streams[0]!.label);
    expect(last.querySelector("img")?.getAttribute("src")).toBe(
      `http://localhost:3000/_humanish/runs/${OTHER}/screenshots/portrait-1.png`,
    );
    const open = last.querySelector<HTMLAnchorElement>(".compare-open")!;
    expect(open.getAttribute("href")).toBe(
      `/_humanish/runs/${OTHER}/observer/index.html#/lane/lane-1/f/1`,
    );
    expect(await clickPrevented(open)).toBe(false);
    expect(opened).toEqual([]);
    expect(window.location.hash).toBe(
      `#/compare?lane=lane-1&lane=lane-2&clock=elapsed&at=0&run=${OTHER}`,
    );
    await choose("Other run participant", "lane-2");
    expect(
      document.querySelectorAll(".compare-participant")[2]?.getAttribute("data-stream-id"),
    ).toBe("lane-2");
    expect(window.location.hash).toBe(
      `#/compare?lane=lane-1&lane=lane-2&clock=elapsed&at=0&run=${OTHER}&otherLane=lane-2`,
    );
  });

  it("ignores the answer for a run the address has moved away from", async () => {
    const answers: ((response: Response) => void)[] = [];
    const signals: AbortSignal[] = [];
    vi.spyOn(window, "fetch").mockImplementation((_input, init) => {
      signals.push(init!.signal!);
      return new Promise<Response>((resolve) => answers.push(resolve));
    });
    address(`clock=elapsed&run=${OTHER}`);
    await render({ history });
    await navigate("#/compare?lane=lane-1&lane=lane-2&clock=elapsed");
    expect(signals[0]!.aborted).toBe(true);
    await act(async () => answers[0]!(new Response(feed(otherRun()))));
    expect(statuses()).toEqual([]);
    expect(document.querySelectorAll(".compare-participant")).toHaveLength(2);
  });

  it("says when another run could not be loaded", async () => {
    vi.spyOn(window, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    address(`clock=elapsed&run=${OTHER}`);
    await render({ history });
    expect(statuses()).toEqual([
      "Could not load that run. Check that its viewer is still available.",
    ]);
    expect(document.querySelectorAll(".compare-participant")).toHaveLength(2);
  });
});

describe("a participant's panel", () => {
  it("says a frame failed to load and asks for it again on Retry image", async () => {
    address(`clock=shared&at=${START + 7000}`);
    await render();
    const image = panel("lane-1").querySelector("img")!;
    await act(async () => image.dispatchEvent(new Event("error")));
    expect(panel("lane-1").querySelector(".compare-stage")?.textContent).toBe("Frame unavailable");
    expect(panel("lane-1").querySelector("img")).toBeNull();
    await click(
      [...panel("lane-1").querySelectorAll("button")].find((b) => b.textContent === "Retry image")!,
    );
    expect(panel("lane-1").querySelector("img")).not.toBeNull();
    expect(panel("lane-1").querySelector("button")).toBeNull();
  });

  it("shows nothing for a failed frame while the server is stopped and asks again when it returns", async () => {
    address(`clock=shared&at=${START + 7000}`);
    await render();
    await act(async () => panel("lane-1").querySelector("img")!.dispatchEvent(new Event("error")));
    await render({ serverStopped: true });
    expect(panel("lane-1").querySelector(".compare-stage")?.childNodes).toHaveLength(0);
    expect(panel("lane-1").querySelector("button")).toBeNull();
    expect(panel("lane-1").querySelector(".compare-caption")?.textContent).toBe(
      "Recorded capture · 0:00 before cursor · frame 1",
    );
    await render({ serverStopped: false });
    expect(panel("lane-1").querySelector("img")).not.toBeNull();
  });

  it("captions each capture's age and frame, and says when the cursor is outside a recording", async () => {
    dropCaptures(data.streams[0]!, [4]);
    dropCaptures(data.streams[1]!, [1]);
    address(`clock=shared&at=${START + 7000}`);
    await render();
    const caption = (id: string) => panel(id).querySelector(".compare-caption")?.textContent;
    expect(caption("lane-1")).toBe("Recorded capture · 0:00 before cursor · frame 1");
    expect(caption("lane-2")).toBe("Outside recorded coverage");
    expect(panel("lane-2").querySelector(".compare-stage")?.textContent).toBe(
      "No capture yet at this time",
    );
    expect(panel("lane-2").querySelector(".compare-open")).toBeNull();
    await seekTo(START + 28_000);
    expect(caption("lane-1")).toBe(
      "Past recording end · last capture · 0:07 before cursor · frame 3",
    );
    expect(caption("lane-2")).toBe("Recorded capture · 0:00 before cursor · frame 3");
  });

  it("marks estimated timing, and says which recordings have no capture timestamps", async () => {
    moveCaptures(data.streams[1]!, () => undefined);
    address(`clock=shared&at=${START + 7000}`);
    await render();
    expect(panel("lane-2").querySelector(".compare-stage")?.textContent).toBe(
      "No capture timestamps",
    );
    expect(panel("lane-2").querySelector(".compare-caption")?.textContent).toBe(
      "Outside recorded coverage",
    );
    await choose("Comparison clock", "elapsed");
    expect(panel("lane-2").querySelector(".compare-caption")?.textContent).toBe(
      "Recorded capture · 0:00 before cursor · frame 1 · estimated timing",
    );
    expect(panel("lane-1").querySelector(".compare-caption")?.textContent).toBe(
      "Recorded capture · 0:00 before cursor · frame 1",
    );
  });

  it("offers no transport when no recording has capture timestamps", async () => {
    moveCaptures(data.streams[0]!, () => undefined);
    moveCaptures(data.streams[1]!, () => undefined);
    address("clock=shared");
    await render();
    expect(document.querySelector(".compare-transport")).toBeNull();
    expect(document.querySelector(".comparison")?.textContent).toContain(
      "No timestamped frames to align. Choose elapsed time for older recordings.",
    );
    expect(window.location.hash).toBe("#/compare?lane=lane-1&lane=lane-2&clock=shared");
  });

  it("says when recordings do not overlap in shared time", async () => {
    moveCaptures(data.streams[1]!, (at) => new Date(Date.parse(at) + 3_600_000).toISOString());
    address("clock=shared");
    await render();
    expect(statuses()).toEqual([
      "These recordings do not overlap in time. Choose elapsed time to compare their progress.",
    ]);
    await choose("Comparison clock", "elapsed");
    expect(statuses()).toEqual([]);
  });

  it("opens a frame here on a plain click and leaves a modified click to the browser", async () => {
    address(`clock=shared&at=${START + 15_000}`);
    await render();
    const open = panel("lane-2").querySelector<HTMLAnchorElement>(".compare-open")!;
    expect(open.getAttribute("href")).toBe("#/lane/lane-2/f/2");
    expect(open.getAttribute("aria-label")).toBe("Open frame 2 from Synthetic participant 2");
    expect(await clickPrevented(open, { ctrlKey: true })).toBe(false);
    expect(opened).toEqual([]);
    expect(await clickPrevented(open)).toBe(true);
    expect(opened).toEqual([["lane-2", 1]]);
  });
});
