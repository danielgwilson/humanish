// @vitest-environment jsdom
// Characterization of the App frame through the rendered App: the study library, the skip link,
// the study views bar, the run notices, the participants view's context line and the grid
// preferences that outlive the grid.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as fixtures from "../../scripts/observer-browser-fixtures.mjs";
import { App } from "../app";
import type { ObserverData } from "../lib/observer-data";
import type { RunNote } from "../lib/run-notes";
import type { StudyReport } from "../lib/study-report";
import { NO_ANALYSIS, parseStudyAnalysis, projectStudyAnalysis } from "../lib/study-analysis";
import { scaleFixture } from "./scale-fixture";

const RUN = "synthetic-observer-browser-proof";
let container: HTMLDivElement;
let root: Root;

function quietMedia(): void {
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
}
/** Every media query reports phone width until `widen` fires a change to desktop width. */
function phoneMedia() {
  const listeners = new Set<() => void>();
  const media = {
    matches: true,
    media: "",
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  window.matchMedia = (() => media) as unknown as typeof window.matchMedia;
  const change = async (matches: boolean) => {
    media.matches = matches;
    await act(async () => listeners.forEach((listener) => listener()));
  };
  return { widen: () => change(false), narrow: () => change(true) };
}
async function render(element: React.ReactElement): Promise<void> {
  await act(async () => root.render(element));
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
/** Dispatches a cancelable click and says whether the page took it over. */
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
async function compare(streamId: string): Promise<void> {
  await click(find(`[data-stream-id="${streamId}"] .card-details-trigger`));
  await click(find('.pop-panel button[aria-label^="Compare participant"]'));
  await click(find('.pop-panel [aria-label="Close participant details"]'));
}
const libraryToggle = () => find('[aria-label="Toggle study library"]');
const staticSidebar = () => document.querySelector(".frame > .side");
const pageLine = () => document.querySelector(".grid-pages span")?.textContent ?? null;
const attention = () => document.querySelector(".main .run-status:not(.run-status-compact)");

function note(atMs: number, text: string): RunNote {
  return {
    id: `note-20260901t110000000z-${String(atMs).padStart(12, "0")}`,
    atMs,
    participant: null,
    nearest: null,
    text,
    author: "you",
    createdAt: "2026-09-01T11:00:00.000Z",
    editedAt: null,
  };
}
function withReport(): { data: ObserverData; report: StudyReport } {
  const data = fixtures.fixture();
  const report = projectStudyAnalysis(
    parseStudyAnalysis(fixtures.plainFindingsFixture(data), data),
    data,
  )!;
  return { data, report };
}

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => undefined;
});
beforeEach(() => {
  quietMedia();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // A served page polls; these tests hold every request open so no answer changes the view.
  vi.spyOn(window, "fetch").mockImplementation(() => new Promise<Response>(() => undefined));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  window.history.replaceState(null, "", window.location.pathname);
});

