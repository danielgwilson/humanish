// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";
import { StudyReport } from "../components/study-report";
import { NO_ANALYSIS, parseStudyAnalysis, projectStudyAnalysis, type LoadedStudyAnalysis } from "../lib/study-analysis";
import type { AutomaticStudyAnalysisView } from "../lib/automatic-analysis";
import { useObserverFeed } from "../lib/use-observer-feed";
import * as fixtures from "../../scripts/observer-browser-fixtures.mjs";

// UI/transport fixtures only. These tests do not claim an automatic provider dispatch.
const data = fixtures.fixture();
let container: HTMLDivElement, root: Root, remote: LoadedStudyAnalysis;
const job = (state: AutomaticStudyAnalysisView["state"]): AutomaticStudyAnalysisView => ({ state, analysisId: null, reason: null, updatedAt: new Date().toISOString() });
const click = async (selector: string) => { const el = container.querySelector(selector); expect(el).not.toBeNull(); await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
async function mount(element = <App data={data} analysis={remote} />) { await act(async () => { root.render(element); }); }

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => undefined;
  window.matchMedia = ((media: string) => ({ matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime("2026-09-15T01:00:00.000Z");
  window.history.replaceState(null, "", "/"); localStorage.clear(); localStorage.setItem("humanish-sidebar", "open");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  remote = { ...NO_ANALYSIS, automatic: job("queued") };
  vi.spyOn(window, "fetch").mockImplementation(async (input) => String(input) === "observer-data.json" ? new Response(JSON.stringify(data))
    : String(input) === "study-analysis.json" ? new Response(JSON.stringify(remote)) : new Response(null, { status: 404 }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

describe("automatic analysis within the existing study shell", () => {
  it("polls queued → running → complete without navigation or replacing the shell", async () => {
    await mount();
    const sidebar = container.querySelector(".side"), nav = container.querySelector(".study-viewbar");
    expect(container.querySelector(".gallery")).not.toBeNull();
    expect(window.location.hash).toBe("");
    await click('.study-views a[href="#/report"]');
    expect(container.textContent).toContain("Analysis is queued.");
    expect(container.querySelector('.study-views a[href="#/report"]')?.textContent).not.toContain("0");
    expect(container.textContent).not.toContain("No findings");
    remote = { ...NO_ANALYSIS, automatic: job("running") }; await advance(5000);
    expect(container.textContent).toContain("Analyzing recorded evidence…");
    remote = fixtures.analysisFixture(data); remote.automatic = { ...job("complete"), analysisId: remote.analysis!.id };
    await advance(5000);
    expect(container.querySelectorAll("[data-finding]")).toHaveLength(2);
    expect(container.querySelector(".side")).toBe(sidebar); expect(container.querySelector(".study-viewbar")).toBe(nav);
    expect(window.location.hash).toBe("#/report");
    expect(container.querySelector("[data-automatic-analysis-state]")).toBeNull();
  });
  it("does not navigate away from a selected recording when results arrive", async () => {
    await mount(); await click(".open-overlay");
    const route = window.location.hash, player = container.querySelector(".player");
    remote = fixtures.analysisFixture(data); remote.automatic = { ...job("complete"), analysisId: remote.analysis!.id };
    await advance(5000);
    expect(window.location.hash).toBe(route); expect(container.querySelector(".player")).toBe(player);
  });
  it("labels a prior unknown task outcome separately from current analysis progress", async () => {
    remote = fixtures.analysisFixture(data);
    remote.analysis!.result!.participants[0]!.outcome = "unknown";
    remote.automatic = job("running");
    await mount();
    expect(container.querySelector(".countline")?.textContent).toContain("Analyzed outcomes:");
    expect(container.querySelector(".card-outcome")?.textContent).toBe("Analyzed outcome: Unknown");
    await click(".open-overlay");
    expect(container.querySelector(".report-outcome-context")?.textContent).toBe("Analyzed outcome: Unknown");
    await click('.study-views a[href="#/report"]');
    expect(container.textContent).toContain("Analyzing recorded evidence…");
  });
  it("keeps previous findings visible after a new automatic failure", async () => {
    remote = fixtures.analysisFixture(data); remote.automatic = { ...job("failed"), reason: "AUTOMATIC_ANALYSIS_ADMISSION_REFUSED" };
    await mount(); await click('.study-views a[href="#/report"]');
    expect(container.querySelector(".report-overview-title")?.textContent).toContain("Report available");
    expect(container.querySelector(".report-analysis-details")?.hasAttribute("open")).toBe(false);
    expect(container.querySelector(".report-analysis-details")?.textContent).toContain("Analysis failed.");
    expect(container.textContent).toContain("The displayed report is from a separate analysis.");
    expect(container.textContent).toContain("Analysis was refused before dispatch.");
    expect(container.textContent).toContain("higher --max-cost");
    expect(container.querySelectorAll("[data-finding]")).toHaveLength(2);
    await click('.study-views a[href="#"]'); expect(container.querySelector(".gallery")).not.toBeNull();
  });
  it.each(["queued", "running"] as const)("never polls or promises live progress in a saved %s snapshot", async (state) => {
    remote.automatic = job(state); await mount(<App data={data} analysis={remote} snapshot />);
    await click('.study-views a[href="#/report"]'); await advance(60_000);
    expect(window.fetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain(`This snapshot was saved while analysis was ${state}.`);
    expect(container.querySelector("[data-automatic-analysis-state]")?.getAttribute("data-automatic-analysis-state")).toBe("unknown");
    expect(container.textContent).not.toContain("No findings");
  });
  it("turns a disconnected running heartbeat unknown while retaining recordings", async () => {
    remote.automatic = job("running"); await mount(); await click('.study-views a[href="#/report"]');
    vi.mocked(window.fetch).mockRejectedValue(new Error("offline")); await advance(16_000);
    expect(container.textContent).toContain("Analysis status is unknown.");
    await click('.study-views a[href="#"]'); expect(container.querySelector(".gallery")).not.toBeNull();
  });
  it("leaves the recording feed independent of a pending analysis request", async () => {
    const fetched: string[] = [];
    vi.mocked(window.fetch).mockImplementation(async (input, init) => {
      fetched.push(String(input));
      if (String(input) === "study-analysis.json") return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      return String(input) === "observer-data.json" ? new Response(JSON.stringify(data)) : new Response(null, { status: 404 });
    });
    function Probe() { const feed = useObserverFeed(data, false, remote); return <p>{feed.connection.state}</p>; }
    await mount(<Probe />); await advance(10_000);
    expect(container.textContent).toBe("current");
    expect(fetched.filter((url) => url === "observer-data.json")).toHaveLength(3);
    expect(fetched.filter((url) => url === "study-analysis.json")).toHaveLength(1);
  });
  it.each(["failed", "cancelled", "skipped", "unknown", "complete", "partial"] as const)("does not label a job-only %s view as zero findings", async (state) => {
    remote.automatic = job(state); await mount(); await click('.study-views a[href="#/report"]');
    expect(container.querySelector("[data-automatic-analysis-state]")?.getAttribute("data-automatic-analysis-state")).toBe(state);
    expect(container.textContent).not.toContain("No findings"); expect(container.textContent).not.toContain("0 findings");
  });
  it("keeps the finished-with-limitations message for the selected partial result", async () => {
    const selected = fixtures.analysisFixture(data, { status: "partial" });
    const report = projectStudyAnalysis(parseStudyAnalysis(selected, data), data)!;
    await mount(<StudyReport data={data} report={report} automatic={{ ...job("partial"), analysisId: report.id }} findingId="" onFinding={() => {}} onOpen={() => {}} />);
    expect(container.textContent?.match(/Report available · limitations/g)).toHaveLength(1);
    expect(container.querySelectorAll("[data-finding]")).toHaveLength(2);
  });
  it.each(["AUTOMATIC_ANALYSIS_ADMISSION_EXCEEDED", "AUTOMATIC_ANALYSIS_REUSED"])("retains the specific over-admission limitation under %s", async (reason) => {
    const selected = fixtures.analysisFixture(data, { status: "partial" });
    selected.analysis!.error = "analysis_admission_estimate_exceeded";
    const report = projectStudyAnalysis(parseStudyAnalysis(selected, data), data)!;
    await mount(<StudyReport data={data} report={report} automatic={{ ...job("partial"), analysisId: report.id, reason }} findingId="" onFinding={() => {}} onOpen={() => {}} />);
    expect(container.textContent?.match(/Report available · limitations/g)).toHaveLength(1);
    expect(container.querySelector('[data-analysis-admission-exceeded]')?.textContent).toContain("Reported usage exceeded an admission estimate or configured limit.");
    expect(container.querySelectorAll("[data-finding]")).toHaveLength(2);
  });
});
