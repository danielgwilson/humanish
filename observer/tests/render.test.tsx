// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import firstRun from "../../tests/golden/observer-data/first-run.json";
import { App } from "../app";
import type { ObserverData } from "../lib/observer-data";

// The golden is schema-proven at the repo root (tests/observer-data-contract.test.ts);
// rendering it here proves the scaffold consumes the frozen contract as-is.
const data = firstRun as unknown as ObserverData;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom implements neither; the player's feed auto-follow calls scrollIntoView.
  Element.prototype.scrollIntoView = () => undefined;
  // jsdom has no matchMedia; the register contract (lib/humanish/theme.ts) reads it.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
});

async function mount(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
});

describe("the filter funnel (second Base UI adoption: popover/sheet)", () => {
  it("filters live behind the funnel; the badge counts active filters", async () => {
    await mount(<App data={data} />);
    expect(container.querySelector(".pop-panel")).toBeNull();
    await click(container.querySelector('[aria-label="Filter participants"]') as Element);
    const panel = document.querySelector(".pop-panel");
    expect(panel).not.toBeNull();
    const search = panel?.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      set.call(search, "nomatch-xyz");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("No participants match");
    expect(container.querySelector(".filter-count")?.textContent).toBe("1");
  });
});

describe("the run library control (D6: first Base UI adoption)", () => {
  it("desktop: collapses and restores the static sidebar, persisted", async () => {
    window.localStorage.removeItem("humanish-sidebar");
    await mount(<App data={data} />);
    expect(container.querySelector(".side")).not.toBeNull();
    const toggle = container.querySelector('[aria-label="Toggle run library"]') as Element;
    await click(toggle);
    expect(container.querySelector(".side")).toBeNull();
    expect(window.localStorage.getItem("humanish-sidebar")).toBe("closed");
    await click(toggle);
    expect(container.querySelector(".side")).not.toBeNull();
  });

  it("phone: the same control opens the library as a Base UI drawer instead", async () => {
    window.localStorage.removeItem("humanish-sidebar");
    const original = window.matchMedia;
    // jsdom has no layout; the click-time width check is the only viewport branch.
    window.matchMedia = ((query: string) =>
      ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    try {
      await mount(<App data={data} />);
      const toggle = container.querySelector('[aria-label="Toggle run library"]') as Element;
      await click(toggle);
      const pop = document.querySelector(".drawer-pop");
      expect(pop).not.toBeNull();
      expect(pop?.querySelector(".side")).not.toBeNull();
      // the static sidebar state is untouched by the drawer path
      expect(window.localStorage.getItem("humanish-sidebar")).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("observer scaffold rendering the first-run golden", () => {
  it("renders the study grid: tally line + one card per participant", async () => {
    await mount(<App data={data} />);
    expect(container.querySelectorAll(".card")).toHaveLength(4);
    const tally = container.querySelector(".countline")?.textContent ?? "";
    expect(tally).toContain("4 participants");
    expect(tally).toContain("4 warnings");
    expect(tally).toContain("dry-run");
    // every card carries exactly one signal line
    expect(container.querySelectorAll(".card .sig-label")).toHaveLength(4);
  });

  it("register toggle writes data-theme and persists the explicit choice", async () => {
    await mount(<App data={data} />);
    const toggle = container.querySelector('button[aria-label="Toggle color register"]');
    expect(toggle).not.toBeNull();
    await click(toggle as Element);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("humanish-theme")).toBe("dark");
    await click(toggle as Element);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("opens a frameless participant into the evidence stub and returns on Escape", async () => {
    await mount(<App data={data} />);
    const overlay = container.querySelector(".open-overlay");
    expect(overlay).not.toBeNull();
    await click(overlay as Element);
    expect(container.textContent).toContain("no screenshot frames");
    expect(container.querySelector(".pager")).not.toBeNull();
    // The player breadcrumbs carry an explicit back affordance.
    const back = container.querySelector(".crumb-back");
    expect(back).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelectorAll(".card")).toHaveLength(4);
  });

  it("renders the honest empty state when no data is inlined", async () => {
    await mount(<App data={null} />);
    expect(container.textContent).toContain("opened without run data");
  });
});

// A live-shaped stream, grafted onto the frozen golden IN THE TEST (the committed
// goldens stay dry-run; a live-shaped golden lands with the contract-addition PR).
// Shapes mirror humanish.actor-trace.v1 as produced by the computer-use route.
function liveShapedData(options: { live?: boolean; ended?: boolean } = {}): ObserverData {
  const clone = structuredClone(firstRun) as unknown as { streams: Array<Record<string, unknown>> };
  const stream = clone.streams[0];
  if (!stream) throw new Error("fixture has no stream");
  stream.timeline = []; // dry-run warn events would outrank the notable completion below
  if (options.live) {
    stream.status = "running";
    stream.statusLabel = "Running";
    // The shape the attached watch server injects (withRuntimeStreamUrls, #357).
    stream.embed = { kind: "iframe", url: "https://live.example/desktop", title: "Live desktop" };
    if (options.ended) stream.liveEnded = true;
  }
  stream.actor = {
    provider: "computer-use-loop",
    durationMs: 191_864,
    status: "passed",
    completionReason: "budget_reached",
    reason: "estimated spend $5.14 crossed execution.caps.maxUsd=$5 after productive activity",
    ids: { model: "synthetic-model" },
    redaction: { status: "passed", screenshots: "raw", notes: "synthetic" },
    items: [
      {
        id: "screenshot-001",
        kind: "screenshot",
        lifecycle: "completed",
        title: "turn-00-start",
        screenshotRef: { path: "screenshots/lane/turn-00-start.png", redaction: "none" }
      },
      // Reasoning precedes the actions it motivated, exactly as capture orders a turn (#427).
      {
        id: "reasoning-001",
        kind: "reasoning",
        lifecycle: "completed",
        title: "reasoning turn 1",
        text: "**Scanning the form** The form is empty; I will tab to the first field."
      },
      { id: "ui_action-001", kind: "ui_action", lifecycle: "completed", title: "keypress TAB" },
      {
        id: "screenshot-002",
        kind: "screenshot",
        lifecycle: "completed",
        title: "turn-01",
        screenshotRef: { path: "screenshots/lane/turn-01.png", redaction: "none" }
      },
      {
        id: "reasoning-002",
        kind: "reasoning",
        lifecycle: "completed",
        title: "reasoning turn 2",
        text: "**Confirming** A confirm dialog appeared, so I will click its primary button."
      },
      { id: "ui_action-002", kind: "ui_action", lifecycle: "completed", title: "click (700, 420)" }
    ],
    affordanceUse: {
      schema: "humanish.affordance-use.v1",
      counts: { keyboard: 2, pointer: 1 },
      total: 3,
      shortcutTotal: 0
    }
  };
  return clone as unknown as ObserverData;
}

describe("observer scaffold rendering a live-shaped lane", () => {
  it("shows the keyframe thumb (last screenshot) and the ⚑ notable reason verbatim", async () => {
    await mount(<App data={liveShapedData()} />);
    const img = container.querySelector(".card .keyframe");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("../screenshots/lane/turn-01.png");
    const card = container.querySelector(".card");
    expect(card?.textContent).toContain("budget cap");
    expect(card?.textContent).toContain("crossed execution.caps.maxUsd=$5");
    // Duration rides the thumb as an overlay pill, not a meta line.
    expect(card?.querySelector(".th-dur")?.textContent).toBe("3m 12s");
  });

  it("opens into the review player: stage, filmstrip seek, pins, tabs", async () => {
    await mount(<App data={liveShapedData()} />);
    await click(container.querySelector(".open-overlay") as Element);

    // Player mounted at frame 0 with the full feed in the Actions tab.
    expect(container.querySelector(".player")).not.toBeNull();
    const stageImg = () => container.querySelector(".stage-box img")?.getAttribute("src");
    expect(stageImg()).toBe("../screenshots/lane/turn-00-start.png");
    expect(container.querySelectorAll(".filmstrip .fs")).toHaveLength(2);
    expect(container.querySelectorAll(".arow")).toHaveLength(6);
    // Scrubber markers: one tick for the frame with a recorded click, and the
    // end flag because the lane completed on a notable reason (budget cap).
    expect(container.querySelectorAll(".scrub-tick")).toHaveLength(1);
    expect(container.querySelector(".scrub-flag")).not.toBeNull();

    // Filmstrip seek advances the stage; the click action's parsed pin renders on frame 1.
    const thumbs = container.querySelectorAll(".filmstrip .fs");
    await click(thumbs[1] as Element);
    expect(stageImg()).toBe("../screenshots/lane/turn-01.png");
    expect(container.querySelectorAll(".pins .spin")).toHaveLength(1);

    // Report tab carries the recorded reason verbatim and the RAW chip shows in transport.
    const reportTab = [...container.querySelectorAll(".itabs button")].find((b) => b.textContent === "report");
    await click(reportTab as Element);
    expect(container.textContent).toContain("crossed execution.caps.maxUsd=$5 after productive activity");
    expect(container.querySelector(".rawchip")).not.toBeNull();
  });

  it("thought rows (#427): reported thinking in its own register, anchored to the prior frame", async () => {
    await mount(<App data={liveShapedData()} />);
    await click(container.querySelector(".open-overlay") as Element);

    const thoughts = container.querySelectorAll(".arow.thought");
    expect(thoughts).toHaveLength(2);
    // The row shows the summary itself, not the "reasoning turn N" chrome, and is
    // labeled as the participant's REPORTED thinking (self-narration, not ground truth).
    expect(thoughts[0]?.textContent).toContain("The form is empty");
    expect(thoughts[0]?.textContent).not.toContain("reasoning turn");
    expect(thoughts[0]?.getAttribute("title")).toContain("Reported thinking");
    // The provider's markdown **lead** renders as a bold span, never literal asterisks.
    expect(thoughts[0]?.querySelector("strong")?.textContent).toBe("Scanning the form");
    expect(thoughts[0]?.textContent).not.toContain("**");
    // Each thought anchors to the frame the participant was looking at when it thought it.
    await click(thoughts[1] as Element);
    expect(container.querySelector(".stage-box img")?.getAttribute("src")).toBe("../screenshots/lane/turn-01.png");
    // The transport tally separates thoughts from recorded actions.
    expect(container.querySelector(".t-meta")?.textContent).toContain("2 actions");
    expect(container.querySelector(".t-meta")?.textContent).toContain("2 thoughts");
  });

  it("live card ticker (#427 stage 2): the decide-line is the newest thought while the lane runs", async () => {
    const data = liveShapedData({ live: true });
    await mount(<App data={data} />);
    const ticker = container.querySelector(".csig.ticker");
    expect(ticker).not.toBeNull();
    // Newest thought wins, markdown bold leads flatten, and the line is labeled as thinking.
    expect(ticker?.textContent).toContain("thinking");
    expect(ticker?.textContent).toContain("A confirm dialog appeared");
    expect(ticker?.textContent).not.toContain("**");
    expect(ticker?.getAttribute("title")).toContain("Reported thinking");

    // A finished lane keeps the signal line — the ticker is a live-only surface.
    await mount(<App data={liveShapedData()} />);
    expect(container.querySelector(".csig.ticker")).toBeNull();
  });

  it("watching live: read-only stream stage, scrub-back replay, jump-to-live", async () => {
    await mount(<App data={liveShapedData({ live: true })} />);
    expect(container.querySelector(".card .chip")?.textContent).toBe("Live");
    await click(container.querySelector(".open-overlay") as Element);

    const iframe = () => container.querySelector(".stage-live iframe");
    expect(iframe()?.getAttribute("src")).toBe("https://live.example/desktop");

    // Scrubbing back swaps the stage to recorded frames (instant replay)…
    const thumbs = container.querySelectorAll(".filmstrip .fs");
    await click(thumbs[0] as Element);
    expect(iframe()).toBeNull();
    expect(container.querySelector(".stage-box img")?.getAttribute("src")).toBe("../screenshots/lane/turn-00-start.png");

    // …and jump-to-live returns to the stream.
    const jump = container.querySelector(".live-jump");
    expect(jump).not.toBeNull();
    await click(jump as Element);
    expect(iframe()).not.toBeNull();
  });

  it("a live lane streams before its first frame: the player's live stage, not the stub (#426)", async () => {
    const data = liveShapedData({ live: true });
    (data as unknown as { streams: Array<{ actor: { items: unknown[] } }> }).streams[0]!.actor.items = [];
    await mount(<App data={data} />);
    await click(container.querySelector(".open-overlay") as Element);
    expect(container.querySelector(".stage-live iframe")?.getAttribute("src")).toBe("https://live.example/desktop");
    expect(container.textContent).toContain("awaiting the first recorded frame");
    expect(container.querySelector(".stub")).toBeNull();
  });

  it("a live lane's grid thumb IS the stream (#331), read-only and capped", async () => {
    const data = liveShapedData({ live: true });
    await mount(<App data={data} />);
    const frame = container.querySelector(".thumb-live") as HTMLIFrameElement | null;
    expect(frame?.getAttribute("src")).toBe("https://live.example/desktop");
    expect(frame?.getAttribute("tabindex")).toBe("-1");
  });

  it("live thumbs autoconnect for at most four lanes; deeper live lanes keep the placeholder", async () => {
    const data = liveShapedData({ live: true });
    const holder = data as unknown as { streams: Array<Record<string, unknown>> };
    const first = holder.streams[0]!;
    holder.streams = [0, 1, 2, 3, 4].map((index) => ({
      ...structuredClone(first),
      id: `lane-${index}`,
      sim: { ...(first.sim as Record<string, unknown>), index: index + 1 }
    }));
    await mount(<App data={data} />);
    expect(container.querySelectorAll(".thumb-live")).toHaveLength(4);
    expect(container.querySelectorAll(".chip-dot").length).toBeGreaterThanOrEqual(5);
  });

  it("a lane whose sandbox ended falls back to recorded evidence (#357)", async () => {
    await mount(<App data={liveShapedData({ live: true, ended: true })} />);
    await click(container.querySelector(".open-overlay") as Element);
    expect(container.querySelector(".stage-live")).toBeNull();
    expect(container.querySelector(".stage-box img")).not.toBeNull();
    expect(container.textContent).toContain("stream ended · recorded evidence");
  });

  it("served mode lists the run library in the sidebar", async () => {
    const history = {
      latestRunId: "golden-first-run",
      runs: [
        { runId: "golden-first-run", href: "/_humanish/runs/golden-first-run/observer/index.html", status: "pass", mode: "dry-run", streamCount: 4 },
        { runId: "other-run", href: "/_humanish/runs/other-run/observer/index.html", status: "failed", mode: "live", streamCount: 2 }
      ]
    };
    vi.stubGlobal("fetch", (input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).includes("history")
          ? ({ ok: true, json: async () => history } as unknown as Response)
          : ({ ok: false } as unknown as Response)
      )
    );
    try {
      await mount(<App data={data} />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const link = container.querySelector('a[href="/_humanish/runs/other-run/observer/index.html"]');
      expect(link).not.toBeNull();
      expect(container.querySelector(".side [data-on] .mono-id")?.textContent).toBe("golden-first-run");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