describe("the study library", () => {
  it("starts collapsed from ?sidebar=closed on a served page", async () => {
    window.history.replaceState(null, "", "/?sidebar=closed");
    await render(<App data={fixtures.fixture()} />);
    expect(staticSidebar()?.hasAttribute("inert")).toBe(true);
    expect(libraryToggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("starts collapsed in a snapshot of one study and open in a snapshot of two or by choice", async () => {
    const data = fixtures.fixture();
    await render(<App data={data} snapshot />);
    expect(staticSidebar()?.hasAttribute("inert")).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(container);
    const library = {
      entries: [
        { runId: RUN, title: "This study", description: "Synthetic" },
        { runId: "synthetic-other", title: "Other study", description: "Synthetic" },
      ],
      onSelect: () => undefined,
    };
    await render(<App data={data} snapshot library={library} />);
    expect(staticSidebar()?.hasAttribute("inert")).toBe(false);
    expect(document.querySelector(".topbar")?.textContent).toContain("This study");
    await act(async () => root.unmount());
    root = createRoot(container);
    localStorage.setItem("humanish-sidebar", "open");
    await render(<App data={data} snapshot />);
    expect(staticSidebar()?.hasAttribute("inert")).toBe(false);
  });

  it("keeps the collapse control working when browser storage refuses it", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    await render(<App data={fixtures.fixture()} snapshot />);
    expect(staticSidebar()?.hasAttribute("inert")).toBe(false);
    await click(libraryToggle());
    expect(staticSidebar()?.hasAttribute("inert")).toBe(true);
    await click(libraryToggle());
    expect(staticSidebar()?.hasAttribute("inert")).toBe(false);
  });

  it("on a phone, closes the drawer after a pick and when the window widens", async () => {
    const media = phoneMedia();
    const picked: string[] = [];
    const library = {
      entries: [
        { runId: RUN, title: "This study", description: "Synthetic" },
        { runId: "synthetic-other", title: "Other study", description: "Synthetic" },
      ],
      onSelect: (id: string) => picked.push(id),
    };
    await render(<App data={fixtures.fixture()} library={library} />);
    expect(staticSidebar()).toBeNull();
    await click(libraryToggle());
    expect(libraryToggle().getAttribute("aria-expanded")).toBe("true");
    await click(find('.drawer-pop [data-study-id="synthetic-other"]'));
    expect(picked).toEqual(["synthetic-other"]);
    expect(libraryToggle().getAttribute("aria-expanded")).toBe("false");

    await click(libraryToggle());
    expect(libraryToggle().getAttribute("aria-expanded")).toBe("true");
    await media.widen();
    expect(staticSidebar()).not.toBeNull();
    await media.narrow();
    expect(staticSidebar()).toBeNull();
    expect(libraryToggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("on a phone, closes the drawer after choosing the current study", async () => {
    phoneMedia();
    await render(<App data={fixtures.fixture()} />);
    await click(find('[data-stream-id="lane-1"] .open-overlay'));
    await click(libraryToggle());
    await click(find(`.drawer-pop [data-study-id="${RUN}"]`));
    expect(libraryToggle().getAttribute("aria-expanded")).toBe("false");
    expect(window.location.hash).toBe("");
    expect(document.querySelectorAll(".gallery .card")).toHaveLength(3);
  });
});

describe("the frame", () => {
  it("skips to the evidence without changing the address", async () => {
    await render(<App data={fixtures.fixture()} snapshot />);
    expect(await clickPrevented(find(".skip-observer"))).toBe(true);
    expect(document.activeElement).toBe(find("#observer-content"));
    expect(window.location.hash).toBe("");
  });

  it("marks the current view and counts findings and notes", async () => {
    const { data, report } = withReport();
    const notes = { notes: [note(1000, "First"), note(2000, "Second")], token: null };
    await render(
      <App data={data} report={report} snapshot notes={{ ...notes, unreadable: false }} />,
    );
    const participants = find('.study-views a[aria-label="All participants"]');
    const findings = find('.study-views a[href="#/report"]');
    expect(participants.textContent).toBe("Participants 3");
    expect(findings.textContent).toBe("Findings 22 notes");
    expect(find(".viewbar-notes").textContent).toBe("2 notes");
    expect(participants.getAttribute("aria-current")).toBe("page");
    expect(findings.hasAttribute("aria-current")).toBe(false);
    expect(await clickPrevented(findings)).toBe(true);
    expect(findings.getAttribute("aria-current")).toBe("page");
    expect(participants.hasAttribute("aria-current")).toBe(false);
    expect(document.querySelector(".study-report")).not.toBeNull();
  });

  it("counts one note in the singular and keeps Findings current in a recording opened from it", async () => {
    const { data, report } = withReport();
    await render(
      <App
        data={data}
        report={report}
        snapshot
        notes={{ notes: [note(1000, "Only")], token: null, unreadable: false }}
      />,
    );
    expect(find(".viewbar-notes").textContent).toBe("1 note");
    await click(find('.study-views a[href="#/report"]'));
    await click(find(".design-capture"));
    expect(window.location.hash).toMatch(/^#\/lane\//);
    expect(find('.study-views a[href="#/report"]').getAttribute("aria-current")).toBe("page");
  });

  it("shows a pending mark or a dash for findings while automatic analysis has no report", async () => {
    const data = fixtures.fixture();
    const automatic = (state: "queued" | "failed") => ({
      ...NO_ANALYSIS,
      automatic: { state, analysisId: null, reason: null, updatedAt: new Date().toISOString() },
    });
    await render(<App data={data} analysis={automatic("queued")} />);
    const count = () => find('.study-views a[href="#/report"] span');
    expect(count().textContent).toBe("…");
    expect(count().getAttribute("aria-label")).toBe("Analysis is queued.");
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(<App data={data} analysis={automatic("failed")} />);
    expect(count().textContent).toBe("—");
    expect(count().getAttribute("aria-label")).toBe("Analysis failed.");
  });

  it("leaves a modified click on a view link to the browser", async () => {
    const { data, report } = withReport();
    await render(<App data={data} report={report} snapshot />);
    const findings = find('.study-views a[href="#/report"]');
    for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"] as const)
      expect(await clickPrevented(findings, { [modifier]: true }), modifier).toBe(false);
    expect(await clickPrevented(findings, { button: 1 })).toBe(false);
  });

  it("shows the run status with Exit monitor while monitoring, and leaves monitoring from it", async () => {
    await render(<App data={fixtures.fixture()} snapshot />);
    expect(attention()).toBeNull();
    await click(find('[aria-label="View and filter participants"]'));
    await click(button("Monitor", find(".pop-panel")));
    expect(find(".observer-shell").classList.contains("monitoring")).toBe(true);
    expect(staticSidebar()).toBeNull();
    await click(button("Exit monitor", attention()!));
    expect(find(".observer-shell").classList.contains("monitoring")).toBe(false);
    expect(attention()).toBeNull();
    expect(staticSidebar()).not.toBeNull();
  });

  it("shows the run status above the evidence for an interrupted or unconfirmed run", async () => {
    const runtime = (state: "interrupted" | "unknown" | "finished") => ({
      ...fixtures.fixture(),
      runtime: { state, observedAt: new Date().toISOString(), source: "local-run-status" as const },
    });
    for (const [state, shown] of [
      ["interrupted", true],
      ["unknown", true],
      ["finished", false],
    ] as const) {
      await render(<App data={runtime(state)} snapshot />);
      expect(!!attention(), state).toBe(shown);
      if (shown) expect(attention()?.textContent).not.toContain("Exit monitor");
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });
});

describe("the participants view", () => {
  it("puts the way back, the pager and the analyzed outcome above a frame-free participant", async () => {
    const data = fixtures.fixture({ frames: 0 });
    const report: StudyReport = {
      id: "synthetic-report",
      runId: RUN,
      summary: "",
      scope: "",
      findings: [],
      outcomes: [{ streamId: "lane-2", label: "Reported complete" }],
      methodology: [],
    };
    await render(<App data={data} report={report} snapshot />);
    await click(find('[data-stream-id="lane-2"] .open-overlay'));
    expect(find(".stub")).not.toBeNull();
    expect(find("h2.sr-only").textContent).toBe("Synthetic participant 2 recording");
    const context = find(".study-context-actions");
    expect(context.querySelector(".recording-return")?.getAttribute("aria-label")).toBe(
      "Back to participants",
    );
    expect(context.querySelector(".pager")?.textContent).toBe("participant 2 / 3");
    expect(context.querySelector(".report-outcome-context")?.textContent).toBe(
      "Analyzed outcome: Reported complete",
    );
    await click(find('.pager [aria-label="Next participant"]'));
    expect(find("h2.sr-only").textContent).toBe("Synthetic participant 3 recording");
    expect(document.querySelector(".report-outcome-context")).toBeNull();
  });

  it("counts the compare selection, states the limit at three, and names the comparison", async () => {
    await render(<App data={fixtures.fixture()} snapshot />);
    expect(document.querySelector(".study-context-actions")).toBeNull();
    await compare("lane-1");
    await compare("lane-2");
    const selection = () => find(".study-context-actions .compare-selection");
    expect(selection().textContent).toBe("Compare selected (2/3)");
    expect(selection().querySelector('[role="status"]')).toBeNull();
    await compare("lane-3");
    expect(selection().querySelector("button")?.textContent).toBe("Compare selected (3/3)");
    expect(selection().querySelector('[role="status"]')?.textContent).toBe(
      "Comparison limit: 3 participants. Remove one to choose another.",
    );
    await click(button("Compare selected (3/3)"));
    expect(find("h2.sr-only").textContent).toBe("Compare participants");
    expect(document.querySelector(".study-context-actions")).toBeNull();
  });
});

describe("grid preferences", () => {
  it("keep the grid's page while a participant is open", async () => {
    await render(<App data={scaleFixture(40)} snapshot />);
    await click(button("Next page"));
    expect(pageLine()).toBe("Showing 37–40 of 40 participants");
    const last = [...document.querySelectorAll<HTMLElement>(".gallery .card")].at(-1)!;
    await click(last.querySelector<HTMLElement>(".open-overlay")!);
    expect(pageLine()).toBeNull();
    await click(find(".recording-return"));
    expect(pageLine()).toBe("Showing 37–40 of 40 participants");
  });

  it("keep at most fifty pins, dropping the oldest", async () => {
    const older = Array.from({ length: 50 }, (_, index) => `older-${index}`);
    localStorage.setItem(`humanish-observer-pins-${RUN}`, JSON.stringify(older));
    await render(<App data={fixtures.fixture()} snapshot />);
    await click(find('[data-stream-id="lane-2"] .card-pin-toggle'));
    const saved = JSON.parse(localStorage.getItem(`humanish-observer-pins-${RUN}`)!) as string[];
    expect(saved).toHaveLength(50);
    expect(saved[0]).toBe("older-1");
    expect(saved.at(-1)).toBe("lane-2");
    expect(document.querySelector(".gallery .card")?.getAttribute("data-stream-id")).toBe("lane-2");
  });

  it("save the preview size and read it back", async () => {
    const data = fixtures.fixture();
    await render(<App data={data} snapshot />);
    expect(find(".gallery").classList.contains("density-comfortable")).toBe(true);
    await click(find('[aria-label="View and filter participants"]'));
    await choose("Preview size", "compact");
    expect(find(".gallery").classList.contains("density-compact")).toBe(true);
    expect(localStorage.getItem("humanish-observer-density")).toBe('"compact"');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(<App data={data} snapshot />);
    expect(find(".gallery").classList.contains("density-compact")).toBe(true);
  });
});
