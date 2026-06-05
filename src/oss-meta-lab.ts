import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { attachObserverRuntimeStreamUrls, renderObserver } from "./observer.js";
import type { ObserverResult } from "./observer.js";
import {
  DEFAULT_OSS_REPOS,
  normalizeOssRepoSlugs,
  validateOssRepoSlug
} from "./oss-lab.js";
import { redactOssRemoteTelemetryText } from "./oss-remote-telemetry.js";
import {
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  runDryRun
} from "./run.js";
import type {
  ReviewSummary,
  RunBundle,
  RunEvent,
  RunFeedbackCandidate,
  RunResult,
  RunSimulation,
  RunSetupQualitySnapshot,
  RunStream,
  RunStreamCompletion
} from "./run.js";

export const OSS_META_LAB_SCHEMA = "mimetic.oss-meta-lab-result.v1";

export interface OssMetaLabOptions {
  completionTimeoutMs?: number;
  count?: number;
  cwd: string;
  dryRun?: boolean;
  onObserverReady?: (observer: ObserverResult & { ok: true }) => Promise<void> | void;
  open?: boolean;
  redactRepoNames?: boolean;
  repos?: string[];
  runId?: string;
}

export interface OssMetaLabLiveRefreshController {
  stop(): Promise<void>;
}

export interface OssMetaLabAssignment {
  index: number;
  repo: string;
  scenarioId: string;
  simId: string;
  streamId: string;
}

export interface OssMetaLabCleanupResult {
  killed: number;
  skipped: number;
  errors: string[];
}

interface OssMetaLabLiveDesktop {
  actorEvidence?: OssMetaLabActorEvidenceArtifacts;
  bootstrap?: OssMetaLabBootstrap;
  completion?: OssMetaLabCompletion;
  desktop?: E2BDesktopSandbox;
  error?: string;
  hostActorPlan?: OssMetaLabHostActorPlan;
  hostActorPlanPath?: string;
  repo: string;
  screenshot?: OssMetaLabScreenshot;
  sandboxId?: string;
  simId: string;
  streamId: string;
  url?: string;
}

interface OssMetaLabActorEvidenceArtifacts {
  actorLastMessageTailPath?: string;
  actorLogTailPath?: string;
  setupQualityPath?: string;
}

interface OssMetaLabBootstrap {
  codexMode: "tui-attempted";
  completionPath?: string;
  launcherPath?: string;
  logPath?: string;
  mimeticPackageUploaded: boolean;
  nestedObserverPath?: string;
  status: "started" | "failed";
  tail: string;
  terminalTitle?: string;
}

export type OssMetaLabCompletionStatus = "running" | "passed" | "failed" | "blocked" | "timed_out";
export type OssMetaLabAppStatus = "not_started" | "running" | "blocked" | "failed" | "missing" | "unknown";
export type OssMetaLabActorStatus = "not_started" | "running" | "passed" | "failed" | "blocked" | "timed_out" | "suspended" | "unknown";
export type OssMetaLabVisualStatus = "not_started" | "visible" | "blocked" | "unknown";

export interface OssMetaLabCompletion {
  actorLogPath?: string;
  actorLogTail?: string;
  actorLastMessageTail?: string;
  actorPid?: number;
  actorStatus?: OssMetaLabActorStatus;
  appLogPath?: string;
  appPid?: number;
  appReason?: string;
  appStatus?: OssMetaLabAppStatus;
  appUrl?: string;
  checkedAt: string;
  exitCode?: number;
  logTail?: string;
  nestedObserverPresent?: boolean;
  nestedVerifyPassed?: boolean;
  reason: string;
  setupQuality?: RunSetupQualitySnapshot;
  status: OssMetaLabCompletionStatus;
  visualReason?: string;
  visualStatus?: OssMetaLabVisualStatus;
  visualWindowCount?: number;
}

export interface OssMetaLabHostActorPlan {
  schema: "mimetic.oss-host-actor-plan.v1";
  generatedAt: string;
  personas: Array<{
    id: string;
    name: string;
    intent: string;
    traits: string[];
  }>;
  recommendedProof: string;
  repo: string;
  scenarios: Array<{
    id: string;
    title: string;
    goal: string;
    steps: string[];
  }>;
  source: "local-codex-exec";
  status: "passed" | "failed" | "blocked";
  summary: string;
}

interface OssMetaLabHostActorPlanResult {
  artifactPath: string;
  error?: string;
  plan?: OssMetaLabHostActorPlan;
  planPath: string;
  repo: string;
  streamId: string;
  worktreePath: string;
}

export interface OssMetaLabActorAuthPreflight {
  ok: boolean;
  reason: string;
  status?: number;
}

export interface OssMetaLabScreenshot {
  capturedAt: string;
  observerUrl: string;
  path: string;
}

interface OssMetaLabLocalPackage {
  fileName: string;
  path: string;
  sizeBytes: number;
}

export interface OssMetaLabResult {
  schema: typeof OSS_META_LAB_SCHEMA;
  ok: boolean;
  assignments: OssMetaLabAssignment[];
  count?: number;
  cwd: string;
  dryRun: boolean;
  error?: {
    code:
      | "MIMETIC_INVALID_OSS_COUNT"
      | "MIMETIC_INVALID_OSS_REPO"
      | "MIMETIC_META_RUN_FAILED";
    message: string;
  };
  liveRequested: boolean;
  observer?: ObserverResult;
  repos: string[];
  runId?: string;
  sandboxes: Array<{
    actorStatus?: OssMetaLabActorStatus;
    appStatus?: OssMetaLabAppStatus;
    bootstrapStatus?: "started" | "failed";
    completionReason?: string;
    completionStatus?: OssMetaLabCompletionStatus;
    repo: string;
    screenshotPresent?: boolean;
    sandboxId?: string;
    streamId: string;
    urlPresent: boolean;
    visualStatus?: OssMetaLabVisualStatus;
    visualWindowCount?: number;
  }>;
  warnings: string[];
}

interface OssMetaLabRuntime {
  artifactRoot: string;
  assignments: OssMetaLabAssignment[];
  createdAt: string;
  cwd: string;
  dryRun: boolean;
  liveDesktops: OssMetaLabLiveDesktop[];
  liveRequested: boolean;
  missingKeys: string[];
  persistScreenshots: boolean;
  redactRepoNames: boolean;
  runId: string;
  startedAt: number;
}

const execFileAsync = promisify(execFile);
const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const liveRuntimeByResult = new WeakMap<OssMetaLabResult, OssMetaLabRuntime>();
const OSS_META_LAB_PROVIDER_METADATA = {
  mode: "oss-meta-lab",
  tool: "mimetic-cli"
} as const;
const OSS_META_LAB_REMOTE_ENV_NAMES = [
  "MIMETIC_OSS_META_ACTOR_FIRST",
  "MIMETIC_OSS_META_ACTOR_MODEL",
  "MIMETIC_OSS_META_HOST_CODEX_ACTOR",
  "MIMETIC_OSS_META_ACTOR_TIMEOUT_MS",
  "MIMETIC_OSS_META_REQUIRE_ACTOR"
] as const;
const OSS_META_LAB_ACTOR_AUTH_PLACEHOLDER = "CODEX_API_KEY or CODEX_ACCESS_TOKEN";
const OSS_META_LAB_ACTOR_PREFLIGHT_PLACEHOLDER = "Codex actor API quota/auth preflight";
const OSS_META_LAB_HOST_ACTOR_PLACEHOLDER = "host Codex actor plan";

interface OssMetaLabOutcome {
  ok: boolean;
  reason: string;
  verdict: ReviewSummary["verdict"];
}

export function buildOssRepoAssignments(repos: string[], count: number): OssMetaLabAssignment[] {
  return Array.from({ length: count }, (_, index) => {
    const repo = repos[index % repos.length];
    if (!repo) {
      throw new Error("At least one OSS repo is required.");
    }

    return {
      index: index + 1,
      repo,
      scenarioId: `oss-meta-${repoSlugToken(repo)}`,
      simId: `oss-${String(index + 1).padStart(2, "0")}`,
      streamId: `oss-${String(index + 1).padStart(2, "0")}-desktop`
    };
  });
}

export function collectOssMetaLabRemoteEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of OSS_META_LAB_REMOTE_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value) {
      result[name] = value;
    }
  }
  return result;
}

export function collectOssMetaLabPrivateEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  const codexApiKey = env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  const codexAccessToken = env.CODEX_ACCESS_TOKEN?.trim();
  const githubToken = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();

  if (codexApiKey) {
    result.MIMETIC_CODEX_API_KEY = codexApiKey;
  }
  if (codexAccessToken) {
    result.MIMETIC_CODEX_ACCESS_TOKEN = codexAccessToken;
  }
  if (githubToken) {
    result.MIMETIC_GITHUB_TOKEN = githubToken;
  }

  return result;
}

export async function preflightOssMetaActorApiKey(args: {
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<OssMetaLabActorAuthPreflight> {
  const apiKey = args.env.CODEX_API_KEY?.trim() || args.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: true,
      reason: "No API-key actor auth present; preflight skipped."
    };
  }

  const fetchImpl = args.fetchImpl ?? fetch;
  const model = args.env.MIMETIC_OSS_META_ACTOR_PREFLIGHT_MODEL?.trim() || "gpt-4.1-mini";
  try {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: "Return a JSON object exactly like {\"status\":\"passed\"}. This is an actor auth preflight.",
        max_output_tokens: 32,
        model,
        text: {
          format: {
            type: "json_object"
          }
        }
      })
    });
    if (response.ok) {
      return {
        ok: true,
        reason: `OpenAI actor API-key preflight passed for ${model}.`,
        status: response.status
      };
    }

    const body = await response.text().catch(() => "");
    return {
      ok: false,
      reason: compactError(`OpenAI actor API-key preflight failed with HTTP ${response.status}: ${body}`),
      status: response.status
    };
  } catch (error) {
    return {
      ok: false,
      reason: compactError(error)
    };
  }
}

function hostCodexActorRequested(env: NodeJS.ProcessEnv): boolean {
  return env.MIMETIC_OSS_META_HOST_CODEX_ACTOR === "1";
}

function remoteActorAuthRequested(env: NodeJS.ProcessEnv): boolean {
  return env.MIMETIC_OSS_META_ACTOR_FIRST === "1" || env.MIMETIC_OSS_META_REQUIRE_ACTOR === "1";
}

function actorRequired(env: NodeJS.ProcessEnv): boolean {
  return env.MIMETIC_OSS_META_REQUIRE_ACTOR === "1";
}

async function createHostActorPlans(args: {
  assignments: OssMetaLabAssignment[];
  cwd: string;
  redactRepoNames: boolean;
  runId: string;
}): Promise<OssMetaLabHostActorPlanResult[]> {
  return Promise.all(args.assignments.map((assignment) =>
    createHostActorPlan({
      assignment,
      cwd: args.cwd,
      redactRepoNames: args.redactRepoNames,
      runId: args.runId
    })
  ));
}

async function createHostActorPlan(args: {
  assignment: OssMetaLabAssignment;
  cwd: string;
  redactRepoNames: boolean;
  runId: string;
}): Promise<OssMetaLabHostActorPlanResult> {
  const token = repoSlugToken(args.assignment.repo);
  const actorRoot = path.join(args.cwd, ".mimetic", "runs", args.runId, "host-actors", token);
  const artifactPath = path.join("host-actors", token, "actor-plan.json");
  const tmpRoot = path.join(args.cwd, ".mimetic", "tmp", "host-actors", args.runId, token);
  const repoDir = path.join(tmpRoot, "repo");
  const planPath = path.join(actorRoot, "actor-plan.json");
  const schemaPath = path.join(tmpRoot, "actor-plan.schema.json");
  await mkdir(actorRoot, { recursive: true });

  if (args.redactRepoNames) {
    const plan = failedHostActorPlan({
      repo: "[redacted-authorized-repo]",
      status: "blocked",
      summary: "Host Codex actor plans are public-safe artifacts and require non-redacted public repo labels."
    });
    await writeJson(planPath, plan);
    return {
      artifactPath,
      error: plan.summary,
      plan,
      planPath,
      repo: args.assignment.repo,
      streamId: args.assignment.streamId,
      worktreePath: repoDir
    };
  }

  try {
    await mkdir(tmpRoot, { recursive: true });
    await execFileAsync("git", ["clone", "--depth=1", `https://github.com/${args.assignment.repo}.git`, repoDir], {
      cwd: tmpRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: readPositiveInt(process.env.MIMETIC_OSS_META_HOST_CLONE_TIMEOUT_MS, 90_000)
    });
    await writeJson(schemaPath, hostActorPlanJsonSchema());

    const repoContext = await readHostActorRepoContext(repoDir);
    const outputPath = path.join(tmpRoot, "codex-last-message.json");
    const codexEnv = hostCodexEnv(process.env);
    const codexCommand = [
      "codex exec",
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      shellQuote(repoDir),
      "--output-schema",
      shellQuote(schemaPath),
      "--output-last-message",
      shellQuote(outputPath),
      shellQuote(buildHostActorPrompt(args.assignment.repo, repoContext)),
      "< /dev/null"
    ].join(" ");
    const codexResult = await execFileAsync("bash", ["-lc", codexCommand], {
      cwd: repoDir,
      env: codexEnv,
      maxBuffer: 10 * 1024 * 1024,
      timeout: readPositiveInt(process.env.MIMETIC_OSS_META_HOST_ACTOR_TIMEOUT_MS, 240_000)
    });

    const rawPlan = await readFile(outputPath, "utf8").catch(() => {
      const stdout = typeof codexResult.stdout === "string" ? codexResult.stdout : "";
      const stderr = typeof codexResult.stderr === "string" ? codexResult.stderr : "";
      return [stdout, stderr].filter((value) => value.trim()).join("\n");
    });
    await writeFile(path.join(actorRoot, "codex-output.txt"), `${sanitizeRemoteLog(rawPlan)}\n`, "utf8");
    const plan = normalizeHostActorPlan(rawPlan, args.assignment.repo);
    await writeJson(planPath, plan);
    return {
      artifactPath,
      ...(plan.status === "passed" ? {} : { error: plan.summary }),
      plan,
      planPath,
      repo: args.assignment.repo,
      streamId: args.assignment.streamId,
      worktreePath: repoDir
    };
  } catch (error) {
    const plan = failedHostActorPlan({
      repo: args.assignment.repo,
      status: "failed",
      summary: compactError(error)
    });
    await writeJson(planPath, plan);
    return {
      artifactPath,
      error: plan.summary,
      plan,
      planPath,
      repo: args.assignment.repo,
      streamId: args.assignment.streamId,
      worktreePath: repoDir
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function hostCodexEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "CODEX_HOME",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TERM",
    "TMP",
    "TMPDIR",
    "TEMP",
    "USER",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME"
  ];
  return Object.fromEntries(allowed.flatMap((name) => {
    const value = env[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

async function readHostActorRepoContext(repoDir: string): Promise<string> {
  const packageText = await readFile(path.join(repoDir, "package.json"), "utf8").catch(() => "");
  const readmeText = await readFile(path.join(repoDir, "README.md"), "utf8").catch(() => "");
  const indexText = await readFile(path.join(repoDir, "index.html"), "utf8").catch(() => "");
  let packageSummary = "package.json missing";
  try {
    const pkg = JSON.parse(packageText) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      name?: string;
      packageManager?: string;
      scripts?: Record<string, string>;
    };
    packageSummary = JSON.stringify({
      name: pkg.name,
      packageManager: pkg.packageManager,
      scripts: pkg.scripts ?? {},
      dependencies: Object.keys(pkg.dependencies ?? {}).slice(0, 20),
      devDependencies: Object.keys(pkg.devDependencies ?? {}).slice(0, 20)
    }, null, 2);
  } catch {}

  return [
    "package_summary:",
    packageSummary.slice(0, 2_500),
    "",
    "readme_excerpt:",
    readmeText.replace(/\s+/g, " ").trim().slice(0, 2_000) || "(missing)",
    "",
    "index_excerpt:",
    indexText.replace(/\s+/g, " ").trim().slice(0, 800) || "(missing)"
  ].join("\n");
}

function buildHostActorPrompt(repo: string, repoContext: string): string {
  return [
    "You are a public-safe Mimetic host actor.",
    "Use the bounded public repository context below to author a compact Mimetic setup plan.",
    "Do not print secrets, environment values, private data, or long source snippets.",
    "Do not commit, push, file issues, or mutate remotes.",
    "Return only JSON matching the supplied schema.",
    "",
    `Repository: ${repo}`,
    "",
    "Plan requirements:",
    "- status must be passed if you can infer useful public-safe personas/scenarios.",
    "- Include exactly 1 or 2 synthetic personas.",
    "- Include exactly 1 or 2 desktop/mobile browser scenarios.",
    "- Scenario steps must be concise and public-safe.",
    "- recommendedProof should name the strongest Mimetic command shape for this repo.",
    "- Current Mimetic supports `mimetic run --app-url <loopback-url> --sims 2`; do not invent --browser, --viewport, --persona, or --scenario flags.",
    "",
    "Bounded public repo context:",
    repoContext
  ].join("\n");
}

function hostActorPlanJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "summary", "personas", "scenarios", "recommendedProof"],
    properties: {
      status: { type: "string", enum: ["passed", "blocked", "failed"] },
      summary: { type: "string" },
      personas: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "intent", "traits"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            intent: { type: "string" },
            traits: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              items: { type: "string" }
            }
          }
        }
      },
      recommendedProof: { type: "string" },
      scenarios: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "title", "goal", "steps"],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            goal: { type: "string" },
            steps: {
              type: "array",
              minItems: 2,
              maxItems: 8,
              items: { type: "string" }
            }
          }
        }
      }
    }
  };
}

function normalizeHostActorPlan(raw: string, repo: string): OssMetaLabHostActorPlan {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return failedHostActorPlan({
      repo,
      status: "failed",
      summary: "Host Codex actor did not return parseable JSON."
    });
  }

  const personas = Array.isArray(parsed.personas)
    ? parsed.personas.map(normalizeHostActorPersona).filter((persona): persona is OssMetaLabHostActorPlan["personas"][number] => persona !== null).slice(0, 2)
    : [];
  const scenarios = Array.isArray(parsed.scenarios)
    ? parsed.scenarios.map(normalizeHostActorScenario).filter((scenario): scenario is OssMetaLabHostActorPlan["scenarios"][number] => scenario !== null).slice(0, 2)
    : [];
  const status = parsed.status === "blocked" || parsed.status === "failed" ? parsed.status : "passed";
  if (status === "passed" && (personas.length === 0 || scenarios.length === 0)) {
    return failedHostActorPlan({
      repo,
      status: "failed",
      summary: "Host Codex actor plan lacked usable personas or scenarios."
    });
  }

  return {
    schema: "mimetic.oss-host-actor-plan.v1",
    generatedAt: new Date().toISOString(),
    personas,
    recommendedProof: normalizeHostActorRecommendedProof(parsed.recommendedProof),
    repo,
    scenarios,
    source: "local-codex-exec",
    status,
    summary: cleanHostActorText(parsed.summary, status === "passed" ? "Host Codex actor authored a public-safe Mimetic plan." : "Host Codex actor could not author a complete plan.")
  };
}

function normalizeHostActorPersona(value: unknown): OssMetaLabHostActorPlan["personas"][number] | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = safeArtifactToken(cleanHostActorText(candidate.id, "host-actor-persona")).slice(0, 80) || "host-actor-persona";
  const traits = Array.isArray(candidate.traits)
    ? candidate.traits.map((trait) => cleanHostActorText(trait, "")).filter(Boolean).slice(0, 5)
    : [];
  return {
    id,
    name: cleanHostActorText(candidate.name, "Host Actor Persona"),
    intent: cleanHostActorText(candidate.intent, "Evaluate the app with a public-safe synthetic goal."),
    traits: traits.length > 0 ? traits : ["public_safe", "synthetic_user"]
  };
}

