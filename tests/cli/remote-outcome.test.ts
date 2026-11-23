// How `run` and `observe --run` report a remote run once the launcher is done with it: a run that
// ended is written as a local run of its route writes it, from this machine's copy of the run
// directory, and a run that detached or ended without a result keeps its own error.
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { runAutomaticAnalysis } from "../../src/analysis/automatic.js";
import type { AutomaticAnalysisOutcome } from "../../src/analysis/job.js";
import { reportRemoteOutcome } from "../../src/cli/commands/study-remote.js";
import { runFactsFor } from "../../src/cli/io.js";
import type { RemoteOutcome } from "../../src/remote/launch.js";
import { analyzedRun, FINDINGS_RUN, liveRun } from "../helpers/analyzed-run.js";

const KEYS = { provider: "e2b" as const, keys: ["E2B_API_KEY", "OPENAI_API_KEY"] };

/**
 * What reportRemoteOutcome printed, the exit code it set and the study facts it left for the
 * command's telemetry event, for `run` or `run --json`.
 */
async function report(json: boolean, cwd: string, outcome: RemoteOutcome, forwarded?: typeof KEYS) {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | undefined;
  const command = new Command("run").option("--json");
  command.parse(json ? ["--json"] : [], { from: "user" });
  const io = {
    writeOut: (text: string) => out.push(text),
    writeErr: (text: string) => err.push(text),
    setExitCode: (code: number) => {
      exitCode = code;
    },
  };
  await reportRemoteOutcome(command, io, cwd, outcome, forwarded);
  return { stdout: out.join(""), stderr: err.join(""), exitCode, facts: runFactsFor(command) };
}

/** A computer-use result as the runner's `watch --serve` wrote it, in the runner's project. */
function computerUseResult(automaticAnalysis: AutomaticAnalysisOutcome) {
  const run = `.humanish/runs/${FINDINGS_RUN}`;
  return {
    schema: "humanish.study-result.v1",
    route: "computer-use",
    studyId: "checkout-flow",
    ok: true,
    cwd: "/home/user/project",
    actor: "openai-computer-use",
    appUrl: "https://app.example.com/",
    dryRun: false,
    runId: FINDINGS_RUN,
    session: {
      status: "passed",
      completionReason: "goal_satisfied",
      reason: "Done.",
      screenshots: 2,
    },
    observer: {
      schema: "humanish.observer-result.v1",
      ok: true,
      cwd: "/home/user/project",
      run: FINDINGS_RUN,
      observerPath: `${run}/observer/index.html`,
      observerDataPath: `${run}/observer/observer-data.json`,
      eventsPath: `${run}/events.ndjson`,
      observerUrl: "http://127.0.0.1:7000/observer/index.html",
      serverUrl: "http://127.0.0.1:7000/observer/index.html",
      bundlePath: `${run}/run.json`,
      opened: false,
      warnings: [],
    },
    warnings: [],
    automaticAnalysisTrigger: "default",
    automaticAnalysis,
  };
}

/** A terminal result as the runner's `watch` wrote it, in the runner's project. */
function terminalResult(automaticAnalysis: AutomaticAnalysisOutcome) {
  const run = `.humanish/runs/${FINDINGS_RUN}`;
  return {
    schema: "humanish.study-result.v1",
    route: "terminal",
    studyId: "ledger-study",
    ok: true,
    cwd: "/home/user/project",
    actor: "codex-exec",
    product: "ledger-cli",
    dryRun: false,
    runId: FINDINGS_RUN,
    session: { status: "passed", completionReason: "goal_satisfied", reason: "Done." },
    sandbox: {
      sandboxId: "[redacted-sandbox-id]",
      sandboxIdDigest: "1f2e3d4c5b6a7980",
      killed: true,
      remaining: 0,
    },
    observer: {
      schema: "humanish.observer-result.v1",
      ok: true,
      cwd: "/home/user/project",
      run: FINDINGS_RUN,
      observerPath: `${run}/observer/index.html`,
      observerDataPath: `${run}/observer/observer-data.json`,
      eventsPath: `${run}/events.ndjson`,
      observerUrl: `file:///home/user/project/${run}/observer/index.html`,
      bundlePath: `${run}/run.json`,
      opened: false,
      warnings: [],
    },
    warnings: [],
    automaticAnalysisTrigger: "default",
    automaticAnalysis,
  };
}

/** The lines an analysis with the fixture's one finding adds under the route's own lines. */
const findingLines = (cwd: string) => [
  "analysis: partial, because it covered only part of the evidence",
  "findings: 1",
  "- finding-1 The participant could not create an item. (blocked task, medium confidence, no recovery observed)",
  "design findings: none",
  `all findings: humanish review --run findings-run --cwd ${cwd}`,
  "",
];

