// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ParticipantFeedback } from "../components/participant-feedback";
import * as fixtures from "../../scripts/observer-browser-fixtures.mjs";

it("pages through original statements, excludes other evidence kinds and keeps exact source links", async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const data = fixtures.fixture(), stream = data.streams[0]!;
  stream.actor!.items.push(...Array.from({ length: 25 }, (_, i) => ({ id: `statement-${i}`, kind: "message" as const, lifecycle: "completed" as const, title: `Statement ${i}`, text: `Original statement number ${i}.` })),
    { id: "not-statement", kind: "reasoning", lifecycle: "completed", title: "Thinking", text: "Reasoning is not participant feedback." },
    { id: "harness-notice", kind: "notice", lifecycle: "completed", title: "Harness notice", text: "Runtime notice is not participant feedback." });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<ParticipantFeedback data={data} stream={stream} />));
    expect(container.querySelectorAll("[data-feedback-entry]")).toHaveLength(20);
    expect(container.textContent).toContain("7–26 of 26");
    expect(container.textContent).not.toContain("Reasoning is not"); expect(container.textContent).not.toContain("Runtime notice is not");
    expect(container.querySelector('[data-feedback-entry="statement-24"] a')?.getAttribute("href")).toBe("#/lane/lane-1/f/4/e/statement-24");
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
    expect(container.querySelectorAll("[data-feedback-entry]")).toHaveLength(6);
    expect(container.textContent).toContain("FINAL SYNTHETIC EVIDENCE REMAINS INSPECTABLE");
    expect(container.textContent).toContain("1–6 of 26");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("retains the structured closing account without duplicating its readable message projection", async () => {
  const data = fixtures.fixture(), stream = data.streams[0]!;
  stream.actor!.debrief = { trigger: "stop_when", status: "completed", reason: "Recorded ending.", messageId: "lane-1-final", report: { summary: "Original closing summary.", frictionReports: ["Original friction report."] } };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<ParticipantFeedback data={data} stream={stream} />));
    expect(container.textContent).toContain("Original closing summary."); expect(container.textContent).toContain("Original friction report.");
    expect(container.querySelectorAll("[data-feedback-entry]")).toHaveLength(0);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("#/lane/lane-1/f/4/e/lane-1-final");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
