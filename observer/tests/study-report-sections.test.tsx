// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as fixtures from "../../scripts/observer-browser-fixtures.mjs";
import { StudyReport } from "../components/study-report";
import type { StudyReport as ReportData } from "../lib/study-report";

// Characterization of the report's states, finding rows and concerns through the rendered
// component. The fixture's captures are seven seconds apart, so the second capture is 00:07.
const data = fixtures.fixture();
type Finding = ReportData["findings"][number];

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F1",
    title: "A synthetic finding",
    impact: "friction",
    summary: "A synthetic summary.",
    scope: "One participant",
    limitation: "Synthetic limitation.",
    nextStep: "Check the addressed capture.",
    priorityReason: "Synthetic priority.",
    account: "",
    accountSource: "",
    moments: [
      {
        streamId: "lane-1",
        eventId: "lane-1-frame-2",
        label: "Second capture",
        note: "The lead note.",
        bases: ["visual"],
      },
      {
        streamId: "lane-1",
        eventId: "lane-1-action-2",
        label: "Recorded click",
        note: "The action note.",
        bases: ["action"],
      },
    ],
    ...overrides,
  };
}
function report(overrides: Partial<ReportData> = {}): ReportData {
  return {
    id: "synthetic-report",
    runId: data.run.runId,
    summary: "A synthetic report.",
    scope: "Synthetic scope.",
    findings: [finding()],
    outcomes: [],
    methodology: [],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
const handlers = {
  onFinding: vi.fn(),
  onOpen: vi.fn(),
  onOpenDesign: vi.fn(),
  onConcernsOpen: vi.fn(),
};

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function mount(
  props: Partial<ComponentProps<typeof StudyReport>> & { report: ReportData | undefined },
) {
  await act(async () =>
    root.render(<StudyReport data={data} findingId="" {...handlers} {...props} />),
  );
}
const text = (selector: string) =>
  [...container.querySelectorAll(selector)].map((node) => node.textContent);
async function press(element: Element) {
  await act(async () => (element as HTMLElement).click());
}

describe("report states", () => {
  it("says a finding the report does not contain is unavailable", async () => {
    await mount({ report: report(), findingId: "F9" });
    expect(container.querySelector('[role="alert"] h2')?.textContent).toBe("Findings unavailable");
    expect(container.querySelector('[role="alert"] p')?.textContent).toBe(
      "This finding could not be found.",
    );
  });

  it("keeps the notes and method of a failed analysis and says no findings are available", async () => {
    await mount({
      report: report({
        state: "failed",
        findings: [],
        messages: ["The provider refused the request."],
        methodology: ["A synthetic method."],
      }),
    });
    const notice = container.querySelector(".analysis-notice")!;
    expect(notice.textContent).toBe("Analysis failed. Participant evidence remains available.");
    expect(notice.getAttribute("data-analysis-state")).toBe("failed");
    expect(text(".analysis-messages summary")).toEqual(["Analysis notes (1)"]);
    expect(text(".analysis-messages li")).toEqual(["The provider refused the request."]);
    expect(text(".study-report-empty h2")).toEqual(["No findings available"]);
    expect(text(".study-report-empty p")).toEqual([
      "The original participant recordings and feedback are still available in Participants.",
    ]);
    expect(text(".report-method summary")).toEqual(["About this analysis"]);
    expect(text(".report-method p")).toEqual(["A synthetic method."]);
  });

  it("warns that a stale analysis predates the evidence and leaves missing moments closed", async () => {
    const stale = finding();
    stale.moments.push({
      streamId: "lane-1",
      eventId: "missing-event",
      label: "Removed entry",
      note: "",
    });
    await mount({ report: report({ state: "stale", findings: [stale] }), findingId: "F1" });
    const notice = container.querySelector(".analysis-notice")!;
    expect(notice.textContent).toBe(
      "Evidence has changed since this analysis. Review these findings against the current recording or generate a new analysis.",
    );
    expect(notice.hasAttribute("data-analysis-state")).toBe(false);
    const missing = container.querySelector<HTMLButtonElement>(
      '[data-report-moment="missing-event"]',
    )!;
    expect(missing.disabled).toBe(true);
    expect(missing.firstElementChild?.textContent).toBe("Time unavailable");
  });
});

describe("a finding row", () => {
  it("opens its lead capture and each supporting moment with the finding id", async () => {
    await mount({ report: report(), findingId: "F1" });
    expect(text('[data-finding="F1"] .report-rank')).toEqual(["01"]);
    expect(container.querySelector('[data-finding="F1"]')?.textContent).toContain(
      "One participant · 2 evidence moments",
    );
    const lead = container.querySelector<HTMLButtonElement>("button.report-evidence")!;
    expect(lead.getAttribute("aria-label")).toMatch(/^Open recording: .+ · 00:07$/);
    expect(lead.querySelector("img")?.getAttribute("src")).toBe("../screenshots/portrait-2.png");
    expect(lead.querySelector(".observation-basis")?.textContent).toBe("Visual observation");
    await press(lead);
    expect(handlers.onOpen).toHaveBeenLastCalledWith("lane-1", 1, undefined, "F1");
    const moments = [...container.querySelectorAll<HTMLButtonElement>("[data-report-moment]")];
    expect(moments.map((moment) => moment.getAttribute("aria-current"))).toEqual(["true", null]);
    expect(
      moments.map((moment) => moment.querySelector(".moment-source span")?.textContent),
    ).toEqual(["Visual observation · Second capture", "Recorded action · Recorded click"]);
    await press(moments[1]!);
    expect(handlers.onOpen).toHaveBeenLastCalledWith("lane-1", 1, "lane-1-action-2", "F1");
    expect(text(".report-next p")).toEqual(["Check the addressed capture."]);
    expect(text(".report-priority p")).toEqual(["Synthetic priority."]);
  });

  it("labels reviewer corrections and keeps the original finding beside them", async () => {
    await mount({
      report: report({
        findings: [
          finding({
            corrections: [
              {
                status: "confirmed",
                reason: "The capture shows it.",
                replacementClaim: null,
                createdAt: "2026-10-01T00:00:00.000Z",
              },
              {
                status: "amended",
                reason: "The form was sent.",
                replacementClaim: "The confirmation appeared late.",
                createdAt: "2026-10-02T00:00:00.000Z",
              },
            ],
          }),
        ],
      }),
      findingId: "F1",
    });
    const disposition = container.querySelector(".finding-disposition")!;
    expect(disposition.textContent).toBe("Amended");
    expect(disposition.getAttribute("data-disposition")).toBe("amended");
    expect(text(".finding-correction h3")).toEqual([
      "Confirmed by reviewer",
      "Amended by reviewer",
    ]);
    expect(text(".finding-correction:last-of-type p")).toEqual([
      "The form was sent.",
      "The confirmation appeared late.",
    ]);
    expect(text(".finding-correction span")).toEqual([
      "2026-10-01T00:00:00.000Z · Original finding retained",
      "2026-10-02T00:00:00.000Z · Original finding retained",
    ]);
  });

  it("shows cited statements, or the single account an older analysis recorded", async () => {
    await mount({
      report: report({
        findings: [
          finding({
            accounts: [
              { text: "It felt frozen.", label: "Participant 1", streamId: "lane-1", eventId: "x" },
            ],
          }),
        ],
      }),
      findingId: "F1",
    });
    expect(text(".report-account summary")).toEqual(["Cited participant statements"]);
    expect(text(".report-account blockquote")).toEqual(["It felt frozen."]);
    expect(text(".report-account figcaption")).toEqual(["Participant 1"]);
    await mount({
      report: report({
        findings: [finding({ account: "It felt slow.", accountSource: "Final message" })],
      }),
      findingId: "F1",
    });
    expect(text(".report-account summary")).toEqual(["Participant feedback"]);
    expect(text(".report-account blockquote")).toEqual(["It felt slow."]);
    expect(text(".report-account p")).toEqual(["Final message"]);
  });
});

describe("concerns considered", () => {
  const concern = (
    disposition: "finding" | "context" | "unsupported",
    findingId: string | null,
    moments: { streamId: string; eventId: string }[],
  ) => ({
    claim: `A ${disposition} claim.`,
    basis: "inference" as const,
    limitation: "",
    disposition,
    findingId,
    reason: `The ${disposition} reason.`,
    moments,
  });

  it("links an included finding and opens concern evidence without a finding id", async () => {
    await mount({
      report: report({
        concernReviews: [
          concern("finding", "F1", [{ streamId: "lane-1", eventId: "lane-1-action-2" }]),
          concern("context", null, []),
          concern("unsupported", null, [
            { streamId: "lane-2", eventId: "lane-2-action-1" },
            { streamId: "lane-2", eventId: "lane-2-frame-3" },
          ]),
        ],
      }),
      concernsOpen: false,
    });
    expect(text(".report-concerns > summary")).toEqual(["Concerns considered (3)"]);
    expect(text(".concern-disposition")).toEqual(["Context only", "Not established"]);
    expect(text(".concern-claim")).toEqual([
      "A finding claim.",
      "A context claim.",
      "A unsupported claim.",
    ]);
    await press(container.querySelector(".concern-heading button")!);
    expect(handlers.onFinding).toHaveBeenLastCalledWith("F1");
    const evidence = [...container.querySelectorAll(".concern-evidence button")];
    expect(
      evidence.map((item) => item.getAttribute("aria-label")?.replace(/: .+? · /, ": · ")),
    ).toEqual([
      "Open concern evidence: · 00:07 · 1 of 1",
      "Open concern evidence: · 00:00 · 1 of 2",
      "Open concern evidence: · 00:14 · 2 of 2",
    ]);
    await press(evidence[0]!);
    expect(handlers.onOpen).toHaveBeenLastCalledWith("lane-1", 1, "lane-1-action-2", "");
    const details = container.querySelector<HTMLDetailsElement>(".report-concerns")!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(handlers.onConcernsOpen).toHaveBeenLastCalledWith(true);
  });

  it("says when no material concern was recorded", async () => {
    await mount({ report: report({ concernReviews: [] }) });
    expect(container.querySelector(".report-concerns")?.textContent).toContain(
      "No material concerns were recorded in this review.",
    );
  });
});
