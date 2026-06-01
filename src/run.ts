import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const RUN_BUNDLE_SCHEMA = "mimetic.run-bundle.v1";
export const REVIEW_SCHEMA = "mimetic.review.v1";
export const VERIFY_SCHEMA = "mimetic.verify-result.v1";
export const RUNS_SCHEMA = "mimetic.runs-result.v1";
export const DOCTOR_SCHEMA = "mimetic.doctor-result.v1";

export interface RunOptions {
  cwd: string;
  dryRun?: boolean;
  runId?: string;
  simCount?: number;
}

export interface RunBundle {
  schema: typeof RUN_BUNDLE_SCHEMA;
  runId: string;
  mode: "dry-run";
  simCount: number;
  createdAt: string;
  cwd: string;
  artifactRoot: string;
  source: {
    packageName: string | null;
    mimeticSource: "present" | "missing";
    git: {
      status: "not_captured";
      note: string;
    };
  };
  persona: {
    id: string;
    name: string;
    source: string;
    sourceDigest: string;
  };
  scenario: {
    id: string;
    title: string;
    goal: string;
    source: string;
    sourceDigest: string;
  };
  lifecycle: Array<{
    at: string;
    event: string;
    message: string;
  }>;
  simulations: Array<{
    id: string;
    index: number;
    personaId: string;
    scenarioId: string;
    status: "contract_proof_only";
    summary: string;
  }>;
  redaction: {
    status: "passed";
    notes: string;
  };
  artifacts: {
    run: string;
    reviewJson: string;
    reviewMarkdown: string;
  };
  review: ReviewSummary;
  feedbackCandidates: Array<unknown>;
}

export interface ReviewSummary {
  schema: typeof REVIEW_SCHEMA;
  verdict: "contract_proof_only";
  summary: string;
  gaps: string[];
}

export interface RunResult {
  schema: "mimetic.run-result.v1";
  ok: boolean;
  runId?: string;
  mode?: "dry-run";
  simCount?: number;
  cwd: string;
  artifactRoot?: string;
  bundlePath?: string;
  reviewPath?: string;
  latestPath?: string;
  warnings: string[];
  error?: {
    code: "MIMETIC_LIVE_RUN_UNIMPLEMENTED" | "MIMETIC_INVALID_CWD" | "MIMETIC_INVALID_SIM_COUNT";
    message: string;
  };
}

export interface VerifyResult {
  schema: typeof VERIFY_SCHEMA;
  ok: boolean;
  cwd: string;
  run: string;
  bundlePath?: string;
  checks: Array<{
    name: string;
    ok: boolean;
    message: string;
  }>;
  error?: {
    code: "MIMETIC_RUN_NOT_FOUND" | "MIMETIC_INVALID_RUN_BUNDLE";
    message: string;
  };
}

export interface RunsResult {
  schema: typeof RUNS_SCHEMA;
  ok: boolean;
  cwd: string;
  runs: Array<{
    runId: string;
    createdAt: string | null;
    mode: string | null;
    path: string;
  }>;
  latest: string | null;
}

export interface DoctorResult {
  schema: typeof DOCTOR_SCHEMA;
  ok: boolean;
  cwd: string;
  checks: Array<{
    name: string;
    ok: boolean;
    message: string;
  }>;
}

interface RunPointer {
  schema: "mimetic.latest-run.v1";
  runId: string;
  path: string;
  updatedAt: string;
}

const sensitivePatterns = [
  /sk-[a-z0-9_-]{12,}/i,
  /gho_[a-z0-9_]{12,}/i,
  /BEGIN (RSA|OPENSSH|PRIVATE) KEY/i
];

const builtinPersona = {
  id: "builtin-synthetic-new-user",
  name: "Built-in Synthetic New User",
  source: "builtin:synthetic-new-user",
  sourceDigest: "builtin"
};

const builtinScenario = {
  id: "builtin-first-run-smoke",
  title: "Built-in First-Run Smoke",
  goal: "Create a public-safe dry-run contract bundle from built-in defaults.",
  source: "builtin:first-run-smoke",
  sourceDigest: "builtin"
};

