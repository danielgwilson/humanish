import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildObserverData } from "../../src/observer-data.js";
import { prepareRunArtifactPaths, type PreparedRunArtifactPaths } from "../../src/run-paths.js";
import type { RunBundle } from "../../src/run.js";
import { captureStudyEvidence } from "../../src/study-analysis-evidence.js";
import { parseStudyAnalysis, projectStudyAnalysis } from "../lib/study-analysis.js";
import { reportProblem, resolveReportMoment } from "../lib/study-report.js";
import { isObserverData } from "../lib/validate.js";
import { syntheticArtifact } from "../../tests/study-analysis-fixtures.js";

// Synthetic local bundle, not a provider wire fixture. This checks the full
// evidence-producer -> Observer -> report-admission seam without provider calls.
describe("receiving context in Observer analysis", () => {
  let cwd: string, bundle: RunBundle, prepared: PreparedRunArtifactPaths;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-observer-receiving-"));
    prepared = await prepareRunArtifactPaths(cwd, "receiving-fixture");
    bundle = JSON.parse(await readFile(new URL("../../tests/golden/labs/first-run.json", import.meta.url), "utf8")) as RunBundle;
    bundle.runId = "receiving-fixture";
    bundle.streams = bundle.streams.slice(0, 2).map((stream, i) => ({ ...stream,
      laneId: `lane-${i}`, status: "complete", assignment: { mission: "Inspect a fictional confirmation email." } }));
    bundle.commsReceiving = { schema: "humanish.comms-receiving.v2", channel: "email", provider: "agentmail",
      publication: "restricted-real-communications", state: "finished", browserConfinement: "mail-surface-only",
      limitations: ["delivery_after_observation_end_unknown"], participants: bundle.streams.map((stream, i) => ({
        participantId: stream.laneId!, leaseId: `local-lease-${i}`, acquisition: "active", cleanup: "absent",
        observed: i + 1, published: i + 1, linkCount: 1, codeCount: 0, blockedAssetCount: 0, blockedLinkCount: 0,
        messages: [{ id: `message-${i}`, firstObservedAt: "2026-01-01T00:00:00.000Z" }], limitations: []
      })) };
  });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
  async function capture() {
    const source = Buffer.from(JSON.stringify(bundle));
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), source);
    return captureStudyEvidence(prepared, source);
  }

  it("admits captured findings and resolves the count-only context without a time, frame or participant action", async () => {
    const before = JSON.stringify(bundle), input = await capture();
    const data = buildObserverData(bundle);
    expect(isObserverData(data)).toBe(true);
    const loaded = parseStudyAnalysis({ state: "ready", analysis: syntheticArtifact(input), corrections: [], warnings: [] }, data);
    expect(loaded.state).toBe("ready");
    const report = projectStudyAnalysis(loaded, data)!;
    expect(report.findings).toHaveLength(1);
    expect(reportProblem(data, report)).toBeNull();
    for (const stream of data.streams) {
      const context = input.evidence.find(entry => entry.eventId === `comms-receiving-${stream.id}`)!;
      expect(context).toMatchObject({ kind: "harness:email_receiving", at: null, elapsedMs: null, frame: null,
        capture: null, quoteEligible: false });
      const event = stream.timeline.find(entry => entry.id === context.eventId)!;
      expect(event).toMatchObject({ type: "Harness email receiving (count-only context)", at: "", level: "info", message: context.text });
      const resolved = resolveReportMoment(data, stream.id, context.eventId)!;
      expect(resolved).toMatchObject({ eventId: context.eventId, frame: null, frameIndex: null, elapsedMs: null, text: context.text });
      const other = bundle.commsReceiving!.participants.find(p => p.participantId !== stream.laneId)!;
      for (const omitted of [other.participantId, "local-lease-", "message-", "2026-01-01T", "apiKey", "providerMessageId"])
        expect(event.message).not.toContain(omitted);
      expect(event.message).toContain("separate observations");
    }
    expect(JSON.stringify(bundle)).toBe(before);
    expect(await readFile(path.join(prepared.physicalRunRoot, "run.json"), "utf8")).toBe(before);
  });

  it("still rejects a ready analysis whose context is removed or has a forged event ID", async () => {
    const input = await capture(), artifact = syntheticArtifact(input), data = buildObserverData(bundle);
    const loaded = { state: "ready", analysis: artifact, corrections: [], warnings: [] };
    const missing = structuredClone(data);
    missing.streams[0]!.timeline = missing.streams[0]!.timeline.filter(event => !event.id.startsWith("comms-receiving-"));
    expect(parseStudyAnalysis(loaded, missing).state).toBe("invalid");
    artifact.evidence.find(entry => entry.kind === "harness:email_receiving")!.eventId = "forged-harness-context";
    expect(parseStudyAnalysis(loaded, data).state).toBe("invalid");
  });

  it("does not project malformed receiving data or invent context for legacy runs", async () => {
    Object.assign(bundle.commsReceiving!.participants[0]!, { address: "synthetic-private-canary@example.test" });
    expect(buildObserverData(bundle).streams.every(stream => stream.timeline.every(event => !event.id.startsWith("comms-receiving-")))).toBe(true);
    await expect(capture()).rejects.toThrow("ANALYSIS_SOURCE_INVALID");
    delete bundle.commsReceiving;
    const input = await capture(), data = buildObserverData(bundle);
    expect(input.evidence.some(entry => entry.kind === "harness:email_receiving")).toBe(false);
    expect(data.streams.every(stream => stream.timeline.every(event => !event.id.startsWith("comms-receiving-")))).toBe(true);
    expect(parseStudyAnalysis({ state: "ready", analysis: syntheticArtifact(input), corrections: [], warnings: [] }, data).state).toBe("ready");
  });
});
