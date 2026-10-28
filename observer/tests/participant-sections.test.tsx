// @vitest-environment jsdom
// Characterization of the participant tile, the grid's live thumbs and the frame-free stub
// through the rendered components: what a tile shows and says, which tiles stream live, and how
// the stub pages long output.
import { Tooltip } from "@base-ui/react/tooltip";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as fixtures from "../../scripts/observer-browser-fixtures.mjs";
import { App } from "../app";
import { ParticipantCard } from "../components/participant-card";
import { ParticipantStub } from "../components/participant-stub";
import { RunStatus } from "../components/run-status";
import type { ObserverData, ObserverStream } from "../lib/observer-data";

/** The fixtures' run clock origin: the run starts there and capture n is n × 7 s later. */
const START = Date.parse(fixtures.fixture().run.createdAt);
const STARTED = new Date(START).toISOString();
let container: HTMLDivElement;
let root: Root;

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => root.render(element));
}
async function card(
  stream: ObserverStream,
  props: Partial<ComponentProps<typeof ParticipantCard>> = {},
): Promise<void> {
  await render(
    <Tooltip.Provider>
      <ParticipantCard
        stream={stream}
        name="Synthetic participant 2"
        onOpen={() => undefined}
        {...props}
      />
    </Tooltip.Provider>,
  );
}
function find<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
  expect(match, text).toBeDefined();
  return match!;
}
async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}
async function openDetails(): Promise<HTMLElement> {
  await click(find(".card-details-trigger"));
  return find(".card-details");
}
const details = () =>
  [...document.querySelectorAll(".card-details dt")].map((term) => [
    term.textContent,
    term.nextElementSibling?.textContent,
  ]);
const caption = () => find(".card-identity > span");
/** `new Image()` returns these: a capture whose size is known once its load event fires. */
function measuredImages(width: number, height: number): HTMLImageElement[] {
  const created: HTMLImageElement[] = [];
  const OriginalImage = globalThis.Image;
  vi.stubGlobal(
    "Image",
    class MeasuredImage {
      constructor() {
        const image = new OriginalImage();
        Object.defineProperty(image, "naturalWidth", { value: width });
        Object.defineProperty(image, "naturalHeight", { value: height });
        created.push(image);
        return image;
      }
    },
  );
  return created;
}
async function load(image: HTMLImageElement, width: number, height: number): Promise<void> {
  Object.defineProperty(image, "naturalWidth", { value: width });
  Object.defineProperty(image, "naturalHeight", { value: height });
  await act(async () => image.dispatchEvent(new Event("load")));
}
function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `Synthetic output line ${index + 1}`).join(
    "\n",
  );
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", window.location.pathname);
});

