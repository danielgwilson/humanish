// pnpm bench: run the Taskly planted-defect benchmark against a humanish build and score it.
// docs/evidence/benchmark/README.md explains the flags, the scores and the budget rules.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { admissionFor, analyzeWithinBudget } from "./lib/analyze.js";
import { readJson, readRunBundle, runCosts } from "./lib/bundle.js";
import {
  interruptActive,
  numberField,
  objectField,
  runCli,
  stringField,
} from "./lib/humanish-cli.js";
import { DEFAULT_ANALYSIS_SPEC, parseAnalysisSpecs, refusedSpecs, runAnalysisMatrix } from "./lib/matrix.js";
import {
  BRAINS,
  analysisCostFor,
  parseParticipant,
  withParticipant,
  type Brain,
  type ParticipantSettings,
  canStartParticipant,
  SpendLedger,
  capThatFits,
  isBrainId,
  participantBoundUsd,
  planRuns,
  projectAnalyses,
  projectBrain,
  round,
  type AnalysisCost,
  type BrainId,
  type BudgetSettings,
} from "./lib/plan.js";
import {
  DEFAULT_PERSONA_FILE,
  REPO_ROOT,
  fixtureDigests,
  personaId,
  studyId,
  writeProject,
} from "./lib/project.js";
import {
  MANIFEST_SCHEMA,
  analysisRefusalLines,
  buildResult,
  summaryMarkdown,
  type AnalysisSpec,
  type Manifest,
  type MatrixAnalysis,
  type RunRecord,
} from "./lib/report.js";
import type { Storage } from "./taskly/answer-key.js";
import { MISSIONS, type MissionId } from "./taskly/missions.js";

const USAGE = `Usage: pnpm bench [options]

Runs the Taskly planted and clean builds through humanish and scores the reports and analyses.

  --brain <ids>            openai-computer-use (default), local-agent-claude, local-agent-codex; comma-separated
  --runs <n>               runs per arm per brain (default 3)
  --max-usd <usd>          hard cap on estimated spend per brain (default 7)
  --mission <id>           neutral (default) or walked
  --dry-run                plan and estimate cost; no keys, no desktop, no spend
  --dotenv <path>          passed to the humanish CLI, which loads keys without printing them
  --cli <path>             humanish CLI to run (default: this checkout's dist/cli.js)
  --participant-cap <usd>  the study's caps.maxUsd for a priced participant (default 0.6)
  --participant <model[@effort]> the participant model and reasoning effort (default: the CLI's)
  --service-tier fast      send participant requests in OpenAI Fast mode
  --persona <file>         persona file the studies use (default: humanish/personas/synthetic-new-user.yaml)
  --storage <where>        memory (default): tasks are lost on reload; local: the builds keep them in localStorage
  --analysis-max-usd <usd> per-run cap override (default: the admitted cost analyze --dry-run reports)
  --analysis-max-output-tokens <n> each analysis's output limit, 256 to 32768 (default 16384)
  --no-analysis            skip the analysis step
  --work-dir <dir>         where the throwaway project and bundles go (default: a new temp dir)
  --out <dir>              where the results JSON and summary go (default: the work dir)
  --rescore <work-dir>     score an earlier invocation's bundles again; no spend
  --analysis-models <list> analyze every recorded run once per model: model or provider:model, each with an optional @effort, comma-separated
  --analysis-repeats <n>   analyses of each run per model (default 1)
  --analysis-concurrency <n> analyses in flight at once across the models (default 4)
  --reanalyze <work-dir>   run only the analysis models on an earlier invocation's recordings; no participant spend
`;

