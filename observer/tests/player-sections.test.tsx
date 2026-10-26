// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import firstRun from "../../tests/golden/observer-data/first-run.json";
import { Player } from "../components/player";
import type { PlayerModel, PlayerRow } from "../lib/player-model";
import type { ObserverData, ObserverStream } from "../lib/observer-data";
import * as fixtures from "../../scripts/observer-browser-fixtures.mjs";

// Characterization of the review player's sections through the rendered component: the
// inspector, transport, filmstrip, activity list and evidence notes.
let data: ObserverData;
let root: Root;
let container: HTMLDivElement;
let stream: ObserverStream;
let model: PlayerModel;

async function render(
  props: Omit<ComponentProps<typeof Player>, "data" | "stream" | "model"> = {},
) {
  await act(async () =>
    root.render(<Player data={data} stream={stream} model={model} {...props} />),
  );
}
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === label || node.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(label: string) {
  const target = button(label);
  await act(async () => target.click());
}
async function key(value: string, target: EventTarget) {
  await act(async () =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
    ),
  );
}
const counter = () => container.querySelector(".counter")?.textContent;
const notice = () => container.querySelector(".player-notice")?.textContent ?? null;
const note = () => container.querySelector(".player-evidence-note")?.textContent;
function checkbox(label: string) {
  return [...container.querySelectorAll("label")]
    .find((node) => node.textContent?.trim() === label)!
    .querySelector<HTMLElement>('[role="checkbox"]')!;
}
async function filterActivity(value: string) {
  const select = container.querySelector<HTMLButtonElement>('[aria-label="Filter activity"]')!;
  await act(async () => select.click());
  const option = document.querySelector<HTMLElement>(
    `.observer-select-option[data-value="${value}"]`,
  )!;
  await act(async () => {
    const pointer = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(pointer, "pointerType", { value: "touch" });
    option.dispatchEvent(pointer);
    option.click();
  });
}
function kv(): [string, string][] {
  return [...container.querySelectorAll(".kv .k")].map((label) => [
    label.textContent ?? "",
    label.nextElementSibling?.textContent ?? "",
  ]);
}
function longRecording() {
  stream = { ...stream, status: "passed" };
  model = {
    ...model,
    frames: Array.from({ length: 1000 }, (_, index) => ({
      index,
      itemId: `frame-${index}`,
      href: `../screenshots/${index}.png`,
      title: `Frame ${index}`,
      atMs: index * 1000,
    })),
    rows: Array.from({ length: 3000 }, (_, index) => ({
      id: `action-${index}`,
      title: `Action ${index}`,
      kind: "ui_action",
      isFrame: false,
      frameIndex: Math.floor(index / 3),
    })),
  };
}
const row = (fields: Partial<PlayerRow> & Pick<PlayerRow, "id">): PlayerRow => ({
  kind: "ui_action",
  title: fields.id,
  isFrame: false,
  frameIndex: 0,
  ...fields,
});

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  data = structuredClone(firstRun) as unknown as ObserverData;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  stream = {
    ...data.streams[0]!,
    id: "participant",
    label: "Synthetic participant",
    status: "running",
    embed: { kind: "iframe", url: "https://live.example/desktop" },
  } as ObserverStream;
  model = {
    paced: "recorded",
    avgFrameMs: 1000,
    rows: [],
    frames: Array.from({ length: 3 }, (_, index) => ({
      index,
      itemId: `frame-${index}`,
      href: `../screenshots/frame-${index}.png`,
      title: `Capture ${index}`,
      atMs: 10_000 + index * 7000,
    })),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the inspector", () => {
  it("resizes by keyboard between 280 and 520 pixels and saves the width", async () => {
    await render({ initialFrame: 0 });
    const handle = container.querySelector<HTMLElement>('[aria-label="Inspector width"]')!;
    const width = () => container.querySelector<HTMLElement>(".inspector")!.style.width;
    expect(handle.getAttribute("aria-valuenow")).toBe("340");
    await key("ArrowLeft", handle);
    expect(width()).toBe("360px");
    for (let step = 0; step < 10; step += 1) await key("ArrowLeft", handle);
    expect(width()).toBe("520px");
    await key("ArrowRight", handle);
    expect(width()).toBe("500px");
    expect(JSON.parse(localStorage.getItem("humanish-player-v1")!)).toEqual({
      speed: 1,
      skipWaits: false,
      inspector: true,
      width: 500,
    });
    // The handle's arrow keys resize; they do not step the recording.
    expect(counter()).toBe("1 / 3");
    for (let step = 0; step < 20; step += 1) await key("ArrowRight", handle);
    expect(width()).toBe("280px");
  });

  it("reads saved preferences within their bounds", async () => {
    localStorage.setItem(
      "humanish-player-v1",
      JSON.stringify({ speed: 3, skipWaits: true, inspector: true, width: 900 }),
    );
    await render({ initialFrame: 0 });
    expect(button("Playback speed").textContent).toBe("1×");
    expect(checkbox("Skip waits").getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector<HTMLElement>(".inspector")!.style.width).toBe("520px");
    await act(async () => root.unmount());
    root = createRoot(container);
    localStorage.setItem("humanish-player-v1", JSON.stringify({ inspector: false }));
    await render({ initialFrame: 0 });
    expect(container.querySelector(".player")?.getAttribute("data-inspector")).toBe("closed");
    expect(container.querySelector(".inspector")).toBeNull();
    expect(button("Show inspector").getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps its tab and activity filter while hidden and shown again", async () => {
    model = {
      ...model,
      rows: [
        row({ id: "narration", kind: "reasoning", title: "Recorded narration", text: "I look." }),
        row({ id: "action", title: "click (100, 100)" }),
      ],
    };
    await render({ initialFrame: 0 });
    await filterActivity("thoughts");
    await click("details");
    await click("Hide inspector");
    expect(container.querySelector(".inspector")).toBeNull();
    await click("Show inspector");
    expect(container.querySelector(".inspector .kv")).not.toBeNull();
    await click("actions");
    expect(container.querySelectorAll(".acts .arow")).toHaveLength(1);
    expect(container.querySelector(".acts .thought-full")?.textContent).toBe("I look.");
  });

  it("shows a zoom's image small on its activity row", async () => {
    model = {
      ...model,
      rows: [
        row({
          id: "zoom",
          title: "zoom 98x22 at (817, 177)",
          zoomHref: "../screenshots/zoom-001.webp",
        }),
        row({ id: "click", title: "click (100, 100)" }),
      ],
    };
    await render({ initialFrame: 0 });
    const images = container.querySelectorAll<HTMLImageElement>(".acts .arow img");
    expect([...images].map((image) => image.getAttribute("src"))).toEqual([
      "../screenshots/zoom-001.webp",
    ]);
    expect(images[0]?.closest(".arow")?.textContent).toContain("zoom 98x22 at (817, 177)");
  });

  it("lists the recorded actor, viewport, affordances and redaction in Details", async () => {
    stream = {
      ...stream,
      viewport: { width: 1280, height: 800 },
      actor: {
        ...fixtures.fixture().streams[0]!.actor!,
        ids: { model: "synthetic-model" },
        affordanceUse: { counts: { click: 3, key: 2 }, shortcutTotal: 1 },
      },
    } as unknown as ObserverStream;
    model = {
      ...model,
      rows: [
        row({ id: "one", title: "click (1, 1)" }),
        row({ id: "thought", kind: "reasoning", title: "Plan" }),
      ],
    };
    await render({ initialFrame: 0 });
    await click("details");
    expect(kv()).toEqual([
      ["Persona", "synthetic-new-user"],
      ["Scenario", data.run.scenario.title],
      ["Participant", "Synthetic participant"],
      ["Actor", "synthetic-browser-proof · synthetic-model"],
      ["Duration", "28s"],
      ["Recorded", "1 action · 1 thought"],
      ["Timing", "recorded pace"],
      ["Viewport", "1280×800"],
      ["Affordances", "click 3 · key 2 · shortcuts 1"],
      ["Redaction", "screenshots raw"],
      ["Artifacts", "8 linked files"],
    ]);
  });

  it("shows the outcome, the recorded reason, study gaps and the cost line in Feedback", async () => {
    // No trace items, so the statements section between the reason and the gaps stays empty.
    const actor = { ...fixtures.fixture().streams[0]!.actor!, items: [] };
    stream = {
      ...stream,
      statusLabel: "Passed",
      ending: { label: "Spend limit" },
      actor: { ...actor, estimatedCost: { estimatedCostUsd: 0.1234, ratesAsOf: "2026-09-01" } },
    } as unknown as ObserverStream;
    await render({ initialFrame: 0 });
    await click("Feedback");
    const blocks = () =>
      [...container.querySelectorAll(".inspector .blk")].map((block) => [
        block.querySelector(".o-label")?.textContent,
        [...block.querySelectorAll(".verbatim")].map((line) => line.textContent),
      ]);
    expect(blocks()).toEqual([
      ["Outcome", ["Passed · ⚑ Spend limit"]],
      ["Recorded reason, verbatim", ["“Synthetic task completed.”"]],
      ["Study-level gaps", data.run.knownGaps],
      ["Est. participant cost", ["~$0.12 (rates as of 2026-09-01)"]],
    ]);
    stream = {
      ...stream,
      actor: { ...actor, executionProfile: { billing: "account-unknown" } },
    } as unknown as ObserverStream;
    await render({ initialFrame: 0 });
    expect(blocks().at(-1)).toEqual(["Account usage", ["Codex account · dollar cost unknown"]]);
  });
});

