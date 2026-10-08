// @vitest-environment jsdom
// Navigation between the Observer's views and saved moments, through the rendered App: the
// address in the hash, the recording's way back in history state, focus after a return, and the
// moments kept in browser storage.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as fixtures from "../../scripts/observer-browser-fixtures.mjs";
import { App } from "../app";
import type { ObserverData } from "../lib/observer-data";
import type { StudyReport } from "../lib/study-report";
import { parseStudyAnalysis, projectStudyAnalysis } from "../lib/study-analysis";

const RUN = "synthetic-observer-browser-proof";
const F1_HEADLINE = "One participant could not tell whether their form was sent.";

let container: HTMLDivElement;
let root: Root;

function study(): { data: ObserverData; report: StudyReport } {
  const data = fixtures.fixture();
  const projected = projectStudyAnalysis(
    parseStudyAnalysis(fixtures.plainFindingsFixture(data), data),
    data,
  )!;
  const report: StudyReport = {
    ...projected,
    concernReviews: [
      {
        claim: "A participant paused on the second step.",
        basis: "visual",
        limitation: "",
        disposition: "context",
        findingId: null,
        reason: "The pause has no recorded cause.",
        moments: [{ streamId: "lane-2", eventId: "lane-2-action-2" }],
      },
    ],
  };
  return { data, report };
}

async function mount(data: ObserverData, report?: StudyReport): Promise<void> {
  await act(async () => root.render(<App data={data} snapshot {...(report ? { report } : {})} />));
}
async function remount(data: ObserverData, report?: StudyReport): Promise<void> {
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount(data, report);
}
function find<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  expect(match, text).toBeDefined();
  return match!;
}
async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}
async function press(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key }));
  });
}
/** Focus moves after the next paint. */
async function nextPaint(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
}
const returnButton = () => find(".recording-return");
const savedPanel = () => document.querySelector<HTMLElement>(".saved-moments");
async function openSavedMoments(): Promise<HTMLElement> {
  if (!savedPanel()) await click(find('[aria-label="Saved moments"]'));
  return savedPanel()!;
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
  localStorage.clear();
  window.history.replaceState(null, "", window.location.pathname);
});

describe("a recording opened from the report", () => {
  it("returns to its finding, opened and focused, and keeps that way back across a reload", async () => {
    const { data, report } = study();
    await mount(data, report);
    await click(find('.study-views a[href="#/report"]'));
    expect(window.location.hash).toBe("#/report");
    await click(find('[data-finding="F1"]'));
    expect(window.location.hash).toBe("#/report/F1");

    await click(find('[data-finding-row="F1"] .report-evidence'));
    expect(window.location.hash).toBe("#/lane/lane-1/f/2/e/lane-1-action-2");
    expect(window.history.state).toMatchObject({
      humanishRecordingSource: { runId: RUN, kind: "finding", findingId: "F1" },
    });
    expect(returnButton().dataset.returnKind).toBe("finding");
    expect(returnButton().getAttribute("aria-label")).toBe(`Back to finding: ${F1_HEADLINE}`);
    expect(returnButton().textContent).toBe(`← ${F1_HEADLINE}`);
    expect(find('.study-views a[href="#/report"]').getAttribute("aria-current")).toBe("page");

    await remount(data, report);
    expect(returnButton().dataset.returnKind).toBe("finding");

    await click(returnButton());
    expect(window.location.hash).toBe("#/report/F1");
    expect(find('[data-finding="F1"]').getAttribute("aria-expanded")).toBe("true");
    await nextPaint();
    expect(document.activeElement).toBe(find('[data-finding="F1"]'));
  });

  it("pages to the next participant with the same way back", async () => {
    const { data, report } = study();
    await mount(data, report);
    await click(find('.study-views a[href="#/report"]'));
    await click(find('[data-finding="F1"]'));
    await click(find('[data-finding-row="F1"] .report-evidence'));
    await click(find('[aria-label="Next participant"]'));
    // F1 cites no moment of lane-2, so its recording opens on its first frame.
    expect(window.location.hash).toBe("#/lane/lane-2/f/1");
    expect(returnButton().getAttribute("aria-label")).toBe(`Back to finding: ${F1_HEADLINE}`);
    await click(find('[aria-label="Previous participant"]'));
    expect(window.location.hash).toBe("#/lane/lane-1/f/2/e/lane-1-action-2");
  });

  it("returns from a design capture to the design findings heading", async () => {
    const { data, report } = study();
    await mount(data, report);
    await click(find('.study-views a[href="#/report"]'));
    await click(find('[data-design-finding="D2"] .design-capture'));
    expect(window.location.hash).toBe("#/lane/lane-1/f/3");
    expect(returnButton().getAttribute("aria-label")).toBe("Back to design findings");
    await click(returnButton());
    expect(window.location.hash).toBe("#/report");
    await nextPaint();
    expect(document.activeElement).toBe(find("#design-findings-heading"));
  });

  it("returns from concern evidence to the concerns, opened", async () => {
    const { data, report } = study();
    await mount(data, report);
    await click(find('.study-views a[href="#/report"]'));
    expect(find<HTMLDetailsElement>(".report-concerns").open).toBe(false);
    await click(find('button[aria-label^="Open concern evidence"]'));
    expect(window.location.hash).toBe("#/lane/lane-2/f/2/e/lane-2-action-2");
    expect(returnButton().getAttribute("aria-label")).toBe("Back to concerns considered");
    await click(returnButton());
    expect(window.location.hash).toBe("#/report");
    expect(find<HTMLDetailsElement>(".report-concerns").open).toBe(true);
    await nextPaint();
    expect(document.activeElement).toBe(find(".report-concerns > summary"));
  });
});

