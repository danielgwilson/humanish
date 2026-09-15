import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorTraceItem } from "../src/actor-contract.js";
import { prepareRunArtifactPaths, type PreparedRunArtifactPaths } from "../src/run-paths.js";
import { captureStudyEvidence, validateStudyAnalysisEvidence } from "../src/study-analysis-evidence.js";
import { digestStudyAnalysisInput } from "../src/study-analysis-validation.js";
import { loadStudyAnalysis, writeStudyAnalysis } from "../src/study-analysis-store.js";
import { syntheticArtifact } from "./study-analysis-fixtures.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

// Synthetic source-contract fixtures only: no provider responses or product claims.
interface FixtureStream {
  id: string; simId: string; label: string; status: string;
  assignment?: { mission?: string; focus?: string; tasks?: Array<{ id: string; goal: string }> };
  ui?: { intent: string };
  actor: { lane: string; status: "passed"; completionReason: "turn_completed"; items: ActorTraceItem[] };
}
const stream = (id: string, items: ActorTraceItem[] = []): FixtureStream => ({ id, simId: id, label: id, status: "passed",
  assignment: { mission: `Inspect the synthetic ${id} interface.` },
  actor: { lane: "computer-use", status: "passed", completionReason: "turn_completed", items } });
const message = (id: string, text: string): ActorTraceItem => ({ id, kind: "message", lifecycle: "completed", title: id, text });