describe("the inspector's network row", () => {
  it("shows the participant's network log in Details as its counts, linking the file", async () => {
    stream = {
      ...stream,
      network: {
        schema: "humanish.browser-network.v1",
        path: "network/p1.ndjson",
        records: 412,
        failed: 3,
        pending: 2,
        bytes: 66104,
        sha256: "0".repeat(64),
        startedAt: "2026-10-16T10:00:07.812Z",
        origins: ["https://shop.example"],
        complete: true,
        omitted: { otherOrigin: 1203, overCap: 0, invalid: 0 },
      },
    };
    await render({ initialFrame: 0 });
    await click("details");
    expect(kv()).toContainEqual(["Network", "412 requests, 3 failed, 2 pending"]);
    const link = [...container.querySelectorAll<HTMLAnchorElement>(".kv a")].find(
      (anchor) => anchor.textContent === "412 requests, 3 failed, 2 pending",
    );
    expect(link?.getAttribute("href")).toBe("../network/p1.ndjson");
  });

  it("says in Details why a participant's network log is missing or cut short", async () => {
    const network = {
      schema: "humanish.browser-network.v1" as const,
      origins: ["https://shop.example"],
      omitted: { otherOrigin: 0, overCap: 0, invalid: 0 },
    };
    stream = { ...stream, network: { ...network, complete: false, reason: "no-capture" } };
    await render({ initialFrame: 0 });
    await click("details");
    expect(kv()).toContainEqual(["Network", "Not recorded: capture did not start"]);
    expect(container.querySelector(".kv a")).toBeNull();

    stream = {
      ...stream,
      network: {
        ...network,
        path: "network/p1.ndjson",
        records: 20_000,
        failed: 0,
        pending: 1,
        bytes: 3_200_000,
        sha256: "0".repeat(64),
        complete: false,
        reason: "capped",
        omitted: { ...network.omitted, overCap: 31 },
      },
    };
    await render({ initialFrame: 0 });
    expect(kv()).toContainEqual([
      "Network",
      "20000 requests, 0 failed, 1 pending · cut at the size cap",
    ]);
  });

  it("says in Details that capture kept no request, with no link, when it started and wrote no file", async () => {
    stream = {
      ...stream,
      network: {
        schema: "humanish.browser-network.v1",
        startedAt: "2026-10-16T10:00:07.812Z",
        origins: ["https://shop.example"],
        complete: true,
        omitted: { otherOrigin: 14, overCap: 0, invalid: 0 },
      },
    };
    await render({ initialFrame: 0 });
    await click("details");
    expect(kv()).toContainEqual(["Network", "0 requests"]);
    expect(container.querySelector(".kv a")).toBeNull();
  });
});