const RUN_TIMEOUT_MS = 40 * 60_000;
const SHORT_TIMEOUT_MS = 5 * 60_000;
/** Desktop starts closer together than this have failed in bursts on E2B. */
const START_SPACING_MS = 40_000;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function outputTokens(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 256 || value > 32_768)
    fail(`--analysis-max-output-tokens must be a whole number from 256 to 32768, got ${raw}.`);
  return value;
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
    "max-usd": { type: "string", default: "7" },
    mission: { type: "string", default: "neutral" },
    "dry-run": { type: "boolean", default: false },
    dotenv: { type: "string" },
    cli: { type: "string", default: path.join(REPO_ROOT, "dist", "cli.js") },
    "participant-cap": { type: "string", default: "0.6" },
    "analysis-max-usd": { type: "string" },
    participant: { type: "string" },
    "service-tier": { type: "string" },
    persona: { type: "string" },
    storage: { type: "string", default: "memory" },
    "analysis-max-output-tokens": { type: "string" },
    "no-analysis": { type: "boolean", default: false },
    "work-dir": { type: "string" },
    out: { type: "string" },
    rescore: { type: "string" },
    "analysis-models": { type: "string" },
    "analysis-repeats": { type: "string" },
    "analysis-concurrency": { type: "string", default: "4" },
    reanalyze: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

/** The results file's participant suffix, such as `-gpt-6.1-sol@low-fast`. */
function participantLabel(settings: ParticipantSettings | undefined): string {
  if (settings === undefined) return "";
  const effort = settings.reasoningEffort === undefined ? "" : `@${settings.reasoningEffort}`;
  return `-${settings.model}${effort}${settings.serviceTier === undefined ? "" : `-${settings.serviceTier}`}`;
}

function writeResults(projectDir: string, manifest: Manifest, outDir: string): void {
  const result = buildResult(projectDir, manifest);
  const stem =
    `${result.createdAt.slice(0, 10)}-${result.humanish.version}-${manifest.mission}-${manifest.brains.join("+")}` +
    participantLabel(manifest.participant) +
    (manifest.persona === undefined || manifest.persona === "synthetic-new-user" ? "" : `-${manifest.persona}`) +
    (manifest.storage === "local" ? "-local-storage" : "") +
    (manifest.analysisMatrix ? "-analysis-models" : "");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${stem}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  const mdPath = path.join(outDir, `${stem}.md`);
  writeFileSync(mdPath, summaryMarkdown(result, `${stem}.json`));
  for (const brain of result.brains) {
    for (const line of analysisRefusalLines(brain)) process.stdout.write(`${brain.brain} ${line}\n`);
    const report = brain.summary.report.recall.total;
    const analysis = brain.summary.analysis.recall.total;
    process.stdout.write(
      `${brain.brain}: report recall ${report.hits}/${report.of}, analysis recall ${analysis.hits}/${analysis.of}, ` +
        `invented on clean ${brain.summary.report.invented.clean} (reports) and ${brain.summary.analysis.invented.clean} (analyses), ` +
        `estimated spend $${brain.spentUsd.total.toFixed(2)}\n`,
    );
    for (const model of brain.analysisModels ?? []) {
      const recall = model.summary.recall.total;
      process.stdout.write(
        `${brain.brain} ${model.spec}: analysis recall ${recall.hits}/${recall.of}, invented on clean ${model.summary.invented.clean}, ` +
          `estimated spend $${model.spentUsd.total.toFixed(2)} over ${model.analyses.length} analyses, ` +
          `wall time ${Math.round(model.wallMs.total / 1000)} s\n`,
      );
    }
  }
  process.stdout.write(`Results: ${jsonPath}\nSummary: ${mdPath}\n`);
}

if (values.rescore !== undefined && values.reanalyze !== undefined) {
  fail("--rescore scores recorded analyses and --reanalyze makes new ones. Pass one of them.");
}
if (values.rescore !== undefined) {
  const workDir = path.resolve(values.rescore);
  const manifest = readJson<Manifest>(path.join(workDir, "manifest.json"));
  writeResults(path.join(workDir, "project"), manifest, path.resolve(values.out ?? workDir));
  process.exit(0);
}