function normalizeHostActorScenario(value: unknown): OssMetaLabHostActorPlan["scenarios"][number] | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const steps = Array.isArray(candidate.steps)
    ? candidate.steps.map((step) => cleanHostActorText(step, "")).filter(Boolean).slice(0, 8)
    : [];
  if (steps.length === 0) return null;
  return {
    id: safeArtifactToken(cleanHostActorText(candidate.id, "host-actor-scenario")).slice(0, 80) || "host-actor-scenario",
    title: cleanHostActorText(candidate.title, "Host Actor Scenario"),
    goal: cleanHostActorText(candidate.goal, "Exercise the primary public-safe app workflow."),
    steps
  };
}

export function normalizeHostActorRecommendedProof(value: unknown): string {
  const proof = cleanHostActorText(value, "");
  if (!/\bmimetic\s+run\b/.test(proof)) {
    return "Start the target app on a loopback URL, then run `mimetic run --app-url http://127.0.0.1:<port> --sims 2`.";
  }

  if (/\s--(?:browser|viewport|persona|scenario)\b/.test(proof)) {
    return "Start the target app on a loopback URL, then run `mimetic run --app-url http://127.0.0.1:<port> --sims 2`.";
  }

  return proof;
}

function failedHostActorPlan(args: {
  repo: string;
  status: "failed" | "blocked";
  summary: string;
}): OssMetaLabHostActorPlan {
  return {
    schema: "mimetic.oss-host-actor-plan.v1",
    generatedAt: new Date().toISOString(),
    personas: [],
    recommendedProof: "Host actor plan was not available.",
    repo: args.repo,
    scenarios: [],
    source: "local-codex-exec",
    status: args.status,
    summary: cleanHostActorText(args.summary, "Host Codex actor plan failed.")
  };
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  for (const line of raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).reverse()) {
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {}
    }
  }

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence?.[1]) {
    try {
      const parsed = JSON.parse(fence[1].trim()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {}
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    const lastClose = raw.lastIndexOf("}");
    if (lastClose === -1) return null;
    for (let start = raw.lastIndexOf("{", lastClose); start >= 0; start = raw.lastIndexOf("{", start - 1)) {
      try {
        const parsed = JSON.parse(raw.slice(start, lastClose + 1)) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {}
    }
    return null;
  }
}

function cleanHostActorText(value: unknown, fallback: string): string {
  const text = String(typeof value === "string" ? value : fallback)
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted-openai-key]")
    .replace(/e2b_[A-Za-z0-9_-]{12,}/g, "[redacted-e2b-key]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{12,}/g, "[redacted-github-token]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return text || fallback;
}

export async function runOssMetaLab(options: OssMetaLabOptions): Promise<OssMetaLabResult> {
  const cwd = path.resolve(options.cwd);
  const dryRun = options.dryRun === true;
  const liveRequested = !dryRun;
  const warnings: string[] = [];
  const repos = normalizeOssRepoSlugs(options.repos);
  const count = options.count ?? DEFAULT_OSS_REPOS.length;

  if (!Number.isInteger(count) || count < 1) {
    return {
      schema: OSS_META_LAB_SCHEMA,
      ok: false,
      assignments: [],
      cwd,
      dryRun,
      error: {
        code: "MIMETIC_INVALID_OSS_COUNT",
        message: "--count must be a positive integer."
      },
      liveRequested,
      repos,
      sandboxes: [],
      warnings
    };
  }

  const invalid = repos.find((repo) => !validateOssRepoSlug(repo));
  if (invalid) {
    return {
      schema: OSS_META_LAB_SCHEMA,
      ok: false,
      assignments: [],
      count,
      cwd,
      dryRun,
      error: {
        code: "MIMETIC_INVALID_OSS_REPO",
        message: `Only GitHub owner/repo slugs are supported: ${invalid}`
      },
      liveRequested,
      repos,
      sandboxes: [],
      warnings
    };
  }

  const redactRepoNames = options.redactRepoNames ?? (liveRequested && Boolean(process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN));
  const hostActorMode = liveRequested && hostCodexActorRequested(process.env);
  const missingKeys = missingLiveKeys(process.env);
  if (liveRequested && missingKeys.length > 0) {
    warnings.push(`Live E2B/Codex launch is waiting on env vars: ${missingKeys.join(", ")}.`);
    warnings.push("Observer lanes stay in the live waiting state until keys are present.");
  }
  if (liveRequested && !(process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim())) {
    warnings.push("No GH_TOKEN or GITHUB_TOKEN is present; public repos can clone, but private GitHub repos will fail inside E2B.");
  }

  const assignments = buildOssRepoAssignments(repos, count);
  const publicAssignments = redactAssignments(assignments, redactRepoNames);
  const publicRepos = redactRepoNames ? publicAssignments.map((assignment) => assignment.repo) : repos;
  const runId = options.runId ?? makeMetaRunId();
  const runResult: RunResult = await runDryRun({
    cwd,
    dryRun: true,
    runId,
    simCount: count
  });

  if (!runResult.ok || !runResult.runId) {
    return {
      schema: OSS_META_LAB_SCHEMA,
      ok: false,
      assignments: publicAssignments,
      count,
      cwd,
      dryRun,
      error: {
        code: "MIMETIC_META_RUN_FAILED",
        message: runResult.error?.message ?? "Failed to create OSS meta-lab run bundle."
      },
      liveRequested,
      repos: publicRepos,
      sandboxes: [],
      warnings: [...warnings, ...runResult.warnings]
    };
  }

  const artifactRoot = path.join(cwd, ".mimetic", "runs", runId);
  const createdAt = new Date().toISOString();
  const persistScreenshots = !redactRepoNames;
  let liveDesktops: OssMetaLabLiveDesktop[] = [];
  let substrateMissingKeys = [...missingKeys];
  await mkdir(artifactRoot, { recursive: true });

  const initialBundle = buildMetaBundle({
    assignments,
    createdAt,
    cwd,
    dryRun,
    liveDesktops,
    liveRequested,
    missingKeys: substrateMissingKeys,
    redactRepoNames,
    runId
  });
  await writeMetaBundleArtifacts(artifactRoot, initialBundle);

  let observer = await renderObserver(cwd, runId, { open: false });
  if (observer.ok && options.onObserverReady) {
    await options.onObserverReady(observer as ObserverResult & { ok: true });
  }

  const hostActorPlanResults = hostActorMode && missingKeys.length === 0
    ? await createHostActorPlans({
        assignments,
        cwd,
        redactRepoNames,
        runId
      })
    : [];
  const hostActorPlansByStream = new Map(hostActorPlanResults.flatMap((result) =>
    result.plan?.status === "passed" ? [[result.streamId, result] as const] : []
  ));
  if (hostActorPlanResults.length > 0) {
    const passed = hostActorPlanResults.filter((result) => result.plan?.status === "passed").length;
    warnings.push(`Host Codex actor authored ${passed}/${hostActorPlanResults.length} public-safe Mimetic plan${hostActorPlanResults.length === 1 ? "" : "s"}.`);
    for (const failed of hostActorPlanResults.filter((result) => result.plan?.status !== "passed")) {
      warnings.push(`Host Codex actor plan failed for ${redactRepoNames ? "[redacted-authorized-repo]" : failed.repo}: ${failed.error ?? failed.plan?.summary ?? "unknown failure"}`);
    }
  }
  const hostActorPlanBlocked = hostActorMode
    && actorRequired(process.env)
    && hostActorPlanResults.length > 0
    && hostActorPlanResults.some((result) => result.plan?.status !== "passed");
  const actorAuthPreflight = liveRequested
    && missingKeys.length === 0
    && !hostActorMode
    && actorRequired(process.env)
    && process.env.MIMETIC_OSS_META_SKIP_ACTOR_PREFLIGHT !== "1"
    ? await preflightOssMetaActorApiKey({ env: process.env })
    : undefined;
  const actorAuthPreflightBlocked = actorAuthPreflight !== undefined && !actorAuthPreflight.ok;
  substrateMissingKeys = [
    ...missingKeys,
    ...(hostActorPlanBlocked ? [OSS_META_LAB_HOST_ACTOR_PLACEHOLDER] : []),
    ...(actorAuthPreflightBlocked ? [OSS_META_LAB_ACTOR_PREFLIGHT_PLACEHOLDER] : [])
  ];
  if (actorAuthPreflight) {
    warnings.push(actorAuthPreflight.ok
      ? actorAuthPreflight.reason
      : `Remote Codex actor API-key preflight blocked live launch: ${actorAuthPreflight.reason}`);
  }
  let localPackage: OssMetaLabLocalPackage | undefined;
  if (liveRequested && missingKeys.length === 0 && !hostActorPlanBlocked && !actorAuthPreflightBlocked) {
    try {
      localPackage = await packLocalMimeticPackage(cwd, runId);
      warnings.push(`Packed local mimetic-cli package for sandbox install (${localPackage.fileName}).`);
    } catch (error) {
      warnings.push(`Local mimetic-cli package pack failed; sandbox bootstrap will try public npm fallback. ${compactError(error)}`);
    }
  }
  if (liveRequested && missingKeys.length === 0 && !hostActorPlanBlocked && !actorAuthPreflightBlocked) {
    try {
      liveDesktops = await launchLiveDesktops(assignments, {
        cwd,
        hostActorPlansByStream,
        ...(localPackage ? { localPackage } : {}),
        redactRepoNames
      });
      const completionSummary = await pollLiveDesktopCompletions(liveDesktops, {
        ...(options.completionTimeoutMs === undefined
          ? {}
          : {
              timeoutMs: options.completionTimeoutMs,
              timeoutReason: "attached watch mode serves the Observer immediately after desktop streams are created"
            })
      });
      warnings.push(...completionSummary.warnings);
    } catch (error) {
      warnings.push(compactError(error));
      liveDesktops = assignments.map((assignment) => {
        const hostActorPlanResult = hostActorPlanResults.find((result) => result.streamId === assignment.streamId);
        return {
          error: compactError(error),
          ...(hostActorPlanResult?.plan ? { hostActorPlan: hostActorPlanResult.plan } : {}),
          ...(hostActorPlanResult?.artifactPath ? { hostActorPlanPath: hostActorPlanResult.artifactPath } : {}),
          repo: redactRepoNames ? repoArtifactLabel(assignment) : assignment.repo,
          simId: assignment.simId,
          streamId: assignment.streamId
        };
      });
    }
  } else if (hostActorPlanBlocked) {
    warnings.push("Live E2B launch skipped because required host Codex actor plan evidence did not pass preflight.");
  } else if (actorAuthPreflightBlocked) {
    warnings.push("Live E2B launch skipped because required Codex actor API-key quota/auth preflight failed.");
  }
  const liveDesktopCount = liveDesktops.filter((desktop) => desktop.url).length;
  const failedLiveDesktopCount = liveDesktops.filter((desktop) => desktop.error).length;
  const startedBootstrapCount = liveDesktops.filter((desktop) => desktop.bootstrap?.status === "started").length;
  const terminalCompletionCount = liveDesktops.filter((desktop) => isTerminalCompletion(desktop.completion)).length;
  const runningAppCount = liveDesktops.filter((desktop) => desktop.completion?.appStatus === "running").length;
  const visibleDesktopCount = liveDesktops.filter((desktop) => desktop.completion?.visualStatus === "visible").length;
  if (liveDesktops.length > 0) {
    warnings.push(`Launched ${liveDesktopCount}/${liveDesktops.length} live E2B desktop stream${liveDesktops.length === 1 ? "" : "s"}.`);
    if (startedBootstrapCount > 0) {
      warnings.push(`Started ${startedBootstrapCount}/${liveDesktops.length} visible bootstrap terminal${liveDesktops.length === 1 ? "" : "s"} for target app startup, nested Mimetic setup, and Codex actor attempt.`);
      if (terminalCompletionCount > 0) {
        warnings.push(`Classified ${terminalCompletionCount}/${startedBootstrapCount} bootstrap terminal state${startedBootstrapCount === 1 ? "" : "s"} from remote public-safe evidence.`);
        warnings.push(`Detected ${runningAppCount}/${terminalCompletionCount} target app HTTP-ready surface${terminalCompletionCount === 1 ? "" : "s"} from remote public-safe evidence.`);
        warnings.push(`Detected ${visibleDesktopCount}/${terminalCompletionCount} headed desktop visual layout${terminalCompletionCount === 1 ? "" : "s"} from remote public-safe evidence.`);
      }
    } else {
      warnings.push("Codex TUI injection and nested Mimetic execution remain the next substrate slice behind these live desktops.");
    }
  }
  if (failedLiveDesktopCount > 0) {
    warnings.push(`${failedLiveDesktopCount} E2B desktop launch${failedLiveDesktopCount === 1 ? "" : "es"} failed; see stream events in the Observer.`);
  }

  if (persistScreenshots) {
    const screenshotSummary = await captureLiveDesktopScreenshots(artifactRoot, liveDesktops);
    warnings.push(...screenshotSummary.warnings);
  } else if (liveDesktops.some((desktop) => desktop.url)) {
    warnings.push("Skipped persistent desktop screenshots because repo labels are redacted; live stream URLs remain runtime-only.");
  }
  const actorEvidenceSummary = await writeActorEvidenceArtifacts(artifactRoot, liveDesktops, redactRepoNames);
  warnings.push(...actorEvidenceSummary.warnings);
  const bundle = buildMetaBundle({
    assignments,
    createdAt,
    cwd,
    dryRun,
    liveDesktops,
    liveRequested,
    missingKeys: substrateMissingKeys,
    redactRepoNames,
    runId
  });

  await writeMetaBundleArtifacts(artifactRoot, bundle);

  const finalObserver = await renderObserver(cwd, runId, { open: options.open === true });
  Object.assign(observer, finalObserver);
  if (observer.ok) {
    attachObserverRuntimeStreamUrls(
      observer,
      liveDesktops
        .filter((desktop) => desktop.url)
        .map((desktop) => ({
          streamId: desktop.streamId,
          url: desktop.url as string
        }))
    );
  }
  const outcome = classifyMetaLabOutcome({
    dryRun,
    liveDesktops,
    liveRequested,
    missingKeys: substrateMissingKeys
  });

  const result: OssMetaLabResult = {
    schema: OSS_META_LAB_SCHEMA,
    ok: observer.ok && outcome.ok,
    assignments: publicAssignments,
    count,
    cwd,
    dryRun,
    ...(observer.ok && outcome.ok
      ? {}
      : {
          error: {
            code: "MIMETIC_META_RUN_FAILED" as const,
            message: observer.ok ? outcome.reason : observer.error?.message ?? "OSS meta-lab Observer failed."
          }
        }),
    liveRequested,
    observer,
    repos: publicRepos,
    runId,
    sandboxes: liveDesktops.map(formatLiveDesktopForResult),
    warnings: [...warnings, ...observer.warnings]
  };

  if (observer.ok && liveDesktops.some((desktop) => desktop.desktop && desktop.bootstrap?.status === "started")) {
    liveRuntimeByResult.set(result, {
      artifactRoot,
      assignments,
      createdAt,
      cwd,
      dryRun,
      liveDesktops,
      liveRequested,
      missingKeys: substrateMissingKeys,
      persistScreenshots,
      redactRepoNames,
      runId,
      startedAt: Date.now()
    });
  }

  return result;
}

async function writeMetaBundleArtifacts(artifactRoot: string, bundle: RunBundle): Promise<void> {
  await writeJson(path.join(artifactRoot, "run.json"), bundle);
  await writeJson(path.join(artifactRoot, "review.json"), bundle.review);
  await writeFile(path.join(artifactRoot, "review.md"), renderMetaReviewMarkdown(bundle), "utf8");
  await writeFile(path.join(artifactRoot, "events.ndjson"), `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

export function startOssMetaLabLiveRefresh(
  result: OssMetaLabResult,
  options: {
    intervalMs?: number;
    screenshotIntervalMs?: number;
    timeoutMs?: number;
  } = {}
): OssMetaLabLiveRefreshController | null {
  const runtime = liveRuntimeByResult.get(result);
  if (!runtime) {
    return null;
  }

  const intervalMs = options.intervalMs ?? readPositiveInt(process.env.MIMETIC_OSS_META_WATCH_REFRESH_MS, 5_000);
  const screenshotIntervalMs = options.screenshotIntervalMs ?? readPositiveInt(process.env.MIMETIC_OSS_META_SCREENSHOT_REFRESH_MS, 15_000);
  const timeoutMs = options.timeoutMs ?? readNonNegativeInt(process.env.MIMETIC_OSS_META_COMPLETION_TIMEOUT_MS, 240_000);
  const deadline = timeoutMs === 0 ? null : runtime.startedAt + timeoutMs;
  let lastScreenshotAt = 0;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) {
      return;
    }

    running = true;
    try {
      const now = Date.now();
      const timedOut = deadline !== null && now >= deadline;
      const shouldCaptureScreenshot = runtime.persistScreenshots
        && (timedOut || lastScreenshotAt === 0 || now - lastScreenshotAt >= screenshotIntervalMs);
      await refreshOssMetaLabLiveRuntime(runtime, {
        captureScreenshots: shouldCaptureScreenshot,
        timedOut,
        timeoutMs
      });
      result.sandboxes = runtime.liveDesktops.map(formatLiveDesktopForResult);
      const outcome = classifyMetaLabOutcome({
        dryRun: runtime.dryRun,
        liveDesktops: runtime.liveDesktops,
        liveRequested: runtime.liveRequested,
        missingKeys: runtime.missingKeys
      });
      result.ok = result.observer?.ok === true && outcome.ok;
      if (result.ok) {
        delete result.error;
      } else {
        result.error = {
          code: "MIMETIC_META_RUN_FAILED",
          message: outcome.reason
        };
      }
      if (shouldCaptureScreenshot) {
        lastScreenshotAt = now;
      }
      if (runtime.liveDesktops.every((desktop) => isTerminalCompletion(desktop.completion))) {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      }
    } catch {
      // Attached watch is best-effort telemetry. Keep serving the last verified
      // bundle instead of crashing the user's observer process.
    } finally {
      running = false;
    }
  };

  void tick();
  timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      while (running) {
        await wait(100);
      }
    }
  };
}

export function sandboxIdsForOssMetaLabCleanup(result: Pick<OssMetaLabResult, "sandboxes">): string[] {
  return [...new Set(result.sandboxes.flatMap((sandbox) => sandbox.sandboxId ? [sandbox.sandboxId] : []))];
}

export async function cleanupOssMetaLabSandboxes(
  result: Pick<OssMetaLabResult, "sandboxes">,
  options: {
    killSandbox?: (sandboxId: string, requestTimeoutMs: number) => Promise<unknown>;
    requestTimeoutMs?: number;
  } = {}
): Promise<OssMetaLabCleanupResult> {
  const ids = sandboxIdsForOssMetaLabCleanup(result);
  const skipped = result.sandboxes.length - ids.length;
  if (ids.length === 0) {
    return { killed: 0, skipped, errors: [] };
  }

  const requestTimeoutMs = options.requestTimeoutMs ?? readPositiveInt(process.env.MIMETIC_E2B_REQUEST_TIMEOUT_MS, 60_000);
  let killSandbox = options.killSandbox;
  if (!killSandbox) {
    const e2bApiKey = process.env.E2B_API_KEY;
    if (!e2bApiKey) {
      return {
        killed: 0,
        skipped: skipped + ids.length,
        errors: ["E2B_API_KEY is not present; remote sandbox cleanup skipped."]
      };
    }

    const desktopModule = await loadE2BDesktopModule();
    if (!desktopModule.Sandbox.kill) {
      return {
        killed: 0,
        skipped: skipped + ids.length,
        errors: ["Installed @e2b/desktop SDK does not expose Sandbox.kill; remote sandbox cleanup skipped."]
      };
    }

    killSandbox = async (sandboxId, timeout) => desktopModule.Sandbox.kill?.(sandboxId, { requestTimeoutMs: timeout });
  }

  let killed = 0;
  const errors: string[] = [];
  for (const id of ids) {
    try {
      await killSandbox(id, requestTimeoutMs);
      killed += 1;
    } catch (error) {
      errors.push(`${id}: ${compactError(error)}`);
    }
  }

  return { killed, skipped, errors };
}

export function buildOssMetaBundleFixture(args: {
  assignments: OssMetaLabAssignment[];
  createdAt: string;
  cwd: string;
  dryRun: boolean;
  lanes: Array<{
    actorEvidence?: OssMetaLabActorEvidenceArtifacts;
    bootstrap?: OssMetaLabBootstrap;
    completion?: OssMetaLabCompletion;
    error?: string;
    hostActorPlan?: OssMetaLabHostActorPlan;
    hostActorPlanPath?: string;
    repo: string;
    screenshot?: OssMetaLabScreenshot;
    sandboxId?: string;
    simId: string;
    streamId: string;
    url?: string;
  }>;
  liveRequested: boolean;
  missingKeys: string[];
  redactRepoNames?: boolean;
  runId: string;
}): RunBundle {
  return buildMetaBundle({
    assignments: args.assignments,
    createdAt: args.createdAt,
    cwd: args.cwd,
    dryRun: args.dryRun,
    liveDesktops: args.lanes,
    liveRequested: args.liveRequested,
    missingKeys: args.missingKeys,
    redactRepoNames: args.redactRepoNames === true,
    runId: args.runId
  });
}

export function buildOssMetaBootstrapScriptFixture(): string {
  const [assignment] = buildOssRepoAssignments(["maciekt07/TodoApp"], 1);
  if (!assignment) {
    throw new Error("Missing OSS meta-lab fixture assignment.");
  }

  return buildRemoteBootstrapScript({
    assignment,
    completionPath: "/home/user/mimetic-oss-lab/maciekt07-todoapp/completion.json",
    displayRepo: "maciekt07/TodoApp",
    logPath: "/home/user/mimetic-oss-lab/maciekt07-todoapp/bootstrap.log",
    nestedObserverPath: "/home/user/mimetic-oss-lab/maciekt07-todoapp/repo/.mimetic/runs/nested-maciekt07-todoapp/observer/index.html",
    remoteHostActorPlanPath: "/home/user/mimetic-oss-lab/maciekt07-todoapp/host-actor-plan.json",
    rootDir: "/home/user/mimetic-oss-lab/maciekt07-todoapp",
    token: "maciekt07-todoapp"
  });
}

function buildMetaBundle(args: {
  assignments: OssMetaLabAssignment[];
  createdAt: string;
  cwd: string;
  dryRun: boolean;
  liveDesktops: OssMetaLabLiveDesktop[];
  liveRequested: boolean;
  missingKeys: string[];
  redactRepoNames: boolean;
  runId: string;
}): RunBundle {
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events: RunEvent[] = [
    {
      id: "event-000",
      at: args.createdAt,
      level: "info",
      type: "oss-meta.contract.created",
      message: "Created public-safe OSS meta-lab Observer-of-Observers contract."
    }
  ];

  for (const assignment of args.assignments) {
    const prompt = buildCodexBootstrapPrompt(assignment, args.redactRepoNames);
    const liveDesktop = args.liveDesktops.find((desktop) => desktop.streamId === assignment.streamId);
    const repoLabel = args.redactRepoNames ? repoArtifactLabel(assignment) : assignment.repo;
    const scenarioId = args.redactRepoNames ? `oss-meta-${repoLabel}` : assignment.scenarioId;
    const status = statusForMeta(args, liveDesktop);
    const completion = liveDesktop?.completion;
    const screenshot = liveDesktop?.screenshot;
    const terminalTail = terminalTailForMeta(prompt, liveDesktop);
    const liveStreamPresent = Boolean(liveDesktop?.url);
    simulations.push({
      id: assignment.simId,
      index: assignment.index,
      personaId: `codex-oss-operator-${String(assignment.index).padStart(2, "0")}`,
      scenarioId,
      status,
      streamKind: "browser",
      mode: "browser-sim",
      progress: progressForMeta(status, liveDesktop),
      currentStep: currentStepForMeta(args, assignment),
      summary: completion
        ? `Headed E2B desktop lane assigned to ${repoLabel}; ${completion.reason}`
        : liveDesktop?.bootstrap?.status === "started"
        ? `Headed E2B desktop lane assigned to ${repoLabel}; bootstrap terminal launched to set up Mimetic and open the nested Observer.`
        : `Headed E2B desktop lane assigned to ${repoLabel}; nested Codex TUI should set up Mimetic and open a nested Observer inside that desktop.`,
      streamIds: [assignment.streamId],
      startedAt: args.createdAt,
      updatedAt: args.createdAt
    });

    streams.push({
      id: assignment.streamId,
      simId: assignment.simId,
      kind: "browser",
      label: `E2B desktop - ${repoLabel}`,
      status,
      transport: liveStreamPresent ? "sse" : screenshot ? "snapshot" : status === "contract_proof_only" ? "snapshot" : "sse",
      updatedAt: args.createdAt,
      embed: {
        kind: screenshot ? "screenshot" : "placeholder",
        ...(screenshot ? { url: screenshot.observerUrl } : {}),
        title: `E2B desktop ${assignment.index}`
      },
      viewport: {
        width: 1440,
        height: 960,
        deviceScaleFactor: 1
      },
      terminal: {
        title: `Codex TUI bootstrap - ${repoLabel}`,
        format: "plain",
        stdin: liveDesktop?.bootstrap ? "sent" : "planned",
        tail: terminalTail
      },
      ui: {
        route: completion?.appUrl ?? `e2b://desktop/${repoLabel}`,
        intent: "Watch the headed desktop where the bootstrap clones the repo, starts the target app, sets up Mimetic, opens the nested Observer, and attempts a Codex actor.",
        ...(completion?.actorStatus ? { actorStatus: completion.actorStatus } : {}),
        ...(completion?.appStatus ? { appStatus: completion.appStatus } : {}),
        ...(completion?.appUrl ? { appUrl: completion.appUrl } : {}),
        ...(liveDesktop?.bootstrap?.nestedObserverPath ? { nestedObserverPath: liveDesktop.bootstrap.nestedObserverPath } : {}),
        ...(screenshot ? { screenshotUrl: screenshot.observerUrl } : {}),
        ...(completion?.visualStatus ? { visualStatus: completion.visualStatus } : {}),
        state: completion
          ? [
              completion.reason,
              completion.appStatus ? `app=${completion.appStatus}` : "",
              completion.actorStatus ? `actor=${completion.actorStatus}` : "",
              completion.visualStatus ? `visual=${completion.visualStatus}` : ""
            ].filter(Boolean).join(" | ")
          : liveDesktop?.bootstrap?.status === "started"
          ? "bootstrap terminal launched; target app and nested Observer setup running"
          : liveStreamPresent ? "live E2B desktop stream present; stream URL is runtime-only" : args.dryRun ? "contract desktop" : "headed E2B desktop"
      },
      ...(completion ? { completion: completionForStream(completion) } : {}),
      artifacts: [
        { label: "run bundle", path: "run.json", kind: "bundle" },
        { label: "review", path: "review.md", kind: "review" },
        { label: "events", path: "events.ndjson", kind: "events" },
        ...(completion?.appLogPath ? [{ label: "remote app log", path: completion.appLogPath, kind: "log" as const }] : []),
        ...(completion?.actorLogPath ? [{ label: "remote actor log", path: completion.actorLogPath, kind: "log" as const }] : []),
        ...(liveDesktop?.actorEvidence?.actorLastMessageTailPath ? [{ label: "actor last-message tail", path: liveDesktop.actorEvidence.actorLastMessageTailPath, kind: "log" as const }] : []),
        ...(liveDesktop?.actorEvidence?.actorLogTailPath ? [{ label: "actor log tail", path: liveDesktop.actorEvidence.actorLogTailPath, kind: "log" as const }] : []),
        ...(liveDesktop?.actorEvidence?.setupQualityPath ? [{ label: "setup quality", path: liveDesktop.actorEvidence.setupQualityPath, kind: "filesystem" as const }] : []),
        ...(liveDesktop?.hostActorPlanPath ? [{ label: "host Codex actor plan", path: liveDesktop.hostActorPlanPath, kind: "trace" as const }] : []),
        ...(liveDesktop?.bootstrap?.logPath ? [{ label: "remote bootstrap log", path: liveDesktop.bootstrap.logPath, kind: "log" as const }] : []),
        ...(liveDesktop?.bootstrap?.nestedObserverPath ? [{ label: "nested observer path", path: liveDesktop.bootstrap.nestedObserverPath, kind: "observer" as const }] : []),
        ...(screenshot ? [{ label: "desktop screenshot", path: screenshot.path, kind: "screenshot" as const }] : [])
      ]
    });

    events.push(
      {
        id: `event-${String(assignment.index).padStart(3, "0")}-assigned`,
        at: args.createdAt,
        level: "info",
        type: "oss-meta.repo.assigned",
        message: `Assigned ${repoLabel} to Codex desktop lane ${assignment.index}.`,
        simId: assignment.simId,
        streamId: assignment.streamId
      },
      {
        id: `event-${String(assignment.index).padStart(3, "0")}-prompt`,
        at: args.createdAt,
        level: "info",
        type: "oss-meta.codex.prompt.ready",
        message: "Codex TUI bootstrap prompt is available in the stream logs tab.",
        simId: assignment.simId,
        streamId: assignment.streamId
      }
    );

    if (liveStreamPresent && liveDesktop) {
      events.push({
        id: `event-${String(assignment.index).padStart(3, "0")}-stream`,
        at: args.createdAt,
        level: "info",
        type: "oss-meta.e2b.stream.started",
        message: `Live E2B desktop stream started for ${repoLabel}; auth URL is runtime-only and not persisted in run artifacts.`,
        simId: assignment.simId,
        streamId: assignment.streamId
      });
      if (liveDesktop.bootstrap?.status === "started") {
        events.push({
          id: `event-${String(assignment.index).padStart(3, "0")}-bootstrap-started`,
          at: args.createdAt,
          level: "info",
          type: "oss-meta.bootstrap.started",
          message: `Visible bootstrap terminal launched for ${repoLabel}.`,
          simId: assignment.simId,
          streamId: assignment.streamId
        });
        if (completion) {
          events.push({
            id: `event-${String(assignment.index).padStart(3, "0")}-bootstrap-${completion.status}`,
            at: completion.checkedAt,
            level: eventLevelForCompletion(completion.status),
            type: `oss-meta.bootstrap.${completion.status}`,
            message: `${repoLabel}: ${completion.reason}`,
            simId: assignment.simId,
            streamId: assignment.streamId
          });
        }
      } else if (liveDesktop.bootstrap?.status === "failed") {
        events.push({
          id: `event-${String(assignment.index).padStart(3, "0")}-bootstrap-failed`,
          at: args.createdAt,
          level: "error",
          type: "oss-meta.bootstrap.failed",
          message: `Bootstrap launcher failed for ${repoLabel}.`,
          simId: assignment.simId,
          streamId: assignment.streamId
        });
      }
    } else if (liveDesktop?.error) {
      events.push({
        id: `event-${String(assignment.index).padStart(3, "0")}-stream-error`,
        at: args.createdAt,
        level: "error",
        type: "oss-meta.e2b.stream.failed",
        message: `E2B desktop stream failed for ${repoLabel}: ${liveDesktop.error}`,
        simId: assignment.simId,
        streamId: assignment.streamId
      });
    }
  }

  if (args.liveRequested && args.missingKeys.length > 0) {
    events.push({
      id: "event-live-keys-blocked",
      at: args.createdAt,
      level: "warn",
      type: "oss-meta.live.keys_missing",
      message: `Live launch is blocked until ${args.missingKeys.join(", ")} are present.`
    });
  }

  if (args.liveRequested && args.liveDesktops.length === 0) {
    events.push({
      id: "event-live-substrate-planned",
      at: args.createdAt,
      level: "warn",
      type: "oss-meta.live.substrate_planned",
      message: args.missingKeys.length > 0
        ? "E2B desktop launch is waiting on required environment variables."
        : "Codex TUI injection and nested Mimetic execution are planned behind this Observer contract."
    });
  }
  if (args.liveDesktops.some((desktop) => desktop.url)) {
    events.push({
      id: "event-live-substrate-started",
      at: args.createdAt,
      level: "info",
      type: "oss-meta.live.substrate_started",
      message: args.liveDesktops.some((desktop) => desktop.bootstrap?.status === "started")
        ? "E2B desktop streams are connected and bootstrap terminals are launched."
        : "E2B desktop streams are connected; Codex TUI injection is still pending."
    });
  }

  const review = createMetaReview(args);
  const feedbackCandidates = buildMetaFeedbackCandidates({
    assignments: args.assignments,
    liveDesktops: args.liveDesktops,
    redactRepoNames: args.redactRepoNames,
    runId: args.runId
  });
  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: args.dryRun ? "dry-run" : "live",
    simCount: args.assignments.length,
    createdAt: args.createdAt,
    cwd: args.cwd,
    artifactRoot: path.join(".mimetic", "runs", args.runId),
    source: {
      packageName: "mimetic-cli",
      mimeticSource: "present",
      git: {
        status: "not_captured",
        note: "OSS meta-lab does not capture host git state in this slice."
      }
    },
    persona: {
      id: "oss-meta-codex-tui-operators",
      name: "Codex TUI OSS Setup Operators",
      source: "lab:oss:meta",
      sourceDigest: "public-safe"
    },
    scenario: {
      id: "oss-meta-observer-of-observers",
      title: "OSS Observer-of-Observers Meta-Lab",
      goal: "Launch headed E2B desktops where Codex agents clone authorized GitHub repos, set up Mimetic, run nested Mimetic proof commands, attempt Codex TUI, and keep each nested Observer visible.",
      source: "lab:oss:meta",
      sourceDigest: "public-safe"
    },
    lifecycle: [
      {
        at: args.createdAt,
        event: "oss-meta.run.created",
        message: `Created OSS meta-lab run with ${args.assignments.length} headed desktop lane${args.assignments.length === 1 ? "" : "s"}.`
      },
      {
        at: args.createdAt,
        event: "oss-meta.repos.assigned",
        message: `Assigned repos: ${args.assignments.map((assignment) => args.redactRepoNames ? repoArtifactLabel(assignment) : assignment.repo).join(", ")}.`
      },
      {
        at: args.createdAt,
        event: "oss-meta.observer.ready",
        message: "Top-level Observer is ready to watch nested Mimetic Observers."
      }
    ],
    simulations,
    streams,
    events,
    redaction: {
      status: "passed",
      notes: "OSS meta-lab artifacts contain GitHub slugs and redacted/synthetic bootstrap evidence only."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review,
    feedbackCandidates
  };
}

