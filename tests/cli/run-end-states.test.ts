// How `runs`, `review` and `analyze` read a run between its start and its findings: participants
// still running, automatic analysis running in the run's process, an analysis whose process
// stopped, and a run that ended interrupted. Each run is a dry-run bundle marked live, with the
// status.json and analysis job a real run leaves at that point written beside it.
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";

import { claimAutomaticAnalysis } from "../../src/analysis/job.js";

import { createProgram } from "../../src/cli/program.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { RUN_STATUS_SCHEMA, type RunStatusRecord } from "../../src/run/status.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const RUN = "end-states-run";

async function runCli(cwd: string, args: string[]) {
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
    await program.parseAsync(["node", "humanish", ...args, "--cwd", cwd], { from: "node" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  return { exitCode, output: stdout.join("") };
}

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

/**
 * A live run of the study `signup`. `participants: "running"` leaves its stream running and
 * run.json without an outcome, as a run's last live flush does; `"ended"` publishes it finished.
 */
async function liveRun(options: {
  participants: "running" | "ended" | "ended-unpublished";
  status: Partial<RunStatusRecord>;
}) {
  const cwd = await makeTestTempDir("humanish-run-end-states-");
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  await runDryRun({ cwd, dryRun: true, runId: RUN });
  const runRoot = path.join(cwd, ".humanish", "runs", RUN);
  const bundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as RunBundle;
  bundle.mode = "live";
  bundle.study = { id: "signup", path: ".humanish/studies/signup.yaml", origin: "committed" };
  if (options.participants === "running") {
    bundle.streams[0]!.status = "running";
    delete bundle.outcome;
  } else {
    bundle.streams[0]!.status = "complete";
    if (options.participants === "ended-unpublished") delete bundle.outcome;
    else
      bundle.outcome = {
        state: "finished",
        ok: true,
        execution: { succeeded: true, failures: [] },
      };
  }
  await writeFile(path.join(runRoot, "run.json"), JSON.stringify(bundle, null, 2) + "\n");
  const status: RunStatusRecord = {
    schema: RUN_STATUS_SCHEMA,
    runId: RUN,
    state: "running",
    mode: "live",
    study: { id: "signup" },
    pid: process.pid,
    startedAt: iso(-600_000),
    updatedAt: iso(-1_000),
    ...options.status,
  };
  await writeFile(path.join(runRoot, "status.json"), JSON.stringify(status, null, 2) + "\n");
  return { cwd, runRoot };
}

/**
 * The automatic analysis job a run's process writes once it claims the analysis, running and
 * last refreshed `ageMs` ago, written by the job's own writer.
 */
async function writeJob(cwd: string, ageMs: number) {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - ageMs });
  try {
    const prepared = await resolveRunPath(cwd, RUN);
    const job = await claimAutomaticAnalysis(prepared!, {
      configDigest: "a".repeat(64),
      promptVersion: "study-evidence-8",
    });
    await job!.update({
      state: "running",
      analysisId: job!.attemptId,
      startedAt: new Date().toISOString(),
    });
  } finally {
    vi.useRealTimers();
  }
}

const analyzingStatus = (startedAt: string, updatedAt: string): Partial<RunStatusRecord> => ({
  state: "finished",
  updatedAt,
  completedAt: startedAt,
  outcome: { verdict: "contract_proof_only", ok: true },
  analysis: { startedAt },
});

const review = async (cwd: string) =>
  JSON.parse((await runCli(cwd, ["review", "--run", RUN, "--json"])).output).analysis as {
    state: string;
    message: string;
    next: string | null;
  };

describe("runs shows a run whose analysis is running", () => {
  it("lists it as analyzing, beside its participants' result", async () => {
    const { cwd } = await liveRun({
      participants: "ended",
      status: analyzingStatus(iso(-90_000), iso(-1_000)),
    });
    const human = await runCli(cwd, ["runs"]);
    expect(human.output).toMatch(new RegExp(`- ${RUN} live [^\\n]*analyzing`));
    const json = JSON.parse((await runCli(cwd, ["runs", "--json"])).output);
    expect(json.runs[0].analysis).toMatchObject({ state: "running" });
  });
});