const cliPath = path.resolve(values.cli);
if (!existsSync(cliPath)) fail(`No humanish CLI at ${cliPath}. Run pnpm build, or pass --cli.`);
const version = execFileSync(process.execPath, [cliPath, "--version"], { encoding: "utf8" }).trim();
const source =
  cliPath === path.join(REPO_ROOT, "dist", "cli.js") ? `this checkout at ${gitState()}` : `${cliPath}`;
const dryRun = values["dry-run"];
const dotenvArgs = values.dotenv ? ["--dotenv", path.resolve(values.dotenv)] : [];
// `humanish analyze` takes no --dotenv, so Node loads the same file into that child's environment.
const analyzeNodeArgs = values.dotenv ? [`--env-file=${path.resolve(values.dotenv)}`] : [];
const analysisLimits = {
  analysisMaxUsd: values["analysis-max-usd"] === undefined
    ? Math.min(1000, positiveNumber(values["max-usd"], "--max-usd"))
    : positiveNumber(values["analysis-max-usd"], "--analysis-max-usd"),
  analysisAutoCap: values["analysis-max-usd"] === undefined,
  ...(values["analysis-max-output-tokens"] === undefined
    ? {}
    : { analysisMaxOutputTokens: outputTokens(values["analysis-max-output-tokens"]) }),
};

// The analysis matrix: each recorded run analyzed by every model, `repeats` times.
const matrixMode =
  values["analysis-models"] !== undefined || values["analysis-repeats"] !== undefined || values.reanalyze !== undefined;