function statusForMeta(args: {
  dryRun: boolean;
  liveDesktops: OssMetaLabLiveDesktop[];
  liveRequested: boolean;
  missingKeys: string[];
}, liveDesktop: OssMetaLabLiveDesktop | undefined): RunSimulation["status"] {
  if (args.dryRun) return "contract_proof_only";
  if (liveDesktop?.completion?.status === "passed" && liveDesktop.completion.appStatus !== "running") return "blocked";
  if (liveDesktop?.completion?.status === "passed" && liveDesktop.completion.visualStatus !== "visible") return "blocked";
  if (liveDesktop?.completion?.status === "passed") return "passed";
  if (liveDesktop?.completion?.status === "failed") return "failed";
  if (liveDesktop?.completion?.status === "blocked") return "blocked";
  if (liveDesktop?.completion?.status === "timed_out") return "timed_out";
  if (liveDesktop?.bootstrap?.status === "failed") return "failed";
  if (liveDesktop?.url) return "running";
  if (liveDesktop?.error) return "failed";
  if (args.missingKeys.length > 0) return "blocked";
  return "preparing";
}

function progressForMeta(status: RunSimulation["status"], liveDesktop: OssMetaLabLiveDesktop | undefined): number {
  if (status === "contract_proof_only") return 100;
  if (status === "passed") return 100;
  if (status === "timed_out") return 100;
  if (status === "failed" && liveDesktop?.completion) return 100;
  if (status === "blocked") return 18;
  if (status === "failed") return 8;
  if (liveDesktop?.completion?.appStatus === "running") return 86;
  if (liveDesktop?.bootstrap?.status === "started") return 74;
  if (liveDesktop?.url) return 58;
  return 34;
}

function currentStepForMeta(args: {
  dryRun: boolean;
  liveDesktops: OssMetaLabLiveDesktop[];
  liveRequested: boolean;
  missingKeys: string[];
  redactRepoNames?: boolean;
}, assignment: OssMetaLabAssignment): string {
  const liveDesktop = args.liveDesktops.find((desktop) => desktop.streamId === assignment.streamId);
  const repoLabel = args.redactRepoNames ? repoArtifactLabel(assignment) : assignment.repo;
  if (args.dryRun) {
    return `Contract ready for ${repoLabel}; no E2B desktop launched.`;
  }
  if (liveDesktop?.completion) {
    return liveDesktop.completion.reason;
  }
  if (liveDesktop?.bootstrap?.status === "started") {
    return `Bootstrap terminal launched for ${repoLabel}; Codex TUI attempt, Mimetic setup, and nested Observer run inside the desktop.`;
  }
  if (liveDesktop?.bootstrap?.status === "failed") {
    return `Bootstrap launcher failed for ${repoLabel}.`;
  }
  if (liveDesktop?.url) {
    return `Live E2B desktop connected for ${repoLabel}; Codex TUI injection pending.`;
  }
  if (liveDesktop?.error) {
    return `E2B desktop launch failed for ${repoLabel}.`;
  }
  if (args.missingKeys.length > 0) {
    return `Waiting for ${args.missingKeys.join(", ")} before launching ${repoLabel}.`;
  }
  return `Ready to launch E2B desktop and inject Codex TUI for ${repoLabel}.`;
}

function createMetaReview(args: {
  dryRun: boolean;
  liveDesktops: OssMetaLabLiveDesktop[];
  liveRequested: boolean;
  missingKeys: string[];
}): ReviewSummary {
  const started = args.liveDesktops.filter((desktop) => desktop.bootstrap?.status === "started");
  const terminalCompletions = args.liveDesktops.filter((desktop) => isTerminalCompletion(desktop.completion));
  const appRunning = args.liveDesktops.filter((desktop) => desktop.completion?.appStatus === "running");
  const visualVisible = args.liveDesktops.filter((desktop) => desktop.completion?.visualStatus === "visible");
  const nestedLiveProof = args.liveDesktops.some((desktop) =>
    desktop.completion?.nestedVerifyPassed === true
    && /\bmimetic run live\b/.test(desktop.completion.logTail ?? "")
  );
  const outcome = classifyMetaLabOutcome(args);
  const gaps = [
    nestedLiveProof && appRunning.length > 0 && visualVisible.length > 0
      ? "Target app browser surfaces, nested Observer windows, and nested Mimetic live app-url proof are visible inside headed desktops."
      : appRunning.length > 0 && visualVisible.length > 0
      ? "Target app browser surfaces and nested Observer windows are visible inside headed desktops; real Mimetic browser personas driving those apps are still the next adapter slice."
      : appRunning.length > 0
      ? "Target app surfaces responded over HTTP, but headed desktop browser-window visibility was not detected for every lane."
      : started.length > 0 && terminalCompletions.length === started.length
      ? "OSS lane terminal states are classified from public-safe remote bootstrap evidence, but target app HTTP readiness was not detected."
      : args.liveDesktops.some((desktop) => desktop.bootstrap?.status === "started")
      ? "Visible E2B bootstrap terminals are launched and run nested Mimetic setup plus target app startup; completion is watched in the desktop stream until remote evidence is polled back."
      : "Nested Mimetic Observer evidence is represented as a lane contract until Codex TUI injection and nested Mimetic execution land.",
    nestedLiveProof
      ? "Nested Mimetic proof reached live app-url mode with desktop/mobile browser evidence; autonomous multi-step persona navigation is still the next adapter slice."
      : "Nested Mimetic proof did not reach live app-url mode; target app startup or browser evidence is still missing.",
    "The top-level run does not clone, modify, commit, push, or file issues in target repos.",
    "Public runs may record GitHub owner/repo slugs; token-backed maintainer/private runs redact repo labels in durable artifacts by default."
  ];

  if (args.liveRequested && args.missingKeys.length > 0) {
    gaps.unshift(`Live launch is blocked until ${args.missingKeys.join(", ")} are available in environment.`);
  }
  if (args.liveDesktops.some((desktop) => desktop.url) && !args.liveDesktops.some((desktop) => desktop.bootstrap?.status === "started")) {
    gaps.unshift("Live E2B desktop streams are connected, but Codex TUI injection and nested Mimetic execution are not yet automated.");
  }

  return {
    schema: REVIEW_SCHEMA,
    verdict: outcome.verdict,
    summary: outcome.verdict === "fail" || outcome.verdict === "timed_out" || outcome.verdict === "blocked"
      ? outcome.reason
      : args.dryRun
      ? "OSS meta-lab dry-run rendered the Observer-of-Observers contract without provider spend."
      : terminalCompletions.length > 0
        ? `OSS meta-lab launched live E2B desktop streams, classified ${terminalCompletions.length}/${started.length || terminalCompletions.length} bootstrap terminal state${terminalCompletions.length === 1 ? "" : "s"} from public-safe remote evidence, detected ${appRunning.length}/${terminalCompletions.length} target app HTTP-ready surface${terminalCompletions.length === 1 ? "" : "s"}, and detected ${visualVisible.length}/${terminalCompletions.length} headed desktop visual layout${terminalCompletions.length === 1 ? "" : "s"}.`
      : args.liveDesktops.some((desktop) => desktop.bootstrap?.status === "started")
        ? "OSS meta-lab launched live E2B desktop streams, injected visible bootstrap terminals, and started target app plus nested Mimetic setup inside each desktop."
        : args.liveDesktops.some((desktop) => desktop.url)
          ? "OSS meta-lab launched live E2B desktop streams and rendered them in the top-level Observer."
        : "OSS meta-lab rendered the live headed-desktop control surface and marked the missing substrate truth in-lane.",
    gaps
  };
}

