// pnpm bench: run the Taskly planted-defect benchmark against a humanish build and score it.
// docs/evidence/benchmark/README.md explains the flags, the scores and the budget rules.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { readJson, readRunBundle, runCosts } from "./lib/bundle.js";
import {
  interruptActive,
  numberField,
  objectField,
  runCli,
  stringField,
} from "./lib/humanish-cli.js";
import {
  BRAINS,
  canStartAnalysis,
  canStartParticipant,
  isBrainId,
  participantBoundUsd,
  planRuns,
  projectBrain,
  round,
  type BrainId,
  type BudgetSettings,
} from "./lib/plan.js";
import { REPO_ROOT, fixtureDigests, studyId, writeProject } from "./lib/project.js";
import {
  MANIFEST_SCHEMA,
  buildResult,
  summaryMarkdown,
  type Manifest,
  type RunRecord,
} from "./lib/report.js";
import { MISSIONS, type MissionId } from "./taskly/missions.js";

const USAGE = `Usage: pnpm bench [options]

Runs the Taskly planted and clean builds through humanish and scores the reports and analyses.

  --brain <ids>            openai-computer-use (default), local-agent-claude, local-agent-codex; comma-separated
  --runs <n>               runs per arm per brain (default 3)
  --max-usd <usd>          hard cap on estimated spend per brain (default 4)
  --mission <id>           neutral (default) or walked
  --dry-run                plan and estimate cost; no keys, no desktop, no spend
  --dotenv <path>          passed to the humanish CLI, which loads keys without printing them
  --cli <path>             humanish CLI to run (default: this checkout's dist/cli.js)
  --participant-cap <usd>  the study's caps.maxUsd for a priced participant (default 0.6)
  --analysis-max-usd <usd> humanish analyze --max-cost per run (default 1.75)
  --no-analysis            skip the analysis step
  --work-dir <dir>         where the throwaway project and bundles go (default: a new temp dir)
  --out <dir>              where the results JSON and summary go (default: the work dir)
  --rescore <work-dir>     score an earlier invocation's bundles again; no spend
`;

const RUN_TIMEOUT_MS = 40 * 60_000;
const ANALYSIS_TIMEOUT_MS = 12 * 60_000;
const SHORT_TIMEOUT_MS = 5 * 60_000;
/** Desktop starts closer together than this have failed in bursts on E2B. */
const START_SPACING_MS = 40_000;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function positiveNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) fail(`${flag} must be a positive number, got ${raw}.`);
  return value;
}

