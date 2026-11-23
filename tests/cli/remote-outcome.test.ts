// How `run` and `observe --run` report a remote run once the launcher is done with it: a run that
// ended is written as a local run of its route writes it, from this machine's copy of the run
// directory, and a run that detached or ended without a result keeps its own error.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { runAutomaticAnalysis } from "../../src/analysis/automatic.js";
import type { AutomaticAnalysisOutcome } from "../../src/analysis/job.js";
import { reportRemoteOutcome } from "../../src/cli/commands/study-remote.js";
import { runFactsFor } from "../../src/cli/io.js";
import type { RemoteOutcome } from "../../src/remote/launch.js";
import { analyzedRun, FINDINGS_RUN, liveRun } from "../helpers/analyzed-run.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const KEYS = { provider: "e2b" as const, keys: ["E2B_API_KEY", "OPENAI_API_KEY"] };

/**
 * What reportRemoteOutcome printed, the exit code it set and the study facts it left for the
 * command's telemetry event, for `run` or `run --json`.
 */
async function report(
  json: boolean,
  cwd: string,
  outcome: RemoteOutcome,
  forwarded?: typeof KEYS,
  options?: { runFacts: boolean },
) {
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
  await reportRemoteOutcome(command, io, cwd, outcome, forwarded, options);
  return { stdout: out.join(""), stderr: err.join(""), exitCode, facts: runFactsFor(command) };
}

/** A participant's sandbox, as the result names it: by digest only. */
const SANDBOX = {
  sandboxId: "[redacted-sandbox-id]",
  sandboxIdDigest: "5c1d2e3f4a5b6c7d",
  killed: true,
  streamUrlPresent: true,
};

/** The warnings the Observer's render adds to a live run's result, here and in the runner. */
const OBSERVER_WARNINGS = [
  "Observer renders verified local evidence artifacts; runtime stream auth URLs are not persisted.",
  "Before filing public feedback, use `humanish feedback issue` so redaction and public-safety checks gate the payload.",
];

/**
 * A computer-use result with one participant as the runner's `watch --serve` writes it, in the
 * runner's project. Its shape, warnings included, is a live remote run's; its values are made up.
 */
function computerUseResult(automaticAnalysis: AutomaticAnalysisOutcome) {
  const run = `.humanish/runs/${FINDINGS_RUN}`;
  const session = {
    status: "passed",
    completionReason: "goal_satisfied",
    reason: "Done.",
    screenshots: 2,
  };
  const subject = { source: "app-url", state: { provenance: "undeclared" } };
  const participant = {
    id: "lane-01",
    index: 1,
    persona: "first-time-visitor",
    device: "desktop",
    resolution: [1280, 800],
  };
  return {
    schema: "humanish.study-result.v1",
    route: "computer-use",
    studyId: "checkout-flow",
    ok: true,
    cwd: "/home/user/project",
    actor: "computer-use",
    appUrl: "https://app.example.com/",
    dryRun: false,
    runId: FINDINGS_RUN,
    session,
    sandbox: SANDBOX,
    subject,
    plan: {
      strategy: "per-lane-worlds",
      laneCount: 1,
      concurrency: 1,
      waves: 1,
      perLaneSessionBudgetMs: 420000,
      worstCaseSandboxMinutes: 18,
      dryRun: false,
      lanes: [
        {
          ...participant,
          instructionDigest: "5da0734bb02c3fa2",
          targetDigest: "9e8d7c6b5a493827",
          maxSessionMs: 180000,
        },
      ],
    },
    lanes: [
      {
        ...participant,
        subject,
        status: "passed",
        ok: true,
        diagnostics: { category: "participant_outcome" },
        session,
        sandbox: SANDBOX,
      },
    ],
    diagnostics: { category: "participant_outcome" },
    laneSummary: {
      strategy: "per-lane-worlds",
      total: 1,
      passed: 1,
      skipped: 0,
      harnessErrors: 0,
      hollow: 0,
      concurrency: 1,
      waves: 1,
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
      warnings: [
        ...OBSERVER_WARNINGS,
        "Live observer server is polling observer-data.json with no-store caching.",
      ],
    },
    warnings: [
      "Browser window clipping corrected for participant lane-01; physical bounds are 1275x744 at (5, 56).",
      "Browser window fill did not reach the requested 1280x800 screen for participant lane-01; measured physical bounds are 1275x744 at (5, 56).",
      "Screenshots are unblurred for local use: the bundle stays in the gitignored .humanish/ folder and nothing scans these pixels, so review them before sharing. Set policies.redactScreenshots: true to blur screenshots in a bundle you plan to share.",
      ...OBSERVER_WARNINGS,
      "The live computer-use server polls observer-data.json with no-store caching.",
    ],
    automaticAnalysisTrigger: "default",
    automaticAnalysis,
  };
}