function classifyMetaLabOutcome(args: {
  dryRun: boolean;
  liveDesktops: OssMetaLabLiveDesktop[];
  liveRequested: boolean;
  missingKeys: string[];
}): OssMetaLabOutcome {
  if (args.dryRun) {
    return {
      ok: true,
      reason: "OSS meta-lab dry-run rendered the Observer-of-Observers contract without provider spend.",
      verdict: "contract_proof_only"
    };
  }

  if (args.liveRequested && args.missingKeys.length > 0) {
    return {
      ok: true,
      reason: `Live launch is blocked until ${args.missingKeys.join(", ")} are available in environment.`,
      verdict: "blocked"
    };
  }

  const launchFailures = args.liveDesktops.filter((desktop) => desktop.error || desktop.bootstrap?.status === "failed");
  if (launchFailures.length > 0) {
    return {
      ok: false,
      reason: `OSS meta-lab failed ${launchFailures.length}/${args.liveDesktops.length} live desktop or bootstrap launch${launchFailures.length === 1 ? "" : "es"}.`,
      verdict: "fail"
    };
  }

  const failedCompletions = args.liveDesktops.filter((desktop) => desktop.completion?.status === "failed");
  if (failedCompletions.length > 0) {
    return {
      ok: false,
      reason: `OSS meta-lab classified ${failedCompletions.length}/${args.liveDesktops.length} bootstrap terminal state${failedCompletions.length === 1 ? "" : "s"} as failed from public-safe remote evidence.`,
      verdict: "fail"
    };
  }

  const timedOutCompletions = args.liveDesktops.filter((desktop) => desktop.completion?.status === "timed_out");
  if (timedOutCompletions.length > 0) {
    return {
      ok: false,
      reason: `OSS meta-lab timed out waiting for ${timedOutCompletions.length}/${args.liveDesktops.length} bootstrap completion marker${timedOutCompletions.length === 1 ? "" : "s"}.`,
      verdict: "timed_out"
    };
  }

  const blockedCompletions = args.liveDesktops.filter((desktop) => desktop.completion?.status === "blocked");
  if (blockedCompletions.length > 0) {
    return {
      ok: false,
      reason: `OSS meta-lab classified ${blockedCompletions.length}/${args.liveDesktops.length} bootstrap terminal state${blockedCompletions.length === 1 ? "" : "s"} as blocked from public-safe remote evidence.`,
      verdict: "blocked"
    };
  }

  const completedWithMissingApp = args.liveDesktops.filter((desktop) =>
    desktop.completion?.status === "passed"
    && desktop.completion.appStatus !== "running"
  );
  if (completedWithMissingApp.length > 0) {
    return {
      ok: false,
      reason: `OSS meta-lab completed nested Mimetic setup but did not detect ${completedWithMissingApp.length}/${args.liveDesktops.length} target app HTTP-ready surface${completedWithMissingApp.length === 1 ? "" : "s"}.`,
      verdict: "blocked"
    };
  }

  const completedWithMissingVisual = args.liveDesktops.filter((desktop) =>
    desktop.completion?.status === "passed"
    && desktop.completion.visualStatus !== "visible"
  );
  if (completedWithMissingVisual.length > 0) {
    return {
      ok: false,
      reason: `OSS meta-lab completed nested Mimetic setup but did not detect ${completedWithMissingVisual.length}/${args.liveDesktops.length} headed desktop visual layout${completedWithMissingVisual.length === 1 ? "" : "s"}.`,
      verdict: "blocked"
    };
  }

  if (args.liveDesktops.length > 0 && args.liveDesktops.every((desktop) => desktop.completion?.status === "passed")) {
    return {
      ok: true,
      reason: `OSS meta-lab passed ${args.liveDesktops.length}/${args.liveDesktops.length} bootstrap terminal states with target app HTTP readiness and headed desktop visual layout detected from public-safe remote evidence.`,
      verdict: "pass"
    };
  }

  return {
    ok: true,
    reason: "OSS meta-lab rendered the live headed-desktop control surface and marked the missing substrate truth in-lane.",
    verdict: "contract_proof_only"
  };
}

function terminalTailForMeta(prompt: string, liveDesktop: OssMetaLabLiveDesktop | undefined): string {
  if (!liveDesktop?.completion) {
    return liveDesktop?.bootstrap?.tail ?? prompt;
  }

  const lines = [
    `Remote bootstrap ${liveDesktop.completion.status}: ${liveDesktop.completion.reason}`,
    `checked_at: ${liveDesktop.completion.checkedAt}`,
    ...(liveDesktop.completion.appStatus === undefined ? [] : [`app_status: ${liveDesktop.completion.appStatus}`]),
    ...(liveDesktop.completion.appUrl === undefined ? [] : [`app_url: ${liveDesktop.completion.appUrl}`]),
    ...(liveDesktop.completion.appReason === undefined ? [] : [`app_reason: ${liveDesktop.completion.appReason}`]),
    ...(liveDesktop.completion.actorStatus === undefined ? [] : [`actor_status: ${liveDesktop.completion.actorStatus}`]),
    ...(liveDesktop.completion.exitCode === undefined ? [] : [`exit_code: ${liveDesktop.completion.exitCode}`]),
    ...(liveDesktop.completion.nestedVerifyPassed === undefined ? [] : [`nested_verify_passed: ${liveDesktop.completion.nestedVerifyPassed ? "true" : "false"}`]),
    ...(liveDesktop.completion.nestedObserverPresent === undefined ? [] : [`nested_observer_present: ${liveDesktop.completion.nestedObserverPresent ? "true" : "false"}`]),
    ...(liveDesktop.completion.visualStatus === undefined ? [] : [`visual_status: ${liveDesktop.completion.visualStatus}`]),
    ...(liveDesktop.completion.visualWindowCount === undefined ? [] : [`visual_window_count: ${liveDesktop.completion.visualWindowCount}`]),
    ...(liveDesktop.completion.visualReason === undefined ? [] : [`visual_reason: ${liveDesktop.completion.visualReason}`]),
    ...(liveDesktop.completion.setupQuality === undefined ? [] : [
      `setup_quality: ${liveDesktop.completion.setupQuality.status}`,
      `setup_summary: ${liveDesktop.completion.setupQuality.summary}`
    ]),
    "",
    "public-safe actor last message tail:",
    liveDesktop.completion.actorLastMessageTail?.trim() || "(no actor last-message captured)",
    "",
    "public-safe actor log tail:",
    liveDesktop.completion.actorLogTail?.trim() || "(no actor log tail captured)",
    "",
    "public-safe bootstrap log tail:",
    liveDesktop.completion.logTail?.trim() || "(no log tail captured)"
  ];

  return lines.join("\n").trim();
}

function completionForStream(completion: OssMetaLabCompletion): RunStreamCompletion {
  return {
    ...(completion.actorLogPath === undefined ? {} : { actorLogPath: completion.actorLogPath }),
    ...(completion.actorLogTail === undefined ? {} : { actorLogTail: completion.actorLogTail }),
    ...(completion.actorLastMessageTail === undefined ? {} : { actorLastMessageTail: completion.actorLastMessageTail }),
    ...(completion.actorPid === undefined ? {} : { actorPid: completion.actorPid }),
    ...(completion.actorStatus === undefined ? {} : { actorStatus: completion.actorStatus }),
    ...(completion.appLogPath === undefined ? {} : { appLogPath: completion.appLogPath }),
    ...(completion.appPid === undefined ? {} : { appPid: completion.appPid }),
    ...(completion.appReason === undefined ? {} : { appReason: completion.appReason }),
    ...(completion.appStatus === undefined ? {} : { appStatus: completion.appStatus }),
    ...(completion.appUrl === undefined ? {} : { appUrl: completion.appUrl }),
    checkedAt: completion.checkedAt,
    ...(completion.exitCode === undefined ? {} : { exitCode: completion.exitCode }),
    ...(completion.logTail === undefined ? {} : { logTail: completion.logTail }),
    ...(completion.nestedObserverPresent === undefined ? {} : { nestedObserverPresent: completion.nestedObserverPresent }),
    ...(completion.nestedVerifyPassed === undefined ? {} : { nestedVerifyPassed: completion.nestedVerifyPassed }),
    reason: completion.reason,
    status: completion.status,
    ...(completion.visualReason === undefined ? {} : { visualReason: completion.visualReason }),
    ...(completion.visualStatus === undefined ? {} : { visualStatus: completion.visualStatus }),
    ...(completion.visualWindowCount === undefined ? {} : { visualWindowCount: completion.visualWindowCount })
  };
}

function buildMetaFeedbackCandidates(args: {
  assignments: OssMetaLabAssignment[];
  liveDesktops: OssMetaLabLiveDesktop[];
  redactRepoNames: boolean;
  runId: string;
}): RunFeedbackCandidate[] {
  const candidates: RunFeedbackCandidate[] = [];

  for (const assignment of args.assignments) {
    const desktop = args.liveDesktops.find((lane) => lane.streamId === assignment.streamId);
    if (!desktop) {
      continue;
    }

    const repoLabel = args.redactRepoNames ? repoArtifactLabel(assignment) : assignment.repo;
    const scenarioId = args.redactRepoNames ? `oss-meta-${repoLabel}` : assignment.scenarioId;
    const baseEvidence = feedbackEvidenceForDesktop(desktop);
    const setupQualityPath = desktop.actorEvidence?.setupQualityPath;
    const failedSetupChecks = desktop.completion?.setupQuality?.checks.filter((check) => !check.ok) ?? [];

    if (setupQualityPath && failedSetupChecks.length > 0) {
      candidates.push({
        schema: "mimetic.feedback-candidate.v1",
        id: `setup-quality-${safeArtifactToken(assignment.streamId)}`,
        run_id: args.runId,
        stream_id: assignment.streamId,
        adapter_id: "oss-meta-lab",
        scenario_id: scenarioId,
        persona_id: `codex-oss-operator-${String(assignment.index).padStart(2, "0")}`,
        actor: "codex-tui",
        substrate: "e2b-desktop",
        failure_owner: "actor",
        summary: `${repoLabel} Mimetic setup needs review`,
        expected: "The setup actor should create committed Mimetic source files, useful personas/scenarios, a package script, and a .mimetic/ runtime ignore without preserving private state.",
        actual: failedSetupChecks.map((check) => `${check.label}: ${check.detail}`).join(" "),
        evidence: [
          {
            path: setupQualityPath,
            kind: "filesystem",
            note: "Setup-quality snapshot with tree, checks, package scripts, and allowlisted previews."
          },
          ...baseEvidence
        ],
        redaction: {
          status: "passed",
          notes: "Feedback candidate references local public-safe run artifacts only."
        },
        idempotency_key: `mimetic:${args.runId}:${assignment.streamId}:setup-quality`,
        proposed_next_state: "setup-quality-review",
        acceptance_proof: [
          `pnpm mimetic -- verify --run ${args.runId} --json`,
          `pnpm mimetic -- watch --run ${args.runId} --no-open`
        ]
      });
    }

    const actorText = `${desktop.completion?.actorLastMessageTail ?? ""}\n${desktop.completion?.actorLogTail ?? ""}`;
    if (/\b(?:does not support|unknown option|unsupported)\b[\s\S]{0,120}--app-url/i.test(actorText)) {
      candidates.push({
        schema: "mimetic.feedback-candidate.v1",
        id: `published-cli-app-url-${safeArtifactToken(assignment.streamId)}`,
        run_id: args.runId,
        stream_id: assignment.streamId,
        adapter_id: "oss-meta-lab",
        scenario_id: scenarioId,
        persona_id: `codex-oss-operator-${String(assignment.index).padStart(2, "0")}`,
        actor: "codex-tui",
        substrate: "e2b-desktop",
        failure_owner: "harness",
        summary: "Published Mimetic install path blocked app-url proof",
        expected: "A fresh npm-installed Mimetic CLI should support the app-url live proof path documented for agents.",
        actual: "The actor evidence reports that the installed CLI did not accept or expose the app-url proof option.",
        evidence: baseEvidence,
        redaction: {
          status: "passed",
          notes: "Actor evidence was redacted before persistence."
        },
        idempotency_key: `mimetic:${args.runId}:${assignment.streamId}:published-cli-app-url`,
        proposed_next_state: "adapter-hardening",
        acceptance_proof: [
          "npm view mimetic-cli version",
          "npx mimetic -- run --help | grep -- --app-url",
          `pnpm mimetic -- verify --run ${args.runId} --json`
        ]
      });
    }
  }

  return candidates.slice(0, 20);
}

function feedbackEvidenceForDesktop(desktop: OssMetaLabLiveDesktop): RunFeedbackCandidate["evidence"] {
  const evidence: RunFeedbackCandidate["evidence"] = [];
  if (desktop.actorEvidence?.actorLastMessageTailPath) {
    evidence.push({
      path: desktop.actorEvidence.actorLastMessageTailPath,
      kind: "log",
      note: "Public-safe actor last-message tail."
    });
  }
  if (desktop.actorEvidence?.actorLogTailPath) {
    evidence.push({
      path: desktop.actorEvidence.actorLogTailPath,
      kind: "log",
      note: "Public-safe actor log tail."
    });
  }
  if (desktop.screenshot?.path) {
    evidence.push({
      path: desktop.screenshot.path,
      kind: "screenshot",
      note: "Headed desktop screenshot fallback."
    });
  }
  if (desktop.hostActorPlanPath) {
    evidence.push({
      path: desktop.hostActorPlanPath,
      kind: "trace",
      note: "Host-authored public-safe actor plan."
    });
  }
  return evidence;
}

function eventLevelForCompletion(status: OssMetaLabCompletionStatus): RunEvent["level"] {
  if (status === "passed") return "info";
  if (status === "running") return "info";
  if (status === "blocked" || status === "timed_out") return "warn";
  return "error";
}

function isTerminalCompletion(completion: OssMetaLabCompletion | undefined): boolean {
  return completion !== undefined && completion.status !== "running";
}

function buildCodexBootstrapPrompt(assignment: OssMetaLabAssignment, redactRepoName = false): string {
  const repoLabel = redactRepoName ? "[redacted-authorized-repo]" : `https://github.com/${assignment.repo}.git`;
  return [
    `# Mimetic OSS Meta-Lab Actor ${assignment.index}`,
    "",
    "You are running inside a disposable headed E2B desktop with a visible terminal and browser.",
    "Public-safety hard rails: use only authorized repo contents; never print keys; never commit, push, file issues, or preserve private artifacts.",
    "",
    `Target repo: ${repoLabel}`,
    "",
    "Mission:",
    "1. Clone the target repo into a clean disposable workspace.",
    "2. Inspect the package manager, dev scripts, README, and app shape.",
    "3. Get the repo into a local runnable dev mode if feasible.",
    "4. Discover the Mimetic skill path and try installing it with `npx skills add danielgwilson/mimetic-cli --skill mimetic-cli`.",
    "5. Install Mimetic as a dev dependency with the package manager the repo already uses.",
    "6. Run `npx mimetic init --yes` or the package-manager equivalent.",
    "7. Author plausible public-safe Mimetic personas and desktop/mobile browser scenarios for this repo if feasible.",
    "8. Run the strongest Mimetic proof path the installed package supports. If the app is running locally, prefer `npx mimetic run --app-url <loopback-url> --sims 2` so the nested Observer contains desktop/mobile browser evidence.",
    "9. Open the nested Mimetic Observer in the E2B browser and keep it visible.",
    "10. Record public-safe blockers and evidence paths only.",
    "",
    "Expected nested outcome: the top-level Mimetic Observer shows this desktop, and this desktop shows its own nested Mimetic Observer."
  ].join("\n");
}

function renderMetaReviewMarkdown(bundle: RunBundle): string {
  return `# Mimetic OSS Meta-Lab Review

Run: ${bundle.runId}

Verdict: ${bundle.review.verdict}

${bundle.review.summary}

## Public-Safety

- Redaction: ${bundle.redaction.status}
- Notes: ${bundle.redaction.notes}

## Assigned Repos

${bundle.streams.map((stream) => `- ${stream.label}: ${stream.simId}`).join("\n")}

## Gaps

${bundle.review.gaps.map((gap) => `- ${gap}`).join("\n")}
`;
}

async function launchLiveDesktops(
  assignments: OssMetaLabAssignment[],
  options: {
    cwd?: string;
    hostActorPlansByStream?: Map<string, OssMetaLabHostActorPlanResult>;
    localPackage?: OssMetaLabLocalPackage;
    redactRepoNames?: boolean;
  } = {}
): Promise<OssMetaLabLiveDesktop[]> {
  const e2bApiKey = process.env.E2B_API_KEY;
  if (!e2bApiKey) {
    return [];
  }

  const desktopModule = await loadE2BDesktopModule();
  const timeoutMs = readPositiveInt(process.env.MIMETIC_E2B_TIMEOUT_MS, 60 * 60 * 1000);
  const requestTimeoutMs = readPositiveInt(process.env.MIMETIC_E2B_REQUEST_TIMEOUT_MS, 60_000);

  return Promise.all(assignments.map(async (assignment) => {
    const repoLabel = options.redactRepoNames ? repoArtifactLabel(assignment) : assignment.repo;
    const hostActorPlanResult = options.hostActorPlansByStream?.get(assignment.streamId);
    try {
      const desktop = await desktopModule.Sandbox.create({
        apiKey: e2bApiKey,
        requestTimeoutMs,
        timeoutMs,
        metadata: {
          ...OSS_META_LAB_PROVIDER_METADATA,
          repo: repoLabel,
          simId: assignment.simId
        },
        envs: {
          ...collectOssMetaLabRemoteEnv(process.env),
          ...collectOssMetaLabPrivateEnv(process.env)
        },
        resolution: [1440, 960],
        dpi: 96,
        lifecycle: {
          onTimeout: "kill"
        }
      });
      const bootstrap = await startOssBootstrap(desktop, assignment, options.localPackage, requestTimeoutMs, {
        ...(hostActorPlanResult === undefined ? {} : { hostActorPlanResult }),
        repoLabel,
        token: options.redactRepoNames ? repoLabel : repoSlugToken(assignment.repo)
      });
      await desktop.wait(750).catch(() => undefined);
      await desktop.stream.start({ requireAuth: true });
      const authKey = desktop.stream.getAuthKey();
      const url = desktop.stream.getUrl({
        authKey,
        autoConnect: true,
        viewOnly: true,
        resize: "scale"
      });

      return {
        bootstrap,
        desktop,
        ...(hostActorPlanResult?.plan ? { hostActorPlan: hostActorPlanResult.plan } : {}),
        ...(hostActorPlanResult?.artifactPath ? { hostActorPlanPath: hostActorPlanResult.artifactPath } : {}),
        repo: repoLabel,
        sandboxId: desktop.sandboxId,
        simId: assignment.simId,
        streamId: assignment.streamId,
        url
      };
    } catch (error) {
      return {
        error: compactError(error),
        ...(hostActorPlanResult?.plan ? { hostActorPlan: hostActorPlanResult.plan } : {}),
        ...(hostActorPlanResult?.artifactPath ? { hostActorPlanPath: hostActorPlanResult.artifactPath } : {}),
        repo: repoLabel,
        simId: assignment.simId,
        streamId: assignment.streamId
      };
    }
  }));
}