export async function runDryRun(options: RunOptions): Promise<RunResult> {
  const cwd = path.resolve(options.cwd);
  const cwdError = await validateCwd(cwd);
  const warnings: string[] = [];

  if (cwdError) {
    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd,
      warnings,
      error: cwdError
    };
  }

  if (!options.dryRun) {
    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd,
      warnings,
      error: {
        code: "MIMETIC_LIVE_RUN_UNIMPLEMENTED",
        message: "Only run --dry-run is implemented in this open-source-safe slice."
      }
    };
  }

  const simCount = normalizeSimCount(options.simCount);
  if (simCount === null) {
    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd,
      warnings,
      error: {
        code: "MIMETIC_INVALID_SIM_COUNT",
        message: "--sims must be an integer between 1 and 64."
      }
    };
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const runId = options.runId ?? `dryrun-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const artifactRoot = path.join(".mimetic", "runs", runId);
  const absoluteArtifactRoot = path.join(cwd, artifactRoot);
  const packageName = await readPackageName(cwd);
  const mimeticSource = await directoryExists(path.join(cwd, "mimetic")) ? "present" : "missing";
  const selection = await loadDryRunSelection(cwd, mimeticSource);

  if (mimeticSource === "missing") {
    warnings.push("Committed mimetic/ source was not found; using built-in synthetic dry-run defaults.");
  }
  warnings.push(...selection.warnings);

  const bundle: RunBundle = {
    schema: RUN_BUNDLE_SCHEMA,
    runId,
    mode: "dry-run",
    simCount,
    createdAt,
    cwd,
    artifactRoot,
    source: {
      packageName,
      mimeticSource,
      git: {
        status: "not_captured",
        note: "Source git state capture is planned for the core primitives slice."
      }
    },
    persona: selection.persona,
    scenario: selection.scenario,
    lifecycle: [
      {
        at: createdAt,
        event: "run.created",
        message: `Synthetic dry-run contract bundle created with ${simCount} sim${simCount === 1 ? "" : "s"}.`
      },
      {
        at: createdAt,
        event: "persona.selected",
        message: "Selected public-safe synthetic persona."
      },
      {
        at: createdAt,
        event: "scenario.selected",
        message: "Selected public-safe first-run scenario."
      },
      {
        at: createdAt,
        event: "review.skeleton.created",
        message: "Created review skeleton without claiming product proof."
      }
    ],
    simulations: Array.from({ length: simCount }, (_, index) => ({
      id: `sim-${String(index + 1).padStart(2, "0")}`,
      index: index + 1,
      personaId: selection.persona.id,
      scenarioId: selection.scenario.id,
      status: "contract_proof_only",
      summary: "Synthetic contract proof only; no live actor was launched."
    })),
    redaction: {
      status: "passed",
      notes: "Dry-run bundle contains synthetic contract proof only."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md"
    },
    review: createReviewSummary(),
    feedbackCandidates: []
  };

  await mkdir(absoluteArtifactRoot, { recursive: true });
  await writeJson(path.join(absoluteArtifactRoot, "run.json"), bundle);
  await writeJson(path.join(absoluteArtifactRoot, "review.json"), bundle.review);
  await writeFile(path.join(absoluteArtifactRoot, "review.md"), renderReviewMarkdown(bundle), "utf8");
  await writeJson(path.join(cwd, ".mimetic", "runs", "latest.json"), {
    schema: "mimetic.latest-run.v1",
    runId,
    path: artifactRoot,
    updatedAt: createdAt
  } satisfies RunPointer);

  return {
    schema: "mimetic.run-result.v1",
    ok: true,
    runId,
    mode: "dry-run",
    simCount,
    cwd,
    artifactRoot,
    bundlePath: path.join(artifactRoot, "run.json"),
    reviewPath: path.join(artifactRoot, "review.md"),
    latestPath: path.join(".mimetic", "runs", "latest.json"),
    warnings
  };
}

function normalizeSimCount(value: number | undefined): number | null {
  if (value === undefined) {
    return 1;
  }

  if (!Number.isInteger(value) || value < 1 || value > 64) {
    return null;
  }

  return value;
}

export async function verifyRun(cwdInput: string, runInput: string): Promise<VerifyResult> {
  const cwd = path.resolve(cwdInput);
  const checks: VerifyResult["checks"] = [];
  const resolved = await resolveRunPath(cwd, runInput);

  if (!resolved) {
    return {
      schema: VERIFY_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      checks,
      error: {
        code: "MIMETIC_RUN_NOT_FOUND",
        message: `Run not found: ${runInput}`
      }
    };
  }

  const bundlePath = path.join(resolved, "run.json");
  const bundle = await readJsonIfExists(bundlePath);
  const reviewJson = await readJsonIfExists(path.join(resolved, "review.json"));
  const reviewMarkdown = await readTextIfExists(path.join(resolved, "review.md"));

  checks.push({
    name: "run.json exists",
    ok: bundle !== null,
    message: bundle === null ? "run.json missing" : "run.json present"
  });
  checks.push({
    name: "run schema",
    ok: isRecord(bundle) && bundle.schema === RUN_BUNDLE_SCHEMA,
    message: "run bundle schema is mimetic.run-bundle.v1"
  });
  checks.push({
    name: "redaction passed",
    ok: isRecord(bundle) && isRecord(bundle.redaction) && bundle.redaction.status === "passed",
    message: "redaction status must be passed"
  });
  checks.push({
    name: "review artifacts exist",
    ok: reviewJson !== null && reviewMarkdown !== null,
    message: "review.json and review.md must exist"
  });
  checks.push({
    name: "public-safety scan",
    ok: !containsSensitivePattern(JSON.stringify(bundle ?? {}) + (reviewMarkdown ?? "")),
    message: "bundle and review text must not match known secret patterns"
  });

  const ok = checks.every((check) => check.ok);

  return {
    schema: VERIFY_SCHEMA,
    ok,
    cwd,
    run: runInput,
    bundlePath: path.relative(cwd, bundlePath),
    checks,
    ...(ok
      ? {}
      : {
          error: {
            code: "MIMETIC_INVALID_RUN_BUNDLE" as const,
            message: "Run bundle failed verification."
          }
        })
  };
}

export async function loadRunBundle(
  cwdInput: string,
  runInput: string
): Promise<{ bundle: RunBundle; bundlePath: string; runDir: string } | null> {
  const cwd = path.resolve(cwdInput);
  const resolved = await resolveRunPath(cwd, runInput);

  if (!resolved) {
    return null;
  }

  const bundlePath = path.join(resolved, "run.json");
  const bundle = await readJsonIfExists(bundlePath);

  if (!isRunBundle(bundle)) {
    return null;
  }

  return {
    bundle,
    bundlePath: path.relative(cwd, bundlePath),
    runDir: resolved
  };
}

export async function listRuns(cwdInput: string): Promise<RunsResult> {
  const cwd = path.resolve(cwdInput);
  const runsRoot = path.join(cwd, ".mimetic", "runs");
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const runs = [];
  const latest = await readLatest(cwd);

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const bundle = await readJsonIfExists(path.join(runsRoot, entry.name, "run.json"));
    runs.push({
      runId: entry.name,
      createdAt: isRecord(bundle) && typeof bundle.createdAt === "string" ? bundle.createdAt : null,
      mode: isRecord(bundle) && typeof bundle.mode === "string" ? bundle.mode : null,
      path: path.join(".mimetic", "runs", entry.name)
    });
  }

  return {
    schema: RUNS_SCHEMA,
    ok: true,
    cwd,
    runs: runs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
    latest: latest?.runId ?? null
  };
}

export async function readReview(cwdInput: string, runInput: string): Promise<VerifyResult | (ReviewSummary & { path: string; runId: string })> {
  const verified = await verifyRun(cwdInput, runInput);

  if (!verified.ok || !verified.bundlePath) {
    return verified;
  }

  const cwd = path.resolve(cwdInput);
  const runDir = path.dirname(path.join(cwd, verified.bundlePath));
  const review = await readJsonIfExists(path.join(runDir, "review.json"));

  if (!isReviewSummary(review)) {
    return {
      ...verified,
      ok: false,
      error: {
        code: "MIMETIC_INVALID_RUN_BUNDLE",
        message: "review.json is missing or invalid."
      }
    };
  }

  return {
    ...review,
    path: path.relative(cwd, path.join(runDir, "review.json")),
    runId: path.basename(runDir)
  };
}

export async function doctor(cwdInput: string): Promise<DoctorResult> {
  const cwd = path.resolve(cwdInput);
  const checks = [
    {
      name: "target cwd",
      ok: await directoryExists(cwd),
      message: "target directory exists"
    },
    {
      name: "package.json",
      ok: await fileExists(path.join(cwd, "package.json")),
      message: "package.json is present"
    },
    {
      name: "mimetic source",
      ok: await directoryExists(path.join(cwd, "mimetic")),
      message: "committed mimetic/ source directory is present"
    },
    {
      name: "runtime ignore",
      ok: (await readTextIfExists(path.join(cwd, ".gitignore")))?.includes(".mimetic/") ?? false,
      message: ".gitignore contains .mimetic/"
    }
  ];

  return {
    schema: DOCTOR_SCHEMA,
    ok: checks.every((check) => check.ok),
    cwd,
    checks
  };
}

function createReviewSummary(): ReviewSummary {
  return {
    schema: REVIEW_SCHEMA,
    verdict: "contract_proof_only",
    summary: "Synthetic dry-run bundle was generated. This proves Mimetic artifact plumbing, not product behavior.",
    gaps: [
      "No browser was launched.",
      "No product state was verified.",
      "No model, provider, or E2B substrate was used."
    ]
  };
}

async function loadDryRunSelection(
  cwd: string,
  mimeticSource: "present" | "missing"
): Promise<{
  persona: RunBundle["persona"];
  scenario: RunBundle["scenario"];
  warnings: string[];
}> {
  const warnings: string[] = [];

  if (mimeticSource === "missing") {
    return {
      persona: builtinPersona,
      scenario: builtinScenario,
      warnings
    };
  }

  const personaPath = "mimetic/personas/synthetic-new-user.yaml";
  const scenarioPath = "mimetic/scenarios/first-run-smoke.yaml";
  const personaText = await readTextIfExists(path.join(cwd, personaPath));
  const scenarioText = await readTextIfExists(path.join(cwd, scenarioPath));

  if (personaText === null) {
    warnings.push(`${personaPath} was not found; using built-in persona defaults.`);
  }

  if (scenarioText === null) {
    warnings.push(`${scenarioPath} was not found; using built-in scenario defaults.`);
  }

  return {
    persona: personaText === null
      ? builtinPersona
      : {
          id: readYamlScalar(personaText, "id") ?? "synthetic-new-user",
          name: readYamlScalar(personaText, "name") ?? "Synthetic New User",
          source: personaPath,
          sourceDigest: digestText(personaText)
        },
    scenario: scenarioText === null
      ? builtinScenario
      : {
          id: readYamlScalar(scenarioText, "id") ?? "first-run-smoke",
          title: readYamlScalar(scenarioText, "title") ?? "First-run smoke",
          goal: readYamlScalar(scenarioText, "goal") ?? "Run a public-safe first-run smoke scenario.",
          source: scenarioPath,
          sourceDigest: digestText(scenarioText)
        },
    warnings
  };
}

function renderReviewMarkdown(bundle: RunBundle): string {
  return `# Mimetic Dry-Run Review