/** The lines the computer-use fixture's result prints above its analysis lines. */
const COMPUTER_USE_LINES = [
  "humanish run checkout-flow: live run finished",
  "route: computer-use",
  "run: findings-run",
  "actor: computer-use",
  "subject: https://app.example.com/",
  "diagnostic: participant outcome",
  "session: passed (goal_satisfied) · Done.",
  "screenshots: 2",
  "sandbox: [redacted-sandbox-id 5c1d2e3f4a5b6c7d] stream=connected killed=yes",
  "sandbox ids: .humanish/runs/findings-run/sandbox-receipts.ndjson",
  "observer: .humanish/runs/findings-run/observer/index.html",
  "opened: no",
  "warning: Browser window clipping corrected for participant lane-01; physical bounds are 1275x744 at (5, 56).",
  "warning: Browser window fill did not reach the requested 1280x800 screen for participant lane-01; measured physical bounds are 1275x744 at (5, 56).",
  "warning: Screenshots are unblurred for local use: the bundle stays in the gitignored .humanish/ folder and nothing scans these pixels, so review them before sharing. Set policies.redactScreenshots: true to blur screenshots in a bundle you plan to share.",
  "warning: Observer renders verified local evidence artifacts; runtime stream auth URLs are not persisted.",
  "warning: Before filing public feedback, use `humanish feedback issue` so redaction and public-safety checks gate the payload.",
];

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
    cost: {
      knownTotalUsd: 0,
      fullyMeasured: false,
      lines: { product: null, media: null, payment: null, provider: null },
    },
    noSpend: {
      satisfied: true,
      maxUsd: 0,
      knownZeroLines: [],
      unmeasuredLines: ["product", "media", "payment", "provider"],
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
    expect(printed.stdout.split("\n")).toEqual([...COMPUTER_USE_LINES, ...findingLines(cwd)]);
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
      diagnosticCategory: "participant_outcome",
      outcome: "passed",
      brain: "provider-key",
    });
  });

  it("leaves no study facts on a command that followed a run another command started", async () => {
    const { cwd, outcome } = await analyzedRun();
    const ended = {
      runId: FINDINGS_RUN,
      exitCode: 0,
      result: computerUseResult(outcome),
      files: 12,
    };
    expect((await report(true, cwd, ended, undefined, { runFacts: false })).facts).toEqual({});
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

describe("a remote run that left no run.json here", () => {
  const LAUNCHED = "cua-2026-11-23T00-00-00-000Z-0a0b0c0d";

  /** The launcher's directory for a run, which holds only its remote record. */
  async function launcherProject() {
    const cwd = await makeTestTempDir("humanish-remote-refused-");
    const run = path.join(cwd, ".humanish", "runs", LAUNCHED);
    await mkdir(run, { recursive: true });
    await writeFile(
      path.join(run, "remote.json"),
      `${JSON.stringify({ schema: "humanish.remote-run.v1", runId: LAUNCHED, provider: "e2b", route: "computer-use", deadline: "2026-11-24T00:00:00.000Z", copyPending: true })}\n`,
    );
    return cwd;
  }

  /** The runner's refusal of the study, under the run id the launcher gave it. */
  const refusal = {
    schema: "humanish.study-result.v1",
    route: "computer-use",
    studyId: "checkout-flow",
    ok: false,
    cwd: "/home/user/project",
    actor: "computer-use",
    dryRun: false,
    runId: LAUNCHED,
    appUrl: "https://app.example.com/",
    lanes: [],
    warnings: [],
    error: {
      code: "HUMANISH_COMPUTER_USE_KEYS_MISSING",
      message: "Live computer-use studies need OPENAI_API_KEY and E2B_API_KEY in the environment.",
    },
    automaticAnalysisTrigger: "default",
    automaticAnalysis: { state: "skipped", reason: "AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE" },
  };

  it("prints a runner's refusal as a local refusal, with no analysis line or command", async () => {
    const cwd = await launcherProject();
    const ended = { runId: LAUNCHED, exitCode: 2, result: refusal };

    const json = await report(true, cwd, ended, KEYS);
    expect(json.exitCode).toBe(2);
    const document = JSON.parse(json.stdout);
    expect(document).toMatchObject({ ok: false, error: refusal.error });
    expect(document.automaticAnalysis).toEqual({
      state: "skipped",
      reason: "AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE",
    });
    expect(document).not.toHaveProperty("findings");

    const human = await report(false, cwd, ended, KEYS);
    expect(human.exitCode).toBe(2);
    expect(human.stdout.split("\n")).toEqual([
      "humanish run checkout-flow: live run failed",
      "route: computer-use",
      `run: ${LAUNCHED}`,
      "actor: computer-use",
      "subject: https://app.example.com/",
      "",
    ]);
    expect(human.stderr).toBe(
      "run failed: Live computer-use studies need OPENAI_API_KEY and E2B_API_KEY in the environment.\ncode: HUMANISH_COMPUTER_USE_KEYS_MISSING\n",
    );
  });

  it("names no analysis command for a copied run that never published its run.json", async () => {
    const cwd = await launcherProject();
    const human = await report(
      false,
      cwd,
      { runId: LAUNCHED, exitCode: 2, result: refusal, files: 1 },
      KEYS,
    );
    expect(human.stdout).not.toMatch(/^(analysis|next):/m);
    expect(human.stderr.split("\n").at(-2)).toBe(
      `Run ${LAUNCHED}'s evidence (1 file) is in .humanish/runs/${LAUNCHED}.`,
    );
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
    // The runner's Observer server stopped with the runner, and so did what was said about it.
    expect(computerUse.observer).not.toHaveProperty("serverUrl");
    expect(computerUse.observer.warnings).toEqual(OBSERVER_WARNINGS);
    expect(computerUse.warnings.slice(-2)).toEqual(OBSERVER_WARNINGS);

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
});

describe("a remote run whose copy back did not finish", () => {
  const copyError = "copying the evidence back failed: the runner stopped answering";
  const next = (cwd: string) => `humanish observe --run findings-run --cwd ${cwd}`;
  const unfinished = (cwd: string) =>
    `The run's evidence did not all arrive here, so what its analysis left is not read. ${next(cwd)} finishes the copy while the runner is still there, and records what was lost when it is not.`;

  it("names the command that finishes the copy, and reads nothing from the part that arrived", async () => {
    const { cwd, runRoot } = await liveRun();
    // Ctrl-C while participants ran: the analysis was skipped, and only part of the run arrived.
    await rm(path.join(runRoot, "observer"), { recursive: true, force: true });
    const stopped = { state: "skipped" as const, reason: "AUTOMATIC_ANALYSIS_ACTOR_CANCELLED" };
    const ended = {
      runId: FINDINGS_RUN,
      exitCode: 130,
      result: computerUseResult(stopped),
      error: copyError,
    };

    const json = await report(true, cwd, ended, KEYS);
    expect(json.exitCode).toBe(130);
    const document = JSON.parse(json.stdout);
    expect(document.automaticAnalysis).toEqual({
      ...stopped,
      message: unfinished(cwd),
      nextCommand: next(cwd),
    });
    expect(document).not.toHaveProperty("findings");
    expect(document.warnings.at(-1)).toBe(copyError);
    // Its Observer page may not be here, so no address names one.
    expect(document.observer).not.toHaveProperty("observerUrl");

    const human = await report(false, cwd, ended, KEYS);
    expect(human.exitCode).toBe(130);
    expect(human.stdout.split("\n").slice(-6)).toEqual([
      "warning: Before filing public feedback, use `humanish feedback issue` so redaction and public-safety checks gate the payload.",
      `warning: ${copyError}`,
      "analysis: skipped because the run stopped before its participants finished",
      `analysis: ${unfinished(cwd)}`,
      `next: ${next(cwd)}`,
      "",
    ]);
    expect(human.stderr).toBe("");
  });

  it("does not report findings as stale when run.json did not arrive", async () => {
    const { cwd, outcome } = await analyzedRun();
    await rm(path.join(cwd, ".humanish", "runs", FINDINGS_RUN, "run.json"));
    const ended = {
      runId: FINDINGS_RUN,
      exitCode: 130,
      result: computerUseResult(outcome),
      error: copyError,
    };
    const document = JSON.parse((await report(true, cwd, ended, KEYS)).stdout);
    expect(document.automaticAnalysis).toMatchObject({
      state: "partial",
      message: unfinished(cwd),
      nextCommand: next(cwd),
    });
    expect(document).not.toHaveProperty("findings");
  });
});

describe("a runner's result this humanish cannot read as a run result", () => {
  const unread =
    "The runner's result for run findings-run could not be read as a run result, so it is shown as the runner wrote it.";
  const shapes: [string, (valid: ReturnType<typeof computerUseResult>) => unknown, string][] = [
    ["null", () => null, "did not pass"],
    ["an array", () => [], "did not pass"],
    ["no route", ({ route: _route, ...rest }) => rest, "passed"],
    ["a route that never runs remotely", (valid) => ({ ...valid, route: "scripted" }), "passed"],
    ["another run's id", (valid) => ({ ...valid, runId: "cua-other" }), "passed"],
    ["automaticAnalysis null", (valid) => ({ ...valid, automaticAnalysis: null }), "passed"],
    ["observer null", (valid) => ({ ...valid, observer: null }), "passed"],
    [
      "a non-string observerPath",
      (valid) => ({ ...valid, observer: { ...valid.observer, observerPath: 5 } }),
      "passed",
    ],
    ["lanes that are not a list", (valid) => ({ ...valid, lanes: {} }), "passed"],
  ];

  // Nothing here reads the run directory, so the project is empty.
  const complete = { state: "complete" as const, reason: null };

  it.each(shapes)("prints a result with %s as the runner wrote it", async (_name, shape, ended) => {
    const cwd = await makeTestTempDir("humanish-remote-unread-");
    const result = shape(computerUseResult(complete));
    const remote = { runId: FINDINGS_RUN, exitCode: 0, result, files: 12 };

    const json = await report(true, cwd, remote, KEYS);
    expect(json.exitCode).toBe(0);
    const document = JSON.parse(json.stdout);
    expect(document).toMatchObject({ cwd, remote: KEYS });
    expect(document.warnings.at(-1)).toBe(unread);

    const human = await report(false, cwd, remote, KEYS);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toBe("");
    expect(human.stderr).toBe(
      `warning: ${unread}\nRun findings-run ${ended}; its evidence (12 files) is in .humanish/runs/findings-run. Next: humanish review --run findings-run\n`,
    );
  });

  it("adds the copy error and why it is shown as written to the document's warnings", async () => {
    const cwd = await makeTestTempDir("humanish-remote-unread-");
    const printed = await report(
      true,
      cwd,
      {
        runId: FINDINGS_RUN,
        exitCode: 130,
        result: null,
        error: "copying the evidence back failed: gone",
      },
      KEYS,
    );
    expect(printed.exitCode).toBe(130);
    expect(JSON.parse(printed.stdout)).toEqual({
      cwd,
      remote: KEYS,
      warnings: ["copying the evidence back failed: gone", unread],
    });
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