describe("review before the findings exist", () => {
  it("says participants are still running, not that no analysis ran", async () => {
    const { cwd } = await liveRun({ participants: "running", status: {} });
    const analysis = await review(cwd);
    expect(analysis.state).toBe("running");
    expect(analysis.message).toMatch(/participants are still running/i);
    expect(analysis.message).not.toMatch(/No analysis has run/);
  });

  it("says an interrupted run cut off mid-participant has nothing to analyze and how to rerun", async () => {
    const { cwd } = await liveRun({
      participants: "running",
      status: { state: "interrupted", reason: "reclaimed", completedAt: iso(-1_000) },
    });
    const analysis = await review(cwd);
    expect(analysis.state).toBe("skipped");
    expect(analysis.message).not.toMatch(/No analysis has run/);
    expect(analysis.next).toMatch(/run signup/);
  });

  it("says analysis is running and when it started, before the job is claimed", async () => {
    const startedAt = iso(-90_000);
    const { cwd } = await liveRun({
      participants: "ended",
      status: analyzingStatus(startedAt, iso(-1_000)),
    });
    const analysis = await review(cwd);
    expect(analysis.state).toBe("running");
    expect(analysis.message).toContain(startedAt);
  });

  it("says analysis is running once the job is claimed", async () => {
    const startedAt = iso(-90_000);
    const { cwd } = await liveRun({
      participants: "ended",
      status: analyzingStatus(startedAt, iso(-1_000)),
    });
    await writeJob(cwd, 1_000);
    const analysis = await review(cwd);
    expect(analysis.state).toBe("running");
    expect(analysis.message).toContain(startedAt);
  });

  it("gives an analysis whose process stopped its own message and the command that reruns it", async () => {
    const { cwd } = await liveRun({
      participants: "ended",
      status: analyzingStatus(iso(-300_000), iso(-200_000)),
    });
    await writeJob(cwd, 200_000);
    const analysis = await review(cwd);
    expect(analysis.state).toBe("failed");
    expect(analysis.message).toMatch(/stopped/);
    expect(analysis.message).not.toMatch(/could not be read or checked/);
    expect(analysis.next).toMatch(/analyze --run end-states-run/);
  });
});

describe("analyze names what to do with a run that is not finished", () => {
  const analyze = async (cwd: string) =>
    JSON.parse(
      (await runCli(cwd, ["analyze", "--run", RUN, "--max-cost", "10", "--dry-run", "--json"]))
        .output,
    ) as { ok: boolean; error?: { code: string; message: string } };

  it("a run whose participants are running says analysis starts when they finish", async () => {
    const { cwd } = await liveRun({ participants: "running", status: {} });
    const result = await analyze(cwd);
    expect(result.error?.code).toBe("ANALYSIS_RUN_ACTIVE");
    expect(result.error?.message).not.toMatch(/Wait for the study to finish/);
    expect(result.error?.message).toMatch(/runs/);
  });

  it("an interrupted run cut off mid-participant names the command that runs the study again", async () => {
    const { cwd } = await liveRun({
      participants: "running",
      status: { state: "interrupted", signal: "SIGTERM", completedAt: iso(-1_000) },
    });
    const result = await analyze(cwd);
    expect(result.error?.code).toBe("ANALYSIS_RUN_INCOMPLETE");
    expect(result.error?.message).toMatch(/humanish run signup/);
  });

  it("a stale run whose pid is still in use names reclaim", async () => {
    const { cwd } = await liveRun({
      participants: "ended-unpublished",
      status: { updatedAt: iso(-600_000) },
    });
    const result = await analyze(cwd);
    expect(result.error?.code).toBe("ANALYSIS_RUN_UNCONFIRMED");
    expect(result.error?.message).toMatch(/reclaim --run end-states-run/);
  });

  it("an interrupted run whose participants all ended is analyzed", async () => {
    const { cwd } = await liveRun({
      participants: "ended-unpublished",
      status: { state: "interrupted", reason: "no-publish", completedAt: iso(-1_000) },
    });
    const result = await analyze(cwd);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});