Run: ${bundle.runId}

Verdict: ${bundle.review.verdict}

${bundle.review.summary}

## Public-Safety

- Redaction: ${bundle.redaction.status}
- Notes: ${bundle.redaction.notes}

## Gaps

${bundle.review.gaps.map((gap) => `- ${gap}`).join("\n")}
`;
}

function readYamlScalar(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+?)\\s*$`, "m"));
  if (!match?.[1]) {
    return null;
  }

  return match[1].replace(/^["']|["']$/g, "");
}

function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveRunPath(cwd: string, runInput: string): Promise<string | null> {
  if (runInput === "latest") {
    const latest = await readLatest(cwd);
    return latest ? path.join(cwd, latest.path) : null;
  }

  const direct = path.join(cwd, ".mimetic", "runs", runInput);
  return await directoryExists(direct) ? direct : null;
}

async function readLatest(cwd: string): Promise<RunPointer | null> {
  const latest = await readJsonIfExists(path.join(cwd, ".mimetic", "runs", "latest.json"));

  if (isRunPointer(latest)) {
    return latest;
  }

  return null;
}

async function readPackageName(cwd: string): Promise<string | null> {
  const packageJson = await readJsonIfExists(path.join(cwd, "package.json"));
  return isRecord(packageJson) && typeof packageJson.name === "string" ? packageJson.name : null;
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  const text = await readTextIfExists(filePath);

  if (text === null) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function validateCwd(cwd: string): Promise<RunResult["error"] | null> {
  try {
    const stats = await stat(cwd);

    if (!stats.isDirectory()) {
      return {
        code: "MIMETIC_INVALID_CWD",
        message: `Target cwd is not a directory: ${cwd}`
      };
    }

    return null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        code: "MIMETIC_INVALID_CWD",
        message: `Target cwd does not exist: ${cwd}`
      };
    }

    throw error;
  }
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    return (await stat(directoryPath)).isDirectory();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function containsSensitivePattern(text: string): boolean {
  return sensitivePatterns.some((pattern) => pattern.test(text));
}

function isRunBundle(value: unknown): value is RunBundle {
  return isRecord(value)
    && value.schema === RUN_BUNDLE_SCHEMA
    && typeof value.runId === "string"
    && value.mode === "dry-run"
    && typeof value.createdAt === "string"
    && isRecord(value.review)
    && isReviewSummary(value.review)
    && isRecord(value.redaction)
    && value.redaction.status === "passed";
}

function isReviewSummary(value: unknown): value is ReviewSummary {
  return isRecord(value)
    && value.schema === REVIEW_SCHEMA
    && value.verdict === "contract_proof_only"
    && typeof value.summary === "string"
    && Array.isArray(value.gaps)
    && value.gaps.every((gap) => typeof gap === "string");
}

function isRunPointer(value: unknown): value is RunPointer {
  return isRecord(value)
    && value.schema === "mimetic.latest-run.v1"
    && typeof value.runId === "string"
    && typeof value.path === "string"
    && typeof value.updatedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