describe("a remote run that ended, reported as a local run of its route", () => {
  it("prints a computer-use run's JSON with its findings, its own ok and the keys sent", async () => {
    const { cwd, outcome } = await analyzedRun();
    const ended = {
      runId: FINDINGS_RUN,
      exitCode: 0,
      result: computerUseResult(outcome),
      files: 12,
    };
    const printed = await report(true, cwd, ended, KEYS);
    expect(printed.exitCode).toBe(0);
    const document = JSON.parse(printed.stdout);
    expect(document).toMatchObject({
      ok: true,
      runOk: true,
      cwd,
      remote: { provider: "e2b", keys: ["E2B_API_KEY", "OPENAI_API_KEY"] },
      automaticAnalysis: {
        state: "partial",
        nextCommand: `humanish review --run findings-run --cwd ${cwd}`,
      },
      findings: {
        count: 1,
        review: `humanish review --run findings-run --cwd ${cwd}`,
        observer: ".humanish/runs/findings-run/observer/index.html#/report",
      },
    });
    expect(document.automaticAnalysis.message).toMatch(/1 finding/);
  });

  it("prints the route's lines, the findings and where the evidence is", async () => {
    const { cwd, outcome } = await analyzedRun();
    const ended = {
      runId: FINDINGS_RUN,
      exitCode: 0,
      result: computerUseResult(outcome),
      files: 12,
    };
    const printed = await report(false, cwd, ended, KEYS);
    expect(printed.exitCode).toBe(0);
    expect(printed.stdout.split("\n")).toEqual([
      "humanish run checkout-flow: live run finished",
      "route: computer-use",
      "run: findings-run",
      "actor: openai-computer-use",
      "subject: https://app.example.com/",
      "session: passed (goal_satisfied) · Done.",
      "screenshots: 2",
      "observer: .humanish/runs/findings-run/observer/index.html",
      "opened: no",
      ...findingLines(cwd),
    ]);
    expect(printed.stderr).toBe(
      "Run findings-run's evidence (12 files) is in .humanish/runs/findings-run.\n",
    );
  });

  it("leaves the run's study facts for the launcher's telemetry event, as a local run does", async () => {
    const { cwd, outcome } = await analyzedRun();
    const ended = {
      runId: FINDINGS_RUN,
      exitCode: 0,
      result: computerUseResult(outcome),
      files: 12,
    };
    expect((await report(true, cwd, ended, KEYS)).facts).toEqual({
      mode: "live",
      study: "custom",
      outcome: "passed",
      brain: "provider-key",
    });
  });

  it("reports a passed run whose analysis failed as not ok, with the run's own ok", async () => {
    const { cwd } = await liveRun();
    const outcome = await runAutomaticAnalysis(
      cwd,
      FINDINGS_RUN,
      {
        model: "gpt-5.6-sol",
        question: null,
        maxCostUsd: 5,
        timeoutMs: 1000,
        maxOutputTokens: 8192,
      },
      { apiKey: "synthetic-key", fetch: async () => new Response("unavailable", { status: 503 }) },
    );
    expect(outcome.state).toBe("failed");
    const ended = {
      runId: FINDINGS_RUN,
      exitCode: 2,
      result: computerUseResult(outcome),
      files: 9,
    };

    const json = await report(true, cwd, ended, KEYS);
    expect(json.exitCode).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      runOk: true,
      automaticAnalysis: { state: "failed" },
    });
    const human = await report(false, cwd, ended, KEYS);
    expect(human.exitCode).toBe(2);
    expect(human.stdout.split("\n")[0]).toBe(
      "humanish run checkout-flow: live run finished; the analysis did not complete",
    );
  });

  it("prints a terminal run through the terminal route's lines", async () => {
    const { cwd, outcome } = await analyzedRun();
    const ended = { runId: FINDINGS_RUN, exitCode: 0, result: terminalResult(outcome), files: 7 };
    const printed = await report(false, cwd, ended, KEYS);
    expect(printed.exitCode).toBe(0);
    expect(printed.stdout.split("\n")).toEqual([
      "humanish run ledger-study: live run finished",
      "route: terminal",
      "run: findings-run",
      "actor: codex-exec",
      "product: ledger-cli",
      "sandbox: [redacted-sandbox-id 1f2e3d4c5b6a7980] killed=yes",
      "sandbox ids: .humanish/runs/findings-run/sandbox-receipts.ndjson",
      "observer: .humanish/runs/findings-run/observer/index.html",
      "opened: no",
      ...findingLines(cwd),
    ]);
  });
});

