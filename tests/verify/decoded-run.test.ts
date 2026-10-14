// verify's scan of the decoded run: run.json with every participant's trace loaded, as Observer,
// feedback and analysis read it. A run's traces together can pass V8's longest string, 536,870,888
// characters on Node 24, so no one string may hold two participants' traces.

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The detectors, recorded, so a test can read every text the scan hands them.
vi.mock("../../src/evidence/redaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/evidence/redaction.js")>();
  return {
    ...actual,
    containsSensitive: vi.fn(actual.containsSensitive),
    containsSandboxUrl: vi.fn(actual.containsSandboxUrl),
  };
});

import { containsSandboxUrl, containsSensitive } from "../../src/evidence/redaction.js";
import type { RunBundle, StoredRunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { verifyRun } from "../../src/verify/verify.js";
import { syntheticActor, writeRunBundle } from "../helpers/run-traces.js";

const RUN = "decoded-run";
const TEXTS = ["Participant one saved.", "Participant two opened.", "Participant three left."];
// The byte scan finds the key in its reading with `&#65;` left as written, and the decoded run
// finds it once JSON.parse decodes the escaped `s`. Each scan adds its own finding.
const ESCAPED_KEY = "&#65;\\u0073" + "k-proj-" + "Synthetic0123456789abcdef";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("verify's decoded run scan", () => {
  let cwd: string;
  let runDir: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-decoded-run-"));
    await runDryRun({ cwd, dryRun: true, runId: RUN });
    runDir = path.join(cwd, ".humanish", "runs", RUN);
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  /** The dry run with one participant per text, written as the run writer writes v2. */
  async function writeParticipants(texts: string[]): Promise<StoredRunBundle> {
    const dryRun = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const [template] = dryRun.streams;
    const [simulation] = dryRun.simulations;
    if (!template || !simulation) throw new Error("the dry run wrote no participant");
    const streams = texts.map((text, index) => ({
      ...template,
      id: `stream-${index + 1}`,
      simId: simulation.id,
      actor: syntheticActor(text),
    }));
    return writeRunBundle(runDir, {
      ...dryRun,
      streams,
      simulations: [{ ...simulation, streamIds: streams.map((stream) => stream.id) }],
    });
  }

  /** Replace `from` with `to` in the last participant's trace bytes and re-index that file. */
  async function editLastTrace(stored: StoredRunBundle, from: string, to: string): Promise<void> {
    const trace = stored.streams.at(-1)!.trace!;
    const file = path.join(runDir, trace.path);
    const bytes = Buffer.from((await readFile(file, "utf8")).replace(from, to));
    await writeFile(file, bytes);
    trace.bytes = bytes.length;
    trace.sha256 = sha256(bytes);
    await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(stored, null, 2)}\n`);
  }

  it("finds a key in the last participant's trace in the decoded run", async () => {
    const stored = await writeParticipants(TEXTS);
    await editLastTrace(stored, TEXTS[2]!, `${TEXTS[2]} ${ESCAPED_KEY}`);
    const verified = await verifyRun(cwd, RUN);
    expect(verified.shareSafety.status).toBe("blocked");
    expect(verified.checks.find((check) => check.name === "public-safety scan")?.message).toBe(
      "public-safety findings: sensitive text actors/3.json, sensitive decoded run.json",
    );
  });

  it("finds a key beside the participants in the decoded run", async () => {
    const stored = await writeParticipants(TEXTS);
    // run.json writes `events` after `streams`, so the scan reads it with the last participant.
    stored.events.push({
      id: "event-note",
      at: stored.createdAt,
      level: "info",
      type: "note",
      message: "NOTE",
    });
    const text = `${JSON.stringify(stored, null, 2)}\n`.replace('"NOTE"', `"${ESCAPED_KEY}"`);
    await writeFile(path.join(runDir, "run.json"), text);
    const verified = await verifyRun(cwd, RUN);
    expect(verified.shareSafety.status).toBe("blocked");
    expect(verified.checks.find((check) => check.name === "public-safety scan")?.message).toBe(
      "public-safety findings: sensitive text run.json, sensitive decoded run.json",
    );
  });

  it("holds no two participants' traces in one string", async () => {
    await writeParticipants(TEXTS);
    const detectors = [vi.mocked(containsSensitive), vi.mocked(containsSandboxUrl)];
    for (const detector of detectors) detector.mockClear();
    const stringify = vi.spyOn(JSON, "stringify");
    const verified = await verifyRun(cwd, RUN);
    const results = stringify.mock.results.map((result) => result.value as unknown);
    stringify.mockRestore();
    const scanned = detectors.flatMap((detector) => detector.mock.calls.map(([text]) => text));
    expect(verified.shareSafety.status).toBe("share_ready");
    const joined = [...results, ...scanned].filter(
      (value) =>
        typeof value === "string" && TEXTS.filter((text) => value.includes(text)).length > 1,
    );
    expect(joined).toEqual([]);
  });
});