async function pollLiveDesktopCompletions(
  liveDesktops: OssMetaLabLiveDesktop[],
  options: { timeoutMs?: number; timeoutReason?: string } = {}
): Promise<{ warnings: string[] }> {
  const pollable = liveDesktops.filter((desktop) =>
    desktop.desktop
    && desktop.bootstrap?.status === "started"
    && desktop.bootstrap.completionPath
  );
  if (pollable.length === 0) {
    return { warnings: [] };
  }

  const timeoutMs = options.timeoutMs ?? readNonNegativeInt(process.env.MIMETIC_OSS_META_COMPLETION_TIMEOUT_MS, 240_000);
  const intervalMs = readPositiveInt(process.env.MIMETIC_OSS_META_COMPLETION_INTERVAL_MS, 5_000);
  const requestTimeoutMs = readPositiveInt(process.env.MIMETIC_E2B_REQUEST_TIMEOUT_MS, 60_000);
  const warnings: string[] = [];

  if (timeoutMs === 0) {
    warnings.push(`OSS meta-lab completion polling skipped because ${options.timeoutReason ?? "MIMETIC_OSS_META_COMPLETION_TIMEOUT_MS=0"}.`);
    return { warnings };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    await Promise.all(pollable.map(async (desktop) => {
      if (isTerminalCompletion(desktop.completion) || !desktop.desktop || !desktop.bootstrap?.completionPath) {
        return;
      }

      const completion = await readRemoteCompletion(desktop.desktop, desktop.bootstrap, requestTimeoutMs);
      if (completion) {
        desktop.completion = completion;
      }
    }));

    if (pollable.every((desktop) => isTerminalCompletion(desktop.completion))) {
      return { warnings };
    }

    await wait(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }

  await Promise.all(pollable.map(async (desktop) => {
    if (isTerminalCompletion(desktop.completion) || !desktop.desktop || !desktop.bootstrap) {
      return;
    }

    desktop.completion = {
      checkedAt: new Date().toISOString(),
      logTail: await readRemoteLogTail(desktop.desktop, desktop.bootstrap, requestTimeoutMs),
      reason: `Timed out waiting ${timeoutMs}ms for remote bootstrap completion marker.`,
      status: "timed_out"
    };
  }));

  warnings.push(`Timed out waiting for ${pollable.filter((desktop) => desktop.completion?.status === "timed_out").length}/${pollable.length} OSS meta-lab bootstrap completion marker${pollable.length === 1 ? "" : "s"}.`);
  return { warnings };
}

async function refreshOssMetaLabLiveRuntime(
  runtime: OssMetaLabRuntime,
  options: {
    captureScreenshots: boolean;
    timedOut: boolean;
    timeoutMs: number;
  }
): Promise<void> {
  await refreshLiveDesktopProgress(runtime.liveDesktops, {
    timedOut: options.timedOut,
    timeoutMs: options.timeoutMs
  });

  if (options.captureScreenshots) {
    await captureLiveDesktopScreenshots(runtime.artifactRoot, runtime.liveDesktops);
  }
  await writeActorEvidenceArtifacts(runtime.artifactRoot, runtime.liveDesktops, runtime.redactRepoNames);

  const bundle = buildMetaBundle({
    assignments: runtime.assignments,
    createdAt: runtime.createdAt,
    cwd: runtime.cwd,
    dryRun: runtime.dryRun,
    liveDesktops: runtime.liveDesktops,
    liveRequested: runtime.liveRequested,
    missingKeys: runtime.missingKeys,
    redactRepoNames: runtime.redactRepoNames,
    runId: runtime.runId
  });
  await writeMetaBundleArtifacts(runtime.artifactRoot, bundle);
  await renderObserver(runtime.cwd, runtime.runId, { open: false });
}

async function refreshLiveDesktopProgress(
  liveDesktops: OssMetaLabLiveDesktop[],
  options: { timedOut: boolean; timeoutMs: number }
): Promise<void> {
  const requestTimeoutMs = readPositiveInt(process.env.MIMETIC_E2B_REQUEST_TIMEOUT_MS, 60_000);

  await Promise.all(liveDesktops.map(async (desktop) => {
    if (!desktop.desktop || desktop.bootstrap?.status !== "started") {
      return;
    }
    if (isTerminalCompletion(desktop.completion)) {
      return;
    }

    const completion = await readRemoteCompletion(desktop.desktop, desktop.bootstrap, requestTimeoutMs);
    if (completion) {
      desktop.completion = completion;
      return;
    }

    const logTail = await readRemoteLogTail(desktop.desktop, desktop.bootstrap, requestTimeoutMs);
    desktop.completion = {
      checkedAt: new Date().toISOString(),
      logTail,
      reason: options.timedOut
        ? `Timed out waiting ${options.timeoutMs}ms for remote bootstrap completion marker.`
        : logTail
          ? "Remote bootstrap is running; latest public-safe log tail is available."
          : "Remote bootstrap is running; waiting for first public-safe log output.",
      status: options.timedOut ? "timed_out" : "running"
    };
  }));
}

async function readRemoteCompletion(
  desktop: E2BDesktopSandbox,
  bootstrap: OssMetaLabBootstrap,
  requestTimeoutMs: number
): Promise<OssMetaLabCompletion | null> {
  if (!bootstrap.completionPath) {
    return null;
  }

  const command = `if [ -f ${shellQuote(bootstrap.completionPath)} ]; then cat ${shellQuote(bootstrap.completionPath)}; else exit 3; fi`;
  const result = await desktop.commands.run(`bash -lc ${shellQuote(command)}`, {
    requestTimeoutMs,
    timeoutMs: 30_000
  }).catch(() => null);
  if (!result || (result.exitCode && result.exitCode !== 0) || !result.stdout) {
    return null;
  }

  return parseRemoteCompletion(result.stdout);
}

async function readRemoteLogTail(
  desktop: E2BDesktopSandbox,
  bootstrap: OssMetaLabBootstrap,
  requestTimeoutMs: number
): Promise<string> {
  if (!bootstrap.logPath) {
    return "";
  }

  const command = `tail -n 80 ${shellQuote(bootstrap.logPath)} 2>/dev/null || true`;
  const result = await desktop.commands.run(`bash -lc ${shellQuote(command)}`, {
    requestTimeoutMs,
    timeoutMs: 30_000
  }).catch(() => null);

  return sanitizeRemoteLog(result?.stdout ?? "");
}

async function captureLiveDesktopScreenshots(
  artifactRoot: string,
  liveDesktops: OssMetaLabLiveDesktop[]
): Promise<{ warnings: string[] }> {
  const candidates = liveDesktops.filter((desktop) => desktop.desktop && desktop.url);
  if (candidates.length === 0) {
    return { warnings: [] };
  }

  const screenshotRoot = path.join(artifactRoot, "screenshots");
  await mkdir(screenshotRoot, { recursive: true });
  const warnings: string[] = [];

  await Promise.all(candidates.map(async (desktop) => {
    if (!desktop.desktop) {
      return;
    }

    try {
      await arrangeLiveDesktopForScreenshot(
        desktop.desktop,
        desktop.bootstrap?.terminalTitle,
        readPositiveInt(process.env.MIMETIC_E2B_REQUEST_TIMEOUT_MS, 60_000)
      );
      await desktop.desktop.wait(readPositiveInt(process.env.MIMETIC_OSS_META_SCREENSHOT_SETTLE_MS, 2_500)).catch(() => undefined);
      const bytes = await desktop.desktop.screenshot("bytes");
      const fileName = `${safeArtifactToken(desktop.streamId)}.png`;
      const screenshotPath = path.join(screenshotRoot, fileName);
      await writeFile(screenshotPath, Buffer.from(bytes));
      desktop.screenshot = {
        capturedAt: new Date().toISOString(),
        observerUrl: `../screenshots/${fileName}`,
        path: path.join("screenshots", fileName)
      };
    } catch (error) {
      warnings.push(`Screenshot capture failed for ${desktop.repo}: ${compactError(error)}`);
    }
  }));

  const capturedCount = liveDesktops.filter((desktop) => desktop.screenshot).length;
  if (capturedCount > 0) {
    warnings.push(`Captured ${capturedCount}/${candidates.length} E2B desktop screenshot fallback${candidates.length === 1 ? "" : "s"}.`);
  }

  return { warnings };
}

async function writeActorEvidenceArtifacts(
  artifactRoot: string,
  liveDesktops: OssMetaLabLiveDesktop[],
  redactRepoNames: boolean
): Promise<{ warnings: string[] }> {
  const candidates = liveDesktops.filter((desktop) =>
    desktop.completion?.actorLastMessageTail || desktop.completion?.actorLogTail || desktop.completion?.setupQuality
  );
  if (candidates.length === 0) {
    return { warnings: [] };
  }

  const actorEvidenceRoot = path.join(artifactRoot, "actor-evidence");
  const setupQualityRoot = path.join(artifactRoot, "setup-quality");
  await mkdir(actorEvidenceRoot, { recursive: true });
  await mkdir(setupQualityRoot, { recursive: true });
  let written = 0;

  for (const desktop of candidates) {
    const baseName = safeArtifactToken(desktop.streamId);
    const actorEvidence: OssMetaLabActorEvidenceArtifacts = {};

    if (desktop.completion?.actorLastMessageTail) {
      const relativePath = path.join("actor-evidence", `${baseName}-actor-last-message-tail.txt`);
      await writeFile(
        path.join(artifactRoot, relativePath),
        renderPublicSafeActorEvidenceText("actor-last-message", desktop.streamId, desktop.completion.actorLastMessageTail),
        "utf8"
      );
      actorEvidence.actorLastMessageTailPath = relativePath;
      written += 1;
    }

    if (desktop.completion?.actorLogTail) {
      const relativePath = path.join("actor-evidence", `${baseName}-actor-log-tail.txt`);
      await writeFile(
        path.join(artifactRoot, relativePath),
        renderPublicSafeActorEvidenceText("actor-log", desktop.streamId, desktop.completion.actorLogTail),
        "utf8"
      );
      actorEvidence.actorLogTailPath = relativePath;
      written += 1;
    }

    if (desktop.completion?.setupQuality) {
      const relativePath = path.join("setup-quality", `${baseName}-setup-quality.json`);
      const snapshot = redactRepoNames
        ? suppressSetupQualityPreviews(desktop.completion.setupQuality)
        : desktop.completion.setupQuality;
      await writeJson(path.join(artifactRoot, relativePath), snapshot);
      actorEvidence.setupQualityPath = relativePath;
      written += 1;
    }

    desktop.actorEvidence = actorEvidence;
  }

  return {
    warnings: [
      `Persisted ${written} public-safe local actor evidence artifact${written === 1 ? "" : "s"}.`
    ]
  };
}

function suppressSetupQualityPreviews(snapshot: RunSetupQualitySnapshot): RunSetupQualitySnapshot {
  return {
    ...snapshot,
    summary: sanitizeSetupQualityText(snapshot.summary),
    checks: snapshot.checks.map((check) => ({
      ...check,
      label: sanitizeSetupQualityText(check.label),
      detail: sanitizeSetupQualityText(check.detail)
    })),
    previews: [],
    redaction: {
      status: "passed",
      rawPreviews: "suppressed",
      notes: "Raw file previews are suppressed for token-backed/private OSS meta-lab runs."
    }
  };
}

function renderPublicSafeActorEvidenceText(kind: string, streamId: string, text: string): string {
  const sanitized = sanitizeRemoteLog(text);
  return [
    `schema: mimetic.oss-meta-actor-evidence.v1`,
    `kind: ${kind}`,
    `stream: ${streamId}`,
    `redaction: passed`,
    "",
    sanitized || "(no actor evidence captured)"
  ].join("\n").trimEnd() + "\n";
}

async function arrangeLiveDesktopForScreenshot(
  desktop: E2BDesktopSandbox,
  terminalTitle: string | undefined,
  requestTimeoutMs: number
): Promise<void> {
  const command = buildRemoteScreenshotArrangeCommand(terminalTitle);
  await desktop.commands.run(`bash -lc ${shellQuote(command)}`, {
    requestTimeoutMs,
    timeoutMs: 15_000
  }).catch(() => undefined);
}

function parseRemoteCompletion(payload: string): OssMetaLabCompletion | null {
  try {
    const parsed = JSON.parse(payload) as {
      actorLogPath?: unknown;
      actorLogTail?: unknown;
      actorLastMessageTail?: unknown;
      actorPid?: unknown;
      actorStatus?: unknown;
      appLogPath?: unknown;
      appPid?: unknown;
      appReason?: unknown;
      appStatus?: unknown;
      appUrl?: unknown;
      completedAt?: unknown;
      exitCode?: unknown;
      logTail?: unknown;
      nestedObserverPresent?: unknown;
      nestedVerifyStatus?: unknown;
      reason?: unknown;
      setupQuality?: unknown;
      status?: unknown;
      visualReason?: unknown;
      visualStatus?: unknown;
      visualWindowCount?: unknown;
    };
    const status = normalizeCompletionStatus(parsed.status);
    if (!status) {
      return null;
    }

    const nestedVerifyPassed = parsed.nestedVerifyStatus === "passed"
      ? true
      : parsed.nestedVerifyStatus === "failed" ? false : undefined;
    const appStatus = normalizeAppStatus(parsed.appStatus);
    const actorStatus = normalizeActorStatus(parsed.actorStatus);
    const visualStatus = normalizeVisualStatus(parsed.visualStatus);

    return {
      ...(typeof parsed.actorLogPath === "string" && parsed.actorLogPath.trim() ? { actorLogPath: sanitizeRemoteLog(parsed.actorLogPath) } : {}),
      ...(typeof parsed.actorLogTail === "string" && parsed.actorLogTail.trim() ? { actorLogTail: sanitizeRemoteLog(parsed.actorLogTail) } : {}),
      ...(typeof parsed.actorLastMessageTail === "string" && parsed.actorLastMessageTail.trim() ? { actorLastMessageTail: sanitizeRemoteLog(parsed.actorLastMessageTail) } : {}),
      ...(typeof parsed.actorPid === "number" && Number.isFinite(parsed.actorPid) ? { actorPid: parsed.actorPid } : {}),
      ...(actorStatus ? { actorStatus } : {}),
      ...(typeof parsed.appLogPath === "string" && parsed.appLogPath.trim() ? { appLogPath: sanitizeRemoteLog(parsed.appLogPath) } : {}),
      ...(typeof parsed.appPid === "number" && Number.isFinite(parsed.appPid) ? { appPid: parsed.appPid } : {}),
      ...(typeof parsed.appReason === "string" && parsed.appReason.trim() ? { appReason: sanitizeRemoteLog(parsed.appReason).replace(/\s+/g, " ").slice(0, 240) } : {}),
      ...(appStatus ? { appStatus } : {}),
      ...(typeof parsed.appUrl === "string" && parsed.appUrl.trim() ? { appUrl: sanitizeRemoteLog(parsed.appUrl).replace(/\s+/g, " ").slice(0, 240) } : {}),
      checkedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : new Date().toISOString(),
      ...(typeof parsed.exitCode === "number" ? { exitCode: parsed.exitCode } : {}),
      ...(typeof parsed.logTail === "string" ? { logTail: sanitizeRemoteLog(parsed.logTail) } : {}),
      ...(typeof parsed.nestedObserverPresent === "boolean" ? { nestedObserverPresent: parsed.nestedObserverPresent } : {}),
      ...(nestedVerifyPassed === undefined ? {} : { nestedVerifyPassed }),
      reason: typeof parsed.reason === "string" && parsed.reason.trim()
        ? sanitizeRemoteLog(parsed.reason).replace(/\s+/g, " ").slice(0, 240)
        : defaultReasonForCompletion(status),
      ...(isRunSetupQualitySnapshot(parsed.setupQuality) ? { setupQuality: sanitizeSetupQualitySnapshot(parsed.setupQuality) } : {}),
      status,
      ...(typeof parsed.visualReason === "string" && parsed.visualReason.trim() ? { visualReason: sanitizeRemoteLog(parsed.visualReason).replace(/\s+/g, " ").slice(0, 240) } : {}),
      ...(visualStatus ? { visualStatus } : {}),
      ...(typeof parsed.visualWindowCount === "number" && Number.isFinite(parsed.visualWindowCount) ? { visualWindowCount: parsed.visualWindowCount } : {})
    };
  } catch {
    return null;
  }
}

function normalizeAppStatus(value: unknown): OssMetaLabAppStatus | null {
  return value === "not_started"
    || value === "running"
    || value === "blocked"
    || value === "failed"
    || value === "missing"
    || value === "unknown"
    ? value
    : null;
}

function normalizeVisualStatus(value: unknown): OssMetaLabVisualStatus | null {
  return value === "not_started"
    || value === "visible"
    || value === "blocked"
    || value === "unknown"
    ? value
    : null;
}

function normalizeActorStatus(value: unknown): OssMetaLabActorStatus | null {
  return value === "not_started"
    || value === "running"
    || value === "passed"
    || value === "failed"
    || value === "blocked"
    || value === "timed_out"
    || value === "suspended"
    || value === "unknown"
    ? value
    : null;
}

function normalizeCompletionStatus(value: unknown): OssMetaLabCompletionStatus | null {
  return value === "running"
    || value === "passed"
    || value === "failed"
    || value === "blocked"
    || value === "timed_out"
    ? value
    : null;
}

function defaultReasonForCompletion(status: OssMetaLabCompletionStatus): string {
  switch (status) {
    case "passed":
      return "Remote bootstrap completed successfully.";
    case "failed":
      return "Remote bootstrap failed.";
    case "blocked":
      return "Remote bootstrap is blocked.";
    case "timed_out":
      return "Remote bootstrap completion timed out.";
    case "running":
      return "Remote bootstrap is still running.";
  }
}

function isRunSetupQualitySnapshot(value: unknown): value is RunSetupQualitySnapshot {
  if (!isRecord(value) || value.schema !== "mimetic.setup-quality.v1") {
    return false;
  }

  return Array.isArray(value.checks)
    && Array.isArray(value.tree)
    && Array.isArray(value.previews)
    && isRecord(value.mimetic)
    && isRecord(value.packageScripts)
    && typeof value.generatedAt === "string"
    && typeof value.summary === "string"
    && (value.status === "passed" || value.status === "needs_review" || value.status === "blocked");
}

function sanitizeSetupQualitySnapshot(snapshot: RunSetupQualitySnapshot): RunSetupQualitySnapshot {
  const safeTree = snapshot.tree
    .filter((entry) => isSafeRepoRelativePath(entry.path) && (entry.type === "file" || entry.type === "directory"))
    .slice(0, 240)
    .map((entry) => ({
      path: sanitizeSetupQualityPath(entry.path),
      type: entry.type,
      ...(typeof entry.sizeBytes === "number" && Number.isFinite(entry.sizeBytes) ? { sizeBytes: Math.max(0, Math.round(entry.sizeBytes)) } : {})
    }));
  const safePreviews = snapshot.previews
    .filter((preview) => isSafeRepoRelativePath(preview.path))
    .slice(0, 20)
    .map((preview) => ({
      path: sanitizeSetupQualityPath(preview.path),
      language: sanitizePreviewLanguage(preview.language),
      truncated: preview.truncated === true,
      text: sanitizeSetupQualityText(preview.text).slice(0, 8_000)
    }));
  const safeScripts: Record<string, string> = {};
  for (const [key, value] of Object.entries(snapshot.packageScripts)) {
    const safeKey = sanitizeSetupQualityText(key).replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 80);
    if (!safeKey || typeof value !== "string") {
      continue;
    }
    safeScripts[safeKey] = sanitizeSetupQualityText(value).slice(0, 300);
  }

  return {
    schema: "mimetic.setup-quality.v1",
    generatedAt: sanitizeSetupQualityText(snapshot.generatedAt).slice(0, 80) || new Date().toISOString(),
    redaction: {
      status: "passed",
      rawPreviews: snapshot.redaction?.rawPreviews === "suppressed" ? "suppressed" : "included",
      notes: sanitizeSetupQualityText(snapshot.redaction?.notes ?? "Remote setup snapshot was redacted before persistence.").slice(0, 240)
    },
    summary: sanitizeSetupQualityText(snapshot.summary).slice(0, 320),
    status: snapshot.status,
    checks: snapshot.checks
      .filter((check) => isRecord(check) && typeof check.id === "string" && typeof check.label === "string" && typeof check.detail === "string")
      .slice(0, 40)
      .map((check) => ({
        id: sanitizeSetupQualityText(check.id).replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 80) || "check",
        label: sanitizeSetupQualityText(check.label).slice(0, 140),
        ok: check.ok === true,
        detail: sanitizeSetupQualityText(check.detail).slice(0, 320)
      })),
    tree: safeTree,
    previews: safePreviews,
    packageScripts: safeScripts,
    mimetic: {
      configPresent: snapshot.mimetic.configPresent === true,
      personaCount: typeof snapshot.mimetic.personaCount === "number" && Number.isFinite(snapshot.mimetic.personaCount) ? Math.max(0, Math.round(snapshot.mimetic.personaCount)) : 0,
      scenarioCount: typeof snapshot.mimetic.scenarioCount === "number" && Number.isFinite(snapshot.mimetic.scenarioCount) ? Math.max(0, Math.round(snapshot.mimetic.scenarioCount)) : 0,
      packageScriptPresent: snapshot.mimetic.packageScriptPresent === true,
      gitignoreContainsRuntimeIgnore: snapshot.mimetic.gitignoreContainsRuntimeIgnore === true
    }
  };
}