describe("what a remote run's result names on this machine", () => {
  it("names this machine's copy of the run where the runner named its own", async () => {
    const { cwd, outcome } = await analyzedRun();
    const here = `file://${cwd}/.humanish/runs/findings-run/observer/index.html`;

    const served = await report(
      true,
      cwd,
      { runId: FINDINGS_RUN, exitCode: 0, result: computerUseResult(outcome), files: 12 },
      KEYS,
    );
    const computerUse = JSON.parse(served.stdout);
    expect(computerUse.cwd).toBe(cwd);
    expect(computerUse.observer).toMatchObject({ cwd, observerUrl: here });
    // The runner's Observer server stopped with the runner.
    expect(computerUse.observer).not.toHaveProperty("serverUrl");

    const rendered = await report(
      true,
      cwd,
      { runId: FINDINGS_RUN, exitCode: 0, result: terminalResult(outcome), files: 7 },
      KEYS,
    );
    expect(JSON.parse(rendered.stdout).observer).toMatchObject({ cwd, observerUrl: here });
  });

  it("leaves out a rejected analysis output, which stays in the runner", async () => {
    const { cwd, outcome } = await analyzedRun();
    const rejected = {
      ...outcome,
      result: {
        ...outcome.result!,
        rejectedOutputPath: ".humanish/analysis-diagnostics/findings-run/analysis-1.json",
      },
    };
    const ended = {
      runId: FINDINGS_RUN,
      exitCode: 0,
      result: computerUseResult(rejected),
      files: 12,
    };
    const json = await report(true, cwd, ended, KEYS);
    expect(JSON.parse(json.stdout).automaticAnalysis.result).not.toHaveProperty(
      "rejectedOutputPath",
    );
    const human = await report(false, cwd, ended, KEYS);
    expect(human.stdout).not.toMatch(/analysis-diagnostics/);
  });

  it("adds why the copy did not finish to the warnings, and names no evidence it did not copy", async () => {
    const { cwd, outcome } = await analyzedRun();
    const ended = {
      runId: FINDINGS_RUN,
      exitCode: 130,
      result: computerUseResult(outcome),
      error: "copying the evidence back failed: the runner stopped answering",
    };
    const json = await report(true, cwd, ended, KEYS);
    expect(json.exitCode).toBe(130);
    expect(JSON.parse(json.stdout).warnings).toEqual([
      "copying the evidence back failed: the runner stopped answering",
    ]);
    const human = await report(false, cwd, ended, KEYS);
    expect(human.stdout.split("\n")).toContain(
      "warning: copying the evidence back failed: the runner stopped answering",
    );
    expect(human.stderr).toBe("");
  });
});

describe("a remote run that detached or ended without a result", () => {
  it("prints a detached run's code and the commands that follow or stop it", async () => {
    const detached = { runId: "cua-remote", exitCode: 0, detached: true };
    const json = await report(true, "/work/project", detached, KEYS);
    expect(json.exitCode).toBe(129);
    expect(json.stdout).toBe(`{
  "schema": "humanish.run-result.v1",
  "ok": false,
  "cwd": "/work/project",
  "runId": "cua-remote",
  "warnings": [],
  "remote": {
    "provider": "e2b",
    "keys": [
      "E2B_API_KEY",
      "OPENAI_API_KEY"
    ]
  },
  "error": {
    "code": "HUMANISH_REMOTE_DETACHED",
    "message": "The terminal closed, so run cua-remote goes on in its runner without this machine. Follow it and copy it back with humanish observe --run cua-remote, or stop it and its sandboxes with humanish reclaim --run cua-remote."
  }
}
`);
    const human = await report(false, "/work/project", detached, KEYS);
    expect(human.stdout).toBe("");
    expect(human.stderr).toBe(
      "run failed: The terminal closed, so run cua-remote goes on in its runner without this machine. Follow it and copy it back with humanish observe --run cua-remote, or stop it and its sandboxes with humanish reclaim --run cua-remote.\ncode: HUMANISH_REMOTE_DETACHED\n",
    );
  });

  it("prints a run that ended without a result as failed, with a failing code", async () => {
    const stopped = { runId: "cua-remote", exitCode: 0, error: "stopped before the run started" };
    const json = await report(true, "/work/project", stopped);
    expect(json.exitCode).toBe(2);
    expect(json.stdout).toBe(`{
  "schema": "humanish.run-result.v1",
  "ok": false,
  "cwd": "/work/project",
  "runId": "cua-remote",
  "warnings": [],
  "error": {
    "code": "HUMANISH_REMOTE_FAILED",
    "message": "Run cua-remote stopped before the run started."
  }
}
`);
    const human = await report(
      false,
      "/work/project",
      { runId: "cua-remote", exitCode: 130 },
      KEYS,
    );
    expect(human.exitCode).toBe(130);
    expect(human.stdout).toBe("");
    expect(human.stderr).toBe(
      "run failed: Run cua-remote ended without a result.\ncode: HUMANISH_REMOTE_FAILED\n",
    );
  });
});