const { values } = parseArgs({
  options: {
    brain: { type: "string", default: "openai-computer-use" },
    runs: { type: "string", default: "3" },
    "max-usd": { type: "string", default: "4" },
    mission: { type: "string", default: "neutral" },
    "dry-run": { type: "boolean", default: false },
    dotenv: { type: "string" },
    cli: { type: "string", default: path.join(REPO_ROOT, "dist", "cli.js") },
    "participant-cap": { type: "string", default: "0.6" },
    "analysis-max-usd": { type: "string", default: "1.75" },
    "no-analysis": { type: "boolean", default: false },
    "work-dir": { type: "string" },
    out: { type: "string" },
    rescore: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

function writeResults(projectDir: string, manifest: Manifest, outDir: string): void {
  const result = buildResult(projectDir, manifest);
  const stem = `${result.createdAt.slice(0, 10)}-${result.humanish.version}-${manifest.mission}-${manifest.brains.join("+")}`;
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${stem}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  const mdPath = path.join(outDir, `${stem}.md`);
  writeFileSync(mdPath, summaryMarkdown(result, `${stem}.json`));
  for (const brain of result.brains) {
    const report = brain.summary.report.recall.total;
    const analysis = brain.summary.analysis.recall.total;
    process.stdout.write(
      `${brain.brain}: report recall ${report.hits}/${report.of}, analysis recall ${analysis.hits}/${analysis.of}, ` +
        `invented on clean ${brain.summary.report.invented.clean} (reports) and ${brain.summary.analysis.invented.clean} (analyses), ` +
        `estimated spend $${brain.spentUsd.total.toFixed(2)}\n`,
    );
  }
  process.stdout.write(`Results: ${jsonPath}\nSummary: ${mdPath}\n`);
}

if (values.rescore !== undefined) {
  const workDir = path.resolve(values.rescore);
  const manifest = readJson<Manifest>(path.join(workDir, "manifest.json"));
  writeResults(path.join(workDir, "project"), manifest, path.resolve(values.out ?? workDir));
  process.exit(0);
}

const brainIds = values.brain.split(",").map((brain) => brain.trim());
for (const brain of brainIds) {
  if (!isBrainId(brain)) fail(`Unknown brain ${brain}. Choose from: ${Object.keys(BRAINS).join(", ")}.`);
}
const brains = brainIds as BrainId[];
const runsPerArm = Number(values.runs);
if (!Number.isSafeInteger(runsPerArm) || runsPerArm < 1) fail(`--runs must be a whole number of at least 1.`);
if (values.mission !== "neutral" && values.mission !== "walked") fail(`--mission must be neutral or walked.`);
const mission = MISSIONS[values.mission as MissionId];
const cliPath = path.resolve(values.cli);
if (!existsSync(cliPath)) fail(`No humanish CLI at ${cliPath}. Run pnpm build, or pass --cli.`);
const version = execFileSync(process.execPath, [cliPath, "--version"], { encoding: "utf8" }).trim();
const source =
  cliPath === path.join(REPO_ROOT, "dist", "cli.js") ? `this checkout at ${gitState()}` : `${cliPath}`;

/** The checkout's commit, and the commit that last changed src/, which is what the build measures. */
function gitState(): string {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  try {
    const head = git("rev-parse", "--short", "HEAD");
    const src = git("log", "-1", "--format=%h", "--", "src");
    const dirty = git("status", "--porcelain", "--", "src") ? ", with uncommitted src/ changes" : "";
    return `${head}, src/ as of ${src}${dirty}`;
  } catch {
    return "an unknown commit";
  }
}

const dryRun = values["dry-run"];
const workDir = path.resolve(values["work-dir"] ?? mkdtempSync(path.join(os.tmpdir(), "humanish-bench-")));
const projectDir = path.join(workDir, "project");
const logFile = path.join(workDir, "cli.log");
const outDir = path.resolve(values.out ?? workDir);
mkdirSync(projectDir, { recursive: true });
writeProject(
  projectDir,
  brains.map((brain) => BRAINS[brain]),
  mission,
  positiveNumber(values["participant-cap"], "--participant-cap"),
);

// The CLI's own dry run checks each generated study and reports its worst-case desktop minutes.
let worstCaseDesktopMinutes = 0;
for (const brain of brains) {
  for (const arm of ["planted", "clean"] as const) {
    const id = studyId(BRAINS[brain], arm);
    const check = await runCli(cliPath, ["run", id, "--cwd", projectDir, "--dry-run", "--no-open", "--detach", "--json"], {
      logFile,
      timeoutMs: SHORT_TIMEOUT_MS,
    });
    if (check.code !== 0 || check.json?.ok !== true) fail(`The CLI refused study ${id}; see ${logFile}.`);
    const minutes = numberField(objectField(check.json, "plan"), "worstCaseSandboxMinutes");
    worstCaseDesktopMinutes = Math.max(worstCaseDesktopMinutes, minutes ?? 0);
  }
}

const budget: BudgetSettings = {
  maxUsdPerBrain: positiveNumber(values["max-usd"], "--max-usd"),
  participantCapUsd: positiveNumber(values["participant-cap"], "--participant-cap"),
  analysisMaxUsd: positiveNumber(values["analysis-max-usd"], "--analysis-max-usd"),
  worstCaseDesktopMinutes,
  analysis: !values["no-analysis"],
};

process.stdout.write(
  `humanish ${version} (${source}), mission ${mission.id}, ${runsPerArm} runs per arm, cap $${budget.maxUsdPerBrain} per brain\n`,
);
for (const brain of brains) {
  const projection = projectBrain(BRAINS[brain], runsPerArm * 2, budget);
  process.stdout.write(
    `${brain}: ${projection.runs} runs planned. At typical spend, ${projection.participantsFit} runs and ` +
      `${projection.analysesFit} analyses fit under $${budget.maxUsdPerBrain}, about $${projection.typicalUsd.toFixed(2)}. ` +
      `Worst case for the whole plan: $${projection.boundUsd.toFixed(2)}.` +
      `${BRAINS[brain].priced ? "" : " Participant model spend is unpriced and not bounded by the cap."}\n`,
  );
  if (projection.participantsFit < projection.runs || (budget.analysis && projection.analysesFit < projection.runs)) {
    process.stdout.write(`  The plan does not fit: lower --runs or raise --max-usd for a complete result.\n`);
  }
}

if (dryRun) {
  if (values["work-dir"] === undefined) rmSync(workDir, { recursive: true, force: true });
  process.stdout.write("Dry run: no participant ran and nothing was spent.\n");
  process.exit(0);
}

const manifest: Manifest = {
  schema: MANIFEST_SCHEMA,
  createdAt: new Date().toISOString(),
  humanish: { version, source },
  mission: mission.id,
  brains,
  runsPerArm,
  budget,
  fixture: fixtureDigests(),
  stopped: {},
  runs: [],
};
const saveManifest = (): void =>
  writeFileSync(path.join(workDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
saveManifest();
process.stdout.write(`Work dir: ${workDir}\n`);

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  interruptActive();
});

const dotenvArgs = values.dotenv ? ["--dotenv", path.resolve(values.dotenv)] : [];
// `humanish analyze` takes no --dotenv, so Node loads the same file into that child's environment.
const analyzeNodeArgs = values.dotenv ? [`--env-file=${path.resolve(values.dotenv)}`] : [];
const spent: Partial<Record<BrainId, number>> = {};
const consecutiveFailures: Partial<Record<BrainId, number>> = {};
let lastStart = 0;
const runsRoot = path.join(projectDir, ".humanish", "runs");
const runDirectories = (): Set<string> =>
  new Set(existsSync(runsRoot) ? readdirSync(runsRoot).filter((name) => name !== "latest.json") : []);

/**
 * Analyze one run when its admission estimate still fits under the cap. A dispatched request with
 * no recorded estimate is charged its whole limit.
 */
async function analyzeWithinBudget(
  runId: string,
  spentUsd: number,
): Promise<{ analysis: RunRecord["analysis"]; chargeUsd: number }> {
  const args = ["analyze", "--run", runId, "--cwd", projectDir, "--max-cost", String(budget.analysisMaxUsd), "--json"];
  const admission = await runCli(cliPath, [...args, "--dry-run"], { logFile, timeoutMs: SHORT_TIMEOUT_MS });
  const admissionUsd = numberField(objectField(admission.json, "admission"), "estimatedCostUsd");
  const base = { analysisId: null, estimatedUsd: null, admissionUsd };
  if (admission.json?.ok !== true) {
    return {
      analysis: { ...base, state: "refused", error: stringField(objectField(admission.json, "error"), "code") },
      chargeUsd: 0,
    };
  }
  if (!canStartAnalysis(spentUsd, budget, admissionUsd ?? budget.analysisMaxUsd)) {
    return { analysis: { ...base, state: "skipped_budget", error: null }, chargeUsd: 0 };
  }
  const result = await runCli(cliPath, args, {
    logFile,
    timeoutMs: ANALYSIS_TIMEOUT_MS,
    nodeArgs: analyzeNodeArgs,
  });
  const usage = objectField(result.json, "usage");
  const estimated = numberField(usage, "estimatedCostUsd");
  const dispatched = usage?.dispatched === true;
  return {
    analysis: {
      ...base,
      state: result.json?.ok === true ? "complete" : dispatched ? "failed" : "refused",
      analysisId: stringField(result.json, "analysisId"),
      estimatedUsd: estimated,
      error: stringField(objectField(result.json, "error"), "code"),
    },
    chargeUsd: estimated ?? (dispatched ? budget.analysisMaxUsd : 0),
  };
}

for (const planned of planRuns(brains, runsPerArm)) {
  const brain = BRAINS[planned.brain];
  if (interrupted) manifest.stopped[planned.brain] ??= "interrupted";
  if (manifest.stopped[planned.brain]) continue;
  const spentSoFar = spent[planned.brain] ?? 0;
  if (!canStartParticipant(spentSoFar, brain, budget)) {
    manifest.stopped[planned.brain] =
      `budget: $${spentSoFar.toFixed(2)} spent, and the next run could add $${participantBoundUsd(brain, budget).toFixed(2)}`;
    saveManifest();
    continue;
  }
  const wait = lastStart + START_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastStart = Date.now();
  const record: RunRecord = {
    brain: planned.brain,
    arm: planned.arm,
    index: planned.index,
    studyId: studyId(brain, planned.arm),
    runId: null,
    ok: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    analysis: { state: "not_run", analysisId: null, estimatedUsd: null, admissionUsd: null, error: null },
    cleanup: null,
  };
  manifest.runs.push(record);
  saveManifest();
  process.stdout.write(`${planned.brain} ${planned.arm} ${planned.index}: running\n`);

  const before = runDirectories();
  const run = await runCli(
    cliPath,
    ["run", record.studyId, "--cwd", projectDir, "--no-open", "--detach", "--json", ...dotenvArgs],
    { logFile, timeoutMs: RUN_TIMEOUT_MS },
  );
  // A run stopped by a timeout or a signal prints no JSON; its directory still names it.
  record.runId =
    stringField(run.json, "runId") ?? [...runDirectories()].find((id) => !before.has(id)) ?? null;
  record.ok = typeof run.json?.ok === "boolean" ? run.json.ok : false;
  record.error = run.timedOut
    ? "timed out"
    : stringField(objectField(run.json, "error"), "code") ?? (record.ok ? null : `exit ${run.code ?? "signal"}`);
  record.finishedAt = new Date().toISOString();
  saveManifest();

  if (record.runId !== null) {
    const cleanup = await runCli(cliPath, ["cleanup", "--run", record.runId, "--cwd", projectDir, "--json"], {
      logFile,
      timeoutMs: SHORT_TIMEOUT_MS,
    });
    const summary = objectField(cleanup.json, "summary");
    const failed = numberField(summary, "failed") ?? 0;
    record.cleanup = { alreadyClean: numberField(summary, "alreadyClean") ?? 0, failed, reclaimed: null };
    if (failed > 0) {
      const reclaim = await runCli(
        cliPath,
        ["reclaim", "--run", record.runId, "--cwd", projectDir, "--json", ...dotenvArgs],
        { logFile, timeoutMs: SHORT_TIMEOUT_MS },
      );
      record.cleanup.reclaimed = reclaim.json?.ok === true;
    }
    try {
      const costs = runCosts(readRunBundle(projectDir, record.runId));
      spent[planned.brain] = round(
        spentSoFar + (costs.participantUsd ?? 0) + (costs.desktopUsd ?? 0),
      );
    } catch {
      // No readable bundle: count the participant's worst case so the cap still holds.
      spent[planned.brain] = round(spentSoFar + participantBoundUsd(brain, budget));
    }
    consecutiveFailures[planned.brain] = 0;
  } else {
    consecutiveFailures[planned.brain] = (consecutiveFailures[planned.brain] ?? 0) + 1;
    if ((consecutiveFailures[planned.brain] ?? 0) >= 2) {
      manifest.stopped[planned.brain] = `two runs in a row failed before recording a run (${record.error ?? "unknown"})`;
    }
  }

  const afterRun = spent[planned.brain] ?? 0;
  if (record.runId === null) record.analysis.state = "skipped_no_run";
  else if (!budget.analysis) record.analysis.state = "skipped_disabled";
  else if (interrupted) record.analysis.state = "not_run";
  else {
    const { analysis, chargeUsd } = await analyzeWithinBudget(record.runId, afterRun);
    record.analysis = analysis;
    spent[planned.brain] = round(afterRun + chargeUsd);
  }
  saveManifest();
  process.stdout.write(
    `${planned.brain} ${planned.arm} ${planned.index}: run ${record.ok ? "ok" : `failed (${record.error ?? "unknown"})`}, ` +
      `analysis ${record.analysis.state}, spent $${(spent[planned.brain] ?? 0).toFixed(2)}\n`,
  );
}

saveManifest();
writeResults(projectDir, manifest, outDir);