function sanitizePreviewLanguage(value: unknown): RunSetupQualitySnapshot["previews"][number]["language"] {
  return value === "json" || value === "yaml" || value === "typescript" || value === "markdown" || value === "text"
    ? value
    : "text";
}

function sanitizeSetupQualityPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").slice(0, 240);
}

function sanitizeSetupQualityText(value: unknown): string {
  return redactOssRemoteTelemetryText(String(value ?? ""))
    .replace(/\0/g, "")
    .replace(/https?:\/\/[^/\s]*e2b[^)\s]+/gi, "[redacted-e2b-url]")
    .trim();
}

function isSafeRepoRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  return !path.isAbsolute(normalized)
    && !normalized.includes("://")
    && !normalized.startsWith("../")
    && !normalized.split("/").includes("..")
    && !normalized.split("/").some((segment) => /^(?:\.env(?:\..*)?|\.npmrc|\.git|node_modules|dist|build|\.next)$/.test(segment));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeRemoteLog(value: string): string {
  return redactOssRemoteTelemetryText(value)
    .split(/\r?\n/)
    .slice(-80)
    .join("\n")
    .trim();
}

async function loadE2BDesktopModule(): Promise<E2BDesktopModule> {
  try {
    return await import("@e2b/desktop") as unknown as E2BDesktopModule;
  } catch (error) {
    if (isMissingE2BDesktopDependency(error)) {
      throw new Error(
        "Live E2B desktop launch requires optional peer dependency @e2b/desktop. Install it in this project with `npm i -D @e2b/desktop`, or run `mimetic lab run oss --dry-run`."
      );
    }

    throw error;
  }
}

function isMissingE2BDesktopDependency(error: unknown): boolean {
  const value = error as { code?: string; message?: string };
  return value.code === "ERR_MODULE_NOT_FOUND" && value.message?.includes("@e2b/desktop") === true;
}

async function startOssBootstrap(
  desktop: E2BDesktopSandbox,
  assignment: OssMetaLabAssignment,
  localPackage: OssMetaLabLocalPackage | undefined,
  requestTimeoutMs: number,
  display: { hostActorPlanResult?: OssMetaLabHostActorPlanResult; repoLabel: string; token: string } = {
    repoLabel: assignment.repo,
    token: repoSlugToken(assignment.repo)
  }
): Promise<OssMetaLabBootstrap> {
  const token = display.token;
  const rootDir = `/home/user/mimetic-oss-lab/${token}`;
  const remotePackagePath = `/tmp/${localPackage?.fileName ?? "mimetic-cli.tgz"}`;
  const remoteHostActorPlanPath = `${rootDir}/host-actor-plan.json`;
  const bootstrapPath = `${rootDir}/bootstrap.sh`;
  const launcherPath = `${rootDir}/launch-terminal.sh`;
  const logPath = `${rootDir}/bootstrap.log`;
  const completionPath = `${rootDir}/completion.json`;
  const nestedObserverPath = `${rootDir}/repo/.mimetic/runs/nested-${token}/observer/index.html`;
  const title = `Mimetic ${assignment.index} ${display.repoLabel}`;
  const baseTail = [
    `repo: ${display.repoLabel}`,
    `sandbox: ${desktop.sandboxId}`,
    `remote package: ${localPackage ? remotePackagePath : "npm:mimetic-cli fallback"}`,
    `bootstrap: ${bootstrapPath}`,
    `completion: ${completionPath}`,
    `log: ${logPath}`,
    `nested observer: ${nestedObserverPath}`
  ].join("\n");

  try {
    await runDesktopCommand(desktop, `mkdir -p ${shellQuote(rootDir)}`, {
      requestTimeoutMs,
      timeoutMs: 30_000
    });

    if (localPackage) {
      const packageBytes = await readFile(localPackage.path);
      await desktop.files.write(remotePackagePath, toArrayBuffer(packageBytes), {
        requestTimeoutMs,
        useOctetStream: true
      });
    }
    if (display.hostActorPlanResult?.plan) {
      await desktop.files.write(remoteHostActorPlanPath, `${JSON.stringify(display.hostActorPlanResult.plan, null, 2)}\n`, {
        requestTimeoutMs
      });
    }

    const bootstrapScript = buildRemoteBootstrapScript({
      assignment,
      completionPath,
      displayRepo: display.repoLabel,
      logPath,
      nestedObserverPath,
      ...(display.hostActorPlanResult?.plan ? { remoteHostActorPlanPath } : {}),
      rootDir,
      token,
      ...(localPackage ? { remotePackagePath } : {})
    });
    const launcherScript = buildRemoteLauncherScript({
      bootstrapPath,
      launcherPath,
      logPath,
      title
    });

    await desktop.files.write(bootstrapPath, bootstrapScript, { requestTimeoutMs });
    await desktop.files.write(launcherPath, launcherScript, { requestTimeoutMs });
    await runDesktopCommand(desktop, `chmod +x ${shellQuote(bootstrapPath)} ${shellQuote(launcherPath)}`, {
      requestTimeoutMs,
      timeoutMs: 30_000
    });
    await runDesktopCommand(desktop, `bash ${shellQuote(launcherPath)}`, {
      requestTimeoutMs,
      timeoutMs: 30_000
    });
    await desktop.wait(1200).catch(() => undefined);
    await runDesktopCommand(desktop, buildRemoteFocusCommand(title), {
      requestTimeoutMs,
      timeoutMs: 10_000
    }).catch(() => undefined);

    return {
      codexMode: "tui-attempted",
      completionPath,
      launcherPath,
      logPath,
      mimeticPackageUploaded: Boolean(localPackage),
      nestedObserverPath,
      status: "started",
      tail: [
        "Visible E2B bootstrap terminal launched.",
        "The terminal clones the authorized repo, installs this local mimetic-cli package tarball when available, runs nested Mimetic proof commands, attempts Codex TUI, then opens the nested Observer in Chrome.",
        baseTail
      ].join("\n"),
      terminalTitle: title
    };
  } catch (error) {
    return {
      codexMode: "tui-attempted",
      completionPath,
      launcherPath,
      logPath,
      mimeticPackageUploaded: Boolean(localPackage),
      nestedObserverPath,
      status: "failed",
      tail: [
        "Bootstrap launcher failed before the remote terminal could start.",
        baseTail,
        `error: ${compactError(error)}`
      ].join("\n"),
      terminalTitle: title
    };
  }
}