if (matrixMode && values["no-analysis"]) fail("--no-analysis turns analysis off; the analysis model flags turn it on. Pass one or the other.");
let specs: AnalysisSpec[] = [DEFAULT_ANALYSIS_SPEC];
if (values["analysis-models"] !== undefined) {
  try {
    specs = parseAnalysisSpecs(values["analysis-models"]);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
const repeats = Number(values["analysis-repeats"] ?? "1");
if (!Number.isSafeInteger(repeats) || repeats < 1) fail(`--analysis-repeats must be a whole number of at least 1.`);
const concurrency = Number(values["analysis-concurrency"]);
if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
  fail(`--analysis-concurrency must be a whole number of at least 1.`);
}

/** Replace the manifest whole, so a reader or a crash never sees a partly written file. */
function writeManifest(file: string, manifest: Manifest): void {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** The first Ctrl-C stops new analyses; detached analyses in flight finish and are recorded. */
function onInterrupt(stop: () => void): void {
  process.on("SIGINT", () => {
    stop();
    interruptActive();
    process.stdout.write("Interrupted: no new run or analysis starts; analyses in flight finish and are recorded.\n");
  });
}

const SPEC_REFUSED =
  "Remove the refused analysis models, or pass --cli with a humanish build that supports them. Nothing was spent.";

/** Print each analysis model the CLI refuses; true when there is one. */
async function anySpecRefused(projectDir: string, logFile: string): Promise<boolean> {
  const refusals = await refusedSpecs(specs, { cliPath, projectDir, logFile });
  for (const refusal of refusals) {
    process.stdout.write(`${refusal.spec}: humanish ${version} refuses this analyst. ${refusal.message}\n`);
  }
  return refusals.length > 0;
}

/** The dry-run projection for each analysis model, from per-analysis cost estimates. */
function printModelProjections(
  costs: (spec: AnalysisSpec) => AnalysisCost[] | null,
  planned: number,
  basis: string,
  capUsd: number,
): void {
  for (const spec of specs) {
    const known = costs(spec);
    if (known === null) {
      process.stdout.write(
        `${spec.label}: ${planned} analyses planned. This checkout has no rate for ${spec.model}, so the dry run cannot project ` +
          `its spend. Each analysis still starts only when the worst case analyze --dry-run reports fits under $${capUsd}.\n`,
      );
      continue;
    }
    const projection = projectAnalyses(known, capUsd);
    const refused = planned - known.length;
    process.stdout.write(
      `${spec.label}: ${planned} analyses planned${refused > 0 ? `, ${refused} refused by analyze --dry-run` : ""}. ` +
        `At ${basis}, ${projection.fit} fit under $${capUsd}, about $${projection.typicalUsd.toFixed(2)}. ` +
        `If each wrote its whole output allowance, ${projection.worstCaseFit} would fit, $${projection.worstCaseUsd.toFixed(2)}.\n`,
    );
    process.stdout.write(
      projection.fit < projection.analyses
        ? `  The plan does not fit $${capUsd}: every analysis starts at --max-usd ${projection.capThatFits}, or lower the runs or --analysis-repeats.\n`
        : `  Every planned analysis fits under $${capUsd}.\n`,
    );
  }
}

/** Analyze the manifest's recorded runs with every model, saving the manifest after each one. */
async function runMatrix(
  manifest: Manifest,
  budget: BudgetSettings,
  paths: { projectDir: string; logFile: string },
  save: () => void,
  stopped: () => boolean,
): Promise<void> {
  const runOf = (analysis: MatrixAnalysis): RunRecord | undefined =>
    manifest.runs.find((run) => run.runId === analysis.runId);
  await runAnalysisMatrix(manifest, {
    specs, repeats, concurrency, budget, cliPath, cliVersion: version, ...paths, analyzeNodeArgs, stopped,
    onRecord: (analysis, spentUsd) => {
      save();
      const run = runOf(analysis);
      process.stdout.write(
        `${analysis.spec} ${run ? `${run.arm} ${run.index}` : analysis.runId} repeat ${analysis.repeat}: ` +
          `analysis ${analysis.state}${analysis.error ? ` (${analysis.error})` : ""}, spent $${spentUsd.toFixed(2)}\n`,
      );
    },
  });
}

let interrupted = false;

if (values.reanalyze !== undefined) {
  const workDir = path.resolve(values.reanalyze);
  const manifestPath = path.join(workDir, "manifest.json");
  if (!existsSync(manifestPath)) fail(`No manifest.json in ${workDir}. Pass the --work-dir of an earlier pnpm bench.`);
  const manifest = readJson<Manifest>(manifestPath);
  const projectDir = path.join(workDir, "project");
  const logFile = path.join(workDir, "cli.log");
  const budget: BudgetSettings = {
    ...manifest.budget,
    maxUsdPerBrain: positiveNumber(values["max-usd"], "--max-usd"),
    ...analysisLimits,
    analysis: true,
  };
  const recorded = manifest.runs.flatMap((run) => (run.runId === null ? [] : [run.runId]));
  process.stdout.write(
    `humanish ${version} (${source}) analyzing ${recorded.length} recorded runs from ${workDir}, ` +
      `${repeats} analys${repeats === 1 ? "is" : "es"} of each per model, cap $${budget.maxUsdPerBrain} per model\n`,
  );
  if (await anySpecRefused(projectDir, logFile)) fail(SPEC_REFUSED);
  if (dryRun) {
    // Admission on each recorded run is the CLI's own estimate for that run and analyst.
    const admitted = new Map<string, AnalysisCost[]>();
    for (const spec of specs) {
      const costs: AnalysisCost[] = [];
      for (const runId of recorded) {
        const admission = await admissionFor({ runId, budget, cliPath, projectDir, logFile, spec });
        if (admission.ok && admission.admissionUsd !== null && admission.worstCaseUsd !== null) {
          costs.push({ typicalUsd: admission.admissionUsd, worstCaseUsd: admission.worstCaseUsd });
        }
      }
      admitted.set(spec.label, Array.from({ length: repeats }, () => costs).flat());
    }
    printModelProjections((spec) => admitted.get(spec.label) ?? [], recorded.length * repeats, "the expected cost analyze --dry-run reports", budget.maxUsdPerBrain);
    process.stdout.write("Dry run: no analysis ran and nothing was spent.\n");
    process.exit(0);
  }
  onInterrupt(() => {
    interrupted = true;
  });
  const save = (): void => writeManifest(manifestPath, manifest);
  await runMatrix(manifest, budget, { projectDir, logFile }, save, () => interrupted);
  save();
  writeResults(projectDir, manifest, path.resolve(values.out ?? workDir));
  process.exit(0);
}

const brainIds = values.brain.split(",").map((brain) => brain.trim());
for (const brain of brainIds) {
  if (!isBrainId(brain)) fail(`Unknown brain ${brain}. Choose from: ${Object.keys(BRAINS).join(", ")}.`);
}
const brains = brainIds as BrainId[];
let participant: ParticipantSettings | undefined;
if (values.participant !== undefined || values["service-tier"] !== undefined) {
  try {
    participant = parseParticipant(values.participant ?? "gpt-5.6-sol", values["service-tier"]);
    for (const brain of brains) withParticipant(BRAINS[brain], participant);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
/** The brain with this invocation's participant settings. */
const brainFor = (id: BrainId): Brain =>
  participant === undefined ? BRAINS[id] : withParticipant(BRAINS[id], participant);
const personaFile = path.resolve(values.persona ?? DEFAULT_PERSONA_FILE);
if (!existsSync(personaFile)) fail(`No persona file at ${personaFile}.`);
const runsPerArm = Number(values.runs);
if (!Number.isSafeInteger(runsPerArm) || runsPerArm < 1) fail(`--runs must be a whole number of at least 1.`);
if (values.mission !== "neutral" && values.mission !== "walked") fail(`--mission must be neutral or walked.`);
const mission = MISSIONS[values.mission as MissionId];
if (values.storage !== "memory" && values.storage !== "local") fail(`--storage must be memory or local.`);
const storage: Storage = values.storage;

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

const workDir = path.resolve(values["work-dir"] ?? mkdtempSync(path.join(os.tmpdir(), "humanish-bench-")));
const projectDir = path.join(workDir, "project");
const logFile = path.join(workDir, "cli.log");
const outDir = path.resolve(values.out ?? workDir);
mkdirSync(projectDir, { recursive: true });
writeProject(
  projectDir,
  brains.map(brainFor),
  mission,
  positiveNumber(values["participant-cap"], "--participant-cap"),
  personaFile,
  storage,
);

// The CLI's own dry run checks each generated study and reports its worst-case desktop minutes.
let worstCaseDesktopMinutes = 0;
for (const brain of brains) {
  for (const arm of ["planted", "clean"] as const) {
    const id = studyId(brainFor(brain), arm);
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
  ...analysisLimits,
  worstCaseDesktopMinutes,
  // With the analysis matrix, the matrix analyzes each run after every participant has run.
  analysis: !values["no-analysis"] && !matrixMode,
};

process.stdout.write(
  `humanish ${version} (${source}), mission ${mission.id}, ${storage === "local" ? "builds keeping tasks in localStorage, " : ""}${runsPerArm} run${runsPerArm === 1 ? "" : "s"} per arm, cap $${budget.maxUsdPerBrain} per brain` +
    (matrixMode
      ? ` and per analysis model, ${repeats} analys${repeats === 1 ? "is" : "es"} of each run per model after every participant has run\n`
      : "\n"),
);
for (const brain of brains) {
  const projection = projectBrain(brainFor(brain), runsPerArm * 2, budget);
  process.stdout.write(
    `${brain}: ${projection.runs} runs planned. At typical spend, ${projection.participantsFit} runs` +
      `${budget.analysis ? ` and ${projection.analysesFit} analyses` : ""} fit under $${budget.maxUsdPerBrain}, about $${projection.typicalUsd.toFixed(2)}. ` +
      `Worst case for the whole plan: $${projection.boundUsd.toFixed(2)}.` +
      `${brainFor(brain).priced ? "" : " Participant model spend is unpriced and not bounded by the cap."}\n`,
  );
  if (projection.participantsFit < projection.runs || (budget.analysis && projection.analysesFit < projection.runs)) {
    const needed = capThatFits(brainFor(brain), runsPerArm * 2, budget);
    process.stdout.write(
      `  The plan does not fit $${budget.maxUsdPerBrain}: every run and analysis starts at --max-usd ${needed}, or lower --runs.\n`,
    );
  } else {
    process.stdout.write(`  Every planned run and analysis fits under $${budget.maxUsdPerBrain}.\n`);
  }
}

const specRefused = matrixMode && (await anySpecRefused(projectDir, logFile));
if (matrixMode) {
  const planned = runsPerArm * 2 * brains.length * repeats;
  printModelProjections(
    (spec) => {
      const cost = analysisCostFor(spec.model, spec.reasoningEffort);
      return cost === null ? null : Array.from({ length: planned }, () => cost);
    },
    planned,
    "typical spend, as recorded or scaled from gpt-6-astra at high effort by the model's rates",
    budget.maxUsdPerBrain,
  );
}

if (dryRun) {
  if (values["work-dir"] === undefined) rmSync(workDir, { recursive: true, force: true });
  process.stdout.write("Dry run: no participant ran and nothing was spent.\n");
  process.exit(specRefused ? 2 : 0);
}
if (specRefused) fail(SPEC_REFUSED);

const manifest: Manifest = {
  schema: MANIFEST_SCHEMA,
  createdAt: new Date().toISOString(),
  humanish: { version, source },
  mission: mission.id,
  brains,
  runsPerArm,
  budget,
  fixture: fixtureDigests(personaFile, storage),
  ...(storage === "memory" ? {} : { storage }),
  ...(participant === undefined ? {} : { participant }),
  persona: personaId(personaFile),
  stopped: {},
  runs: [],
};
const saveManifest = (): void =>
  writeManifest(path.join(workDir, "manifest.json"), manifest);
saveManifest();
process.stdout.write(`Work dir: ${workDir}\n`);

onInterrupt(() => {
  interrupted = true;
});

const spent: Partial<Record<BrainId, number>> = {};
const consecutiveFailures: Partial<Record<BrainId, number>> = {};
let lastStart = 0;
const runsRoot = path.join(projectDir, ".humanish", "runs");
const runDirectories = (): Set<string> =>
  new Set(existsSync(runsRoot) ? readdirSync(runsRoot).filter((name) => name !== "latest.json") : []);

for (const planned of planRuns(brains, runsPerArm)) {
  const brain = brainFor(planned.brain);
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
    // reclaim --check asks E2B whether each of the run's sandboxes still exists and kills nothing.
    // Any state other than clean (running, unconfirmed, unknown) gets a reclaim that kills.
    const reclaimArgs = ["reclaim", "--run", record.runId, "--cwd", projectDir, "--json", ...dotenvArgs];
    const check = await runCli(cliPath, [...reclaimArgs, "--check"], {
      logFile,
      timeoutMs: SHORT_TIMEOUT_MS,
    });
    const checkState = stringField(check.json, "state") ?? "unknown";
    record.cleanup = { checkState, reclaimState: null };
    if (checkState !== "clean") {
      const reclaim = await runCli(cliPath, reclaimArgs, { logFile, timeoutMs: SHORT_TIMEOUT_MS });
      record.cleanup.reclaimState = stringField(reclaim.json, "state") ?? "unknown";
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
    const { analysis, chargeUsd } = await analyzeWithinBudget({
      runId: record.runId, ledger: new SpendLedger(budget, afterRun), budget, cliPath, projectDir, logFile, analyzeNodeArgs,
    });
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
if (matrixMode && !interrupted) {
  await runMatrix(manifest, { ...budget, analysis: true }, { projectDir, logFile }, saveManifest, () => interrupted);
}
saveManifest();
writeResults(projectDir, manifest, outDir);
