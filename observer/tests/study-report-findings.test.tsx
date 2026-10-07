// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as fixtures from "../../scripts/observer-browser-fixtures.mjs";
import type { LoadedAnalysis } from "../../src/analysis/types";
import { StudyReport } from "../components/study-report";
import { parseStudyAnalysis, projectStudyAnalysis } from "../lib/study-analysis";

// The synthetic analyses the browser proof renders, through the same parse and projection.
const data = fixtures.fixture();
const project = (saved: LoadedAnalysis) =>
  projectStudyAnalysis(parseStudyAnalysis(saved, data), data)!;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(
  saved: LoadedAnalysis,
  findingId: string,
  handlers: { onOpen?: () => void; onOpenDesign?: () => void } = {},
): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <StudyReport
        data={data}
        report={project(saved)}
        findingId={findingId}
        onFinding={() => undefined}
        onOpen={handlers.onOpen ?? (() => undefined)}
        onOpenDesign={handlers.onOpenDesign ?? (() => undefined)}
      />,
    ),
  );
}

const panel = (id: string) =>
  container.querySelector<HTMLElement>(`[data-finding-row="${id}"] .finding-panel`)!;

describe("a finding with a plain headline", () => {
  it("leads with its headline and experience and keeps the evidence collapsed beneath", async () => {
    await mount(fixtures.plainFindingsFixture(data), "F1");
    const trigger = container.querySelector('[data-finding="F1"]')!;
    expect(trigger.textContent).toContain(
      "One participant could not tell whether their form was sent.",
    );
    expect(trigger.textContent).not.toContain("A recorded action needs investigation");
    expect(panel("F1").querySelector(".report-experience")?.textContent).toBe(
      "They filled in the fictional form and pressed Submit. Nothing on the screen changed, so they pressed it twice more and said it felt like the page had frozen.",
    );
    const evidence = panel("F1").querySelector<HTMLDetailsElement>("details.finding-evidence")!;
    expect(evidence.open).toBe(false);
    expect(evidence.querySelector("summary")?.textContent).toBe(
      "Evidence: A recorded action needs investigation",
    );
    expect(evidence.querySelector(".report-claim")?.textContent).toBe(
      "A synthetic observation for testing the evidence review workflow.",
    );
    expect(evidence.textContent).toContain("Observation details (1)");
  });

  it("says an amended finding was corrected in place of its experience", async () => {
    const saved = fixtures.plainFindingsFixture(data);
    saved.corrections = [
      {
        schema: "humanish.study-analysis-correction.v1",
        id: "correction-1",
        analysisId: "synthetic-analysis-1",
        analysisSha256: "c".repeat(64),
        findingId: "F1",
        findingSha256: "d".repeat(64),
        createdAt: "2026-10-07T00:00:00.000Z",
        status: "amended",
        reason: "The capture shows the form was sent.",
        replacementClaim: "The form was sent, but its confirmation appeared late.",
      },
    ];
    await mount(saved, "F1");
    expect(container.querySelector('[data-finding="F1"]')!.textContent).toContain(
      "The form was sent, but its confirmation appeared late.",
    );
    expect(panel("F1").querySelector(".report-experience")?.textContent).toBe(
      "Corrected in human review. The reviewer's claim replaces the original headline and account.",
    );
    expect(panel("F1").textContent).not.toContain("They filled in the fictional form");
  });

  it("renders an analysis written before headlines with its title and summary in view", async () => {
    await mount(fixtures.analysisFixture(data), "F1");
    expect(container.querySelector('[data-finding="F1"]')!.textContent).toContain(
      "A recorded action needs investigation",
    );
    expect(panel("F1").querySelector(".finding-evidence")).toBeNull();
    expect(panel("F1").querySelector(".report-experience")).toBeNull();
    expect(panel("F1").querySelector(".report-claim")?.textContent).toBe(
      "A synthetic observation for testing the evidence review workflow.",
    );
    expect(container.querySelector(".report-design")).toBeNull();
  });
});

describe("design findings", () => {
  it("are grouped by severity, each with its screen, reasons and a capture that opens", async () => {
    const onOpenDesign = vi.fn();
    await mount(fixtures.plainFindingsFixture(data), "", { onOpenDesign });
    const section = container.querySelector<HTMLElement>(".report-design")!;
    expect(section.querySelector("h2")?.textContent).toBe("Design findings (2)");
    expect([...section.querySelectorAll(".design-group > h3")].map((h) => h.textContent)).toEqual([
      "Major: misleads or blocks (1)",
      "Minor: polish (1)",
    ]);
    expect(
      [...section.querySelectorAll<HTMLElement>("[data-design-finding]")].map(
        (item) => item.dataset.designFinding,
      ),
    ).toEqual(["D2", "D1"]);
    const major = section.querySelector<HTMLElement>('[data-design-finding="D2"]')!;
    expect(major.querySelector("h4")?.textContent).toBe(
      "The Submit button is cut off at the bottom of the window.",
    );
    expect(
      [...major.querySelectorAll("dt")].map((term) => [
        term.textContent,
        term.nextElementSibling?.textContent,
      ]),
    ).toEqual([
      ["Screen", "Form page"],
      [
        "What a designer notices",
        "Only the top half of the primary button is visible without scrolling.",
      ],
      ["Why it matters", "A person may not see that the form has a next step."],
      ["Suggestion", "Keep the primary action inside the first screen, or pin it to the bottom."],
    ]);
    expect(major.querySelector(".design-meta")?.textContent).toBe(
      "Seen by Persona 1 · high confidence",
    );
    const capture = major.querySelector<HTMLButtonElement>("button.design-capture")!;
    expect(capture.querySelector("img")?.getAttribute("src")).toBe("../screenshots/portrait-3.png");
    await act(async () => capture.click());
    expect(onOpenDesign).toHaveBeenCalledWith("lane-1", 2, undefined);
  });

  it("say the design review found nothing when the list is empty", async () => {
    const saved = fixtures.plainFindingsFixture(data);
    saved.analysis!.result!.designFindings = [];
    await mount(saved, "");
    expect(container.querySelector(".report-design")?.textContent).toContain(
      "The design review found no problem in the reviewed captures.",
    );
  });
});