describe("a participant tile's caption and details", () => {
  it("details a recorded participant, its notices and the comparison limit", async () => {
    const stream = fixtures.fixture().streams[1]!;
    stream.timeline = [
      { id: "notice-1", at: STARTED, level: "warn", type: "step", message: "First notice" },
      { id: "notice-2", at: STARTED, level: "error", type: "step", message: "Second notice" },
    ];
    const used: string[] = [];
    await card(stream, {
      onOpen: (id) => used.push(`open ${id}`),
      onPin: (id) => used.push(`pin ${id}`),
      onCompare: (id) => used.push(`compare ${id}`),
      comparisonFull: true,
    });
    expect(caption().textContent).toBe("Passed");
    expect(caption().getAttribute("title")).toBe("Passed");
    expect(find(".thumb img").getAttribute("alt")).toBe(
      "Recorded screen from Synthetic participant 2",
    );
    expect(find(".open-overlay").getAttribute("aria-label")).toBe(
      "Open participant Synthetic participant 2",
    );
    const panel = await openDetails();
    expect(panel.querySelector("h3")?.textContent).toBe("Synthetic participant 2");
    expect(details()).toEqual([
      ["Participant", "Synthetic participant 2"],
      ["Persona", "persona-2"],
      ["Status", "Passed"],
      ["Preview", "Recorded"],
      ["Screen", "1200 × 750 · Browser"],
      ["Duration", "28s"],
    ]);
    expect(panel.querySelector(".sig-label")?.textContent).toBe("final message");
    expect(panel.textContent).toContain("FINAL SYNTHETIC EVIDENCE REMAINS INSPECTABLE");
    expect(panel.querySelector(".card-warnings h3")?.textContent).toBe("2 recorded notices");
    expect(
      [...panel.querySelectorAll(".card-warnings li")].map((item) => item.textContent),
    ).toEqual(["First notice", "Second notice"]);
    expect(button("Compare", panel).disabled).toBe(true);
    expect(panel.textContent).toContain(
      "Comparison limit: 3 participants. Remove one to choose another.",
    );
    await click(button("Pin", panel));
    await click(button("Open participant", panel));
    expect(used).toEqual(["pin lane-2", "open lane-2"]);
  });

  it("puts the analyzed outcome beside the recorded actor", async () => {
    const stream = fixtures.fixture().streams[1]!;
    await card(stream, {
      reviewOutcome: "Reported complete",
      compared: true,
      onCompare: () => undefined,
    });
    expect(caption().textContent).toBe("Analysis: Reported complete");
    expect(caption().className).toBe("card-outcome reviewed-outcome");
    expect(caption().getAttribute("title")).toBe(
      "Independent analysis: Reported complete. Recorded actor: passed.",
    );
    const panel = await openDetails();
    expect(details()).toContainEqual(["Analyzed outcome", "Reported complete"]);
    expect(button("Compare", panel).getAttribute("aria-pressed")).toBe("true");
    expect(button("Compare", panel).disabled).toBe(false);
  });

  it("shows the replay capture's age, and a slow decode's loading state", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = fixtures.fixture().streams[1]!;
    const frame = {
      index: 1,
      itemId: "lane-2-frame-2",
      title: "Capture 2",
      href: "../screenshots/landscape-2.png",
    };
    await card(stream, { replay: { kind: "capture", frame, ageMs: 4200, coverage: "within" } });
    expect(document.querySelector(".capture-loading")).toBeNull();
    await act(async () => vi.advanceTimersByTime(400));
    expect(find(".capture-loading").textContent).toBe("Loading selected capture…");
    expect(caption().textContent).toBe("Loading capture…");
    expect(caption().getAttribute("title")).toBe("Loading the selected capture.");
    await load(find(".thumb img"), 1600, 900);
    expect(document.querySelector(".capture-loading")).toBeNull();
    expect(caption().textContent).toBe("4s ago");
    expect(caption().getAttribute("title")).toBe("Capture · 00:04 before cursor");
    expect(find(".thumb").style.aspectRatio).toBe("1600 / 900");
    await openDetails();
    expect(details()).toContainEqual(["Run status", "Passed"]);
    expect(details()).toContainEqual(["Preview", "Capture · 00:04 before cursor"]);
    expect(details()).toContainEqual(["Screen", "1600 × 900 · Browser"]);
    expect(find(".card-details .sig-label").textContent).toBe("Whole-recording summary");
  });

  it("names the replay moment when there is no capture to show", async () => {
    const stream = fixtures.fixture().streams[1]!;
    for (const [kind, text] of [
      ["timing-unavailable", "Capture timing unavailable"],
      ["before-first", "No capture yet"],
      ["no-captures", "No captured screens"],
    ] as const) {
      await card(stream, { replay: { kind } });
      expect(find(".thumb-ph .ph-state").textContent).toBe(text);
      expect(caption().textContent).toBe(text);
      expect(find(".open-overlay").getAttribute("aria-label")).toBe(
        kind === "timing-unavailable"
          ? "Open recording from start for Synthetic participant 2"
          : "Open participant Synthetic participant 2",
      );
    }
  });
});