function buildRemoteBootstrapScript(args: {
  assignment: OssMetaLabAssignment;
  completionPath: string;
  displayRepo: string;
  logPath: string;
  nestedObserverPath: string;
  remoteHostActorPlanPath?: string;
  remotePackagePath?: string;
  rootDir: string;
  token: string;
}): string {
  const repoUrl = `https://github.com/${args.assignment.repo}.git`;
  const runId = `nested-${args.token}`;
  return `#!/usr/bin/env bash
set -Eeuo pipefail
export TERM=xterm-256color
export MIMETIC_PUBLIC_SAFE=1
MIMETIC_PRIVATE_CODEX_API_KEY="\${MIMETIC_CODEX_API_KEY:-}"
MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN="\${MIMETIC_CODEX_ACCESS_TOKEN:-}"
MIMETIC_PRIVATE_GITHUB_TOKEN="\${MIMETIC_GITHUB_TOKEN:-}"
unset MIMETIC_CODEX_API_KEY MIMETIC_CODEX_ACCESS_TOKEN MIMETIC_GITHUB_TOKEN
unset OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN E2B_API_KEY GH_TOKEN GITHUB_TOKEN
ROOT_DIR=${shellQuote(args.rootDir)}
APP_DIR="$ROOT_DIR/repo"
LOG_PATH=${shellQuote(args.logPath)}
COMPLETION_PATH=${shellQuote(args.completionPath)}
NESTED_OBSERVER=${shellQuote(args.nestedObserverPath)}
REMOTE_PACKAGE=${args.remotePackagePath ? shellQuote(args.remotePackagePath) : "''"}
HOST_ACTOR_PLAN=${args.remoteHostActorPlanPath ? shellQuote(args.remoteHostActorPlanPath) : "''"}
APP_LOG_PATH="$ROOT_DIR/app.log"
ACTOR_LOG_PATH="$ROOT_DIR/actor.log"
ACTOR_LAST_MESSAGE_PATH="$ROOT_DIR/actor-last-message.txt"
TERMINAL_TITLE=${shellQuote(`Mimetic ${args.assignment.index} ${args.displayRepo}`)}
mkdir -p "$ROOT_DIR"
touch "$LOG_PATH"
exec > >(tee -a "$LOG_PATH") 2>&1
NESTED_VERIFY_STATUS=not_run
APP_STATUS=not_started
APP_REASON="Target app startup has not started."
APP_URL=""
APP_PID=""
ACTOR_STATUS=not_started
ACTOR_PID=""
VISUAL_STATUS=not_started
VISUAL_REASON="Browser windows have not been arranged."
VISUAL_WINDOW_COUNT=0

write_completion() {
  local status="$1"
  local reason="$2"
  local exit_code="$3"
  local nested_observer_present=false
  if [[ -f "$NESTED_OBSERVER" ]]; then
    nested_observer_present=true
  fi

  node - "$COMPLETION_PATH" "$LOG_PATH" "$APP_DIR" "$status" "$reason" "$exit_code" "$nested_observer_present" "$NESTED_VERIFY_STATUS" "$APP_STATUS" "$APP_REASON" "$APP_URL" "$APP_PID" "$APP_LOG_PATH" "$ACTOR_STATUS" "$ACTOR_PID" "$ACTOR_LOG_PATH" "$ACTOR_LAST_MESSAGE_PATH" "$VISUAL_STATUS" "$VISUAL_REASON" "$VISUAL_WINDOW_COUNT" <<'NODE' || true
const fs = require("node:fs");
const path = require("node:path");
const [
  completionPath,
  logPath,
  appDir,
  status,
  reason,
  exitCode,
  nestedObserverPresent,
  nestedVerifyStatus,
  appStatus,
  appReason,
  appUrl,
  appPid,
  appLogPath,
  actorStatus,
  actorPid,
  actorLogPath,
  actorLastMessagePath,
  visualStatus,
  visualReason,
  visualWindowCount
] = process.argv.slice(2);
const tailFile = (filePath, lines = 80) => fs.existsSync(filePath)
  ? fs.readFileSync(filePath, "utf8").split(/\\r?\\n/).slice(-lines).join("\\n")
  : "";
const redactText = (value) => String(value || "")
  .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[redacted-openai-key]")
  .replace(/e2b_[A-Za-z0-9_-]{12,}/g, "[redacted-e2b-key]")
  .replace(/(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})/g, "[redacted-github-token]")
  .replace(/\\bBearer\\s+[A-Za-z0-9._~+/=-]{12,}\\b/gi, "Bearer [redacted-token]")
  .replace(/https?:\\/\\/[^/\\s]*e2b[^)\\s]+/gi, "[redacted-e2b-url]");
const redactedTail = redactText(tailFile(logPath, 80));
const actorLogTail = redactText(tailFile(actorLogPath, 80));
const actorLastMessageTail = redactText(tailFile(actorLastMessagePath, 40));
const numberOrNull = (value) => /^\\d+$/.test(String(value || "")) ? Number(value) : null;
const cleanText = (value) => redactText(value)
  .replace(/\\s+/g, " ")
  .trim()
  .slice(0, 240);
const safeRel = (value) => {
  const normalized = String(value || "").replace(/\\\\/g, "/").replace(/^\\.\\/+/, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("://") || normalized.split("/").includes("..")) return "";
  return normalized;
};
const languageFor = (rel) => {
  if (rel.endsWith(".json")) return "json";
  if (rel.endsWith(".yaml") || rel.endsWith(".yml")) return "yaml";
  if (rel.endsWith(".ts") || rel.endsWith(".tsx")) return "typescript";
  if (rel.endsWith(".md") || rel.endsWith(".markdown")) return "markdown";
  return "text";
};
const shouldPreview = (rel) => rel === "package.json"
  || rel === ".gitignore"
  || rel === "mimetic/config.ts"
  || rel === "mimetic/coverage-map.md"
  || rel === "mimetic/coverage-matrix.md"
  || rel.startsWith("mimetic/personas/")
  || rel.startsWith("mimetic/scenarios/");
const ignoredSegments = new Set([".git", "node_modules", ".mimetic", "dist", "build", ".next", "coverage", ".turbo", ".cache"]);
const readTextLimited = (filePath, maxBytes = 12000) => {
  try {
    const buffer = fs.readFileSync(filePath);
    return redactText(buffer.slice(0, maxBytes).toString("utf8")).replace(/\\0/g, "");
  } catch {
    return "";
  }
};
const countFilesUnder = (root, prefix) => {
  try {
    return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
};
const buildSetupQuality = (root) => {
  const tree = [];
  const previews = [];
  const walk = (dir, depth) => {
    if (depth > 4 || tree.length >= 240) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (tree.length >= 240) break;
      if (ignoredSegments.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const rel = safeRel(path.relative(root, absolute));
      if (!rel) continue;
      if (entry.isDirectory()) {
        tree.push({ path: rel, type: "directory" });
        walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = fs.statSync(absolute);
      tree.push({ path: rel, type: "file", sizeBytes: stats.size });
      if (shouldPreview(rel) && previews.length < 20) {
        const text = readTextLimited(absolute);
        previews.push({ path: rel, language: languageFor(rel), truncated: stats.size > 12000 || text.length >= 8000, text: text.slice(0, 8000) });
      }
    }
  };
  const packageJsonPath = path.join(root, "package.json");
  let packageScripts = {};
  if (fs.existsSync(packageJsonPath)) {
    try {
      const parsedPackage = JSON.parse(readTextLimited(packageJsonPath, 20000));
      if (parsedPackage && typeof parsedPackage.scripts === "object" && parsedPackage.scripts) {
        packageScripts = Object.fromEntries(Object.entries(parsedPackage.scripts).filter(([, value]) => typeof value === "string"));
      }
    } catch {}
  }
  walk(root, 0);
  const gitignore = readTextLimited(path.join(root, ".gitignore"), 20000);
  const configPresent = fs.existsSync(path.join(root, "mimetic", "config.ts"));
  const personaCount = countFilesUnder(root, path.join("mimetic", "personas"));
  const scenarioCount = countFilesUnder(root, path.join("mimetic", "scenarios"));
  const packageScriptPresent = Object.entries(packageScripts).some(([key, value]) => key.includes("mimetic") || String(value).includes("mimetic"));
  const gitignoreContainsRuntimeIgnore = /(^|\\n)\\s*\\.mimetic\\/?\\s*(\\n|$)/.test(gitignore);
  const checks = [
    { id: "mimetic-config", label: "Mimetic config", ok: configPresent, detail: configPresent ? "mimetic/config.ts exists." : "mimetic/config.ts was not created." },
    { id: "personas", label: "Personas", ok: personaCount > 0, detail: personaCount + " persona file(s) detected." },
    { id: "scenarios", label: "Scenarios", ok: scenarioCount > 0, detail: scenarioCount + " scenario file(s) detected." },
    { id: "package-script", label: "Package script", ok: packageScriptPresent, detail: packageScriptPresent ? "package.json exposes a Mimetic script." : "package.json does not expose a Mimetic script." },
    { id: "runtime-ignore", label: "Runtime ignore", ok: gitignoreContainsRuntimeIgnore, detail: gitignoreContainsRuntimeIgnore ? ".gitignore ignores .mimetic/." : ".gitignore does not ignore .mimetic/." }
  ];
  const failed = checks.filter((check) => !check.ok);
  return {
    schema: "mimetic.setup-quality.v1",
    generatedAt: new Date().toISOString(),
    redaction: {
      status: "passed",
      rawPreviews: "included",
      notes: "Only allowlisted setup files are previewed; generated state, browser profiles, secrets, .git, node_modules, and .mimetic are excluded."
    },
    summary: failed.length === 0 ? "Mimetic setup evidence looks complete." : failed.length + " setup-quality gap(s) need review.",
    status: failed.length === 0 ? "passed" : "needs_review",
    checks,
    tree,
    previews,
    packageScripts,
    mimetic: { configPresent, personaCount, scenarioCount, packageScriptPresent, gitignoreContainsRuntimeIgnore }
  };
};
const setupQuality = buildSetupQuality(appDir);
fs.writeFileSync(completionPath, JSON.stringify({
  schema: "mimetic.oss-meta-bootstrap-completion.v1",
  status,
  reason,
  exitCode: Number(exitCode),
  appStatus,
  appReason: cleanText(appReason),
  appUrl: cleanText(appUrl),
  appPid: numberOrNull(appPid),
  appLogPath: cleanText(appLogPath),
  actorStatus,
  actorPid: numberOrNull(actorPid),
  actorLogPath: cleanText(actorLogPath),
  actorLogTail,
  actorLastMessageTail,
  nestedObserverPresent: nestedObserverPresent === "true",
  nestedVerifyStatus,
  setupQuality,
  visualStatus,
  visualReason: cleanText(visualReason),
  visualWindowCount: numberOrNull(visualWindowCount),
  logTail: redactedTail,
  completedAt: new Date().toISOString()
}, null, 2) + "\\n");
NODE
}

finish() {
  local exit_code="$?"
  trap - EXIT
  if [[ "$exit_code" -ne 0 ]]; then
    write_completion "failed" "Bootstrap exited before nested Mimetic proof completed." "$exit_code"
  elif [[ "$NESTED_VERIFY_STATUS" != "passed" ]]; then
    write_completion "failed" "Nested Mimetic verification did not pass." "$exit_code"
  elif [[ "$APP_STATUS" != "running" ]]; then
    write_completion "blocked" "Nested Mimetic proof completed, but the target app surface was not proven running." "$exit_code"
  elif [[ "$VISUAL_STATUS" != "visible" ]]; then
    write_completion "blocked" "Nested Mimetic proof completed, but headed desktop visual layout was not proven visible." "$exit_code"
  elif [[ "\${MIMETIC_OSS_META_REQUIRE_ACTOR:-0}" == "1" && "$ACTOR_STATUS" != "passed" ]]; then
    write_completion "blocked" "Required Codex actor evidence did not reach a passed terminal status." "$exit_code"
  else
    write_completion "passed" "Target app surface, nested Mimetic proof, and nested Observer were checked." "$exit_code"
  fi
  exit "$exit_code"
}
trap finish EXIT

echo "== mimetic oss meta-lab bootstrap =="
echo "repo=${args.displayRepo}"
echo "public_safe=1"
echo "provider_secrets=isolated"
echo "github_token=$([[ -n "$MIMETIC_PRIVATE_GITHUB_TOKEN" ]] && echo available-for-clone || echo absent)"
echo "codex_actor_auth=$([[ -n "$MIMETIC_PRIVATE_CODEX_API_KEY$MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN" ]] && echo available-for-actor || echo absent)"
echo "host_actor_plan=$([[ -f "$HOST_ACTOR_PLAN" ]] && echo available || echo absent)"
echo

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing command: $1"
    return 1
  fi
}

ensure_node() {
  local major=0
  if command -v node >/dev/null 2>&1; then
    major="$(node -e 'console.log(Number(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
  fi

  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && [[ "$major" -ge 20 ]]; then
    return 0
  fi

  echo "node_or_npm=missing_or_too_old"
  if command -v apt-get >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
    echo "installing nodejs/npm via nodesource"
    sudo -n apt-get update
    sudo -n apt-get install -y ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo -n apt-get install -y nodejs
  fi
}

need git
ensure_node
need node
need npm

wait_for_http() {
  local url="$1"
  local timeout_ms="$2"
  local interval_ms="$3"
  node - "$url" "$timeout_ms" "$interval_ms" <<'NODE'
const [url, timeoutArg, intervalArg] = process.argv.slice(2);
const timeoutMs = Number(timeoutArg);
const intervalMs = Number(intervalArg);
const startedAt = Date.now();

async function probe() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(intervalMs, 5_000));
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

while (Date.now() - startedAt <= timeoutMs) {
  if (await probe()) process.exit(0);
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
process.exit(1);
NODE
}

wait_for_any_http() {
  local timeout_ms="$1"
  local interval_ms="$2"
  shift 2
  node - "$timeout_ms" "$interval_ms" "$@" <<'NODE'
const [timeoutArg, intervalArg, ...urls] = process.argv.slice(2);
const timeoutMs = Number(timeoutArg);
const intervalMs = Number(intervalArg);
const startedAt = Date.now();

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(intervalMs, 5_000));
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

while (Date.now() - startedAt <= timeoutMs) {
  for (const url of urls) {
    if (await probe(url)) {
      console.log(url);
      process.exit(0);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
process.exit(1);
NODE
}

open_browser_url() {
  local url="$1"
  local profile="$2"
  local x="$3"
  local y="$4"
  local width="$5"
  local height="$6"
  if command -v google-chrome >/dev/null 2>&1; then
    nohup google-chrome --new-window --no-first-run --no-default-browser-check --disable-default-apps --user-data-dir="$ROOT_DIR/chrome-$profile" --window-position="$x,$y" --window-size="$width,$height" "$url" >/dev/null 2>&1 &
  elif command -v firefox >/dev/null 2>&1; then
    nohup firefox --width "$width" --height "$height" "$url" >/dev/null 2>&1 &
  else
    echo "browser_open=skipped profile=$profile url=$url"
  fi
}

open_nested_observer() {
  local label="$1"
  echo
  echo "== $label =="
  if [[ -f "$NESTED_OBSERVER" ]]; then
    open_browser_url "file://$NESTED_OBSERVER" nested-observer 760 0 680 940
  else
    echo "Nested observer missing: $NESTED_OBSERVER"
  fi
}

arrange_lab_windows() {
  echo
  echo "== visual desktop layout =="
  VISUAL_STATUS=unknown
  VISUAL_REASON="Window manager proof was not collected."
  VISUAL_WINDOW_COUNT=0
  if ! command -v xdotool >/dev/null 2>&1; then
    VISUAL_STATUS=unknown
    VISUAL_REASON="xdotool is unavailable; cannot prove headed browser window visibility."
    echo "visual_status=$VISUAL_STATUS reason=$VISUAL_REASON"
    return 0
  fi

  local chrome_windows=()
  local observer_window=""
  for attempt in $(seq 1 40); do
    mapfile -t chrome_windows < <(xdotool search --onlyvisible --class google-chrome 2>/dev/null || true)
    observer_window="$(xdotool search --onlyvisible --name "Mimetic Observer" 2>/dev/null | tail -n 1 || true)"
    VISUAL_WINDOW_COUNT="\${#chrome_windows[@]}"
    if [[ "$VISUAL_WINDOW_COUNT" -ge 2 && -n "$observer_window" ]]; then
      break
    fi
    sleep 0.25
  done

  if [[ -n "$observer_window" ]]; then
    xdotool windowsize "$observer_window" 680 933 >/dev/null 2>&1 || true
    xdotool windowmove "$observer_window" 760 27 >/dev/null 2>&1 || true
  fi

  local slot=0
  local win
  for win in "\${chrome_windows[@]}"; do
    if [[ -n "$observer_window" && "$win" == "$observer_window" ]]; then
      continue
    fi
    if [[ "$slot" -eq 0 ]]; then
      xdotool windowsize "$win" 760 493 >/dev/null 2>&1 || true
      xdotool windowmove "$win" 0 27 >/dev/null 2>&1 || true
    elif [[ "$slot" -eq 1 ]]; then
      xdotool windowsize "$win" 430 420 >/dev/null 2>&1 || true
      xdotool windowmove "$win" 0 520 >/dev/null 2>&1 || true
    else
      xdotool windowsize "$win" 330 420 >/dev/null 2>&1 || true
      xdotool windowmove "$win" 430 520 >/dev/null 2>&1 || true
    fi
    slot=$((slot + 1))
  done

  local terminal_window
  terminal_window="$(xdotool search --onlyvisible --name "$TERMINAL_TITLE" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$terminal_window" ]]; then
    xdotool windowlower "$terminal_window" >/dev/null 2>&1 || xdotool windowminimize "$terminal_window" >/dev/null 2>&1 || true
  fi
  if [[ -n "$observer_window" ]]; then
    xdotool windowactivate "$observer_window" >/dev/null 2>&1 || true
  fi

  mapfile -t chrome_windows < <(xdotool search --onlyvisible --class google-chrome 2>/dev/null || true)
  VISUAL_WINDOW_COUNT="\${#chrome_windows[@]}"
  if [[ "$VISUAL_WINDOW_COUNT" -ge 2 && -n "$observer_window" ]]; then
    VISUAL_STATUS=visible
    VISUAL_REASON="Detected $VISUAL_WINDOW_COUNT visible Chrome windows including nested Observer; app and Observer windows arranged for screenshot."
  else
    VISUAL_STATUS=blocked
    VISUAL_REASON="Expected app and nested Observer browser windows, detected $VISUAL_WINDOW_COUNT visible Chrome window(s)."
  fi
  echo "visual_status=$VISUAL_STATUS window_count=$VISUAL_WINDOW_COUNT reason=$VISUAL_REASON"
}

detect_app_plan() {
  node <<'NODE'
const fs = require("node:fs");
const shell = (value) => "'" + String(value).replace(/'/g, "'\\"'\\"'") + "'";
const emit = (key, value) => console.log(key + "=" + shell(value));

if (!fs.existsSync("package.json")) {
  console.log("APP_PLAN_OK='0'");
  emit("APP_PM", "npm");
  emit("APP_PLAN_REASON", "package.json not found");
  process.exit(0);
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
} catch {
  console.log("APP_PLAN_OK='0'");
  emit("APP_PM", "npm");
  emit("APP_PLAN_REASON", "package.json could not be parsed");
  process.exit(0);
}

const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const lockfiles = fs.readdirSync(".").filter((name) => /^(pnpm-lock\\.yaml|yarn\\.lock|bun\\.lockb?|package-lock\\.json|npm-shrinkwrap\\.json)$/.test(name));
const packageManagerHint = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
let pm = "npm";
if (packageManagerHint.startsWith("pnpm@") || lockfiles.includes("pnpm-lock.yaml")) pm = "pnpm";
else if (packageManagerHint.startsWith("yarn@") || lockfiles.includes("yarn.lock")) pm = "yarn";
else if (packageManagerHint.startsWith("bun@") || lockfiles.includes("bun.lock") || lockfiles.includes("bun.lockb")) pm = "bun";

const names = ["dev", "start", "serve", "preview"];
const entries = names
  .map((name) => ({ name, command: typeof scripts[name] === "string" ? scripts[name].trim() : "" }))
  .filter((entry) => entry.command && /^[A-Za-z0-9:_-]+$/.test(entry.name));

if (!entries.length) {
  console.log("APP_PLAN_OK='0'");
  emit("APP_PM", pm);
  emit("APP_PLAN_REASON", "no dev/start/serve/preview script found");
  process.exit(0);
}

const pickByCommand = (pattern) => entries.find((entry) => pattern.test(entry.command));
let picked = null;
let framework = "generic";
if ((picked = pickByCommand(/\\bnext\\s+(dev|start)\\b/)) || deps.next) framework = "next";
if (!picked && (picked = pickByCommand(/\\bvite(\\s|$)/))) framework = "vite";
if (!picked && deps.vite) { picked = entries.find((entry) => entry.name === "dev") || entries[0]; framework = "vite"; }
if (!picked && deps.next) picked = entries.find((entry) => entry.name === "dev" || entry.name === "start") || entries[0];
if (!picked && (picked = pickByCommand(/\\bastro\\s+dev\\b/))) framework = "vite";
if (!picked) picked = entries.find((entry) => entry.name === "dev") || entries.find((entry) => entry.name === "start") || entries[0];

const command = picked.command;
const portFromCommand = /(?:^|\\s)(?:--port|-p)\\s+([0-9]{2,5})(?:\\s|$)/.exec(command)?.[1]
  || /(?:^|\\s)PORT=([0-9]{2,5})(?:\\s|$)/.exec(command)?.[1];
const defaultPort = framework === "vite" ? "5173" : "3000";

console.log("APP_PLAN_OK='1'");
emit("APP_PM", pm);
emit("APP_SCRIPT", picked.name);
emit("APP_FRAMEWORK", framework);
emit("APP_PORT", portFromCommand || defaultPort);
emit("APP_PLAN_REASON", "selected " + picked.name + " script for " + framework + " app startup");
NODE
}

ensure_package_manager() {
  local pm="$1"
  mkdir -p "$ROOT_DIR/npm-global"
  export NPM_CONFIG_PREFIX="$ROOT_DIR/npm-global"
  export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
  if command -v "$pm" >/dev/null 2>&1; then
    return 0
  fi
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    if [[ "$pm" == "pnpm" ]]; then
      corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
    elif [[ "$pm" == "yarn" ]]; then
      corepack prepare yarn@stable --activate >/dev/null 2>&1 || true
    fi
  fi
  if command -v "$pm" >/dev/null 2>&1; then
    return 0
  fi
  case "$pm" in
    pnpm) npm i -g pnpm --no-audit --no-fund --prefix "$NPM_CONFIG_PREFIX" ;;
    yarn) npm i -g yarn --no-audit --no-fund --prefix "$NPM_CONFIG_PREFIX" ;;
    bun) npm i -g bun --no-audit --no-fund --prefix "$NPM_CONFIG_PREFIX" ;;
    npm) command -v npm >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

install_project_dependencies() {
  local pm="$1"
  if [[ "$pm" == "pnpm" ]]; then
    pnpm config set verify-deps-before-run false --location project >/dev/null 2>&1 || true
    pnpm config set dangerously-allow-all-builds true --location project >/dev/null 2>&1 || true
  fi
  if [[ -d node_modules ]]; then
    echo "dependencies=present"
    return 0
  fi
  echo "dependencies=installing manager=$pm"
  case "$pm" in
    pnpm)
      echo "pnpm_build_scripts=allowed disposable_e2b_lab=1"
      if [[ -f pnpm-lock.yaml ]]; then pnpm install --frozen-lockfile --dangerously-allow-all-builds || pnpm install --dangerously-allow-all-builds; else pnpm install --dangerously-allow-all-builds; fi
      ;;
    yarn)
      if [[ -f yarn.lock ]]; then yarn install --frozen-lockfile --ignore-scripts || yarn install --ignore-scripts; else yarn install --ignore-scripts; fi
      ;;
    bun)
      bun install
      ;;
    npm)
      if [[ -f package-lock.json || -f npm-shrinkwrap.json ]]; then npm ci --ignore-scripts --no-audit --no-fund || npm install --ignore-scripts --no-audit --no-fund; else npm install --ignore-scripts --no-audit --no-fund; fi
      ;;
    *) return 1 ;;
  esac
}

install_mimetic_cli() {
  echo
  echo "== installing mimetic-cli =="
  local plan_output
  plan_output="$(detect_app_plan)"
  eval "$plan_output"
  local pm="\${APP_PM:-npm}"
  if ! ensure_package_manager "$pm"; then
    echo "mimetic_install=blocked package_manager=$pm"
    return 1
  fi
  local spec="mimetic-cli"
  if [[ -n "$REMOTE_PACKAGE" && -f "$REMOTE_PACKAGE" ]]; then
    spec="$REMOTE_PACKAGE"
  fi

  case "$pm" in
    pnpm)
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false npm_config_verify_deps_before_run=false pnpm add -D "$spec" --ignore-scripts
      ;;
    yarn)
      YARN_ENABLE_SCRIPTS=0 yarn add -D "$spec"
      ;;
    bun)
      bun add -d "$spec"
      ;;
    npm)
      npm i -D "$spec" --ignore-scripts --no-audit --no-fund
      ;;
    *)
      return 1
      ;;
  esac
}

apply_host_actor_plan() {
  if [[ "\${MIMETIC_OSS_META_HOST_CODEX_ACTOR:-0}" != "1" ]]; then
    return 0
  fi

  echo
  echo "== host codex actor plan =="
  if [[ ! -f "$HOST_ACTOR_PLAN" ]]; then
    ACTOR_STATUS=blocked
    echo "host_actor_plan=missing"
    return 1
  fi

  node - "$HOST_ACTOR_PLAN" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [planPath] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
if (plan.schema !== "mimetic.oss-host-actor-plan.v1" || plan.status !== "passed") {
  throw new Error("host actor plan is not passed");
}
const clean = (value, fallback) => String(value || fallback)
  .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted-openai-key]")
  .replace(/e2b_[A-Za-z0-9_-]{12,}/g, "[redacted-e2b-key]")
  .replace(/gh[pousr]_[A-Za-z0-9_]{12,}/g, "[redacted-github-token]")
  .replace(/\\s+/g, " ")
  .trim()
  .slice(0, 300);
const token = (value, fallback) => clean(value, fallback).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
const yamlScalar = (value) => clean(value, "").replace(/"/g, "\\\\\"");
const yamlList = (values) => (Array.isArray(values) && values.length ? values : ["public_safe"]).map((value) => "  - " + yamlScalar(value)).join("\\n");
fs.mkdirSync("mimetic/personas", { recursive: true });
fs.mkdirSync("mimetic/scenarios", { recursive: true });
const personas = Array.isArray(plan.personas) ? plan.personas.slice(0, 2) : [];
const scenarios = Array.isArray(plan.scenarios) ? plan.scenarios.slice(0, 2) : [];
if (!personas.length || !scenarios.length) {
  throw new Error("host actor plan lacks personas or scenarios");
}
for (const persona of personas) {
  const id = token(persona.id, "host-codex-persona");
  fs.writeFileSync(path.join("mimetic/personas", id + ".yaml"), [
    "schema: mimetic.persona.v1",
    "id: " + id,
    "name: " + yamlScalar(persona.name || "Host Codex Persona"),
    "summary: " + yamlScalar(persona.intent || "Public-safe host Codex actor persona."),
    "traits:",
    yamlList(persona.traits),
    "constraints:",
    "  - Do not use real personal data.",
    "  - Do not use production accounts.",
    "  - Treat all credentials as env var names only.",
    "  - Source: local Codex host actor plan applied inside disposable E2B."
  ].join("\\n") + "\\n");
}
for (const scenario of scenarios) {
  const id = token(scenario.id, "host-codex-scenario");
  const personaId = token(personas[0].id, "host-codex-persona");
  fs.writeFileSync(path.join("mimetic/scenarios", id + ".yaml"), [
    "schema: mimetic.scenario.v1",
    "id: " + id,
    "title: " + yamlScalar(scenario.title || "Host Codex Scenario"),
    "persona: " + personaId,
    "goal: " + yamlScalar(scenario.goal || "Exercise the app through a public-safe browser flow."),
    "mode: browser",
    "steps:",
    ...(Array.isArray(scenario.steps) && scenario.steps.length ? scenario.steps : ["Open the app", "Reach a meaningful state"]).slice(0, 8).map((step, index) => [
      "  - name: Step " + String(index + 1),
      "    expectation: " + yamlScalar(step)
    ].join("\\n"))
  ].join("\\n") + "\\n");
}
console.log("host_actor_plan=applied personas=" + personas.length + " scenarios=" + scenarios.length);
console.log("host_actor_recommended_proof=" + clean(plan.recommendedProof, "mimetic run --app-url <loopback-url> --sims 2"));
NODE
  local apply_exit=$?
  if [[ "$apply_exit" -eq 0 ]]; then
    ACTOR_STATUS=blocked
    echo "actor_status=$ACTOR_STATUS source=host-codex-plan reason=remote-actor-not-run"
  else
    ACTOR_STATUS=failed
    echo "actor_status=$ACTOR_STATUS source=host-codex-plan exit=$apply_exit"
  fi
  return "$apply_exit"
}

start_target_app_surface() {
  echo
  echo "== target app surface =="
  local plan_output
  plan_output="$(detect_app_plan)"
  eval "$plan_output"
  if [[ "\${APP_PLAN_OK:-0}" != "1" ]]; then
    APP_STATUS=missing
    APP_REASON="\${APP_PLAN_REASON:-no runnable app script detected}"
    echo "app_status=$APP_STATUS reason=$APP_REASON"
    return 0
  fi

  if ! ensure_package_manager "$APP_PM"; then
    APP_STATUS=blocked
    APP_REASON="package manager $APP_PM is unavailable"
    echo "app_status=$APP_STATUS reason=$APP_REASON"
    return 0
  fi

  if ! install_project_dependencies "$APP_PM"; then
    APP_STATUS=blocked
    APP_REASON="dependency install failed before app startup"
    echo "app_status=$APP_STATUS reason=$APP_REASON"
    return 0
  fi

  local app_url_candidates=("http://localhost:$APP_PORT" "http://127.0.0.1:$APP_PORT" "http://[::1]:$APP_PORT")
  APP_URL="\${app_url_candidates[0]}"
  local start_command
  local command_prefix="HOST=0.0.0.0 PORT=$APP_PORT"
  local script_arg_separator="--"
  if [[ "$APP_PM" == "pnpm" ]]; then
    command_prefix="PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false npm_config_verify_deps_before_run=false $command_prefix"
    script_arg_separator=""
  fi
  case "$APP_FRAMEWORK" in
    next)
      start_command="$command_prefix $APP_PM run $APP_SCRIPT $script_arg_separator --hostname 0.0.0.0 --port $APP_PORT"
      ;;
    vite)
      start_command="$command_prefix $APP_PM run $APP_SCRIPT $script_arg_separator --host 0.0.0.0 --port $APP_PORT"
      ;;
    *)
      start_command="$command_prefix $APP_PM run $APP_SCRIPT"
      ;;
  esac

  echo "app_plan=$APP_PLAN_REASON"
  echo "app_url_candidates=\${app_url_candidates[*]}"
  echo "app_command=$start_command"
  nohup bash -lc "$start_command" > "$APP_LOG_PATH" 2>&1 &
  APP_PID=$!

  local ready_url=""
  if ready_url="$(wait_for_any_http 120000 1000 "\${app_url_candidates[@]}")"; then
    APP_URL="$ready_url"
    APP_STATUS=running
    APP_REASON="target app responded at $APP_URL"
    open_browser_url "$APP_URL" app-desktop 0 0 760 520
    open_browser_url "$APP_URL" app-compact 0 520 430 420
  else
    APP_STATUS=blocked
    APP_REASON="target app did not become HTTP-ready at $APP_URL"
    tail -n 40 "$APP_LOG_PATH" || true
  fi
  echo "app_status=$APP_STATUS reason=$APP_REASON pid=$APP_PID"
}

start_actor_attempt() {
  echo
  echo "== codex actor attempt =="
  local actor_script="$ROOT_DIR/actor-run.sh"
  cat > "$actor_script" <<ACTOR
#!/usr/bin/env bash
set +e
APP_DIR="$APP_DIR"
if [[ "\${MIMETIC_OSS_META_ACTOR_FIRST:-0}" == "1" ]]; then
  PROMPT='You are a Mimetic meta-lab actor running in a disposable public-safe repo clone. Inspect package.json, README, scripts, and the app shape. Install mimetic-cli as a dev dependency with the repo package manager if needed. Run npx mimetic init --yes if Mimetic is not initialized. Start the local app if feasible, then run the strongest Mimetic proof available; prefer npx mimetic run --app-url <loopback-url> --sims 2 when the app is running. Render or open the nested Mimetic Observer if feasible. Once the nested Observer proof is rendered or blocked with evidence, write a concise final summary and exit successfully. Do not wait on long-running watchers after rendering proof. Do not print secrets, do not commit, do not push, and do not file issues.'
else
  PROMPT='You are a Mimetic meta-lab actor. Inspect this repo, inspect the running app and Mimetic artifacts already generated here, and draft the best next public-safe personas and desktop/mobile browser scenarios for human users of this app. Once the draft is written, exit successfully. Do not wait on long-running watchers. Do not print secrets, do not commit, do not push, and do not file issues.'
fi
printf -v app_dir_q '%q' "\\$APP_DIR"
printf -v prompt_q '%q' "\\$PROMPT"
printf -v actor_message_q '%q' "$ACTOR_LAST_MESSAGE_PATH"
ACTOR_MODEL="\${MIMETIC_OSS_META_ACTOR_MODEL:-gpt-5.4-mini}"
ACTOR_TIMEOUT_MS="\${MIMETIC_OSS_META_ACTOR_TIMEOUT_MS:-240000}"
ACTOR_TIMEOUT_SECONDS=\\$(( (ACTOR_TIMEOUT_MS + 999) / 1000 ))
printf -v actor_model_q '%q' "\\$ACTOR_MODEL"
CODEX_COMMAND="npx -y @openai/codex@latest exec --ephemeral --ignore-user-config --skip-git-repo-check -m \\$actor_model_q -C \\$app_dir_q --dangerously-bypass-approvals-and-sandbox --output-last-message \\$actor_message_q \\$prompt_q"
if [[ -n "\${MIMETIC_PRIVATE_CODEX_API_KEY:-}" && -n "\${MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN:-}" ]]; then
  CODEX_API_KEY="\\$MIMETIC_PRIVATE_CODEX_API_KEY" CODEX_ACCESS_TOKEN="\\$MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN" timeout "\\$ACTOR_TIMEOUT_SECONDS" bash -lc "\\$CODEX_COMMAND"
elif [[ -n "\${MIMETIC_PRIVATE_CODEX_API_KEY:-}" ]]; then
  CODEX_API_KEY="\\$MIMETIC_PRIVATE_CODEX_API_KEY" timeout "\\$ACTOR_TIMEOUT_SECONDS" bash -lc "\\$CODEX_COMMAND"
elif [[ -n "\${MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN:-}" ]]; then
  CODEX_ACCESS_TOKEN="\\$MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN" timeout "\\$ACTOR_TIMEOUT_SECONDS" bash -lc "\\$CODEX_COMMAND"
else
  timeout "\\$ACTOR_TIMEOUT_SECONDS" bash -lc "\\$CODEX_COMMAND"
fi
code=\\$?
echo "actor_exit=\\$code"
exit "\\$code"
ACTOR
  chmod +x "$actor_script"
  MIMETIC_PRIVATE_CODEX_API_KEY="$MIMETIC_PRIVATE_CODEX_API_KEY" MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN="$MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN" nohup bash "$actor_script" > "$ACTOR_LOG_PATH" 2>&1 &
  ACTOR_PID=$!
  ACTOR_STATUS=running
  echo "actor_status=$ACTOR_STATUS pid=$ACTOR_PID log=$ACTOR_LOG_PATH"
}

wait_for_actor_attempt_if_required() {
  if [[ "\${MIMETIC_OSS_META_REQUIRE_ACTOR:-0}" != "1" ]]; then
    return 0
  fi

  echo
  echo "== required codex actor readback =="
  if [[ -z "$ACTOR_PID" ]]; then
    ACTOR_STATUS=blocked
    echo "actor_status=$ACTOR_STATUS reason=no actor process was started"
    return 1
  fi

  local timeout_ms="\${MIMETIC_OSS_META_ACTOR_TIMEOUT_MS:-240000}"
  local started_ms
  started_ms="$(date +%s%3N)"
  while kill -0 "$ACTOR_PID" >/dev/null 2>&1; do
    local now_ms
    now_ms="$(date +%s%3N)"
    if [[ $((now_ms - started_ms)) -ge "$timeout_ms" ]]; then
      ACTOR_STATUS=timed_out
      kill "$ACTOR_PID" >/dev/null 2>&1 || true
      echo "actor_status=$ACTOR_STATUS timeout_ms=$timeout_ms log=$ACTOR_LOG_PATH"
      return 1
    fi
    sleep 1
  done

  local actor_exit=0
  wait "$ACTOR_PID" || actor_exit=$?
  if [[ "$actor_exit" -eq 0 ]]; then
    ACTOR_STATUS=passed
  else
    ACTOR_STATUS=failed
  fi
  echo "actor_status=$ACTOR_STATUS exit=$actor_exit log=$ACTOR_LOG_PATH"
  echo "actor_log_tail_begin"
  tail -n 80 "$ACTOR_LOG_PATH" || true
  echo "actor_log_tail_end"
  [[ "$actor_exit" -eq 0 ]]
}

rm -rf "$APP_DIR"
ASKPASS="$ROOT_DIR/git-askpass.sh"
cat > "$ASKPASS" <<'ASKPASS'
#!/usr/bin/env bash
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "\${MIMETIC_GITHUB_TOKEN_RUNTIME:-}" ;;
  *) echo "" ;;
esac
ASKPASS
chmod 700 "$ASKPASS"
GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 MIMETIC_GITHUB_TOKEN_RUNTIME="$MIMETIC_PRIVATE_GITHUB_TOKEN" git clone --depth=1 ${shellQuote(repoUrl)} "$APP_DIR"
cd "$APP_DIR"
echo
echo "== repo fingerprint =="
git rev-parse --short HEAD || true
node --version || true
npm --version || true

echo
echo "== mimetic skill discovery =="
if npx -y skills add danielgwilson/mimetic-cli --skill mimetic-cli --list >/tmp/mimetic-skill-list.txt 2>&1; then
  echo "skill_discovery=listed"
elif npx -y skills add danielgwilson/mimetic-cli --skill mimetic-cli >/tmp/mimetic-skill-install.txt 2>&1; then
  echo "skill_install=attempted"
else
  echo "skill_install=blocked"
  tail -n 20 /tmp/mimetic-skill-list.txt /tmp/mimetic-skill-install.txt 2>/dev/null || true
fi

echo
if [[ "\${MIMETIC_OSS_META_ACTOR_FIRST:-0}" == "1" && "\${MIMETIC_OSS_META_HOST_CODEX_ACTOR:-0}" != "1" ]]; then
  start_actor_attempt
  wait_for_actor_attempt_if_required || true
fi

echo
install_mimetic_cli

echo
echo "== mimetic init =="
npx mimetic init --yes
apply_host_actor_plan || true

start_target_app_surface

echo
echo "== nested mimetic proof =="
if [[ "$APP_STATUS" == "running" && -n "$APP_URL" ]]; then
  npx mimetic run --app-url "$APP_URL" --sims 2 --run-id ${shellQuote(runId)}
else
  echo "app_not_running_for_browser_proof=$APP_REASON"
  npx mimetic run --dry-run --run-id ${shellQuote(runId)}
fi
if npx mimetic verify --run latest; then
  NESTED_VERIFY_STATUS=passed
else
  NESTED_VERIFY_STATUS=failed
  exit 1
fi
npx mimetic watch --run latest --detach --no-open
open_nested_observer "opening nested observer"
arrange_lab_windows
if [[ "\${MIMETIC_OSS_META_ACTOR_FIRST:-0}" != "1" && "\${MIMETIC_OSS_META_HOST_CODEX_ACTOR:-0}" != "1" ]]; then
  start_actor_attempt
  wait_for_actor_attempt_if_required || true
fi

echo
echo "== bootstrap complete =="
echo "app_status=$APP_STATUS"
echo "app_url=$APP_URL"
echo "actor_status=$ACTOR_STATUS"
echo "nested_observer=$NESTED_OBSERVER"
`;
}