describe("fair bounded study evidence selection", () => {
  let cwd: string;
  let prepared: PreparedRunArtifactPaths;
  let png: Buffer;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "humanish-evidence-selection-"));
    prepared = await prepareRunArtifactPaths(cwd, "selection-fixture");
    await fs.mkdir(path.join(prepared.physicalRunRoot, "screenshots"));
    const image = new PNG({ width: 4, height: 4 }); image.data.fill(80);
    png = PNG.sync.write(image);
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(cwd, { recursive: true, force: true }); });
  const save = async (streams: FixtureStream[], extra = {}) => {
    const bytes = Buffer.from(JSON.stringify({ schema: "humanish.run-bundle.v1", runId: "selection-fixture", streams, events: [], ...extra }));
    await fs.writeFile(path.join(prepared.physicalRunRoot, "run.json"), bytes);
    return bytes;
  };
  const captures = async (id: string, count: number, missing = false) => {
    const items: ActorTraceItem[] = [];
    for (let index = 0; index < count; index++) {
      const capturePath = `screenshots/${id}-${index}.png`;
      if (!missing) await fs.writeFile(path.join(prepared.physicalRunRoot, capturePath), png);
      items.push({ id: `${id}-${index}`, kind: "screenshot", lifecycle: "completed", title: `Capture ${index}`,
        screenshotRef: { path: capturePath, redaction: "none" } });
    }
    return stream(id, items);
  };

  it("reserves beginning and ending captures for every included participant under the default cap", async () => {
    const streams = await Promise.all(Array.from({ length: 16 }, (_, index) => captures(`p${String(index).padStart(2, "0")}`, 9)));
    const source = await save(streams), input = await captureStudyEvidence(prepared, source);
    expect(input.images).toHaveLength(40);
    for (const participant of streams) {
      const selected = input.evidence.filter((entry) => entry.streamId === participant.id && entry.capture);
      expect(selected.length).toBeGreaterThanOrEqual(2);
      expect(selected.length).toBeLessThanOrEqual(3);
      expect(selected.map((entry) => entry.frame)).toEqual(expect.arrayContaining([0, 8]));
    }
    expect(input.coverage.complete).toBe(false);
    expect(input.coverage.omissions).toContain("Some captures were omitted by the capture count limit.");
    await expect(validateStudyAnalysisEvidence(prepared, syntheticArtifact(input), source)).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(prepared.physicalRunRoot, "run.json"))).toEqual(source);
  });

  it("redistributes a short session's unused capture slots and includes the long session's ending", async () => {
    const source = await save([await captures("long", 80), await captures("short", 4)]);
    const input = await captureStudyEvidence(prepared, source);
    expect(input.evidence.filter((entry) => entry.streamId === "short" && entry.capture)).toHaveLength(4);
    const long = input.evidence.filter((entry) => entry.streamId === "long" && entry.capture);
    expect(long).toHaveLength(36);
    expect(long.map((entry) => entry.frame)).toEqual(expect.arrayContaining([0, 39, 79]));
    expect(long.every((entry) => entry.eventId === `long-${entry.frame}` && entry.capture!.eventId === entry.eventId)).toBe(true);
    expect(input.evidence.every((entry) => entry.at === null && entry.elapsedMs === null)).toBe(true);
  });

  it("prioritizes a late failed action and its actual following result over a uniform sample", async () => {
    const lane = await captures("late", 80);
    lane.actor.items.splice(77, 0, { id: "late-failed-action", kind: "ui_action", lifecycle: "completed", status: "failed",
      title: "Commit change", text: "The action returned an error." });
    lane.actor.items.push(message("ending-account", "The last attempt did not complete."));
    const source = await save([lane]);
    const input = await captureStudyEvidence(prepared, source, { captures: 4, evidence: 6 });
    expect(input.evidence.filter((entry) => entry.capture).map((entry) => entry.frame)).toEqual([0, 76, 77, 79]);
    expect(input.evidence.map((entry) => entry.eventId)).toEqual(expect.arrayContaining(["late-failed-action", "ending-account"]));
    expect(input.evidence.find((entry) => entry.eventId === "late-failed-action")).toMatchObject({ kind: "ui_action", frame: 76, capture: null });
    await expect(validateStudyAnalysisEvidence(prepared, syntheticArtifact(input), source)).resolves.toBeUndefined();
  });

  it("keeps the next actual capture after a failed capture separated by reasoning", async () => {
    const lane = await captures("late", 80);
    lane.actor.items[76] = { ...lane.actor.items[76]!, kind: "ui_action", status: "failed" };
    lane.actor.items.splice(77, 0, { id: "between-frames", kind: "reasoning", lifecycle: "completed", title: "Review result", text: "Inspect the next state." });
    lane.actor.items.push(message("ending-account", "The last attempt did not complete."));
    const source = await save([lane]);
    const input = await captureStudyEvidence(prepared, source, { captures: 4, evidence: 7 });
    expect(input.evidence.filter((entry) => entry.capture).map((entry) => entry.frame)).toEqual([0, 76, 77, 79]);
    expect(input.evidence.find((entry) => entry.eventId === "late-76")).toMatchObject({ kind: "ui_action", frame: 76, capture: { eventId: "late-76" } });
    expect(input.evidence.find((entry) => entry.eventId === "late-77")).toMatchObject({ frame: 77, capture: { eventId: "late-77" } });
    await expect(validateStudyAnalysisEvidence(prepared, syntheticArtifact(input), source)).resolves.toBeUndefined();
  });

  it("keeps selection stable when participant source order changes", async () => {
    const streams = await Promise.all([captures("c", 13), captures("a", 13), captures("b", 13)]);
    const first = await captureStudyEvidence(prepared, await save(streams), { captures: 8, evidence: 17 });
    const second = await captureStudyEvidence(prepared, await save([...streams].reverse()), { captures: 8, evidence: 17 });
    const membership = (input: typeof first) => input.evidence.map((entry) =>
      [entry.streamId, entry.eventId, entry.frame, entry.capture?.sha256 ?? null, entry.text].join("|")).sort();
    expect(membership(second)).toEqual(membership(first));
    expect(second.participants.map((entry) => entry.streamId)).toEqual(["b", "a", "c"]);
  });

  it("does not let a long first account consume a later participant's text or images", async () => {
    const noisy = stream("a", Array.from({ length: 200 }, (_, index) => message(`account-${index}`, `${index}: ${"Long synthetic account. ".repeat(700)}`)));
    noisy.actor.items.push(message("late-account", "The final result was unsuccessful."));
    const other = await captures("b", 2); other.actor.items.push(message("other-ending", "The other task finished."));
    const source = await save([noisy, other]);
    const input = await captureStudyEvidence(prepared, source);
    expect(input.evidence.find((entry) => entry.eventId === "other-ending")?.text).toBe("The other task finished.");
    expect(input.evidence.find((entry) => entry.eventId === "late-account")?.text).toBe("The final result was unsuccessful.");
    expect(input.images).toHaveLength(2);
    const actualBytes = input.participants.reduce((total, participant) => total + Buffer.byteLength(JSON.stringify(participant)), 0)
      + input.evidence.reduce((total, entry) => total + Buffer.byteLength(entry.text), 0);
    expect(actualBytes).toBeLessThanOrEqual(160 * 1024);
    expect(input.coverage.complete).toBe(false);
    expect(input.coverage.omissions).toContain("Some evidence text was truncated by the packet size limit.");
    await expect(validateStudyAnalysisEvidence(prepared, syntheticArtifact(input), source)).resolves.toBeUndefined();
  });

  it("fairly samples late text entries under the item cap and never splits UTF-8 characters", async () => {
    const streams = ["a", "b", "c"].map((id) => stream(id, Array.from({ length: 100 }, (_, index) =>
      message(`${id}-${index}`, `${index}: ${"雪🙂".repeat(100)}`))));
    const source = await save(streams), input = await captureStudyEvidence(prepared, source, { evidence: 9, textBytes: 2200 });
    for (const lane of streams) {
      const entries = input.evidence.filter((entry) => entry.streamId === lane.id);
      expect(entries).toHaveLength(3);
      expect(entries.map((entry) => entry.eventId)).toContain(`${lane.id}-99`);
      expect(entries.every((entry) => entry.text.length > 0 && !entry.text.includes("�"))).toBe(true);
    }
    expect(input.coverage.complete).toBe(false);
    await expect(validateStudyAnalysisEvidence(prepared, syntheticArtifact(input), source)).resolves.toBeUndefined();
  });

  it("bounds attempted file reads while a malformed first participant cannot consume other capture reserves", async () => {
    const first = await captures("a-missing", 100, true), second = await captures("b-valid", 20);
    const source = await save([first, second]);
    const stat = vi.mocked(fs.lstat).mockClear();
    const input = await captureStudyEvidence(prepared, source, { captures: 8 });
    const inspected = new Set(stat.mock.calls.map(([file]) => String(file)).filter((file) => file.endsWith(".png")));
    expect(inspected.size).toBeLessThanOrEqual(16);
    expect([...inspected].filter((file) => file.includes("a-missing"))).toHaveLength(8);
    expect(input.evidence.filter((entry) => entry.streamId === "b-valid" && entry.capture).length).toBeGreaterThanOrEqual(4);
    expect(input.evidence.find((entry) => entry.eventId === "b-valid-19")?.capture).not.toBeNull();
    expect(input.coverage.complete).toBe(false);
  });

  it("reserves bounded read bytes for a later valid lane despite several large invalid early lanes", async () => {
    const streams = await Promise.all(["a", "b", "c", "d", "e"].map((id) => captures(id, 8)));
    for (const lane of streams.slice(0, 4)) {
      for (const item of lane.actor.items) await fs.writeFile(path.join(prepared.physicalRunRoot, item.screenshotRef!.path), Buffer.alloc(256, 1));
    }
    const opened = vi.mocked(fs.open).mockClear();
    const input = await captureStudyEvidence(prepared, await save(streams), { captures: 10, imageBytes: 512, totalImageBytes: 2048 });
    // Each initial reservation fits the malformed bytes: this exercises PNG
    // decoding and consumed read bytes, not a size-only refusal before open.
    for (const id of ["a", "b", "c", "d"]) {
      expect(opened.mock.calls.some(([file]) => String(file).endsWith(`/screenshots/${id}-7.png`))).toBe(true);
    }
    const valid = input.evidence.filter((entry) => entry.streamId === "e" && entry.capture);
    expect(valid.length).toBeGreaterThanOrEqual(2);
    expect(valid.map((entry) => entry.frame)).toEqual(expect.arrayContaining([0, 7]));
    expect(input.coverage.complete).toBe(false);
    const imagePaths = opened.mock.calls.map(([file]) => String(file)).filter((file) => file.endsWith(".png"));
    expect(imagePaths.length).toBeLessThanOrEqual(20);
    expect(imagePaths.reduce((total, file) => total + (file.includes("/e-") ? png.length : 256), 0)).toBeLessThanOrEqual(2 * 2048);
  });

  it.each([false, true])("releases idle byte reservations for a valid image above the initial sixteen-lane share (missing lanes: %s)", async missing => {
    const image = new PNG({ width: 900, height: 900 });
    let noise = 123456789;
    for (let index = 0; index < image.data.length; index++) {
      noise ^= noise << 13; noise ^= noise >>> 17; noise ^= noise << 5;
      image.data[index] = noise & 255;
    }
    const large = PNG.sync.write(image);
    expect(large.length).toBeGreaterThan(2.5 * 1024 * 1024);
    expect(large.length).toBeLessThan(8 * 1024 * 1024);
    const validCount = missing ? 8 : 16;
    const streams = await Promise.all(Array.from({ length: 16 }, (_, index) => captures(`p${String(index).padStart(2, "0")}`, 1, index >= validCount)));
    await fs.writeFile(path.join(prepared.physicalRunRoot, "screenshots/p00-0.png"), large);
    const source = await save(streams);
    const opened = vi.mocked(fs.open).mockClear();
    const input = await captureStudyEvidence(prepared, source);
    expect(input.evidence.filter((entry) => entry.capture).map((entry) => entry.streamId)).toEqual(streams.slice(0, validCount).map((lane) => lane.id));
    expect(input.evidence.find((entry) => entry.streamId === "p00")?.capture).not.toBeNull();
    const imageOpens = opened.mock.calls.map(([file]) => String(file)).filter((file) => file.endsWith(".png"));
    expect(imageOpens.indexOf(path.join(prepared.physicalRunRoot, "screenshots/p00-0.png")))
      .toBeGreaterThan(imageOpens.indexOf(path.join(prepared.physicalRunRoot, `screenshots/p${String(validCount - 1).padStart(2, "0")}-0.png`)));
    const returned = input.images.reduce((total, entry) => total + Buffer.from(entry.dataUrl.split(",")[1]!, "base64").length, 0);
    expect(returned).toBe(large.length + (validCount - 1) * png.length);
    expect(input.coverage.complete).toBe(!missing);
    expect(input.coverage.omissions).not.toContain("Some captures were omitted by the image byte limit.");
    expect(input.coverage.omissions).not.toContain("Some captures were omitted by the bounded read budget.");
    expect(input.coverage.omissions).not.toContain("Some captures were omitted by the capture count limit.");
    await expect(validateStudyAnalysisEvidence(prepared, syntheticArtifact(input), source)).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(prepared.physicalRunRoot, "run.json"))).toEqual(source);
  });

  it("attributes a nonzero global byte remainder to the byte limit instead of invalid evidence", async () => {
    const source = await save([await captures("a", 2)]);
    const opened = vi.mocked(fs.open).mockClear();
    const input = await captureStudyEvidence(prepared, source, { captures: 2, totalImageBytes: png.length + 1 });
    expect(input.images).toHaveLength(1);
    expect(opened.mock.calls.filter(([file]) => String(file).endsWith(".png"))).toHaveLength(1);
    expect(input.coverage.omissions).toContain("Some captures were omitted by the image byte limit.");
    expect(input.coverage.omissions).not.toContain("Some captures were missing, unsafe, oversized, or invalid PNG evidence.");
    expect(input.coverage.omissions).not.toContain("Some captures were omitted by the capture count limit.");
  });

  it("reserves a later small lane's first admission before sharing the budget with earlier larger frames", async () => {
    const largerImage = new PNG({ width: 10, height: 10 });
    for (let index = 0; index < largerImage.data.length; index++) largerImage.data[index] = (index * 53 + Math.floor(index / 11)) % 256;
    const larger = PNG.sync.write(largerImage);
    expect(larger.length).toBeGreaterThan(png.length);
    const streams = await Promise.all([captures("a", 1), captures("b", 1), captures("c", 1)]);
    for (const id of ["a", "b"]) await fs.writeFile(path.join(prepared.physicalRunRoot, `screenshots/${id}-0.png`), larger);
    const source = await save(streams); const opened = vi.mocked(fs.open).mockClear();
    const input = await captureStudyEvidence(prepared, source, { captures: 3, totalImageBytes: 2 * larger.length });
    expect(input.evidence.filter((entry) => entry.capture).map((entry) => entry.streamId)).toEqual(["a", "c"]);
    const imagePaths = opened.mock.calls.map(([file]) => String(file)).filter((file) => file.endsWith(".png"));
    expect(imagePaths[0]).toBe(path.join(prepared.physicalRunRoot, "screenshots/c-0.png"));
    expect(input.coverage.omissions).toContain("Some captures were omitted by the image byte limit.");
    expect(input.coverage.omissions).not.toContain("Some captures were missing, unsafe, oversized, or invalid PNG evidence.");
  });

  it("stops actual malformed-byte reads at the returned-byte bound without claiming a count or image limit", async () => {
    const lane = await captures("invalid", 6);
    for (const item of lane.actor.items) await fs.writeFile(path.join(prepared.physicalRunRoot, item.screenshotRef!.path), Buffer.alloc(512, 1));
    const source = await save([lane]); const opened = vi.mocked(fs.open).mockClear();
    const input = await captureStudyEvidence(prepared, source, { captures: 3, imageBytes: 512, totalImageBytes: 1024 });
    expect(input.images).toHaveLength(0);
    expect(opened.mock.calls.filter(([file]) => String(file).endsWith(".png"))).toHaveLength(4);
    expect(input.coverage.omissions).toContain("Some captures were omitted by the bounded read budget.");
    expect(input.coverage.omissions).not.toContain("Some captures were omitted by the image byte limit.");
    expect(input.coverage.omissions).not.toContain("Some captures were omitted by the capture count limit.");
  });

  it("does not call attempted missing files a capture-count omission", async () => {
    const input = await captureStudyEvidence(prepared, await save([await captures("missing", 3, true)]), { captures: 5 });
    expect(input.images).toHaveLength(0);
    expect(input.coverage.omissions).toContain("Some captures were missing, unsafe, oversized, or invalid PNG evidence.");
    expect(input.coverage.omissions).not.toContain("Some captures were omitted by the capture count limit.");
  });

  it("reclaims a failed slot for a lane whose initial capture share was zero", async () => {
    const source = await save([await captures("a-missing", 1, true), await captures("b-valid", 1)]);
    const stat = vi.mocked(fs.lstat).mockClear();
    const input = await captureStudyEvidence(prepared, source, { captures: 1 });
    expect(input.evidence.filter((entry) => entry.capture).map((entry) => entry.streamId)).toEqual(["b-valid"]);
    const inspected = new Set(stat.mock.calls.map(([file]) => String(file)).filter((file) => file.endsWith(".png")));
    expect(inspected.size).toBe(2);
    expect(input.coverage.omissions).not.toContain("Some captures were omitted by the capture count limit.");
  });

  it("does not stat or read an evidence leaf beneath a symlink while classifying size limits", async () => {
    const outside = path.join(cwd, "outside"); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "foreign.png"), Buffer.alloc(1024));
    await fs.symlink(outside, path.join(prepared.physicalRunRoot, "screenshots/alias"), "dir");
    const lane = stream("unsafe", [{ id: "unsafe-frame", kind: "screenshot", lifecycle: "completed", title: "Unsafe frame",
      screenshotRef: { path: "screenshots/alias/foreign.png", redaction: "none" } }]);
    const source = await save([lane]); const stat = vi.mocked(fs.lstat).mockClear(); const opened = vi.mocked(fs.open).mockClear();
    const input = await captureStudyEvidence(prepared, source, { totalImageBytes: 100 });
    expect(input.images).toHaveLength(0);
    expect(stat.mock.calls.some(([file]) => String(file).endsWith("foreign.png"))).toBe(false);
    expect(opened.mock.calls.some(([file]) => String(file).endsWith("foreign.png"))).toBe(false);
    expect(input.coverage.omissions).not.toContain("Some captures were omitted by the image byte limit.");
  });

  it("caps image byte reads and keeps both endings when the global byte budget fits two frames", async () => {
    const source = await save([await captures("a", 10), await captures("b", 10)]);
    const opened = vi.mocked(fs.open).mockClear();
    const input = await captureStudyEvidence(prepared, source, { captures: 8, totalImageBytes: png.length * 2 });
    expect(input.evidence.filter((entry) => entry.capture).map((entry) => entry.eventId)).toEqual(["a-9", "b-9"]);
    expect(opened.mock.calls.filter(([file]) => String(file).endsWith(".png"))).toHaveLength(2);
    expect(input.images.reduce((total, image) => total + Buffer.from(image.dataUrl.split(",")[1]!, "base64").length, 0)).toBe(png.length * 2);
    expect(input.coverage.omissions).toContain("Some captures were omitted by the image byte limit.");
  });

  it("admits a prior v2 prefix selection without reinterpreting its original frame identities", async () => {
    const source = await save([await captures("history", 6)]), original = await captureStudyEvidence(prepared, source);
    const previous = structuredClone(original);
    previous.evidence.forEach((entry, index) => { if (index >= 2) entry.capture = null; });
    previous.images = previous.images.slice(0, 2);
    previous.coverage = { ...previous.coverage, captureCount: 2, complete: false, omissions: ["Some captures were omitted by the capture count limit."] };
    previous.inputDigest = digestStudyAnalysisInput(previous);
    const current = await captureStudyEvidence(prepared, source, { captures: 2 });
    expect(current.evidence.filter((entry) => entry.capture).map((entry) => entry.frame)).toEqual([0, 5]);
    expect(previous.evidence.filter((entry) => entry.capture).map((entry) => entry.frame)).toEqual([0, 1]);
    await expect(validateStudyAnalysisEvidence(prepared, syntheticArtifact(previous), source)).resolves.toBeUndefined();
    await expect(validateStudyAnalysisEvidence(prepared, syntheticArtifact(current), source)).resolves.toBeUndefined();
    await writeStudyAnalysis(prepared, syntheticArtifact(previous, "prior-prefix"));
    await writeStudyAnalysis(prepared, syntheticArtifact(current, "current-spread"));
    expect(await loadStudyAnalysis(prepared, "prior-prefix")).toMatchObject({ state: "ready", analysis: { inputDigest: previous.inputDigest } });
    expect(await loadStudyAnalysis(prepared, "current-spread")).toMatchObject({ state: "ready", analysis: { inputDigest: current.inputDigest } });
    expect(await fs.readFile(path.join(prepared.physicalRunRoot, "run.json"))).toEqual(source);
  });

  it("preserves explicit assignment/task IDs and never manufactures a missing historical mission", async () => {
    const explicit = stream("explicit", [message("ending", "Stopped.")]);
    explicit.assignment = { mission: "Inspect only the preview.", focus: "Review keyboard access.", tasks: [{ id: "opaque-task", goal: "Open the menu." }] };
    explicit.actor.lane = "scripted-browser"; explicit.ui = { intent: "A competing display intent." };
    const historical = stream("historical"); delete historical.assignment; historical.ui = { intent: "A display-only hint." };
    const scripted = stream("scripted"); delete scripted.assignment; scripted.actor.lane = "scripted-browser"; scripted.ui = { intent: "Inspect the declared scripted page." };
    const blank = stream("blank"); blank.assignment = {}; blank.actor.lane = "scripted-browser"; blank.ui = { intent: "Do not substitute this." };
    const source = await save([explicit, historical, scripted, blank], { scenario: { goal: "Never borrow the whole-study goal." } });
    const input = await captureStudyEvidence(prepared, source);
    expect(input.participants.map((participant) => participant.assignment)).toEqual([
      'Inspect only the preview.\nReview keyboard access.\nTask "opaque-task": Open the menu.', null, "Inspect the declared scripted page.", ""
    ]);
    expect(input.coverage.omissions).toContain("Some participants have no recorded assignment.");
    await expect(validateStudyAnalysisEvidence(prepared, syntheticArtifact(input), source)).resolves.toBeUndefined();
  });
});