describe("the study views", () => {
  it("keep their own scroll position", async () => {
    const { data, report } = study();
    await mount(data, report);
    const content = find("#observer-content");
    await act(async () => {
      content.scrollTop = 240;
      content.dispatchEvent(new Event("scroll"));
    });
    await click(find('[data-stream-id="lane-1"] .open-overlay'));
    expect(content.scrollTop).toBe(0);
    await click(find('.study-views a[href="#/report"]'));
    expect(content.scrollTop).toBe(0);
    await act(async () => {
      content.scrollTop = 90;
      content.dispatchEvent(new Event("scroll"));
    });
    await click(find('.study-views a[aria-label="All participants"]'));
    expect(content.scrollTop).toBe(240);
    await click(find('.study-views a[href="#/report"]'));
    expect(content.scrollTop).toBe(90);
  });

  it("leave monitoring on Escape and on opening the report", async () => {
    const { data, report } = study();
    await mount(data, report);
    const monitor = async () => {
      await click(find('[aria-label="View and filter participants"]'));
      await click(button("Monitor", find(".pop-panel")));
      expect(find(".observer-shell").classList.contains("monitoring")).toBe(true);
    };
    await monitor();
    await press("Escape");
    expect(find(".observer-shell").classList.contains("monitoring")).toBe(false);
    await monitor();
    await click(find('.study-views a[href="#/report"]'));
    expect(find(".observer-shell").classList.contains("monitoring")).toBe(false);
  });
});

describe("the comparison", () => {
  async function choose(streamId: string): Promise<void> {
    await click(find(`[data-stream-id="${streamId}"] .card-details-trigger`));
    await click(find('.pop-panel button[aria-label^="Compare participant"]'));
    await click(find('.pop-panel [aria-label="Close participant details"]'));
  }

  it("opens a frame, comes back to the same address, and reopens it from the grid", async () => {
    const { data } = study();
    await mount(data);
    await choose("lane-1");
    await choose("lane-2");
    await click(button("Compare selected (2/3)"));
    const address = window.location.hash;
    expect(address).toMatch(/^#\/compare\?lane=lane-1&lane=lane-2&clock=shared&at=\d+$/);
    expect(document.querySelectorAll(".compare-participant")).toHaveLength(2);

    await click(find('.compare-participant[data-stream-id="lane-1"] .compare-open'));
    expect(window.location.hash).toBe("#/lane/lane-1/f/1");
    expect(returnButton().getAttribute("aria-label")).toBe("Back to comparison");

    await click(returnButton());
    expect(window.location.hash).toBe(address);
    expect(document.querySelectorAll(".compare-participant")).toHaveLength(2);

    await click(button("Back to participants", find(".compare-toolbar")));
    expect(window.location.hash).toBe("");
    expect(document.querySelectorAll(".card")).toHaveLength(3);
    await click(button("Compare selected (2/3)"));
    expect(window.location.hash).toBe(address);

    await press("Escape");
    expect(window.location.hash).toBe("");
    expect(document.querySelector(".comparison")).toBeNull();
  });
});

describe("saved moments", () => {
  it("saves the paused frame, clears the message on navigation, and opens the moment again", async () => {
    const { data } = study();
    window.history.replaceState(null, "", "#/lane/lane-1/f/2");
    await mount(data);
    const panel = await openSavedMoments();
    expect(panel.textContent).toContain("No saved moments yet.");
    await click(button("Save current moment", panel));
    expect(find(".saved-moments [role=status]").textContent).toBe("Moment saved.");
    const stored: unknown = JSON.parse(localStorage.getItem("humanish-observer-moments") ?? "");
    expect(stored).toEqual([
      {
        runId: RUN,
        streamId: "lane-1",
        itemId: "lane-1-frame-2",
        frame: 1,
        savedAt: expect.any(String),
      },
    ]);

    await click(find('.study-views a[aria-label="All participants"]'));
    expect(window.location.hash).toBe("");
    const reopened = await openSavedMoments();
    expect(find(".saved-moments [role=status]").textContent).toBe("");
    expect(reopened.textContent).not.toContain("Save current moment");

    await click(button("· frame 2", reopened));
    expect(window.location.hash).toBe("#/lane/lane-1/f/2");
    expect(find(".stage-box img").getAttribute("src")).toBe("../screenshots/portrait-2.png");
    expect(savedPanel()).toBeNull();
  });

  it("refuses a moment whose frame or entry the recording no longer holds", async () => {
    const { data } = study();
    const moment = { runId: RUN, streamId: "lane-1", savedAt: "2026-10-08T00:00:00.000Z" };
    localStorage.setItem(
      "humanish-observer-moments",
      JSON.stringify([
        { ...moment, itemId: "lane-1-frame-9", frame: 8 },
        { ...moment, itemId: "lane-1-frame-2", frame: 1, eventId: "lane-1-action-3" },
      ]),
    );
    await mount(data);
    const panel = await openSavedMoments();
    await click(button("· frame 9", panel));
    expect(find(".saved-moments [role=status]").textContent).toBe(
      "This saved frame is no longer in the available recording.",
    );
    await click(button("· frame 2", panel));
    expect(find(".saved-moments [role=status]").textContent).toBe(
      "This saved entry is no longer in its recorded capture interval.",
    );
    expect(window.location.hash).toBe("");
    expect(savedPanel()).not.toBeNull();
  });
});
