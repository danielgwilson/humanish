// `humanish analyze --json` on a run that verifies but whose recorded source analysis refuses: the
// result's error names the file that was refused and why, for each refusal code.

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { runDryRun } from "../../src/run/dry-run.js";
import type { RunBundle } from "../../src/run/bundle.js";
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

  it("names the participant and the item id when two items of its trace share an id", async () => {
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
          message: `Analysis did not read participant ${stream}'s trace: it holds two items with the id "step-1", and analysis cites each item by its id. No request was sent.`,
        },
      }),
    });
  });
});