describe("the transport", () => {
  it("cycles playback speed through 1, 2, 4, 8 and 16", async () => {
    await render({ initialFrame: 0 });
    const speeds: (string | null)[] = [];
    for (let step = 0; step < 5; step += 1) {
      await click("Playback speed");
      speeds.push(button("Playback speed").textContent);
    }
    expect(speeds).toEqual(["2×", "4×", "8×", "16×", "1×"]);
  });

  it("previews the hovered capture and pages the scrubber by a tenth of the captures", async () => {
    await render({ initialFrame: 0 });
    const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!;
    slider.getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;
    await act(async () =>
      slider.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100 })),
    );
    const preview = container.querySelector(".scrub-preview")!;
    expect(preview.querySelector("img")?.getAttribute("src")).toBe("../screenshots/frame-1.png");
    expect(preview.querySelector("span")?.textContent).toBe("00:07 · frame 2");
    await act(async () =>
      slider.dispatchEvent(
        new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
      ),
    );
    expect(container.querySelector(".scrub-preview")).toBeNull();
    await key("PageUp", slider);
    expect(counter()).toBe("2 / 3");
    await key("PageDown", slider);
    expect(counter()).toBe("1 / 3");
    expect(slider.getAttribute("aria-valuetext")).toBe("00:00 of 00:14, frame 1 of 3");
  });

  it("clears a status notice on a seek and keeps it on a jump to live", async () => {
    await render();
    await click("Reload stream");
    expect(notice()).toContain("does not restart the participant");
    await click("Previous frame");
    expect(notice()).toBeNull();
    await click("Fullscreen");
    expect(notice()).toBe(
      "Fullscreen is unavailable in this browser or was declined. The player remains usable here.",
    );
    await click("Jump to live");
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(notice()).toContain("Fullscreen is unavailable");
  });

  it("copies the moment link and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await render({ initialFrame: 1 });
    await click("Copy moment link");
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/#/lane/participant/f/2`);
    expect(notice()).toBe("Link copied to this recorded moment.");
    expect(container.querySelector('[aria-label="Moment link"]')).toBeNull();
  });
});

