import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StudyReport as StudyReportView } from "../components/study-report";
import firstRun from "../../tests/golden/observer-data/first-run.json";
import type { ObserverData, ObserverStream } from "../lib/observer-data";
import { formatHash, parseHash } from "../lib/route";
import { reportFindingId, reportHash, reportProblem, resolveReportMoment, type StudyReport } from "../lib/study-report";

const base = firstRun as unknown as ObserverData;
const stream = { ...base.streams[0], id: "participant", actor: { items: [
  { id: "first", kind: "screenshot", title: "Before action", at: "2026-01-01T00:00:10Z", screenshotRef: { path: "screenshots/first.png" } },
  { id: "click", kind: "ui_action", title: "click (12, 24)", at: "2026-01-01T00:00:13Z" },
  { id: "second", kind: "screenshot", title: "After action", at: "2026-01-01T00:00:17Z", screenshotRef: { path: "screenshots/second.png" } }
] } } as ObserverStream;
const data = { ...base, streams: [stream] };
const report: StudyReport = { id: "review-1", runId: data.run.runId, summary: "A task was blocked.", scope: "1 participant", methodology: [], outcomes: [{ streamId: stream.id, label: "Blocked" }], findings: [{ id: "F1", title: "Task blocked", impact: "Blocked", summary: "A control did not respond.", scope: "1 of 1", limitation: "One attempt", nextStep: "Check the control", priorityReason: "Task impact", account: "I stopped", accountSource: "Closing account", moments: [{ streamId: stream.id, eventId: "click", label: "Attempt", note: "Recorded action" }] }] };

describe("study report evidence navigation", () => {
  it.each(["click", "first"])("qualifies an inherited preview for %s independently of the observation basis", (eventId) => {
    const value = structuredClone(report);
    value.findings[0]!.moments[0]!.eventId = eventId;
    value.findings[0]!.moments[0]!.bases = ["visual"];
    const html = renderToStaticMarkup(createElement(StudyReportView, {
      data, report: value, findingId: "F1", onFinding: () => undefined, onOpen: () => undefined
    }));
    expect(html).toContain("Visual observation");
    expect(html.includes("Capture shown for context")).toBe(eventId === "click");
  });
  it("opens an action on its preceding capture through the existing Observer grammar", () => {
    const moment = resolveReportMoment(data, stream.id, "click")!;
    expect(moment.frame?.itemId).toBe("first");
    expect(moment.elapsedMs).toBe(3000);
    const hash = formatHash(stream.id, moment.frameIndex, null, moment.eventId);
    expect(hash).toBe("#/lane/participant/f/1/e/click");
    expect(parseHash(hash)).toEqual({ laneId: "participant", frame: 0, eventId: "click" });
    expect(resolveReportMoment(data, stream.id, "second")?.frame?.itemId).toBe("second");
  });
  it("refuses missing evidence instead of selecting another frame or participant", () => {
    expect(resolveReportMoment(data, "missing", "click")).toBeNull();
    expect(resolveReportMoment(data, stream.id, "missing")).toBeNull();
    const changed = structuredClone(report);
    changed.findings[0]!.moments[0]!.eventId = "missing";
    expect(reportProblem(data, changed)).toContain("unavailable");
  });
  it("opens a scripted action's own capture with the action ID and no invented evidence time", () => {
    const scripted = structuredClone(data);
    scripted.streams[0]!.actor!.items = Array.from({ length: 4 }, (_, i) => ({
      id: `step-${i}`, kind: "ui_action", lifecycle: "completed", title: `Step ${i}`,
      text: "Original action result.", screenshotRef: { path: `screenshots/step-${i}.png`, redaction: "none" }
    }));
    const moment = resolveReportMoment(scripted, stream.id, "step-2")!;
    expect(moment).toMatchObject({ eventId: "step-2", frameIndex: 2, frame: { itemId: "step-2" }, elapsedMs: null });
    expect(formatHash(stream.id, moment.frameIndex, null, moment.eventId)).toBe("#/lane/participant/f/3/e/step-2");
  });
  it("rejects mismatched studies, duplicate outcomes and unresolved lead evidence", () => {
    expect(reportProblem(data, report)).toBeNull();
    expect(reportProblem(data, { ...report, runId: "other" })).toContain("different study");
    expect(reportProblem(data, { ...report, outcomes: [...report.outcomes, report.outcomes[0]!] })).toContain("duplicated");
    const changed = structuredClone(report); changed.findings[0]!.leadEventId = "missing";
    expect(reportProblem(data, changed)).toContain("unavailable");
  });
  it("keeps report identifiers separate from participant playback routes", () => {
    expect(reportFindingId(reportHash("finding / 2"))).toBe("finding / 2");
    expect(reportFindingId("#/report")).toBe("");
    expect(reportFindingId("#/lane/participant/f/1")).toBeNull();
    expect(reportFindingId("#/report/%XX")).toBeNull();
  });
});
