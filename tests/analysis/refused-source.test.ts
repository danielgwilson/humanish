// `humanish analyze --json` on a run that verifies but whose recorded source analysis refuses: the
// result's error names the file that was refused and why, for each refusal code. A trace the loader
// refuses fails verify before analysis reads it, unless it is past the read limit, so
// captureEvidence's refusal of a mismatched one is pinned on captureEvidence.

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureEvidence } from "../../src/analysis/evidence.js";
import { createProgram } from "../../src/cli/program.js";
import { runDryRun } from "../../src/run/dry-run.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { resolveRunPath } from "../../src/run/locate.js";
import type { StreamTraceIndex } from "../../src/run/streams.js";
import { verifyRun } from "../../src/verify/verify.js";
import { syntheticActor, writeRunBundle } from "../helpers/run-traces.js";

const RUN = "refused-source";

describe("analyze --json on a run whose source analysis refuses", () => {
  let cwd: string;
  let runRoot: string;
  let bundle: RunBundle;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-refused-source-"));
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runDryRun({ cwd, dryRun: true, runId: RUN });
    runRoot = path.join(cwd, ".humanish", "runs", RUN);
    // A synthetic finished live run, as the analysis service tests make one.
    bundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as RunBundle;
    bundle.mode = "live";
    bundle.streams[0]!.status = "complete";
    await rm(path.join(runRoot, "status.json"), { force: true });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function analyzeJson(): Promise<{ exit: number; result: Record<string, unknown> }> {
    const output: string[] = [];
    let exit = 0;
    const program = createProgram({
      writeOut: (text) => output.push(text),
      writeErr: () => {},
      setExitCode: (code) => {
        exit = code;
      },
    });
    await program.parseAsync(
      ["analyze", "--cwd", cwd, "--run", RUN, "--max-cost", "5", "--dry-run", "--json"],
      { from: "user" },
    );
    return { exit, result: JSON.parse(output.join("")) as Record<string, unknown> };
  }

  it("names run.json, its size and the limit when run.json is larger than analysis reads", async () => {
    const json = Buffer.from(JSON.stringify(bundle));
    // Trailing spaces keep run.json valid JSON at one byte past 16 MiB.
    const padding = Buffer.alloc(16 * 1024 * 1024 + 1 - json.length, " ");
    await writeFile(path.join(runRoot, "run.json"), Buffer.concat([json, padding]));

    expect(await analyzeJson()).toEqual({
      exit: 2,
      result: expect.objectContaining({
        ok: false,
        error: {
          code: "ANALYSIS_SOURCE_TOO_LARGE",
          message:
            "Analysis did not read run.json: it holds 16,777,217 bytes, more than the 16,777,216 bytes (16 MiB) analysis reads of it. run.json grows with each participant and the study's mission; split the participants across studies to keep it under the limit. No request was sent.",
        },
      }),
    });
  });

  it("names the participant and the two items' places when two items of its trace share an id", async () => {
    const actor = syntheticActor("I saved the item.", { id: "step-1" });
    actor.items.push({ ...actor.items[0]!, text: "I saved it again." });
    await writeRunBundle(runRoot, {
      ...bundle,
      streams: [{ ...bundle.streams[0]!, actor }],
    });
    expect((await verifyRun(cwd, RUN)).checks.filter((check) => !check.ok)).toEqual([]);
    const stream = bundle.streams[0]!.id;

    expect(await analyzeJson()).toEqual({
      exit: 2,
      result: expect.objectContaining({
        ok: false,
        error: {
          code: "ANALYSIS_SOURCE_INVALID",
          message: `Analysis did not read participant ${stream}'s trace: items 1 and 2 share an id, and analysis cites each item by its id. No request was sent.`,
        },
      }),
    });
  });

  it("names the participant, its trace file and the limit when the trace is larger than analysis reads", async () => {
    const [stream] = bundle.streams;
    // The stream registers its trace as the computer-use route does, so verify requires the file.
    const written = await writeRunBundle(runRoot, {
      ...bundle,
      streams: [
        {
          ...stream!,
          actor: syntheticActor("x".repeat(32 * 1024 * 1024)),
          artifacts: [
            ...stream!.artifacts,
            { label: "actor trace", path: "actor.json", kind: "trace" },
          ],
        },
      ],
    });
    const trace = written.streams[0]!.trace!;
    expect((await verifyRun(cwd, RUN)).shareSafety.status).toBe("local_only");

    expect(await analyzeJson()).toEqual({
      exit: 2,
      result: expect.objectContaining({
        ok: false,
        error: {
          code: "ANALYSIS_SOURCE_TOO_LARGE",
          message: `Participant ${bundle.streams[0]!.id}'s trace was not read: run.json records ${trace.path} at ${trace.bytes} bytes, more than the 33554432 bytes humanish reads of one file. Restoring a copy does not help; open the file with another tool, such as jq, to read its items. No request was sent.`,
        },
      }),
    });
  }, 60_000);

  describe("captureEvidence on a participant trace the loader refuses", () => {
    /** What captureEvidence throws once `edit` changes run.json's index of the participant's trace. */
    async function refusal(
      edit: (trace: StreamTraceIndex) => void,
    ): Promise<{ error: unknown; trace: StreamTraceIndex }> {
      const written = await writeRunBundle(runRoot, {
        ...bundle,
        streams: [{ ...bundle.streams[0]!, actor: syntheticActor("I saved the item.") }],
      });
      const trace = written.streams[0]!.trace!;
      edit(trace);
      await writeFile(path.join(runRoot, "run.json"), JSON.stringify(written));
      const prepared = (await resolveRunPath(cwd, RUN))!;
      const error = await captureEvidence(
        prepared,
        await readFile(path.join(runRoot, "run.json")),
      ).catch((caught: unknown) => caught);
      return { error, trace };
    }

    it("refuses a trace whose index records more than 32 MiB as too large", async () => {
      const { error, trace } = await refusal((index) => {
        index.bytes = 32 * 1024 * 1024 + 1;
      });
      expect(error).toMatchObject({
        message: "ANALYSIS_SOURCE_TOO_LARGE",
        reason: `Participant ${bundle.streams[0]!.id}'s trace was not read: run.json records ${trace.path} at 33554433 bytes, more than the 33554432 bytes humanish reads of one file. Restoring a copy does not help; open the file with another tool, such as jq, to read its items.`,
      });
    });

    it("refuses a trace that does not match its index as invalid", async () => {
      const { error, trace } = await refusal((index) => {
        index.sha256 = "0".repeat(64);
      });
      expect(error).toMatchObject({
        message: "ANALYSIS_SOURCE_INVALID",
        reason: `Participant ${bundle.streams[0]!.id}'s trace was not read: ${trace.path} does not match the sha256 run.json records for it. A trace file must stay as the run wrote it; restore the run folder from a copy.`,
      });
    });
  });
});