describe("the filmstrip and activity list", () => {
  it("pages the filmstrip to earlier and later captures", async () => {
    longRecording();
    await render({ initialFrame: 500 });
    const first = () => container.querySelector(".filmstrip .fs .lab")?.textContent;
    expect(first()).toBe("08:00 · 481");
    await click("Later frames");
    expect(counter()).toBe("521 / 1000");
    expect(first()).toBe("08:20 · 501");
    await click("Earlier frames");
    expect(counter()).toBe("500 / 1000");
  });

  it("returns a paged activity list to the selected capture after a seek", async () => {
    longRecording();
    await render({ initialFrame: 500 });
    const window = () => container.querySelector(".feed-window")?.textContent;
    const on = () => container.querySelectorAll(".acts [data-on]").length;
    expect(window()).toBe("Entries 1451–1550 of 3000 · original events retained");
    expect(on()).toBe(3);
    await click("Later entries");
    expect(window()).toBe("Entries 1551–1650 of 3000 · original events retained");
    expect(on()).toBe(0);
    await click("Next frame");
    expect(window()).toBe("Entries 1454–1553 of 3000 · original events retained");
    expect(on()).toBe(3);
  });
});

describe("the evidence notes", () => {
  it("states how a selected entry relates to its capture", async () => {
    model = {
      ...model,
      rows: [
        row({ id: "same", title: "click (1, 1)", atMs: 10_000 }),
        row({ id: "earlier", title: "click (2, 2)", frameIndex: 1, atMs: 15_000 }),
      ],
    };
    const context = () => container.querySelector(".entry-capture")?.textContent;
    await render({ initialFrame: 0, initialEventId: "same" });
    expect(context()).toBe("Capture 00:00 · same recorded time");
    await render({ initialFrame: 1, initialEventId: "earlier", navigationRevision: 1 });
    expect(context()).toBe("Capture 00:07 · 2s after entry");
    model = {
      ...model,
      paced: "avg",
      frames: model.frames.map(({ atMs: _atMs, ...frame }) => frame),
      rows: [row({ id: "untimed", title: "click (3, 3)" })],
    };
    await render({ initialFrame: 0, initialEventId: "untimed", navigationRevision: 2 });
    expect(context()).toBe("Capture 1 · time unavailable · associated by trace order");
  });

  it("notes a long capture interval and the waits playback skips", async () => {
    stream = { ...stream, status: "passed" };
    model = { ...model, rows: [row({ id: "wait", title: "wait 2s" })] };
    await render({ initialFrame: 0 });
    expect(note()).toContain("Next capture +7s. Changes between captures are not recorded.");
    expect(note()).not.toContain("Playback skips");
    await act(async () => checkbox("Skip waits").click());
    expect(note()).toContain(
      "Next capture +7s. Changes between captures are not recorded. Playback skips 6s of this capture interval containing recorded waits.",
    );
  });

  it("counts the age of the latest capture while following a running participant", async () => {
    vi.useFakeTimers({ now: 100_000 });
    stream = { ...stream, embed: { kind: "placeholder" } } as ObserverStream;
    model = {
      ...model,
      frames: model.frames.map((frame, index) => ({ ...frame, atMs: 85_000 + index * 5000 })),
    };
    await render();
    expect(container.querySelector(".capture-line")?.textContent).toBe("Captured 5s ago");
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.querySelector(".capture-line")?.textContent).toBe("Captured 7s ago");
  });
});