function buildRemoteLauncherScript(args: {
  bootstrapPath: string;
  launcherPath: string;
  logPath: string;
  title: string;
}): string {
  const terminalCommand = `bash -lc ${shellQuote(`${args.bootstrapPath}; echo; echo 'Mimetic bootstrap finished. Leave this terminal open for review.'; exec bash`)}`;
  return `#!/usr/bin/env bash
set -u
BOOTSTRAP=${shellQuote(args.bootstrapPath)}
LOG_PATH=${shellQuote(args.logPath)}
TITLE=${shellQuote(args.title)}
echo "launching visible terminal for $BOOTSTRAP" >> "$LOG_PATH"
if command -v xfce4-terminal >/dev/null 2>&1; then
  nohup xfce4-terminal --hold --title "$TITLE" --command ${shellQuote(terminalCommand)} >> "$LOG_PATH" 2>&1 &
elif command -v xterm >/dev/null 2>&1; then
  nohup xterm -T "$TITLE" -e ${shellQuote(terminalCommand)} >> "$LOG_PATH" 2>&1 &
else
  echo "No GUI terminal found; running bootstrap headless." >> "$LOG_PATH"
  nohup bash "$BOOTSTRAP" >> "$LOG_PATH" 2>&1 &
fi
`;
}

function buildRemoteFocusCommand(title: string): string {
  return `TITLE=${shellQuote(title)}
for attempt in $(seq 1 20); do
  if command -v wmctrl >/dev/null 2>&1; then
    wmctrl -a "$TITLE" >/dev/null 2>&1 && exit 0
  fi
  if command -v xdotool >/dev/null 2>&1; then
    WIN="$(xdotool search --name "$TITLE" 2>/dev/null | head -n 1 || true)"
    if [[ -n "$WIN" ]]; then
      xdotool windowactivate "$WIN" >/dev/null 2>&1 && exit 0
    fi
  fi
  sleep 0.25
done
exit 0`;
}

function buildRemoteScreenshotArrangeCommand(terminalTitle: string | undefined): string {
  return `TERMINAL_TITLE=${shellQuote(terminalTitle ?? "")}
if ! command -v xdotool >/dev/null 2>&1; then
  exit 0
fi
for attempt in $(seq 1 24); do
  CHROME_COUNT="$(xdotool search --onlyvisible --class google-chrome 2>/dev/null | wc -l | tr -d ' ')"
  OBSERVER_WINDOW="$(xdotool search --onlyvisible --name "Mimetic Observer" 2>/dev/null | tail -n 1 || true)"
  if [[ "$CHROME_COUNT" -ge 2 && -n "$OBSERVER_WINDOW" ]]; then
    break
  fi
  sleep 0.25
done
OBSERVER_WINDOW="$(xdotool search --onlyvisible --name "Mimetic Observer" 2>/dev/null | tail -n 1 || true)"
if [[ -n "$OBSERVER_WINDOW" ]]; then
  xdotool windowsize "$OBSERVER_WINDOW" 680 933 >/dev/null 2>&1 || true
  xdotool windowmove "$OBSERVER_WINDOW" 760 27 >/dev/null 2>&1 || true
fi
slot=0
while IFS= read -r win; do
  [[ -z "$win" ]] && continue
  if [[ -n "$OBSERVER_WINDOW" && "$win" == "$OBSERVER_WINDOW" ]]; then
    continue
  fi
  if [[ "$slot" -eq 0 ]]; then
    xdotool windowsize "$win" 760 493 >/dev/null 2>&1 || true
    xdotool windowmove "$win" 0 27 >/dev/null 2>&1 || true
  elif [[ "$slot" -eq 1 ]]; then
    xdotool windowsize "$win" 430 420 >/dev/null 2>&1 || true
    xdotool windowmove "$win" 0 520 >/dev/null 2>&1 || true
  else
    xdotool windowsize "$win" 330 420 >/dev/null 2>&1 || true
    xdotool windowmove "$win" 430 520 >/dev/null 2>&1 || true
  fi
  slot=$((slot + 1))
done < <(xdotool search --onlyvisible --class google-chrome 2>/dev/null || true)
if [[ -n "$TERMINAL_TITLE" ]]; then
  TERMINAL_WINDOW="$(xdotool search --onlyvisible --name "$TERMINAL_TITLE" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$TERMINAL_WINDOW" ]]; then
    xdotool windowlower "$TERMINAL_WINDOW" >/dev/null 2>&1 || xdotool windowminimize "$TERMINAL_WINDOW" >/dev/null 2>&1 || true
  fi
fi
if [[ -n "$OBSERVER_WINDOW" ]]; then
  xdotool windowactivate "$OBSERVER_WINDOW" >/dev/null 2>&1 || true
fi
exit 0`;
}

async function runDesktopCommand(
  desktop: E2BDesktopSandbox,
  command: string,
  options: E2BCommandRunOptions
): Promise<E2BCommandResult> {
  const result = await desktop.commands.run(`bash -lc ${shellQuote(command)}`, options);
  if (result.exitCode && result.exitCode !== 0) {
    throw new Error([
      `Remote command failed with exit code ${result.exitCode}.`,
      `stdout=${result.stdout ?? ""}`,
      `stderr=${result.stderr ?? ""}`
    ].join("\n"));
  }
  return result;
}

async function packLocalMimeticPackage(cwd: string, runId: string): Promise<OssMetaLabLocalPackage> {
  const packageRoot = moduleRoot;
  const packDir = path.join(cwd, ".mimetic", "tmp", "oss-meta", runId, "package");
  await mkdir(packDir, { recursive: true });
  await execFileAsync("pnpm", ["build"], {
    cwd: packageRoot,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });
  await execFileAsync("npm", ["pack", "--pack-destination", packDir], {
    cwd: packageRoot,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });
  const files = await readdir(packDir);
  const fileName = files.find((file) => /^mimetic-cli-.*\.tgz$/.test(file));
  if (!fileName) {
    throw new Error("npm pack did not produce a mimetic-cli tarball.");
  }
  const archivePath = path.join(packDir, fileName);
  const archiveStat = await stat(archivePath);
  return {
    fileName,
    path: archivePath,
    sizeBytes: archiveStat.size
  };
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}

function shellQuote(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function formatLiveDesktopForResult(desktop: OssMetaLabLiveDesktop): OssMetaLabResult["sandboxes"][number] {
  return {
    ...(desktop.completion?.actorStatus ? { actorStatus: desktop.completion.actorStatus } : {}),
    ...(desktop.completion?.appStatus ? { appStatus: desktop.completion.appStatus } : {}),
    ...(desktop.bootstrap ? { bootstrapStatus: desktop.bootstrap.status } : {}),
    ...(desktop.completion ? { completionReason: desktop.completion.reason, completionStatus: desktop.completion.status } : {}),
    repo: desktop.repo,
    ...(desktop.screenshot ? { screenshotPresent: true } : {}),
    ...(desktop.sandboxId ? { sandboxId: desktop.sandboxId } : {}),
    streamId: desktop.streamId,
    urlPresent: Boolean(desktop.url),
    ...(desktop.completion?.visualStatus ? { visualStatus: desktop.completion.visualStatus } : {}),
    ...(desktop.completion?.visualWindowCount === undefined ? {} : { visualWindowCount: desktop.completion.visualWindowCount })
  };
}

function missingLiveKeys(env: NodeJS.ProcessEnv): string[] {
  const missing = ["E2B_API_KEY"].filter((name) => !env[name]?.trim());
  const actorAuthRequested = remoteActorAuthRequested(env);
  const actorAuthPresent = Boolean(env.CODEX_API_KEY?.trim() || env.CODEX_ACCESS_TOKEN?.trim() || env.OPENAI_API_KEY?.trim());
  if (actorAuthRequested && !hostCodexActorRequested(env) && !actorAuthPresent) {
    missing.push(OSS_META_LAB_ACTOR_AUTH_PLACEHOLDER);
  }
  return missing;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

async function wait(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted-openai-key]")
    .replace(/e2b_[A-Za-z0-9_-]{12,}/g, "[redacted-e2b-key]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{12,}/g, "[redacted-github-token]")
    .replace(/https?:\/\/[^/\s]*e2b[^)\s]+/gi, "[redacted-e2b-url]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function makeMetaRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `oss-meta-${stamp}-${randomBytes(4).toString("hex")}`;
}

function repoSlugToken(repo: string): string {
  return repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function repoArtifactLabel(assignment: OssMetaLabAssignment): string {
  return `repo-${String(assignment.index).padStart(2, "0")}`;
}

function redactAssignments(assignments: OssMetaLabAssignment[], redactRepoNames: boolean): OssMetaLabAssignment[] {
  if (!redactRepoNames) {
    return assignments;
  }

  return assignments.map((assignment) => ({
    ...assignment,
    repo: repoArtifactLabel(assignment),
    scenarioId: `oss-meta-${repoArtifactLabel(assignment)}`
  }));
}

function safeArtifactToken(value: string): string {
  const token = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return token || "artifact";
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface E2BDesktopModule {
  Sandbox: {
    create(options: E2BDesktopCreateOptions): Promise<E2BDesktopSandbox>;
    kill?(sandboxId: string, options?: { requestTimeoutMs?: number }): Promise<unknown>;
    list?(options: E2BSandboxListOptions): E2BSandboxPaginator;
  };
}

interface E2BSandboxListOptions {
  metadata?: Record<string, string>;
  requestTimeoutMs?: number;
}

interface E2BSandboxInfo {
  metadata?: Record<string, string>;
  sandboxId?: string;
  state?: string;
}

interface E2BSandboxPaginator {
  hasNext: boolean;
  nextItems(options?: { requestTimeoutMs?: number }): Promise<E2BSandboxInfo[]>;
}

interface E2BDesktopCreateOptions {
  apiKey: string;
  dpi?: number;
  envs?: Record<string, string>;
  lifecycle?: {
    onTimeout: "kill" | "pause";
  };
  metadata?: Record<string, string>;
  requestTimeoutMs?: number;
  resolution?: [number, number];
  timeoutMs?: number;
}

interface E2BDesktopSandbox {
  sandboxId: string;
  commands: {
    run(command: string, options?: E2BCommandRunOptions): Promise<E2BCommandResult>;
  };
  files: {
    write(path: string, data: string | ArrayBuffer, options?: {
      requestTimeoutMs?: number;
      useOctetStream?: boolean;
    }): Promise<unknown>;
  };
  launch(application: string, uri?: string): Promise<void>;
  screenshot(format?: "bytes"): Promise<Uint8Array>;
  wait(ms: number): Promise<void>;
  stream: {
    getAuthKey(): string;
    getUrl(options?: {
      authKey?: string;
      autoConnect?: boolean;
      resize?: "off" | "scale" | "remote";
      viewOnly?: boolean;
    }): string;
    start(options?: {
      requireAuth?: boolean;
      windowId?: string;
    }): Promise<void>;
  };
}

interface E2BCommandRunOptions {
  background?: false;
  cwd?: string;
  envs?: Record<string, string>;
  onStderr?: (data: string) => void | Promise<void>;
  onStdout?: (data: string) => void | Promise<void>;
  requestTimeoutMs?: number;
  timeoutMs?: number;
}

interface E2BCommandResult {
  error?: string;
  exitCode?: number;
  stderr?: string;
  stdout?: string;
}