describe("a participant tile's preview", () => {
  it("streams a live thumb sized from its latest capture", async () => {
    const created = measuredImages(500, 896);
    const stream = fixtures.fixture({ running: true, live: true, origin: "https://live.example" })
      .streams[0]!;
    await card(stream, { liveThumb: true });
    const frame = find<HTMLIFrameElement>(".thumb-live");
    expect(frame.getAttribute("src")).toBe("https://live.example/desktop/lane-1");
    expect(frame.getAttribute("title")).toBe("Live thumb · Synthetic participant 2");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(find(".thumb").style.aspectRatio).toBe("390 / 844");
    await act(async () => created[0]!.dispatchEvent(new Event("load")));
    expect(find(".thumb").style.aspectRatio).toBe("500 / 896");
    expect(caption().textContent).toBe("Live");
    expect(caption().getAttribute("title")).toBe("Live desktop preview");
    await openDetails();
    expect(details()).toContainEqual([
      "Preview",
      "Live desktop preview · read-only; connection health is managed by the provider",
    ]);
    expect(details()).toContainEqual(["Status", "Running"]);
  });

  it("labels an active capture by its age and shows the reported thinking", async () => {
    const stream = fixtures.fixture({ running: true }).streams[1]!;
    stream.liveActor!.items.push({
      id: "lane-2-reasoning",
      kind: "reasoning",
      lifecycle: "completed",
      title: "reasoning",
      text: "Checking whether the form was sent.",
    });
    await card(stream, { now: START + 33_000 });
    expect(caption().textContent).toBe("Capture");
    expect(caption().className).toBe("card-outcome active");
    expect(caption().getAttribute("title")).toBe("Latest capture · 5s ago");
    await openDetails();
    expect(details()).toContainEqual(["Preview", "Latest capture · 5s ago"]);
    expect(find(".card-details .sig-label").textContent).toBe("Reported thinking");
    expect(find(".card-details").textContent).toContain("Checking whether the form was sent.");
    await act(async () => root.unmount());
    root = createRoot(container);
    await card(stream, { updating: false });
    expect(caption().textContent).toBe("Snapshot");
    expect(caption().getAttribute("title")).toBe("Captured while running");
  });

  it("offers Retry frame for a failed capture, and hides the failure while the server is stopped", async () => {
    const stream = fixtures.fixture().streams[1]!;
    await card(stream);
    await act(async () => find(".thumb img").dispatchEvent(new Event("error")));
    expect(find(".thumb img").className).toBe("capture-unavailable");
    expect(find(".frame-unavailable").textContent).toBe("Frame unavailable");
    await click(find(".card-retry"));
    expect(find(".thumb img").className).toBe("keyframe");
    expect(document.querySelector(".frame-unavailable")).toBeNull();
    await act(async () => find(".thumb img").dispatchEvent(new Event("error")));
    await card(stream, { serverStopped: true });
    expect(find(".thumb img").className).toBe("capture-unavailable");
    expect(document.querySelector(".frame-unavailable")).toBeNull();
    expect(document.querySelector(".card-retry")).toBeNull();
    await card(stream, { serverStopped: false });
    expect(find(".thumb img").className).toBe("keyframe");
  });

  it("shows the last terminal lines, or why there is no screen", async () => {
    const data = fixtures.fixture({ frames: 0 });
    const stream = { ...data.streams[1]!, terminalPlain: lines(8) };
    await card(stream);
    const terminal = find(".thumb-term").textContent;
    expect(terminal).toContain("Synthetic output line 3");
    expect(terminal).toContain("Synthetic output line 8");
    expect(terminal).not.toContain("Synthetic output line 2");
    await card({ ...stream, terminalPlain: "" });
    expect(find(".thumb-ph .ph-state").textContent).toBe("No captured screen");
    const running = fixtures.fixture({ running: true, frames: 0 }).streams[1]!;
    await card(running);
    expect(find(".thumb-ph .ph-state").textContent).toBe("Waiting for the first capture…");
  });

  it("says when a queued participant starts, and counts only started participants as active", async () => {
    const data: ObserverData = fixtures.fixture({ running: true, frames: 0 });
    const queued = (stream: ObserverStream): ObserverStream => ({
      ...stream,
      status: "queued",
      statusLabel: "Queued",
      sim: { ...stream.sim, status: "queued", currentStep: "Starts at +2h 35m." },
    });
    await card(queued(data.streams[1]!), { updating: true });
    expect(find(".thumb-ph .ph-state").textContent).toBe("Starts at +2h 35m.");

    const connection = { state: "current" as const, lastReceivedAt: START };
    const status = (streams: ObserverStream[]) =>
      render(
        <RunStatus
          data={{ ...data, streams }}
          connection={connection}
          now={START}
          onRetry={() => undefined}
        />,
      );
    await status([data.streams[0]!, ...data.streams.slice(1).map(queued)]);
    expect(find(".run-status-main").textContent).toContain("1 of 3 participants active");
    await status(data.streams.map(queued));
    expect(find(".run-status-main strong").textContent).toBe("Running");
    expect(find(".run-status-main").textContent).toContain("0 of 3 participants active");
  });
});

