// `review`, `analyze show` and the end of a live run print a run's analysis findings. The run is a
// dry-run bundle marked live, analyzed through the real service with a captured OpenAI wire
// envelope whose answer is the synthetic analysis result.
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";

import { runAutomaticAnalysis } from "../../src/analysis/automatic.js";
import { captureEvidence } from "../../src/analysis/evidence.js";
import type { AnalysisFetch } from "../../src/analysis/provider.js";
import { writeRunFindings } from "../../src/cli/findings.js";
import { createProgram } from "../../src/cli/program.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { syntheticResult } from "../analysis/fixtures.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const RUN = "findings-run";
// Real captured wire envelope; only the synthetic analysis answer is replaced.
// Provenance: fixtures/openai-closing-report/README.md.
const wirePath = new URL(
  "../fixtures/openai-closing-report/typed-closing-report.json",
  import.meta.url,
);

async function runCli(args: string[]) {
  let exitCode = 0;
  const stdout: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: () => {},
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  const override = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(override);
  };
  override(program);
  try {
    await program.parseAsync(["node", "humanish", ...args], { from: "node" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  return { exitCode, output: stdout.join("") };
}

/** A finished live run with one completed stream and the automatic analysis of it. */
async function analyzedRun() {
  const cwd = await makeTestTempDir("humanish-review-findings-");
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  await runDryRun({ cwd, dryRun: true, runId: RUN });
  const runRoot = path.join(cwd, ".humanish", "runs", RUN);
  const bundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as RunBundle;
  bundle.mode = "live";
  bundle.streams[0]!.status = "complete";
  await writeFile(path.join(runRoot, "run.json"), JSON.stringify(bundle, null, 2) + "\n");
  await rm(path.join(runRoot, "status.json"), { force: true });
  const input = await captureEvidence(
    (await resolveRunPath(cwd, RUN))!,
    await readFile(path.join(runRoot, "run.json")),
  );
  const wire = JSON.parse(await readFile(wirePath, "utf8"));
  wire.output[0].content[0].text = JSON.stringify(syntheticResult(input));
  const fetch = vi.fn<AnalysisFetch>(async () => new Response(JSON.stringify(wire)));
  const outcome = await runAutomaticAnalysis(
    cwd,
    RUN,
    { model: "gpt-5.6-sol", question: null, maxCostUsd: 5, timeoutMs: 1000, maxOutputTokens: 8192 },
    { apiKey: "synthetic-key", fetch },
  );
  // The dry-run bundle's coverage is incomplete, so the analysis is partial; its findings are kept.
  expect(outcome.state).toBe("partial");
  return { cwd, outcome };
}

describe("humanish review on an analyzed live run", () => {
  it("prints the findings after the participant review, and the same findings as JSON", async () => {
    const { cwd, outcome } = await analyzedRun();
    const analysisId = outcome.result!.analysisId!;

    const human = await runCli(["review", "--run", RUN, "--cwd", cwd]);
    expect(human.exitCode).toBe(0);
    const lines = human.output.split("\n");
    expect(lines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^findings: 1 from analysis ${analysisId} \\(partial, openai gpt-5\\.6-sol, estimated \\$\\d+\\.\\d\\d\\)$`,
        ),
      ),
    );
    const f1 = lines.indexOf("finding-1 The participant could not create an item.");
    expect(f1).toBeGreaterThan(0);
    expect(lines.slice(f1 + 1, f1 + 8)).toEqual([
      "   They were trying to add an item. The create step did not finish, and they said they could not create it.",
      "   evidence: Item creation was blocked",
      "   impact: blocked task · confidence: medium · recovery: no recovery observed",
      "   The participant could not create an item.",
      "   affected: 1 of 1 exposed participant",
      // The dry-run bundle retains no capture, so its cited event has no frame.
      "   - UI journey: 1 item with no frame",
      "   next step: Check the create interaction.",
    ]);
    // The dry-run bundle retains no capture, so the design review has nothing to cite.
    expect(lines.indexOf("design findings: none in the reviewed captures")).toBeGreaterThan(f1);
    expect(
      lines.indexOf(`analysis: .humanish/runs/${RUN}/analysis/${analysisId}/analysis.json`),
    ).toBeLessThan(lines.indexOf(`review: .humanish/runs/${RUN}/review.json`));

    const json = await runCli(["review", "--run", RUN, "--cwd", cwd, "--json"]);
    expect(json.exitCode).toBe(0);
    const result = JSON.parse(json.output);
    expect(result.schema).toBe("humanish.review.v1");
    expect(result.analysis).toMatchObject({
      schema: "humanish.analysis-findings.v1",
      runId: RUN,
      state: "ready",
      status: "partial",
      analysisId,
      findings: [
        {
          id: "finding-1",
          headline: "The participant could not create an item.",
          experience:
            "They were trying to add an item. The create step did not finish, and they said they could not create it.",
          title: "Item creation was blocked",
          impact: "blocked_task",
          confidence: "medium",
          recovery: "not_observed",
          exposedCount: 1,
          nextStep: "Check the create interaction.",
          correction: null,
        },
      ],
      designFindings: [],
    });
    expect(result.analysis.findings[0].evidence).toEqual([
      expect.objectContaining({ id: "e000001", bases: ["inference"], frame: null, capture: null }),
    ]);
  });

  it("says a dry run has nothing to analyze and names the starter live study", async () => {
    const cwd = await makeTestTempDir("humanish-review-dry-");
    await runCli(["init", "--yes", "--cwd", cwd]);
    await runCli(["run", "first-run", "--cwd", cwd]);
    const human = await runCli(["review", "--cwd", cwd]);
    expect(human.exitCode).toBe(0);
    expect(human.output).toMatch(/\nfindings: none\. This is a dry run: .+\n/);
    expect(human.output).toContain(`\nnext: humanish run try-live --cwd ${cwd}\n`);
    const json = JSON.parse((await runCli(["review", "--cwd", cwd, "--json"])).output);
    expect(json.analysis).toMatchObject({
      state: "dry_run",
      next: `humanish run try-live --cwd ${cwd}`,
      findings: [],
    });
  });

  it("after a dry run of a study that starts as one, says to set it live", async () => {
    const cwd = await makeTestTempDir("humanish-review-dry-");
    await runCli(["init", "--yes", "--cwd", cwd]);
    const tryLive = path.join(cwd, "humanish", "studies", "try-live.yaml");
    await writeFile(
      tryLive,
      (await readFile(tryLive, "utf8")).replace(/^mode: live\b/m, "mode: dry-run"),
    );
    await runCli(["run", "cua-browser", "--cwd", cwd]);
    const json = JSON.parse((await runCli(["review", "--cwd", cwd, "--json"])).output);
    expect(json.analysis).toMatchObject({
      state: "dry_run",
      next: `humanish run cua-browser --cwd ${cwd}`,
    });
    expect(json.analysis.message).toContain("set mode: live in humanish/studies/cua-browser.yaml");
  });
});

describe("humanish review on a live run with no analysis record", () => {
  /** A first-run bundle marked live, as a run whose study left no analysis record. */
  async function liveRunWithoutAnalysis(analysisOff: boolean) {
    const cwd = await makeTestTempDir("humanish-review-off-");
    await runCli(["init", "--yes", "--cwd", cwd]);
    const study = path.join(cwd, "humanish", "studies", "first-run.yaml");
    if (analysisOff)
      await writeFile(study, `${await readFile(study, "utf8")}review:\n  analysis: false\n`);
    const run = JSON.parse((await runCli(["run", "first-run", "--cwd", cwd, "--json"])).output) as {
      runId: string;
    };
    const runJson = path.join(cwd, ".humanish", "runs", run.runId, "run.json");
    const bundle = JSON.parse(await readFile(runJson, "utf8")) as RunBundle;
    expect(bundle.study?.path).toBe("humanish/studies/first-run.yaml");
    await writeFile(runJson, JSON.stringify({ ...bundle, mode: "live" }, null, 2) + "\n");
    return { cwd, runId: run.runId };
  }

  it("says the study turns analysis off, and offers analyze only as the way to run it anyway", async () => {
    const { cwd, runId } = await liveRunWithoutAnalysis(true);
    const json = JSON.parse(
      (await runCli(["review", "--run", runId, "--cwd", cwd, "--json"])).output,
    );
    expect(json.analysis).toMatchObject({
      state: "skipped",
      reason: "AUTOMATIC_ANALYSIS_DISABLED",
      next: expect.stringMatching(new RegExp(`analyze --run ${runId} `)),
      findings: [],
    });
    expect(json.analysis.message).toContain(
      "review.analysis: false in humanish/studies/first-run.yaml",
    );
    const human = await runCli(["review", "--run", runId, "--cwd", cwd]);
    expect(human.output).not.toContain("No analysis has run");
  });

  it("still says no analysis has run when the study leaves analysis on", async () => {
    const { cwd, runId } = await liveRunWithoutAnalysis(false);
    const json = JSON.parse(
      (await runCli(["review", "--run", runId, "--cwd", cwd, "--json"])).output,
    );
    expect(json.analysis).toMatchObject({ state: "none", reason: null });
  });
});

describe("humanish analyze show", () => {
  it("prints the findings as text by default and the raw analysis record only with --json", async () => {
    const { cwd, outcome } = await analyzedRun();
    const human = await runCli(["analyze", "show", "--run", RUN, "--cwd", cwd]);
    expect(human.exitCode).toBe(0);
    expect(human.output.split("\n").slice(0, 3)).toEqual([
      `humanish analyze show ${RUN}`,
      "",
      expect.stringMatching(
        new RegExp(`^findings: 1 from analysis ${outcome.result!.analysisId} \\(partial, `),
      ),
    ]);
    expect(human.output).toContain("\nfinding-1 The participant could not create an item.\n");
    expect(human.output).not.toContain("{");

    const json = await runCli(["analyze", "show", "--run", RUN, "--cwd", cwd, "--json"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.output)).toMatchObject({
      state: "ready",
      analysis: { id: outcome.result!.analysisId, result: { findings: [{ id: "finding-1" }] } },
      corrections: [],
    });
  });

  it("names the next command when there are no findings, and exits 2 for a missing run", async () => {
    const cwd = await makeTestTempDir("humanish-analyze-show-");
    await runCli(["init", "--yes", "--cwd", cwd]);
    await runCli(["run", "first-run", "--cwd", cwd]);
    const dry = await runCli(["analyze", "show", "--cwd", cwd]);
    expect(dry.exitCode).toBe(0);
    expect(dry.output).toMatch(/\nfindings: none\. This is a dry run: /);

    const missing = await runCli(["analyze", "show", "--run", "no-such-run", "--cwd", cwd]);
    expect(missing.exitCode).toBe(2);
    expect(missing.output).toContain("\nfindings: none. Run no-such-run was not found");
    expect(missing.output).toMatch(/\nnext: humanish runs --cwd \S+\n$/);
    const missingJson = await runCli([
      "analyze",
      "show",
      "--run",
      "no-such-run",
      "--cwd",
      cwd,
      "--json",
    ]);
    expect(missingJson.exitCode).toBe(2);
    expect(JSON.parse(missingJson.output)).toMatchObject({ state: "invalid" });
  });
});

describe("the end of a live run", () => {
  it("lists the analysis findings after the analysis line, and prints nothing for --json", async () => {
    const { cwd, outcome } = await analyzedRun();
    const out: string[] = [];
    const io = {
      writeOut: (text: string) => out.push(text),
      writeErr: () => {},
      setExitCode: () => {},
    };
    const result = { runId: RUN, automaticAnalysis: outcome };

    await writeRunFindings(new Command(), io, cwd, result);
    expect(out.join("").split("\n")).toEqual([
      "findings: 1",
      "- finding-1 The participant could not create an item. (blocked task, medium confidence, no recovery observed)",
      "design findings: none",
      `all findings: humanish review --run ${RUN} --cwd ${cwd}`,
      "",
    ]);

    out.length = 0;
    const json = new Command().option("--json");
    json.parse(["--json"], { from: "user" });
    await writeRunFindings(json, io, cwd, result);
    await writeRunFindings(new Command(), io, cwd, {
      runId: RUN,
      automaticAnalysis: { state: "skipped", reason: "AUTOMATIC_ANALYSIS_DRY_RUN" },
    });
    expect(out).toEqual([]);
  });
});