describe("the grid's live thumbs", () => {
  const live = () =>
    [...document.querySelectorAll(".thumb-live")].map(
      (frame) => frame.closest<HTMLElement>("[data-stream-id]")!.dataset.streamId,
    );
  const thumb = (id: string) => find(`[data-stream-id="${id}"] .thumb`);
  async function liveStudy(): Promise<void> {
    vi.spyOn(window, "fetch").mockImplementation(() => new Promise<Response>(() => undefined));
    const data: ObserverData = fixtures.fixture({
      running: true,
      live: true,
      laneCount: 5,
      origin: "https://live.example",
    });
    await render(<App data={data} />);
  }

  it("streams the hovered or focused card among at most four", async () => {
    await liveStudy();
    expect(live()).toEqual(["lane-1", "lane-2", "lane-3", "lane-4"]);
    await act(async () =>
      find('[data-stream-id="lane-5"]').dispatchEvent(
        new MouseEvent("pointerover", { bubbles: true }),
      ),
    );
    expect(live()).toEqual(["lane-1", "lane-2", "lane-3", "lane-5"]);
    await act(async () =>
      find('[data-stream-id="lane-4"] .card-name').dispatchEvent(
        new FocusEvent("focusin", { bubbles: true }),
      ),
    );
    expect(live()).toEqual(["lane-1", "lane-2", "lane-3", "lane-4"]);
  });

  it("streams the four most visible cards the browser reports", async () => {
    const observers: {
      callback: IntersectionObserverCallback;
      options: IntersectionObserverInit | undefined;
      observed: Element[];
      disconnected: boolean;
    }[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        record: (typeof observers)[number];
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          this.record = { callback, options, observed: [], disconnected: false };
          observers.push(this.record);
        }
        observe(target: Element) {
          this.record.observed.push(target);
        }
        disconnect() {
          this.record.disconnected = true;
        }
      },
    );
    await liveStudy();
    expect(live()).toEqual([]);
    const observer = observers.at(-1)!;
    expect(observer.options?.root).toBe(find("#observer-content"));
    expect(observer.options?.threshold).toEqual([0, 0.1, 0.25, 0.5, 0.75, 1]);
    expect(observer.observed).toHaveLength(5);
    const report = async (ratios: [string, number][]) => {
      const entries = ratios.map(([id, ratio]) => ({
        target: thumb(id),
        isIntersecting: ratio > 0,
        intersectionRatio: ratio,
      }));
      await act(async () =>
        observer.callback(
          entries as unknown as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        ),
      );
    };
    await report([
      ["lane-3", 1],
      ["lane-4", 0.75],
      ["lane-5", 0.5],
      ["lane-1", 0.25],
      ["lane-2", 0.1],
    ]);
    expect(live()).toEqual(["lane-1", "lane-3", "lane-4", "lane-5"]);
    await report([["lane-3", 0]]);
    expect(live()).toEqual(["lane-1", "lane-2", "lane-4", "lane-5"]);
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(observer.disconnected).toBe(true);
  });
});

describe("the frame-free stub", () => {
  function stub(stream: Partial<ObserverStream>): Promise<void> {
    const data = fixtures.fixture({ frames: 0 });
    return render(<ParticipantStub data={data} stream={{ ...data.streams[1]!, ...stream }} />);
  }
  const terminalLabel = () =>
    [...document.querySelectorAll(".stub .o-label")]
      .map((label) => label.textContent)
      .find((text) => text?.startsWith("Recorded terminal output")) ?? null;
  const events = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `event-${index + 1}`,
      at: STARTED,
      level: index === 0 ? ("warn" as const) : ("info" as const),
      type: "step",
      message: `Synthetic event ${index + 1}`,
    }));
  const rows = () => [...document.querySelectorAll(".acts .arow")];

  it("pages through more than 100 recorded events and keeps the page as the timeline changes", async () => {
    await stub({ timeline: events(150) });
    expect(find('[aria-label="Event pages"] span').textContent).toBe("1–100 of 150");
    expect(rows()).toHaveLength(100);
    expect(rows()[0]!.className).toBe("arow ev warn");
    expect(rows()[0]!.textContent).toBe("warnstep: Synthetic event 1");
    expect(button("Earlier events").disabled).toBe(true);
    await click(button("Later events"));
    expect(find('[aria-label="Event pages"] span').textContent).toBe("101–150 of 150");
    expect(rows()).toHaveLength(50);
    expect(rows()[0]!.textContent).toBe("infostep: Synthetic event 101");
    expect(button("Later events").disabled).toBe(true);
    await stub({ timeline: events(90) });
    expect(document.querySelector('[aria-label="Event pages"]')).toBeNull();
    expect(rows()).toHaveLength(90);
    await stub({ timeline: events(160) });
    expect(find('[aria-label="Event pages"] span').textContent).toBe("101–160 of 160");
  });

  it("follows the last terminal page until a page is chosen, then keeps it", async () => {
    await stub({ terminalPlain: lines(60) });
    expect(terminalLabel()).toBe("Recorded terminal output · lines 51–60 of 60");
    await stub({ terminalPlain: lines(120) });
    expect(terminalLabel()).toBe("Recorded terminal output · lines 101–120 of 120");
    await click(button("Earlier output"));
    expect(terminalLabel()).toBe("Recorded terminal output · lines 51–100 of 120");
    await stub({ terminalPlain: lines(140) });
    expect(terminalLabel()).toBe("Recorded terminal output · lines 51–100 of 140");
    expect(button("Later output").disabled).toBe(false);
  });

  it("keeps the chosen terminal page while the output is briefly empty", async () => {
    await stub({ terminalPlain: lines(123) });
    await click(button("Earlier output"));
    expect(terminalLabel()).toBe("Recorded terminal output · lines 51–100 of 123");
    await stub({ terminalPlain: "" });
    expect(terminalLabel()).toBeNull();
    expect(document.querySelector(".stub-term")).toBeNull();
    await stub({ terminalPlain: lines(123) });
    expect(terminalLabel()).toBe("Recorded terminal output · lines 51–100 of 123");
  });
});
