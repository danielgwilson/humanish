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
import { scoreOssMetaMeaningfulUse } from "./oss-meta-lab-scoring.js";

export const OSS_META_LAB_SCHEMA = "mimetic.oss-meta-lab-result.v1";

export interface OssMetaLabOptions {
  codexAppServer?: boolean;
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
  cleanup(): Promise<OssMetaLabCleanupResult>;
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
  matched?: number;
  remaining?: number;
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
  appServerEventsPath?: string;
  appServerTracePath?: string;
  appServerTranscriptPath?: string;
  nestedEvidencePath?: string;
  setupQualityPath?: string;
}

interface OssMetaLabBootstrap {
  codexMode: "app-server-client" | "tui-attempted";
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
  appServerActorEvidence?: OssMetaLabAppServerActorEvidence;
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
  nestedStepTraceSummary?: OssMetaLabNestedStepTraceSummary;
  nestedVerifyPassed?: boolean;
  reason: string;
  setupQuality?: RunSetupQualitySnapshot;
  status: OssMetaLabCompletionStatus;
  visualReason?: string;
  visualStatus?: OssMetaLabVisualStatus;
  visualWindowCount?: number;
}

export interface OssMetaLabNestedStepTraceSummary {
  schema: "mimetic.oss-meta-nested-step-trace-summary.v1";
  redaction: {
    status: "passed";
    notes: string;
  };
  counts: {
    blockedSteps: number;
    passedSteps: number;
    surfaces: number;
    totalSteps: number;
    traces: number;
  };
  scenario?: {
    id: string;
    source?: string;
    sourceDigest?: string;
    stepCount?: number;
    title?: string;
  };
  status: "passed" | "blocked" | "unknown";
  surfaces: Array<{
    id: string;
    label?: string;
    ok: boolean;
    reason: string;
    steps: Array<{
      action: string;
      assertionStatuses?: string[];
      id: string;
      label?: string;
      reason: string;
      status: "passed" | "blocked" | "unknown";
    }>;
  }>;
}

export interface OssMetaLabAppServerActorEvidence {
  eventsPath: string;
  eventsText?: string;
  reason?: string;
  status?: string;
  traceJson?: unknown;
  tracePath: string;
  traceText?: string;
  transcriptPath: string;
  transcriptText?: string;
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

export interface OssMetaLabRepoAccessPreflight {
  ok: boolean;
  reason: string;
  repo: string;
  streamId: string;
  tokenPresent: boolean;
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
  "MIMETIC_OSS_META_CODEX_APP_SERVER",
  "MIMETIC_OSS_META_ACTOR_TIMEOUT_MS",
  "MIMETIC_OSS_META_REQUIRE_ACTOR"
] as const;
const OSS_META_LAB_ACTOR_AUTH_PLACEHOLDER = "CODEX_API_KEY or CODEX_ACCESS_TOKEN";
const OSS_META_LAB_ACTOR_PREFLIGHT_PLACEHOLDER = "Codex actor API quota/auth preflight";
const OSS_META_LAB_HOST_ACTOR_PLACEHOLDER = "host Codex actor plan";

interface ExecFileAsyncOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  timeout?: number;
}

type ExecFileAsyncImpl = (
  file: string,
  args: readonly string[],
  options: ExecFileAsyncOptions
) => Promise<{ stderr: string | Buffer; stdout: string | Buffer }>;

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
  const codexAppServerUrl = env.MIMETIC_OSS_META_CODEX_APP_SERVER_URL?.trim()
    || env.CODEX_APP_SERVER_CLIENT_URL?.trim()
    || env.CODEX_APP_SERVER_URL?.trim();
  const githubToken = githubTokenFromEnv(env);

  if (codexApiKey) {
    result.MIMETIC_CODEX_API_KEY = codexApiKey;
  }
  if (codexAccessToken) {
    result.MIMETIC_CODEX_ACCESS_TOKEN = codexAccessToken;
  }
  if (codexAppServerUrl) {
    result.MIMETIC_CODEX_APP_SERVER_URL = codexAppServerUrl;
  }
  if (githubToken) {
    result.MIMETIC_GITHUB_TOKEN = githubToken;
  }

  return result;
}

function githubTokenFromEnv(env: NodeJS.ProcessEnv): string {
  return env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || env.GITHUB_PAT?.trim() || "";
}

async function withGitHubAskPassEnv<T>(
  root: string,
  env: NodeJS.ProcessEnv,
  callback: (gitEnv: NodeJS.ProcessEnv) => Promise<T>
): Promise<T> {
  const gitEnv = await createGitHubAskPassEnv(root, env);
  return callback(gitEnv);
}

async function createGitHubAskPassEnv(root: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  await mkdir(root, { recursive: true });
  const askPassPath = path.join(root, `git-askpass-${randomBytes(4).toString("hex")}.sh`);
  await writeFile(askPassPath, [
    "#!/usr/bin/env bash",
    "case \"$1\" in",
    "  *Username*) echo \"x-access-token\" ;;",
    "  *Password*) echo \"${MIMETIC_GITHUB_TOKEN_RUNTIME:-}\" ;;",
    "  *) echo \"\" ;;",
    "esac",
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o700 });

  const token = githubTokenFromEnv(env);
  return {
    ...gitCredentialIsolatedEnv(env),
    GIT_ASKPASS: askPassPath,
    GIT_TERMINAL_PROMPT: "0",
    ...(token ? { MIMETIC_GITHUB_TOKEN_RUNTIME: token } : {})
  };
}

function gitEnvWithoutGitHubToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...gitCredentialIsolatedEnv(env),
    GIT_ASKPASS: "false",
    SSH_ASKPASS: "false",
    GIT_TERMINAL_PROMPT: "0"
  };
}

function gitCredentialIsolatedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(isolated)) {
    if (key.startsWith("GIT_CONFIG_")) {
      delete isolated[key];
    }
  }
  delete isolated.GH_TOKEN;
  delete isolated.GITHUB_PAT;
  delete isolated.GITHUB_TOKEN;
  delete isolated.GIT_ASKPASS;
  delete isolated.MIMETIC_GITHUB_TOKEN_RUNTIME;
  delete isolated.SSH_ASKPASS;
  return {
    ...isolated,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0"
  };
}

async function runGitRepoAccessProbe(
  execImpl: ExecFileAsyncImpl,
  cwd: string,
  repoUrl: string,
  env: NodeJS.ProcessEnv,
  sourceEnv: NodeJS.ProcessEnv
): Promise<void> {
  await execImpl("git", ["-c", "credential.helper=", "ls-remote", "--exit-code", repoUrl, "HEAD"], {
    cwd,
    env,
    maxBuffer: 256 * 1024,
    timeout: readPositiveInt(sourceEnv.MIMETIC_OSS_META_REPO_PREFLIGHT_TIMEOUT_MS, 45_000)
  });
}

export async function preflightOssMetaRepoAccess(args: {
  assignments: OssMetaLabAssignment[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  execFileImpl?: ExecFileAsyncImpl;
  redactRepoNames?: boolean;
}): Promise<OssMetaLabRepoAccessPreflight[]> {
  const execImpl = args.execFileImpl ?? execFileAsync;
  const tokenPresent = Boolean(githubTokenFromEnv(args.env));
  const root = path.join(args.cwd, ".mimetic", "tmp", `repo-access-${randomBytes(4).toString("hex")}`);

  try {
    await mkdir(root, { recursive: true });
    const tokenGitEnv = tokenPresent ? await createGitHubAskPassEnv(root, args.env) : undefined;
    const anonymousGitEnv = gitEnvWithoutGitHubToken(args.env);
    const results: OssMetaLabRepoAccessPreflight[] = [];

    for (const assignment of args.assignments) {
      const repoUrl = `https://github.com/${assignment.repo}.git`;

      let anonymousError: unknown;
      try {
        await runGitRepoAccessProbe(execImpl, root, repoUrl, anonymousGitEnv, args.env);
        results.push({
          ok: true,
          reason: tokenPresent
            ? "GitHub repo clone access preflight passed with anonymous public clone access."
            : "GitHub repo clone access preflight passed without token auth.",
          repo: assignment.repo,
          streamId: assignment.streamId,
          tokenPresent
        });
        continue;
      } catch (error) {
        anonymousError = error;
      }

      let tokenError: unknown;
      if (tokenGitEnv) {
        try {
          await runGitRepoAccessProbe(execImpl, root, repoUrl, tokenGitEnv, args.env);
          results.push({
            ok: true,
            reason: "GitHub repo clone access preflight passed with token auth after anonymous clone access failed.",
            repo: assignment.repo,
            streamId: assignment.streamId,
            tokenPresent: true
          });
          continue;
        } catch (error) {
          tokenError = error;
        }
      }

      results.push({
        ok: false,
        reason: repoAccessFailureReason({
          anonymousError,
          redactRepoName: args.redactRepoNames === true,
          repo: assignment.repo,
          tokenError,
          tokenPresent
        }),
        repo: assignment.repo,
        streamId: assignment.streamId,
        tokenPresent
      });
    }

    return results;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
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

function codexAppServerModeRequested(env: NodeJS.ProcessEnv, explicit = false): boolean {
  return explicit || env.MIMETIC_OSS_META_CODEX_APP_SERVER === "1";
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
    await withGitHubAskPassEnv(tmpRoot, process.env, async (gitEnv) => {
      await execFileAsync("git", ["clone", "--depth=1", `https://github.com/${args.assignment.repo}.git`, repoDir], {
        cwd: tmpRoot,
        env: gitEnv,
        maxBuffer: 10 * 1024 * 1024,
        timeout: readPositiveInt(process.env.MIMETIC_OSS_META_HOST_CLONE_TIMEOUT_MS, 90_000)
      });
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

function repoAccessFailureReason(args: {
  anonymousError: unknown;
  redactRepoName: boolean;
  repo: string;
  tokenError?: unknown;
  tokenPresent: boolean;
}): string {
  const anonymous = sanitizeRepoAccessError(args.anonymousError, args.repo, args.redactRepoName);
  const token = args.tokenError
    ? ` Token auth also failed: ${sanitizeRepoAccessError(args.tokenError, args.repo, args.redactRepoName)}`
    : "";
  const authHint = args.tokenPresent
    ? "A GitHub token was present, but `git ls-remote` could not read the repo with token or anonymous access. Check token repo access and scopes."
    : "No GitHub token was present. Public repos should pass unauthenticated; private repos need GH_TOKEN, GITHUB_TOKEN, or GITHUB_PAT with read access.";
  return `${authHint} Anonymous access failed: ${anonymous}${token}`.replace(/\s+/g, " ").trim().slice(0, 420);
}

function sanitizeRepoAccessError(error: unknown, repo: string, redactRepoName: boolean): string {
  let message = compactError(error)
    .replace(/github_pat_[A-Za-z0-9_]{12,}/g, "[redacted-github-token]")
    .replace(/\bMIMETIC_GITHUB_TOKEN_RUNTIME=[^\s]+/g, "MIMETIC_GITHUB_TOKEN_RUNTIME=[redacted-github-token]");
  if (redactRepoName) {
    message = message
      .replaceAll(`https://github.com/${repo}.git`, "https://github.com/[redacted-authorized-repo].git")
      .replaceAll(`github.com/${repo}.git`, "github.com/[redacted-authorized-repo].git")
      .replaceAll(repo, "[redacted-authorized-repo]");
  }
  return message;
}

function blockedLiveDesktopsForRepoAccess(args: {
  assignments: OssMetaLabAssignment[];
  preflight: OssMetaLabRepoAccessPreflight[];
  redactRepoNames: boolean;
}): OssMetaLabLiveDesktop[] {
  const checkedAt = new Date().toISOString();
  const preflightByStream = new Map(args.preflight.map((result) => [result.streamId, result]));
  const failedCount = args.preflight.filter((result) => !result.ok).length;

  return args.assignments.map((assignment): OssMetaLabLiveDesktop => {
    const repoLabel = args.redactRepoNames ? repoArtifactLabel(assignment) : assignment.repo;
    const preflight = preflightByStream.get(assignment.streamId);
    const reason = preflight?.ok
      ? `GitHub repo clone access preflight passed for ${repoLabel}, but live launch was skipped because ${failedCount} assigned repo${failedCount === 1 ? "" : "s"} failed preflight.`
      : preflight?.reason ?? `GitHub repo clone access preflight did not run for ${repoLabel}.`;

    return {
      completion: {
        actorStatus: "blocked",
        appReason: reason,
        appStatus: "blocked",
        checkedAt,
        logTail: reason,
        nestedObserverPresent: false,
        nestedVerifyPassed: false,
        reason,
        status: "blocked",
        visualReason: "No headed desktop was launched before repo clone access was proven.",
        visualStatus: "not_started",
        visualWindowCount: 0
      },
      repo: repoLabel,
      simId: assignment.simId,
      streamId: assignment.streamId
    };
  });
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
    .replace(/github_pat_[A-Za-z0-9_]{12,}/g, "[redacted-github-token]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return text || fallback;
}

export async function runOssMetaLab(options: OssMetaLabOptions): Promise<OssMetaLabResult> {
  const cwd = path.resolve(options.cwd);
  const dryRun = options.dryRun === true;
  const liveRequested = !dryRun;
  const codexAppServerMode = codexAppServerModeRequested(process.env, options.codexAppServer === true);
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

  const redactRepoNames = options.redactRepoNames ?? (liveRequested && (Boolean(githubTokenFromEnv(process.env)) || Boolean(options.repos?.length)));
  const hostActorMode = liveRequested && hostCodexActorRequested(process.env);
  const missingKeys = missingLiveKeys(process.env);
  if (liveRequested && missingKeys.length > 0) {
    warnings.push(`Live E2B/Codex launch is waiting on env vars: ${missingKeys.join(", ")}.`);
    warnings.push("Observer lanes stay in the live waiting state until keys are present.");
  }
  if (liveRequested && !githubTokenFromEnv(process.env)) {
    warnings.push("No GH_TOKEN, GITHUB_TOKEN, or GITHUB_PAT is present; public repos can clone, but private GitHub repos will fail access preflight.");
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
  const persistScreenshots = liveRequested;
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

  const shouldPreflightRepoAccess = liveRequested
    && missingKeys.length === 0
    && process.env.MIMETIC_OSS_META_SKIP_REPO_ACCESS_PREFLIGHT !== "1"
    && (Boolean(githubTokenFromEnv(process.env)) || Boolean(options.repos?.length));
  const repoAccessPreflight = shouldPreflightRepoAccess
    ? await preflightOssMetaRepoAccess({
        assignments,
        cwd,
        env: process.env,
        redactRepoNames
      })
    : [];
  const repoAccessPreflightBlocked = repoAccessPreflight.some((result) => !result.ok);
  if (repoAccessPreflight.length > 0) {
    const passed = repoAccessPreflight.filter((result) => result.ok).length;
    warnings.push(`GitHub repo clone access preflight passed ${passed}/${repoAccessPreflight.length} assigned repo${repoAccessPreflight.length === 1 ? "" : "s"}.`);
    for (const failed of repoAccessPreflight.filter((result) => !result.ok)) {
      const assignment = assignments.find((candidate) => candidate.streamId === failed.streamId);
      const repoLabel = assignment && redactRepoNames ? repoArtifactLabel(assignment) : failed.repo;
      warnings.push(`${repoLabel}: ${failed.reason}`);
    }
  }

  const hostActorPlanResults = hostActorMode && missingKeys.length === 0 && !repoAccessPreflightBlocked
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
  if (liveRequested && missingKeys.length === 0 && !repoAccessPreflightBlocked && !hostActorPlanBlocked && !actorAuthPreflightBlocked) {
    try {
      localPackage = await packLocalMimeticPackage(cwd, runId);
      warnings.push(`Packed local mimetic-cli package for sandbox install (${localPackage.fileName}).`);
    } catch (error) {
      warnings.push(`Local mimetic-cli package pack failed; sandbox bootstrap will try public npm fallback. ${compactError(error)}`);
    }
  }
  if (liveRequested && missingKeys.length === 0 && !repoAccessPreflightBlocked && !hostActorPlanBlocked && !actorAuthPreflightBlocked) {
    try {
      liveDesktops = await launchLiveDesktops(assignments, {
        codexAppServerMode,
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
  } else if (repoAccessPreflightBlocked) {
    liveDesktops = blockedLiveDesktopsForRepoAccess({
      assignments,
      preflight: repoAccessPreflight,
      redactRepoNames
    });
    warnings.push("Live E2B launch skipped because GitHub repo clone access preflight failed.");
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
      warnings.push(`Started ${startedBootstrapCount}/${liveDesktops.length} visible bootstrap terminal${liveDesktops.length === 1 ? "" : "s"} for target app startup, nested Mimetic setup, and ${codexAppServerMode ? "Codex app-server client surface" : "Codex actor attempt"}.`);
      if (terminalCompletionCount > 0) {
        warnings.push(`Classified ${terminalCompletionCount}/${startedBootstrapCount} bootstrap terminal state${startedBootstrapCount === 1 ? "" : "s"} from remote public-safe evidence.`);
        warnings.push(`Detected ${runningAppCount}/${terminalCompletionCount} target app HTTP-ready surface${terminalCompletionCount === 1 ? "" : "s"} from remote public-safe evidence.`);
        warnings.push(`Detected ${visibleDesktopCount}/${terminalCompletionCount} headed desktop visual layout${terminalCompletionCount === 1 ? "" : "s"} from remote public-safe evidence.`);
      }
    } else {
      warnings.push(codexAppServerMode
        ? "Codex app-server client surfacing and nested Mimetic execution remain the next substrate slice behind these live desktops."
        : "Codex TUI injection and nested Mimetic execution remain the next substrate slice behind these live desktops.");
    }
  }
  if (failedLiveDesktopCount > 0) {
    warnings.push(`${failedLiveDesktopCount} E2B desktop launch${failedLiveDesktopCount === 1 ? "" : "es"} failed; see stream events in the Observer.`);
  }

  if (persistScreenshots) {
    const screenshotSummary = await captureLiveDesktopScreenshots(artifactRoot, liveDesktops, { redactRepoNames });
    warnings.push(...screenshotSummary.warnings);
  }
  const actorEvidenceSummary = await writeActorEvidenceArtifacts(artifactRoot, liveDesktops, {
    assignments,
    redactRepoNames
  });
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
    sandboxes: liveDesktops.map((desktop) => formatLiveDesktopForResult(desktop, redactRepoNames)),
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
  const publicBundle = publicSafeOssMetaBundle(bundle);
  await writeJson(path.join(artifactRoot, "run.json"), publicBundle);
  await writeJson(path.join(artifactRoot, "review.json"), publicBundle.review);
  await writeFile(path.join(artifactRoot, "review.md"), renderMetaReviewMarkdown(publicBundle), "utf8");
  await writeFile(path.join(artifactRoot, "events.ndjson"), `${publicBundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

export function publicSafeOssMetaBundle(bundle: RunBundle): RunBundle {
  return {
    ...bundle,
    cwd: "[target-cwd]",
    streams: bundle.streams.map(publicSafeMetaStream)
  };
}

function publicSafeMetaStream(stream: RunStream): RunStream {
  return {
    ...stream,
    artifacts: uniqueStreamArtifacts(stream.artifacts.filter((artifact) => isLocalEvidenceArtifactPath(artifact.path))),
    ...(stream.terminal ? {
      terminal: {
        ...stream.terminal,
        tail: sanitizeRemoteLog(stream.terminal.tail)
      }
    } : {}),
    ...(stream.ui ? { ui: publicSafeMetaStreamUi(stream.ui) } : {})
  };
}

function publicSafeMetaStreamUi(ui: NonNullable<RunStream["ui"]>): NonNullable<RunStream["ui"]> {
  const { nestedObserverPath: rawNestedObserverPath, nestedObserverUrl: _rawNestedObserverUrl, ...rest } = ui;
  const nestedObserverPath = rawNestedObserverPath && isLocalEvidenceArtifactPath(rawNestedObserverPath)
    ? rawNestedObserverPath
    : undefined;

  return {
    ...rest,
    ...(nestedObserverPath === undefined ? {} : { nestedObserverPath })
  };
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
      result.sandboxes = runtime.liveDesktops.map((desktop) => formatLiveDesktopForResult(desktop, runtime.redactRepoNames));
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

  const stop = async (): Promise<void> => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    while (running) {
      await wait(100);
    }
  };

  return {
    async cleanup(): Promise<OssMetaLabCleanupResult> {
      await stop();
      return cleanupOssMetaLabLiveDesktops(runtime.liveDesktops);
    },
    async stop(): Promise<void> {
      await stop();
    }
  };
}

function cleanupOssMetaLabLiveDesktops(
  liveDesktops: OssMetaLabLiveDesktop[],
  options: {
    includeProviderReadback?: boolean;
    killSandbox?: (sandboxId: string, requestTimeoutMs: number) => Promise<unknown>;
    listSandboxes?: (request: OssMetaLabProviderListRequest) => Promise<E2BSandboxInfo[]>;
    requestTimeoutMs?: number;
  } = {}
): Promise<OssMetaLabCleanupResult> {
  const result = {
    sandboxes: liveDesktops.map((desktop) => ({
      repo: desktop.repo,
      ...(desktop.sandboxId ? { sandboxId: desktop.sandboxId } : {}),
      streamId: desktop.streamId,
      urlPresent: Boolean(desktop.url)
    }))
  };

  return options.includeProviderReadback === false
    ? cleanupOssMetaLabSandboxes(result, options)
    : cleanupOssMetaLabSandboxesAndProviderMatches(result, options);
}

export function sandboxIdsForOssMetaLabCleanup(result: Pick<OssMetaLabResult, "sandboxes">): string[] {
  return [...new Set(result.sandboxes.flatMap((sandbox) => sandbox.sandboxId ? [sandbox.sandboxId] : []))];
}

export interface OssMetaLabProviderListRequest {
  metadata: Record<string, string>;
  requestTimeoutMs: number;
}

export async function cleanupStaleOssMetaLabSandboxes(options: {
  killSandbox?: (sandboxId: string, requestTimeoutMs: number) => Promise<unknown>;
  listSandboxes?: (request: OssMetaLabProviderListRequest) => Promise<E2BSandboxInfo[]>;
  requestTimeoutMs?: number;
} = {}): Promise<OssMetaLabCleanupResult> {
  return cleanupOssMetaLabSandboxesAndProviderMatches({ sandboxes: [] }, options);
}

export async function cleanupOssMetaLabSandboxesAndProviderMatches(
  result: Pick<OssMetaLabResult, "sandboxes">,
  options: {
    killSandbox?: (sandboxId: string, requestTimeoutMs: number) => Promise<unknown>;
    listSandboxes?: (request: OssMetaLabProviderListRequest) => Promise<E2BSandboxInfo[]>;
    requestTimeoutMs?: number;
  } = {}
): Promise<OssMetaLabCleanupResult> {
  const requestTimeoutMs = options.requestTimeoutMs ?? readPositiveInt(process.env.MIMETIC_E2B_REQUEST_TIMEOUT_MS, 60_000);
  const listed = await listOssMetaLabProviderSandboxIds({
    ...(options.listSandboxes === undefined ? {} : { listSandboxes: options.listSandboxes }),
    requestTimeoutMs
  });
  const ids = [...new Set([...sandboxIdsForOssMetaLabCleanup(result), ...listed.ids])];
  const cleanup = await cleanupOssMetaLabSandboxes({
    sandboxes: ids.map((sandboxId, index) => ({
      repo: "oss-meta-lab",
      sandboxId,
      streamId: `provider-${String(index + 1).padStart(2, "0")}`,
      urlPresent: false
    }))
  }, {
    ...(options.killSandbox === undefined ? {} : { killSandbox: options.killSandbox }),
    redactIds: true,
    requestTimeoutMs
  });
  const remaining = listed.errors.length > 0 || cleanup.errors.length > 0
    ? undefined
    : (await listOssMetaLabProviderSandboxIds({
        ...(options.listSandboxes === undefined ? {} : { listSandboxes: options.listSandboxes }),
        requestTimeoutMs
      })).ids.length;

  return {
    killed: cleanup.killed,
    matched: ids.length,
    ...(remaining === undefined ? {} : { remaining }),
    skipped: result.sandboxes.length - sandboxIdsForOssMetaLabCleanup(result).length + listed.skipped + cleanup.skipped,
    errors: [...listed.errors, ...cleanup.errors]
  };
}

async function listOssMetaLabProviderSandboxIds(options: {
  listSandboxes?: (request: OssMetaLabProviderListRequest) => Promise<E2BSandboxInfo[]>;
  requestTimeoutMs: number;
}): Promise<{ ids: string[]; skipped: number; errors: string[] }> {
  let listSandboxes = options.listSandboxes;
  if (!listSandboxes) {
    const e2bApiKey = process.env.E2B_API_KEY;
    if (!e2bApiKey) {
      return {
        ids: [],
        skipped: 0,
        errors: ["E2B_API_KEY is not present; provider metadata cleanup readback skipped."]
      };
    }

    const desktopModule = await loadE2BDesktopModule();
    if (!desktopModule.Sandbox.list) {
      return {
        ids: [],
        skipped: 0,
        errors: ["Installed @e2b/desktop SDK does not expose Sandbox.list; provider metadata cleanup readback skipped."]
      };
    }

    listSandboxes = async (request) => {
      const paginator = desktopModule.Sandbox.list?.({
        metadata: request.metadata,
        requestTimeoutMs: request.requestTimeoutMs
      });
      const sandboxes: E2BSandboxInfo[] = [];
      if (!paginator) {
        return sandboxes;
      }

      while (true) {
        sandboxes.push(...await paginator.nextItems({ requestTimeoutMs: request.requestTimeoutMs }));
        if (!paginator.hasNext) {
          return sandboxes;
        }
      }
    };
  }

  try {
    const sandboxes = await listSandboxes({
      metadata: { ...OSS_META_LAB_PROVIDER_METADATA },
      requestTimeoutMs: options.requestTimeoutMs
    });
    let skipped = 0;
    const ids = sandboxes.flatMap((sandbox) => {
      const id = sandboxProviderId(sandbox);
      if (!id || !isCleanupEligibleOssMetaLabSandbox(sandbox)) {
        skipped += 1;
        return [];
      }

      return [id];
    });
    return { ids: [...new Set(ids)], skipped, errors: [] };
  } catch (error) {
    return {
      ids: [],
      skipped: 0,
      errors: [`provider metadata cleanup readback failed: ${compactError(error)}`]
    };
  }
}

function sandboxProviderId(sandbox: E2BSandboxInfo): string | null {
  for (const value of [sandbox.sandboxId, sandbox.sandboxID, sandbox.id]) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
}

function isCleanupEligibleOssMetaLabSandbox(sandbox: E2BSandboxInfo): boolean {
  const metadata = sandbox.metadata;
  if (!metadata || metadata.tool !== OSS_META_LAB_PROVIDER_METADATA.tool || metadata.mode !== OSS_META_LAB_PROVIDER_METADATA.mode) {
    return false;
  }

  const state = typeof sandbox.state === "string" ? sandbox.state.toLowerCase() : "";
  return !["closed", "killed", "paused", "terminated"].includes(state);
}

export async function cleanupOssMetaLabSandboxes(
  result: Pick<OssMetaLabResult, "sandboxes">,
  options: {
    killSandbox?: (sandboxId: string, requestTimeoutMs: number) => Promise<unknown>;
    redactIds?: boolean;
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
      const errorText = compactError(error);
      errors.push(`${options.redactIds ? "[provider-runtime]" : id}: ${options.redactIds ? errorText.replaceAll(id, "[provider-runtime]") : errorText}`);
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
    appDir: "/home/user/maciekt07-todoapp",
    completionPath: "/home/user/.mimetic-oss-lab/maciekt07-todoapp/completion.json",
    displayRepo: "maciekt07/TodoApp",
    logPath: "/home/user/.mimetic-oss-lab/maciekt07-todoapp/bootstrap.log",
    nestedObserverPath: "/home/user/maciekt07-todoapp/.mimetic/runs/nested-maciekt07-todoapp/observer/index.html",
    remoteHostActorPlanPath: "/home/user/.mimetic-oss-lab/maciekt07-todoapp/host-actor-plan.json",
    stateDir: "/home/user/.mimetic-oss-lab/maciekt07-todoapp",
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
    const rawLiveDesktop = args.liveDesktops.find((desktop) => desktop.streamId === assignment.streamId);
    const liveDesktop = rawLiveDesktop && args.redactRepoNames
      ? redactLiveDesktopRepoMentions(rawLiveDesktop, assignment.repo)
      : rawLiveDesktop;
    const repoLabel = args.redactRepoNames ? repoArtifactLabel(assignment) : assignment.repo;
    const scenarioId = args.redactRepoNames ? `oss-meta-${repoLabel}` : assignment.scenarioId;
    const status = statusForMeta(args, liveDesktop);
    const completion = liveDesktop?.completion;
    const screenshot = liveDesktop?.screenshot;
    const terminalTail = terminalTailForMeta(prompt, liveDesktop);
    const liveStreamPresent = Boolean(liveDesktop?.url);
    const appServerMode = liveDesktop?.bootstrap?.codexMode === "app-server-client";
    simulations.push({
      id: assignment.simId,
      index: assignment.index,
      personaId: `codex-oss-operator-${String(assignment.index).padStart(2, "0")}`,
      scenarioId,
      status,
      streamKind: "browser",
      mode: "browser-sim",
      progress: progressForMeta(status, liveDesktop),
      currentStep: currentStepForMeta(args, assignment, liveDesktop),
      summary: completion
        ? `Headed E2B desktop lane assigned to ${repoLabel}; ${completion.reason}`
        : liveDesktop?.bootstrap?.status === "started"
        ? `Headed E2B desktop lane assigned to ${repoLabel}; bootstrap terminal launched to set up Mimetic and open the nested Observer${appServerMode ? " plus Codex app-server client surface" : ""}.`
        : `Headed E2B desktop lane assigned to ${repoLabel}; remote bootstrap should set up Mimetic and open a nested Observer inside that desktop.`,
      streamIds: [assignment.streamId],
      startedAt: args.createdAt,
      updatedAt: args.createdAt
    });

    const artifacts = uniqueStreamArtifacts([
      { label: "run bundle", path: "run.json", kind: "bundle" as const },
      { label: "review", path: "review.md", kind: "review" as const },
      { label: "events", path: "events.ndjson", kind: "events" as const },
      ...(completion?.appServerActorEvidence?.tracePath ? [{ label: "codex app-server trace", path: completion.appServerActorEvidence.tracePath, kind: "trace" as const }] : []),
      ...(completion?.appServerActorEvidence?.eventsPath ? [{ label: "codex app-server events", path: completion.appServerActorEvidence.eventsPath, kind: "events" as const }] : []),
      ...(completion?.appServerActorEvidence?.transcriptPath ? [{ label: "codex app-server transcript", path: completion.appServerActorEvidence.transcriptPath, kind: "log" as const }] : []),
      ...(liveDesktop?.actorEvidence?.actorLastMessageTailPath ? [{ label: "actor last-message tail", path: liveDesktop.actorEvidence.actorLastMessageTailPath, kind: "log" as const }] : []),
      ...(liveDesktop?.actorEvidence?.actorLogTailPath ? [{ label: "actor log tail", path: liveDesktop.actorEvidence.actorLogTailPath, kind: "log" as const }] : []),
      ...(liveDesktop?.actorEvidence?.appServerTracePath ? [{ label: "codex app-server trace", path: liveDesktop.actorEvidence.appServerTracePath, kind: "trace" as const }] : []),
      ...(liveDesktop?.actorEvidence?.appServerEventsPath ? [{ label: "codex app-server events", path: liveDesktop.actorEvidence.appServerEventsPath, kind: "events" as const }] : []),
      ...(liveDesktop?.actorEvidence?.appServerTranscriptPath ? [{ label: "codex app-server transcript", path: liveDesktop.actorEvidence.appServerTranscriptPath, kind: "log" as const }] : []),
      ...(liveDesktop?.actorEvidence?.nestedEvidencePath ? [{ label: "nested Mimetic proof", path: liveDesktop.actorEvidence.nestedEvidencePath, kind: "trace" as const }] : []),
      ...(liveDesktop?.actorEvidence?.setupQualityPath ? [{ label: "setup quality", path: liveDesktop.actorEvidence.setupQualityPath, kind: "filesystem" as const }] : []),
      ...(liveDesktop?.hostActorPlanPath ? [{ label: "host Codex actor plan", path: liveDesktop.hostActorPlanPath, kind: "trace" as const }] : []),
      ...(screenshot ? [{ label: "desktop screenshot", path: screenshot.path, kind: "screenshot" as const }] : [])
    ]);

    const stream: RunStream = {
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
        title: `${appServerMode ? "Codex app-server" : "Codex"} bootstrap - ${repoLabel}`,
        format: "plain",
        stdin: liveDesktop?.bootstrap ? "sent" : "planned",
        tail: terminalTail
      },
      ui: {
        route: completion?.appUrl ?? `e2b://desktop/${repoLabel}`,
        intent: appServerMode
          ? "Watch the headed desktop where the bootstrap clones the repo, starts the target app, sets up Mimetic, opens the nested Observer, and opens a Codex app-server client surface."
          : "Watch the headed desktop where the bootstrap clones the repo, starts the target app, sets up Mimetic, opens the nested Observer, and attempts a Codex actor.",
        ...(completion?.actorStatus ? { actorStatus: completion.actorStatus } : {}),
        ...(completion?.appStatus ? { appStatus: completion.appStatus } : {}),
        ...(completion?.appUrl ? { appUrl: completion.appUrl } : {}),
        ...(liveDesktop?.actorEvidence?.nestedEvidencePath ? { nestedObserverPath: liveDesktop.actorEvidence.nestedEvidencePath } : {}),
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
      ...(completion ? { completion: completionForStream(completion, appServerMode) } : {}),
      artifacts
    };
    if (appServerMode) {
      stream.codex = codexMetadataForMetaStream(liveDesktop, completion);
    }
    streams.push(stream);

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
        message: appServerMode
          ? "Codex app-server client hook is available in the stream logs tab."
          : "Codex bootstrap prompt is available in the stream logs tab.",
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
          if (completion.nestedStepTraceSummary) {
            events.push({
              id: `event-${String(assignment.index).padStart(3, "0")}-nested-step-trace`,
              at: completion.checkedAt,
              level: completion.nestedStepTraceSummary.status === "passed" ? "info" : "warn",
              type: "oss-meta.nested.step_trace.summary",
              message: `${repoLabel}: Nested browser trace summary captured ${completion.nestedStepTraceSummary.counts.passedSteps}/${completion.nestedStepTraceSummary.counts.totalSteps} steps across ${completion.nestedStepTraceSummary.counts.surfaces} surface(s).`,
              simId: assignment.simId,
              streamId: assignment.streamId
            });
          }
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
    } else if (completion) {
      events.push({
        id: `event-${String(assignment.index).padStart(3, "0")}-completion-${completion.status}`,
        at: completion.checkedAt,
        level: eventLevelForCompletion(completion.status),
        type: `oss-meta.bootstrap.${completion.status}`,
        message: `${repoLabel}: ${completion.reason}`,
        simId: assignment.simId,
        streamId: assignment.streamId
      });
      if (completion.nestedStepTraceSummary) {
        events.push({
          id: `event-${String(assignment.index).padStart(3, "0")}-nested-step-trace`,
          at: completion.checkedAt,
          level: completion.nestedStepTraceSummary.status === "passed" ? "info" : "warn",
          type: "oss-meta.nested.step_trace.summary",
          message: `${repoLabel}: Nested browser trace summary captured ${completion.nestedStepTraceSummary.counts.passedSteps}/${completion.nestedStepTraceSummary.counts.totalSteps} steps across ${completion.nestedStepTraceSummary.counts.surfaces} surface(s).`,
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

function uniqueStreamArtifacts(artifacts: RunStream["artifacts"]): RunStream["artifacts"] {
  const seen = new Set<string>();
  const unique: RunStream["artifacts"] = [];
  for (const artifact of artifacts) {
    const key = `${artifact.kind}:${artifact.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(artifact);
  }
  return unique;
}

function codexMetadataForMetaStream(
  liveDesktop: OssMetaLabLiveDesktop | undefined,
  completion: OssMetaLabCompletion | undefined
): NonNullable<RunStream["codex"]> {
  const trace = completion?.appServerActorEvidence?.traceJson;
  const traceRecord = isRecord(trace) ? trace : undefined;
  const counts = isRecord(traceRecord?.counts) ? traceRecord.counts : undefined;
  const eventCount = typeof counts?.envelopes === "number" ? counts.envelopes : undefined;
  return {
    provider: "codex-app-server",
    state: codexStateForMeta(completion),
    contract: "Codex app-server JSON-RPC actor telemetry projected from redacted event envelopes, trace summary, transcript tail, and filesystem setup evidence.",
    ...(eventCount === undefined ? {} : { eventCount }),
    ...(liveDesktop?.actorEvidence?.appServerTracePath ? { tracePath: liveDesktop.actorEvidence.appServerTracePath } : {}),
    ...(typeof traceRecord?.threadId === "string" && traceRecord.threadId.trim() ? { threadId: traceRecord.threadId } : {}),
    ...(typeof traceRecord?.turnId === "string" && traceRecord.turnId.trim() ? { turnId: traceRecord.turnId } : {}),
    ...(typeof traceRecord?.sessionId === "string" && traceRecord.sessionId.trim() ? { sessionId: traceRecord.sessionId } : {}),
    ...(typeof traceRecord?.model === "string" && traceRecord.model.trim() ? { model: traceRecord.model } : {})
  };
}

function codexStateForMeta(completion: OssMetaLabCompletion | undefined): NonNullable<RunStream["codex"]>["state"] {
  if (!completion) return "connecting";
  if (completion.actorStatus === "passed") return "completed";
  if (completion.actorStatus === "running") return "running";
  if (completion.actorStatus === "timed_out" || completion.status === "timed_out") return "timed_out";
  if (completion.actorStatus === "blocked" || completion.status === "blocked") return "blocked";
  if (completion.actorStatus === "failed" || completion.status === "failed") return "failed";
  return completion.status === "running" ? "running" : "watching";
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
  if (
    liveDesktop?.completion?.status === "passed"
    && liveDesktop.bootstrap?.codexMode === "app-server-client"
    && liveDesktop.completion.actorStatus !== "passed"
  ) return "blocked";
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
}, assignment: OssMetaLabAssignment, liveDesktop?: OssMetaLabLiveDesktop): string {
  const repoLabel = args.redactRepoNames ? repoArtifactLabel(assignment) : assignment.repo;
  if (args.dryRun) {
    return `Contract ready for ${repoLabel}; no E2B desktop launched.`;
  }
  if (liveDesktop?.completion) {
    return liveDesktop.completion.reason;
  }
  if (liveDesktop?.bootstrap?.status === "started") {
    return liveDesktop.bootstrap.codexMode === "app-server-client"
      ? `Bootstrap terminal launched for ${repoLabel}; Codex app-server actor, Mimetic setup, target app, and nested Observer run inside the desktop.`
      : `Bootstrap terminal launched for ${repoLabel}; Codex TUI attempt, Mimetic setup, and nested Observer run inside the desktop.`;
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
  return `Ready to launch E2B desktop and run Codex actor setup for ${repoLabel}.`;
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
      ? "Target app browser surfaces and nested Observer windows are visible inside headed desktops; nested Mimetic live proof is still missing."
      : appRunning.length > 0
      ? "Target app surfaces responded over HTTP, but headed desktop browser-window visibility was not detected for every lane."
      : started.length > 0 && terminalCompletions.length === started.length
      ? "OSS lane terminal states are classified from public-safe remote bootstrap evidence, but target app HTTP readiness was not detected."
      : args.liveDesktops.some((desktop) => desktop.bootstrap?.status === "started")
      ? "Visible E2B bootstrap terminals are launched and run nested Mimetic setup plus target app startup; completion is watched in the desktop stream until remote evidence is polled back."
      : "Nested Mimetic Observer evidence is represented as a lane contract until Codex TUI injection and nested Mimetic execution land.",
    nestedLiveProof
      ? "Nested Mimetic proof reached live app-url mode with desktop/mobile browser persona evidence; richer app-specific journey manifests remain the next adapter slice."
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

  const completedWithMissingAppServerActor = args.liveDesktops.filter((desktop) =>
    desktop.bootstrap?.codexMode === "app-server-client"
    && desktop.completion?.status === "passed"
    && desktop.completion.actorStatus !== "passed"
  );
  if (completedWithMissingAppServerActor.length > 0) {
    return {
      ok: false,
      reason: `OSS meta-lab completed nested Mimetic setup but did not capture passed Codex app-server actor evidence for ${completedWithMissingAppServerActor.length}/${args.liveDesktops.length} headed desktop lane${completedWithMissingAppServerActor.length === 1 ? "" : "s"}.`,
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
      `setup_summary: ${liveDesktop.completion.setupQuality.summary}`,
      ...(liveDesktop.completion.setupQuality.studyQuality === undefined ? [] : [
        `study_quality: ${liveDesktop.completion.setupQuality.studyQuality.rating}`,
        `study_summary: ${liveDesktop.completion.setupQuality.studyQuality.summary}`
      ])
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

function completionForStream(completion: OssMetaLabCompletion, appServerMode = false): RunStreamCompletion {
  const effectiveStatus = appServerMode && completion.status === "passed" && completion.actorStatus !== "passed"
    ? "blocked"
    : completion.status;
  const effectiveReason = effectiveStatus === "blocked" && completion.status === "passed" && completion.actorStatus !== "passed"
    ? "Codex app-server mode requires passed app-server actor evidence; actor evidence did not reach passed."
    : completion.reason;
  const meaningfulUse = scoreOssMetaMeaningfulUse({
    ...(completion.actorLastMessageTail === undefined ? {} : { actorLastMessageTail: completion.actorLastMessageTail }),
    ...(completion.actorLogTail === undefined ? {} : { actorLogTail: completion.actorLogTail }),
    actorRequired: appServerMode,
    ...(completion.actorStatus === undefined ? {} : { actorStatus: completion.actorStatus }),
    ...(completion.appStatus === undefined ? {} : { appStatus: completion.appStatus }),
    ...(completion.appUrl === undefined ? {} : { appUrl: completion.appUrl }),
    ...(completion.nestedObserverPresent === undefined ? {} : { nestedObserverPresent: completion.nestedObserverPresent }),
    ...(completion.nestedVerifyPassed === undefined ? {} : { nestedVerifyPassed: completion.nestedVerifyPassed }),
    ...(completion.setupQuality === undefined ? {} : { setupQuality: completion.setupQuality }),
    status: effectiveStatus,
    ...(completion.visualStatus === undefined ? {} : { visualStatus: completion.visualStatus })
  });
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
    reason: effectiveReason,
    status: effectiveStatus,
    meaningfulUse,
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
    const studyQuality = desktop.completion?.setupQuality?.studyQuality;

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
        summary: `Generated Mimetic setup for ${repoLabel} needs review`,
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
    if (hasAppUrlProofBlocker(actorText)) {
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
          "npx --yes --package mimetic-cli mimetic run --help | grep -- --app-url",
          `pnpm mimetic -- verify --run ${args.runId} --json`
        ]
      });
    }

    if (setupQualityPath && studyQuality && (studyQuality.rating === "none" || studyQuality.rating === "ceremonial")) {
      candidates.push({
        schema: "mimetic.feedback-candidate.v1",
        id: `study-quality-${safeArtifactToken(assignment.streamId)}`,
        run_id: args.runId,
        stream_id: assignment.streamId,
        adapter_id: "oss-meta-lab",
        scenario_id: scenarioId,
        persona_id: `codex-oss-operator-${String(assignment.index).padStart(2, "0")}`,
        actor: "codex-tui",
        substrate: "e2b-desktop",
        failure_owner: "actor",
        summary: `Generated Mimetic setup for ${repoLabel} was ${studyQuality.rating}`,
        expected: "The setup actor should turn Mimetic init into an app-aware user-study plan with customized coverage, personas, scenarios, app-url proof, and public-safe feedback.",
        actual: studyQuality.summary,
        evidence: [
          {
            path: setupQualityPath,
            kind: "filesystem",
            note: "Setup-quality snapshot includes study-quality checks and public-safe structural signals."
          },
          ...baseEvidence
        ],
        redaction: {
          status: "passed",
          notes: "Study-quality feedback candidate references local public-safe artifacts only."
        },
        idempotency_key: `mimetic:${args.runId}:${assignment.streamId}:study-quality`,
        proposed_next_state: "study-quality-review",
        acceptance_proof: [
          `pnpm mimetic -- verify --run ${args.runId} --json`,
          `pnpm mimetic -- watch --run ${args.runId} --no-open`,
          "Study-quality rating is useful or high_leverage, or the remaining ceremonial state is explicitly explained."
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
    "5. Install Mimetic as a dev dependency with the package manager the repo already uses. The package is `mimetic-cli`; the binary is `mimetic`.",
    "6. Run `npx --no-install mimetic init --yes` or the package-manager equivalent. Do not run bare `npx mimetic` unless you have confirmed it resolves the local `mimetic-cli` binary.",
    "7. Replace starter coverage files with an app-aware `mimetic/coverage-map.md` and `mimetic/coverage-matrix.md` that name real screens, roles, states, happy paths, and at least one sad/friction path discovered from the repo/app.",
    "8. Author at least two public-safe, app-specific Mimetic personas and two desktop/mobile browser scenarios. Avoid generic `first-run-smoke` only; each scenario should name a target journey, route/state, expected evidence, and a failure/friction check.",
    "9. Run `npx --no-install mimetic run --help` and verify `--app-url` is available. If the local binary is missing, install `mimetic-cli`; one-shot fallback is `npx --yes --package mimetic-cli@latest mimetic run --help`.",
    "10. If the app is running locally, run `npx --no-install mimetic run --app-url <loopback-url> --sims 2`; do not use `mimetic watch --sims` as app behavior proof.",
    "11. After `run --app-url`, render or open the nested Mimetic Observer with `npx --no-install mimetic watch --run latest --detach --no-open --json` and keep it visible.",
    "12. Final summary must be public-safe and include: personas/scenarios created, product journeys covered, one observed friction/improvement or `none observed`, and evidence paths. Do not stop at install/init proof.",
    "13. Record public-safe blockers and evidence paths only.",
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
    codexAppServerMode?: boolean;
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
          ...(options.codexAppServerMode ? { MIMETIC_OSS_META_CODEX_APP_SERVER: "1" } : {}),
          ...collectOssMetaLabPrivateEnv(process.env)
        },
        resolution: [1440, 960],
        dpi: 96,
        lifecycle: {
          onTimeout: "kill"
        }
      });
      const bootstrap = await startOssBootstrap(desktop, assignment, options.localPackage, requestTimeoutMs, {
        ...(options.codexAppServerMode === undefined ? {} : { codexAppServerMode: options.codexAppServerMode }),
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
    warnings.push(`Initial OSS meta-lab completion wait skipped because ${options.timeoutReason ?? "MIMETIC_OSS_META_COMPLETION_TIMEOUT_MS=0"}; attached watch continues polling while the Observer is open.`);
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
  await writeActorEvidenceArtifacts(runtime.artifactRoot, runtime.liveDesktops, {
    assignments: runtime.assignments,
    redactRepoNames: runtime.redactRepoNames
  });

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
  liveDesktops: OssMetaLabLiveDesktop[],
  options: { redactRepoNames: boolean } = { redactRepoNames: false }
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
      const laneLabel = options.redactRepoNames ? desktop.streamId : desktop.repo;
      warnings.push(`Screenshot capture failed for ${laneLabel}: ${compactError(error)}`);
    }
  }));

  const capturedCount = liveDesktops.filter((desktop) => desktop.screenshot).length;
  if (capturedCount > 0) {
    warnings.push(options.redactRepoNames
      ? `Captured ${capturedCount}/${candidates.length} local-only redacted E2B desktop screenshot fallback${candidates.length === 1 ? "" : "s"}; do not publish private screenshots.`
      : `Captured ${capturedCount}/${candidates.length} E2B desktop screenshot fallback${candidates.length === 1 ? "" : "s"}.`);
  }

  return { warnings };
}

async function writeActorEvidenceArtifacts(
  artifactRoot: string,
  liveDesktops: OssMetaLabLiveDesktop[],
  options: {
    assignments: OssMetaLabAssignment[];
    redactRepoNames: boolean;
  }
): Promise<{ warnings: string[] }> {
  const candidates = liveDesktops.filter((desktop) =>
    desktop.completion?.actorLastMessageTail
    || desktop.completion?.actorLogTail
    || desktop.completion?.appServerActorEvidence
    || desktop.completion?.nestedObserverPresent !== undefined
    || desktop.completion?.nestedStepTraceSummary !== undefined
    || desktop.completion?.nestedVerifyPassed !== undefined
    || desktop.completion?.setupQuality
  );
  if (candidates.length === 0) {
    return { warnings: [] };
  }

  const actorEvidenceRoot = path.join(artifactRoot, "actor-evidence");
  const nestedEvidenceRoot = path.join(artifactRoot, "nested-evidence");
  const setupQualityRoot = path.join(artifactRoot, "setup-quality");
  await mkdir(actorEvidenceRoot, { recursive: true });
  await mkdir(nestedEvidenceRoot, { recursive: true });
  await mkdir(setupQualityRoot, { recursive: true });
  let written = 0;

  for (const desktop of candidates) {
    const assignment = options.assignments.find((candidate) => candidate.streamId === desktop.streamId);
    const repoForRedaction = options.redactRepoNames ? assignment?.repo : undefined;
    const baseName = safeArtifactToken(desktop.streamId);
    const actorEvidence: OssMetaLabActorEvidenceArtifacts = {};

    if (desktop.completion?.actorLastMessageTail) {
      const relativePath = path.join("actor-evidence", `${baseName}-actor-last-message-tail.txt`);
      await writeFile(
        path.join(artifactRoot, relativePath),
        renderPublicSafeActorEvidenceText("actor-last-message", desktop.streamId, desktop.completion.actorLastMessageTail, {
          providerRuntimeId: options.redactRepoNames ? desktop.sandboxId : undefined,
          repo: repoForRedaction
        }),
        "utf8"
      );
      actorEvidence.actorLastMessageTailPath = relativePath;
      written += 1;
    }

    if (desktop.completion?.actorLogTail) {
      const relativePath = path.join("actor-evidence", `${baseName}-actor-log-tail.txt`);
      await writeFile(
        path.join(artifactRoot, relativePath),
        renderPublicSafeActorEvidenceText("actor-log", desktop.streamId, desktop.completion.actorLogTail, {
          providerRuntimeId: options.redactRepoNames ? desktop.sandboxId : undefined,
          repo: repoForRedaction
        }),
        "utf8"
      );
      actorEvidence.actorLogTailPath = relativePath;
      written += 1;
    }

    if (desktop.completion?.setupQuality) {
      const relativePath = path.join("setup-quality", `${baseName}-setup-quality.json`);
      const snapshot = options.redactRepoNames
        ? redactSetupQualityRepoMentions(suppressSetupQualityPreviews(desktop.completion.setupQuality), repoForRedaction)
        : desktop.completion.setupQuality;
      await writeJson(path.join(artifactRoot, relativePath), snapshot);
      actorEvidence.setupQualityPath = relativePath;
      written += 1;
    }

    if (desktop.completion && (
      desktop.completion.nestedObserverPresent !== undefined
      || desktop.completion.nestedStepTraceSummary !== undefined
      || desktop.completion.nestedVerifyPassed !== undefined
    )) {
      const relativePath = path.join("nested-evidence", `${baseName}-nested-proof.json`);
      await writeJson(path.join(artifactRoot, relativePath), {
        schema: "mimetic.oss-meta-nested-proof.v1",
        streamId: desktop.streamId,
        redaction: {
          status: "passed",
          notes: "Nested proof summary contains booleans and redacted local artifact pointers only; remote sandbox paths are intentionally omitted."
        },
        status: desktop.completion.status,
        reason: desktop.completion.reason,
        checkedAt: desktop.completion.checkedAt,
        nestedObserverPresent: desktop.completion.nestedObserverPresent === true,
        nestedVerifyPassed: desktop.completion.nestedVerifyPassed === true,
        ...(desktop.completion.nestedStepTraceSummary ? { stepTraceSummary: desktop.completion.nestedStepTraceSummary } : {}),
        appStatus: desktop.completion.appStatus ?? "unknown",
        actorStatus: desktop.completion.actorStatus ?? "unknown"
      });
      actorEvidence.nestedEvidencePath = relativePath;
      written += 1;
    }

    if (desktop.completion?.appServerActorEvidence) {
      const evidence = desktop.completion.appServerActorEvidence;
      const tracePath = path.join("codex-app-server", `${baseName}-summary.json`);
      const eventsPath = path.join("codex-app-server", `${baseName}-events.ndjson`);
      const transcriptPath = path.join("codex-app-server", `${baseName}-transcript.txt`);
      await mkdir(path.join(artifactRoot, "codex-app-server"), { recursive: true });
      await writeJson(
        path.join(artifactRoot, tracePath),
        isRecord(evidence.traceJson)
          ? evidence.traceJson
          : {
              schema: "mimetic.codex-app-server-trace.missing.v1",
              redaction: { status: "passed" },
              status: evidence.status ?? "unknown",
              reason: evidence.reason ?? "Remote app-server trace JSON was not captured.",
              traceText: evidence.traceText ?? ""
            }
      );
      await writeFile(path.join(artifactRoot, eventsPath), evidence.eventsText ?? "No app-server event envelope tail captured.\n", "utf8");
      await writeFile(path.join(artifactRoot, transcriptPath), evidence.transcriptText ?? "No app-server transcript tail captured.\n", "utf8");
      evidence.tracePath = tracePath;
      evidence.eventsPath = eventsPath;
      evidence.transcriptPath = transcriptPath;
      actorEvidence.appServerTracePath = tracePath;
      actorEvidence.appServerEventsPath = eventsPath;
      actorEvidence.appServerTranscriptPath = transcriptPath;
      written += 3;
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
    ...(snapshot.studyQuality ? { studyQuality: sanitizeStudyQualitySnapshot(snapshot.studyQuality) } : {}),
    previews: [],
    redaction: {
      status: "passed",
      rawPreviews: "suppressed",
      notes: "Raw file previews are suppressed for token-backed/private OSS meta-lab runs."
    }
  };
}

function renderPublicSafeActorEvidenceText(
  kind: string,
  streamId: string,
  text: string,
  redaction?: { providerRuntimeId?: string | undefined; repo?: string | undefined }
): string {
  const sanitized = sanitizeRemoteLog(redactPrivateActorEvidence(text, redaction));
  return [
    `schema: mimetic.oss-meta-actor-evidence.v1`,
    `kind: ${kind}`,
    `stream: ${streamId}`,
    `redaction: passed`,
    "",
    sanitized || "(no actor evidence captured)"
  ].join("\n").trimEnd() + "\n";
}

function redactLiveDesktopRepoMentions(desktop: OssMetaLabLiveDesktop, repo: string): OssMetaLabLiveDesktop {
  return {
    ...desktop,
    ...(desktop.bootstrap
      ? {
          bootstrap: {
            ...desktop.bootstrap,
            tail: redactPrivateRuntimeMentions(desktop.bootstrap.tail, { providerRuntimeId: desktop.sandboxId, repo })
          }
        }
      : {}),
    ...(desktop.completion
      ? { completion: redactCompletionRepoMentions(desktop.completion, repo, desktop.sandboxId) }
      : {})
  };
}

function redactCompletionRepoMentions(completion: OssMetaLabCompletion, repo: string, providerRuntimeId?: string): OssMetaLabCompletion {
  const redaction = { providerRuntimeId, repo };
  return {
    ...completion,
    ...(completion.actorLogTail === undefined ? {} : { actorLogTail: redactPrivateActorEvidence(completion.actorLogTail, redaction) }),
    ...(completion.actorLastMessageTail === undefined ? {} : { actorLastMessageTail: redactPrivateActorEvidence(completion.actorLastMessageTail, redaction) }),
    ...(completion.appServerActorEvidence === undefined ? {} : { appServerActorEvidence: redactAppServerActorEvidence(completion.appServerActorEvidence, redaction) }),
    ...(completion.appReason === undefined ? {} : { appReason: redactPrivateRuntimeMentions(completion.appReason, redaction) }),
    ...(completion.logTail === undefined ? {} : { logTail: redactPrivateRuntimeMentions(completion.logTail, redaction) }),
    ...(completion.nestedStepTraceSummary === undefined ? {} : { nestedStepTraceSummary: redactNestedStepTraceSummary(completion.nestedStepTraceSummary, redaction) }),
    reason: redactPrivateRuntimeMentions(completion.reason, redaction),
    ...(completion.setupQuality === undefined ? {} : { setupQuality: redactSetupQualityRepoMentions(completion.setupQuality, repo) }),
    ...(completion.visualReason === undefined ? {} : { visualReason: redactPrivateRuntimeMentions(completion.visualReason, redaction) })
  };
}

function redactNestedStepTraceSummary(
  summary: OssMetaLabNestedStepTraceSummary,
  redaction: { providerRuntimeId?: string | undefined; repo?: string | undefined }
): OssMetaLabNestedStepTraceSummary {
  return normalizeNestedStepTraceSummary(redactJsonValue(summary, redaction)) ?? summary;
}

function redactAppServerActorEvidence(
  evidence: OssMetaLabAppServerActorEvidence,
  redaction: { providerRuntimeId?: string | undefined; repo?: string | undefined }
): OssMetaLabAppServerActorEvidence {
  return {
    ...evidence,
    ...(evidence.eventsText === undefined ? {} : { eventsText: redactPrivateActorEvidence(evidence.eventsText, redaction) }),
    ...(evidence.reason === undefined ? {} : { reason: redactPrivateRuntimeMentions(evidence.reason, redaction) }),
    ...(evidence.status === undefined ? {} : { status: redactPrivateRuntimeMentions(evidence.status, redaction) }),
    ...(evidence.traceJson === undefined ? {} : { traceJson: redactJsonValue(evidence.traceJson, redaction) }),
    ...(evidence.traceText === undefined ? {} : { traceText: redactPrivateActorEvidence(evidence.traceText, redaction) }),
    ...(evidence.transcriptText === undefined ? {} : { transcriptText: redactPrivateActorEvidence(evidence.transcriptText, redaction) })
  };
}

function redactJsonValue(value: unknown, redaction: { providerRuntimeId?: string | undefined; repo?: string | undefined }): unknown {
  try {
    return JSON.parse(redactPrivateActorEvidence(JSON.stringify(value), redaction));
  } catch {
    return value;
  }
}

function redactPrivateActorEvidence(text: string, redaction: { providerRuntimeId?: string | undefined; repo?: string | undefined } | undefined): string {
  const redacted = redactPrivateRuntimeMentions(text, redaction);
  return redaction?.repo ? stripSourceDiffBlocks(redacted) : redacted;
}

function stripSourceDiffBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let inDiff = false;
  let emittedMarker = false;

  for (const line of lines) {
    if (/^diff --git\b/.test(line)) {
      if (!emittedMarker) {
        output.push("[redacted-source-diff]");
        emittedMarker = true;
      }
      inDiff = true;
      continue;
    }

    if (inDiff) {
      if (/^(tokens used|Installed\b|Mimetic\b|Created personas:|Created browser scenarios:|Product journeys covered:|Observed friction|Evidence paths:|Verification:|If you want\b)/.test(line)) {
        inDiff = false;
      } else {
        continue;
      }
    }

    output.push(line);
  }

  return output.join("\n");
}

function redactSetupQualityRepoMentions(snapshot: RunSetupQualitySnapshot, repo: string | undefined): RunSetupQualitySnapshot {
  if (!repo) {
    return snapshot;
  }

  return JSON.parse(JSON.stringify(snapshot, (_key, value) =>
    typeof value === "string" ? redactRepoMentions(value, repo) : value
  )) as RunSetupQualitySnapshot;
}

function redactRepoMentions(text: string, repo: string): string {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    return text;
  }

  const replacement = "[redacted-authorized-repo]";
  let redacted = text
    .replace(new RegExp(`https://github\\.com/${escapeRegExp(owner)}/${escapeRegExp(name)}(?:\\.git)?`, "gi"), replacement)
    .replace(new RegExp(`git@github\\.com:${escapeRegExp(owner)}/${escapeRegExp(name)}(?:\\.git)?`, "gi"), replacement)
    .replace(new RegExp(`\\b${escapeRegExp(owner)}/${escapeRegExp(name)}\\b`, "gi"), replacement);

  if (name.length >= 4 && !isCommonRepoBasename(name)) {
    redacted = redacted.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi"), replacement);
  }

  return redacted;
}

function redactPrivateRuntimeMentions(text: string, redaction: { providerRuntimeId?: string | undefined; repo?: string | undefined } | undefined): string {
  let redacted = text;
  if (redaction?.repo) {
    redacted = redactRepoMentions(redacted, redaction.repo);
  }
  if (redaction?.providerRuntimeId) {
    redacted = redacted.replace(new RegExp(escapeRegExp(redaction.providerRuntimeId), "g"), "[redacted-provider-runtime-id]");
  }
  return redacted;
}

function isCommonRepoBasename(value: string): boolean {
  return new Set(["app", "web", "api", "cli", "repo", "site", "docs", "main", "next", "demo", "test"]).has(value.toLowerCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasAppUrlProofBlocker(text: string): boolean {
  const normalized = normalizeActorEvidenceForPattern(text);
  const blocker = "(?:unknown option|unsupported|not available|does\\s+\\W*not\\W*(?:support|expose|accept)|did\\s+\\W*not\\W*(?:support|expose|accept)|doesnt\\s+(?:support|expose|accept)|didnt\\s+(?:support|expose|accept))";
  const appUrl = "(?:--app-url|run\\s+--app-url|app-url\\s+proof)";
  return new RegExp(`${blocker}[\\s\\S]{0,220}${appUrl}|${appUrl}[\\s\\S]{0,220}${blocker}`, "i").test(normalized);
}

function normalizeActorEvidenceForPattern(text: string): string {
  return text
    .replace(/[*_`~[\](){}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
      appServerActorEvidence?: unknown;
      appLogPath?: unknown;
      appPid?: unknown;
      appReason?: unknown;
      appStatus?: unknown;
      appUrl?: unknown;
      completedAt?: unknown;
      exitCode?: unknown;
      logTail?: unknown;
      nestedObserverPresent?: unknown;
      nestedStepTraceSummary?: unknown;
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
    const appServerActorEvidence = normalizeAppServerActorEvidence(parsed.appServerActorEvidence);
    const nestedStepTraceSummary = normalizeNestedStepTraceSummary(parsed.nestedStepTraceSummary);

    return {
      ...(typeof parsed.actorLogPath === "string" && parsed.actorLogPath.trim() ? { actorLogPath: sanitizeRemoteLog(parsed.actorLogPath) } : {}),
      ...(typeof parsed.actorLogTail === "string" && parsed.actorLogTail.trim() ? { actorLogTail: sanitizeRemoteLog(parsed.actorLogTail) } : {}),
      ...(typeof parsed.actorLastMessageTail === "string" && parsed.actorLastMessageTail.trim() ? { actorLastMessageTail: sanitizeRemoteLog(parsed.actorLastMessageTail) } : {}),
      ...(typeof parsed.actorPid === "number" && Number.isFinite(parsed.actorPid) ? { actorPid: parsed.actorPid } : {}),
      ...(actorStatus ? { actorStatus } : {}),
      ...(appServerActorEvidence ? { appServerActorEvidence } : {}),
      ...(typeof parsed.appLogPath === "string" && parsed.appLogPath.trim() ? { appLogPath: sanitizeRemoteLog(parsed.appLogPath) } : {}),
      ...(typeof parsed.appPid === "number" && Number.isFinite(parsed.appPid) ? { appPid: parsed.appPid } : {}),
      ...(typeof parsed.appReason === "string" && parsed.appReason.trim() ? { appReason: sanitizeRemoteLog(parsed.appReason).replace(/\s+/g, " ").slice(0, 240) } : {}),
      ...(appStatus ? { appStatus } : {}),
      ...(typeof parsed.appUrl === "string" && parsed.appUrl.trim() ? { appUrl: sanitizeRemoteLog(parsed.appUrl).replace(/\s+/g, " ").slice(0, 240) } : {}),
      checkedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : new Date().toISOString(),
      ...(typeof parsed.exitCode === "number" ? { exitCode: parsed.exitCode } : {}),
      ...(typeof parsed.logTail === "string" ? { logTail: sanitizeRemoteLog(parsed.logTail) } : {}),
      ...(typeof parsed.nestedObserverPresent === "boolean" ? { nestedObserverPresent: parsed.nestedObserverPresent } : {}),
      ...(nestedStepTraceSummary ? { nestedStepTraceSummary } : {}),
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

function normalizeNestedStepTraceSummary(value: unknown): OssMetaLabNestedStepTraceSummary | null {
  if (!isRecord(value) || !Array.isArray(value.surfaces)) {
    return null;
  }
  const surfaces = value.surfaces
    .slice(0, 8)
    .filter((surface) => isRecord(surface))
    .map((surface) => {
      const steps = Array.isArray(surface.steps)
        ? surface.steps
          .slice(0, 20)
          .filter((step) => isRecord(step))
          .map((step) => {
            const status = normalizeNestedStepStatus(step.status);
            const assertionStatuses = Array.isArray(step.assertionStatuses)
              ? step.assertionStatuses
                .map((statusValue) => publicSafeSummaryToken(statusValue, "assertion"))
                .filter(Boolean)
                .slice(0, 12)
              : undefined;
            return {
              action: publicSafeSummaryToken(step.action, "action"),
              ...(assertionStatuses && assertionStatuses.length > 0 ? { assertionStatuses } : {}),
              id: publicSafeSummaryToken(step.id, "step"),
              ...(typeof step.label === "string" && step.label.trim() ? { label: sanitizeNestedTraceText(step.label, 140) } : {}),
              reason: sanitizeNestedTraceText(step.reason, 240),
              status
            };
          })
        : [];
      return {
        id: publicSafeSummaryToken(surface.id, "surface"),
        ...(typeof surface.label === "string" && surface.label.trim() ? { label: sanitizeNestedTraceText(surface.label, 140) } : {}),
        ok: surface.ok === true,
        reason: sanitizeNestedTraceText(surface.reason, 240),
        steps
      };
    })
    .filter((surface) => surface.steps.length > 0);
  if (surfaces.length === 0) {
    return null;
  }

  const totalSteps = surfaces.reduce((total, surface) => total + surface.steps.length, 0);
  const passedSteps = surfaces.reduce((total, surface) => total + surface.steps.filter((step) => step.status === "passed").length, 0);
  const blockedSteps = surfaces.reduce((total, surface) => total + surface.steps.filter((step) => step.status === "blocked").length, 0);
  const scenario = isRecord(value.scenario)
    ? {
        id: publicSafeSummaryToken(value.scenario.id, "scenario"),
        ...(typeof value.scenario.source === "string" && isSafeRepoRelativePath(value.scenario.source) ? { source: sanitizeSetupQualityPath(value.scenario.source) } : {}),
        ...(typeof value.scenario.sourceDigest === "string" && value.scenario.sourceDigest.trim() ? { sourceDigest: publicSafeSummaryToken(value.scenario.sourceDigest, "digest") } : {}),
        ...(typeof value.scenario.stepCount === "number" && Number.isFinite(value.scenario.stepCount) ? { stepCount: Math.max(0, Math.round(value.scenario.stepCount)) } : {}),
        ...(typeof value.scenario.title === "string" && value.scenario.title.trim() ? { title: sanitizeNestedTraceText(value.scenario.title, 140) } : {})
      }
    : undefined;

  return {
    schema: "mimetic.oss-meta-nested-step-trace-summary.v1",
    redaction: {
      status: "passed",
      notes: "Nested browser trace summary stores counts and redacted step metadata only; URLs, auth streams, remote paths, screenshots, and raw DOM text are omitted."
    },
    counts: {
      blockedSteps,
      passedSteps,
      surfaces: surfaces.length,
      totalSteps,
      traces: surfaces.length
    },
    ...(scenario ? { scenario } : {}),
    status: blockedSteps > 0 ? "blocked" : passedSteps === totalSteps ? "passed" : "unknown",
    surfaces
  };
}

function normalizeNestedStepStatus(value: unknown): "passed" | "blocked" | "unknown" {
  return value === "passed" || value === "blocked" ? value : "unknown";
}

function publicSafeSummaryToken(value: unknown, fallback: string): string {
  const token = sanitizeSetupQualityText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return token || fallback;
}

function sanitizeNestedTraceText(value: unknown, maxLength: number): string {
  return sanitizeSetupQualityText(value)
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(?:^|\s)\/(?:home|tmp|var|Users)\/\S+/g, " [redacted-path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeAppServerActorEvidence(value: unknown): OssMetaLabAppServerActorEvidence | null {
  if (!isRecord(value)) {
    return null;
  }
  const tracePath = safeRelativeArtifactPath(typeof value.tracePath === "string" ? value.tracePath : "");
  const eventsPath = safeRelativeArtifactPath(typeof value.eventsPath === "string" ? value.eventsPath : "");
  const transcriptPath = safeRelativeArtifactPath(typeof value.transcriptPath === "string" ? value.transcriptPath : "");
  if (!tracePath || !eventsPath || !transcriptPath) {
    return null;
  }

  return {
    eventsPath,
    ...(typeof value.eventsText === "string" && value.eventsText.trim() ? { eventsText: sanitizeRemoteLog(value.eventsText) } : {}),
    ...(typeof value.reason === "string" && value.reason.trim() ? { reason: sanitizeRemoteLog(value.reason).replace(/\s+/g, " ").slice(0, 240) } : {}),
    ...(typeof value.status === "string" && value.status.trim() ? { status: sanitizeRemoteLog(value.status).replace(/\s+/g, " ").slice(0, 80) } : {}),
    ...(isRecord(value.traceJson) ? { traceJson: value.traceJson } : {}),
    tracePath,
    ...(typeof value.traceText === "string" && value.traceText.trim() ? { traceText: sanitizeRemoteLog(value.traceText) } : {}),
    transcriptPath,
    ...(typeof value.transcriptText === "string" && value.transcriptText.trim() ? { transcriptText: sanitizeRemoteLog(value.transcriptText) } : {})
  };
}

function safeRelativeArtifactPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("/") || normalized.startsWith("../") || normalized.includes("://") || normalized.split("/").includes("..")) {
    return "";
  }
  return normalized;
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
    ...(snapshot.studyQuality ? { studyQuality: sanitizeStudyQualitySnapshot(snapshot.studyQuality) } : {}),
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

function sanitizeStudyQualitySnapshot(studyQuality: NonNullable<RunSetupQualitySnapshot["studyQuality"]>): NonNullable<RunSetupQualitySnapshot["studyQuality"]> {
  const rating = studyQuality.rating === "none"
    || studyQuality.rating === "ceremonial"
    || studyQuality.rating === "useful"
    || studyQuality.rating === "high_leverage"
    ? studyQuality.rating
    : "none";

  return {
    schema: "mimetic.study-quality.v1",
    rating,
    summary: sanitizeSetupQualityText(studyQuality.summary).slice(0, 320),
    checks: Array.isArray(studyQuality.checks)
      ? studyQuality.checks
        .filter((check) => isRecord(check) && typeof check.id === "string" && typeof check.label === "string" && typeof check.detail === "string")
        .slice(0, 20)
        .map((check) => ({
          id: sanitizeSetupQualityText(check.id).replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 80) || "study-check",
          label: sanitizeSetupQualityText(check.label).slice(0, 140),
          ok: check.ok === true,
          detail: sanitizeSetupQualityText(check.detail).slice(0, 320)
        }))
      : [],
    signals: {
      appUrlProofBlocked: studyQuality.signals?.appUrlProofBlocked === true,
      appUrlProofMentioned: studyQuality.signals?.appUrlProofMentioned === true,
      actorInsightCaptured: studyQuality.signals?.actorInsightCaptured === true,
      coverageCustomized: studyQuality.signals?.coverageCustomized === true,
      personaCustomized: studyQuality.signals?.personaCustomized === true,
      scenarioCustomized: studyQuality.signals?.scenarioCustomized === true
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

function isLocalEvidenceArtifactPath(value: string): boolean {
  return isSafeRepoRelativePath(value);
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
  display: { codexAppServerMode?: boolean; hostActorPlanResult?: OssMetaLabHostActorPlanResult; repoLabel: string; token: string } = {
    repoLabel: assignment.repo,
    token: repoSlugToken(assignment.repo)
  }
): Promise<OssMetaLabBootstrap> {
  const token = display.token;
  const appDir = `/home/user/${token}`;
  const stateDir = `/home/user/.mimetic-oss-lab/${token}`;
  const remotePackagePath = `/tmp/${localPackage?.fileName ?? "mimetic-cli.tgz"}`;
  const remoteHostActorPlanPath = `${stateDir}/host-actor-plan.json`;
  const bootstrapPath = `${stateDir}/bootstrap.sh`;
  const launcherPath = `${stateDir}/launch-terminal.sh`;
  const logPath = `${stateDir}/bootstrap.log`;
  const completionPath = `${stateDir}/completion.json`;
  const nestedObserverPath = `${appDir}/.mimetic/runs/nested-${token}/observer/index.html`;
  const title = `Mimetic ${assignment.index} ${display.repoLabel}`;
  const codexMode = codexAppServerModeRequested(process.env, display.codexAppServerMode === true) ? "app-server-client" : "tui-attempted";
  const baseTail = [
    `repo: ${display.repoLabel}`,
    `project: ${appDir}`,
    `sandbox: ${desktop.sandboxId}`,
    `remote package: ${localPackage ? remotePackagePath : "npm:mimetic-cli fallback"}`,
    `bootstrap: ${bootstrapPath}`,
    `completion: ${completionPath}`,
    `log: ${logPath}`,
    `nested observer: ${nestedObserverPath}`
  ].join("\n");

  try {
    await runDesktopCommand(desktop, `mkdir -p ${shellQuote(stateDir)}`, {
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
      appDir,
      completionPath,
      displayRepo: display.repoLabel,
      logPath,
      nestedObserverPath,
      ...(display.hostActorPlanResult?.plan ? { remoteHostActorPlanPath } : {}),
      stateDir,
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
      codexMode,
      completionPath,
      launcherPath,
      logPath,
      mimeticPackageUploaded: Boolean(localPackage),
      nestedObserverPath,
      status: "started",
      tail: [
        "Visible E2B bootstrap terminal launched.",
        codexMode === "app-server-client"
          ? "The terminal clones the authorized repo, installs this local mimetic-cli package tarball when available, runs nested Mimetic proof commands, opens the nested Observer, and opens the Codex app-server client surface in Chrome when configured."
          : "The terminal clones the authorized repo, installs this local mimetic-cli package tarball when available, runs nested Mimetic proof commands, attempts Codex TUI, then opens the nested Observer in Chrome.",
        baseTail
      ].join("\n"),
      terminalTitle: title
    };
  } catch (error) {
    return {
      codexMode,
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
  appDir: string;
  completionPath: string;
  displayRepo: string;
  logPath: string;
  nestedObserverPath: string;
  remoteHostActorPlanPath?: string;
  remotePackagePath?: string;
  stateDir: string;
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
MIMETIC_PRIVATE_CODEX_APP_SERVER_URL="\${MIMETIC_CODEX_APP_SERVER_URL:-}"
MIMETIC_PRIVATE_GITHUB_TOKEN="\${MIMETIC_GITHUB_TOKEN:-}"
unset MIMETIC_CODEX_API_KEY MIMETIC_CODEX_ACCESS_TOKEN MIMETIC_CODEX_APP_SERVER_URL MIMETIC_GITHUB_TOKEN
unset OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN E2B_API_KEY GH_TOKEN GITHUB_TOKEN
STATE_DIR=${shellQuote(args.stateDir)}
ROOT_DIR="$STATE_DIR"
APP_DIR=${shellQuote(args.appDir)}
LOG_PATH=${shellQuote(args.logPath)}
COMPLETION_PATH=${shellQuote(args.completionPath)}
NESTED_OBSERVER=${shellQuote(args.nestedObserverPath)}
REMOTE_PACKAGE=${args.remotePackagePath ? shellQuote(args.remotePackagePath) : "''"}
HOST_ACTOR_PLAN=${args.remoteHostActorPlanPath ? shellQuote(args.remoteHostActorPlanPath) : "''"}
APP_LOG_PATH="$ROOT_DIR/app.log"
ACTOR_LOG_PATH="$ROOT_DIR/actor.log"
ACTOR_LAST_MESSAGE_PATH="$ROOT_DIR/actor-last-message.txt"
CODEX_APP_SERVER_ROOT_PATH="$ROOT_DIR/codex-app-server"
CODEX_APP_SERVER_STATE_PATH="$CODEX_APP_SERVER_ROOT_PATH/state.json"
CODEX_APP_SERVER_LOG_PATH="$CODEX_APP_SERVER_ROOT_PATH/ui.log"
CODEX_APP_SERVER_PROMPT_PATH="$ROOT_DIR/codex-app-server-prompt.txt"
CODEX_APP_SERVER_PORT="\${MIMETIC_OSS_META_CODEX_APP_SERVER_PORT:-45137}"
CODEX_APP_SERVER_UI_URL=""
STREAM_ID=${shellQuote(args.assignment.streamId)}
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
CODEX_APP_SERVER_CLIENT_OPENED=0

write_completion() {
  local status="$1"
  local reason="$2"
  local exit_code="$3"
  local nested_observer_present=false
  if [[ -f "$NESTED_OBSERVER" ]]; then
    nested_observer_present=true
  fi

  node - "$COMPLETION_PATH" "$LOG_PATH" "$APP_DIR" "$status" "$reason" "$exit_code" "$nested_observer_present" "$NESTED_OBSERVER" "$NESTED_VERIFY_STATUS" "$APP_STATUS" "$APP_REASON" "$APP_URL" "$APP_PID" "$APP_LOG_PATH" "$ACTOR_STATUS" "$ACTOR_PID" "$ACTOR_LOG_PATH" "$ACTOR_LAST_MESSAGE_PATH" "$VISUAL_STATUS" "$VISUAL_REASON" "$VISUAL_WINDOW_COUNT" "$STREAM_ID" "$CODEX_APP_SERVER_STATE_PATH" "$CODEX_APP_SERVER_ROOT_PATH" <<'NODE' || true
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
  nestedObserverPath,
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
  visualWindowCount,
  streamId,
  codexAppServerStatePath,
  codexAppServerRootPath
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
  const readRel = (rel) => readTextLimited(path.join(root, rel), 20000);
  const listFilesUnder = (prefix) => {
    const absoluteRoot = path.join(root, prefix);
    const files = [];
    const visit = (dir, depth) => {
      if (depth > 2 || files.length >= 40) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const absolute = path.join(dir, entry.name);
        const rel = safeRel(path.relative(root, absolute));
        if (!rel) continue;
        if (entry.isDirectory()) visit(absolute, depth + 1);
        else if (entry.isFile()) files.push(rel);
      }
    };
    visit(absoluteRoot, 0);
    return files;
  };
  const coverageMapText = readRel("mimetic/coverage-map.md");
  const coverageMatrixText = readRel("mimetic/coverage-matrix.md");
  const personaFiles = listFilesUnder(path.join("mimetic", "personas"));
  const scenarioFiles = listFilesUnder(path.join("mimetic", "scenarios"));
  const personaText = personaFiles.map((rel) => readRel(rel)).join("\\n");
  const scenarioText = scenarioFiles.map((rel) => readRel(rel)).join("\\n");
  const configText = readRel("mimetic/config.ts");
  const defaultPersonaFiles = new Set(["mimetic/personas/synthetic-new-user.yaml", "mimetic/personas/skeptical-power-user.yaml"]);
  const defaultScenarioFiles = new Set(["mimetic/scenarios/first-run-smoke.yaml", "mimetic/scenarios/onboarding-regression.yaml"]);
  const personaEntries = personaFiles.map((rel) => ({ rel, text: readRel(rel) }));
  const scenarioEntries = scenarioFiles.map((rel) => ({ rel, text: readRel(rel) }));
  const coverageCustomized = (
    Boolean(coverageMapText.trim())
      && !/Current starter coverage is intentionally minimal/i.test(coverageMapText)
      && /\\b(screen|route|role|state|path|flow|journey|surface|happy|sad|friction)\\b/i.test(coverageMapText)
  ) || (
    Boolean(coverageMatrixText.trim())
      && !/\\bstarter\\b/i.test(coverageMatrixText)
      && /\\b(screen|route|role|state|path|flow|journey|surface|happy|sad|friction)\\b/i.test(coverageMatrixText)
  );
  const personaCustomizedCount = personaEntries.filter(({ rel, text }) => !defaultPersonaFiles.has(rel)
    || (Boolean(text.trim())
      && !/privacy-safe first-time user evaluating the app|prefers clear affordances over novelty|starter persona/i.test(text)
      && /\\b(role|workflow|creator|operator|admin|guest|player|customer|seller|designer|developer|founder|marketer|power user|novice|skeptical|accessibility|persona|job-to-be-done)\\b/i.test(text))).length;
  const scenarioCustomizedCount = scenarioEntries.filter(({ rel, text }) => !defaultScenarioFiles.has(rel)
    || (Boolean(text.trim())
      && !/Reach the first meaningful product state|Exercise onboarding friction|starter scenario/i.test(text)
      && /\\b(route|screen|journey|state|happy|sad|friction|error|empty|mobile|desktop|evidence|expectation|selector|upload|preview|pricing|auth|settings|checkout|workflow)\\b/i.test(text))).length;
  const personaCustomized = personaCustomizedCount >= Math.min(2, personaFiles.length || 2);
  const scenarioCustomized = scenarioCustomizedCount >= Math.min(2, scenarioFiles.length || 2);
  const actorEvidenceText = [actorLogTail, actorLastMessageTail, redactedTail, scenarioText, configText].join("\\n");
  const actorEvidenceNormalized = actorEvidenceText.replace(/[*_\`~[\\](){}<>]/g, " ").replace(/\\s+/g, " ").trim();
  const appUrlProofBlocked = /(?:unknown option|unsupported|not available|does\\s+\\W*not\\W*(?:support|expose|accept)|did\\s+\\W*not\\W*(?:support|expose|accept)|doesnt\\s+(?:support|expose|accept)|didnt\\s+(?:support|expose|accept))[\\s\\S]{0,220}(?:--app-url|run\\s+--app-url|app-url\\s+proof)|(?:--app-url|run\\s+--app-url|app-url\\s+proof)[\\s\\S]{0,220}(?:unknown option|unsupported|not available|does\\s+\\W*not\\W*(?:support|expose|accept)|did\\s+\\W*not\\W*(?:support|expose|accept)|doesnt\\s+(?:support|expose|accept)|didnt\\s+(?:support|expose|accept))/i.test(actorEvidenceNormalized);
  const appUrlProofMentioned = !appUrlProofBlocked && (
    nestedVerifyStatus === "passed"
    || /(?:mimetic\\s+run[\\s\\S]{0,160}--app-url|--app-url[\\s\\S]{0,160}mimetic\\s+run)/i.test(actorEvidenceText)
  );
  const actorInsightCaptured = /\\b(observed|found|friction|improvement|issue|gap|confusing|blocked|recommend|none observed|feedback|useful improvement|next harness upgrade)\\b/i.test(actorEvidenceNormalized);
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
  const studyChecks = [
    { id: "coverage-customized", label: "Coverage customized", ok: coverageCustomized, detail: coverageCustomized ? "Coverage map or matrix appears app-aware." : "Coverage map/matrix still appears starter-level or absent." },
    { id: "personas-customized", label: "Personas customized", ok: personaCustomized, detail: personaCustomized ? "Personas appear app-specific or non-starter." : "Personas appear generic starter-level." },
    { id: "scenarios-customized", label: "Scenarios customized", ok: scenarioCustomized, detail: scenarioCustomized ? "Scenarios appear app-specific or non-starter." : "Scenarios appear generic starter-level." },
    { id: "app-url-proof", label: "App-url proof", ok: appUrlProofMentioned, detail: appUrlProofMentioned ? "Actor/setup evidence references app-url proof." : appUrlProofBlocked ? "Actor evidence reports that app-url proof was blocked." : "No app-url proof signal detected." },
    { id: "actor-insight", label: "Actor insight", ok: actorInsightCaptured, detail: actorInsightCaptured ? "Actor evidence mentions feedback, friction, coverage, or observed product behavior." : "Actor evidence does not capture product feedback or coverage insight." }
  ];
  const studySignalCount = studyChecks.filter((check) => check.ok).length;
  const usefulStudy = coverageCustomized && personaCustomized && scenarioCustomized;
  const concreteStudyInsight = actorInsightCaptured || appUrlProofBlocked;
  const studyRating = !configPresent || personaCount === 0 || scenarioCount === 0
    ? "none"
    : usefulStudy && concreteStudyInsight && (appUrlProofMentioned || appUrlProofBlocked)
      ? "high_leverage"
      : usefulStudy
        ? "useful"
        : "ceremonial";
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
    studyQuality: {
      schema: "mimetic.study-quality.v1",
      rating: studyRating,
      summary: "Study-quality rating " + studyRating + " from " + studySignalCount + "/5 app-specific leverage signals" + (appUrlProofBlocked ? "; app-url proof path was blocked by actor evidence." : "."),
      checks: studyChecks,
      signals: {
        appUrlProofBlocked,
        appUrlProofMentioned,
        actorInsightCaptured,
        coverageCustomized,
        personaCustomized,
        scenarioCustomized
      }
    },
    packageScripts,
    mimetic: { configPresent, personaCount, scenarioCount, packageScriptPresent, gitignoreContainsRuntimeIgnore }
  };
};
const setupQuality = buildSetupQuality(appDir);
const safeToken = (value) => String(value || "stream").replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "stream";
const appServerActorEvidence = (() => {
  if (!fs.existsSync(codexAppServerStatePath)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(codexAppServerStatePath, "utf8"));
    const result = state && typeof state === "object" ? state.result || {} : {};
    const readArtifact = (relativePath, maxBytes = 120000) => {
      if (!relativePath || String(relativePath).includes("..") || String(relativePath).includes("://")) return "";
      return readTextLimited(path.join(codexAppServerRootPath, String(relativePath)), maxBytes);
    };
    const readJsonArtifact = (relativePath) => {
      if (!relativePath || String(relativePath).includes("..") || String(relativePath).includes("://")) return null;
      try {
        return JSON.parse(fs.readFileSync(path.join(codexAppServerRootPath, String(relativePath)), "utf8"));
      } catch {
        return null;
      }
    };
    const compactList = (items, mapper, limit = 8) => Array.isArray(items)
      ? items.slice(-limit).map(mapper).filter(Boolean)
      : undefined;
    const projectTraceJson = (value) => {
      if (!value || typeof value !== "object") return null;
      const messages = compactList(value.messages, (message) => message && typeof message === "object" ? {
        ...(message.itemId ? { itemId: cleanText(message.itemId) } : {}),
        ...(message.text ? { text: cleanText(message.text).slice(0, 4000) } : {})
      } : null, 10);
      const commands = compactList(value.commands, (command) => command && typeof command === "object" ? {
        ...(command.itemId ? { itemId: cleanText(command.itemId) } : {}),
        ...(command.command ? { command: cleanText(command.command).slice(0, 2000) } : {}),
        ...(command.cwd ? { cwd: cleanText(command.cwd).slice(0, 500) } : {}),
        ...(command.status ? { status: cleanText(command.status).slice(0, 80) } : {}),
        ...(Number.isFinite(command.exitCode) ? { exitCode: command.exitCode } : {}),
        ...(command.outputTail ? { outputTail: cleanText(command.outputTail).slice(-4000) } : {})
      } : null, 12);
      const fileChanges = compactList(value.fileChanges, (change) => change && typeof change === "object" ? {
        ...(change.itemId ? { itemId: cleanText(change.itemId) } : {}),
        ...(change.status ? { status: cleanText(change.status).slice(0, 80) } : {}),
        ...(Number.isFinite(change.changeCount) ? { changeCount: change.changeCount } : {}),
        ...(change.outputTail ? { outputTail: cleanText(change.outputTail).slice(-2000) } : {})
      } : null, 8);
      return {
        schema: "mimetic.codex-app-server-trace.projected.v1",
        sourceSchema: cleanText(value.schema || ""),
        redaction: value.redaction && typeof value.redaction === "object" ? value.redaction : { status: "passed" },
        status: cleanText(value.status || result.status || state.status || ""),
        reason: cleanText(value.reason || result.reason || state.reason || ""),
        ...(value.counts && typeof value.counts === "object" ? { counts: value.counts } : {}),
        ...(messages && messages.length ? { messages } : {}),
        ...(commands && commands.length ? { commands } : {}),
        ...(fileChanges && fileChanges.length ? { fileChanges } : {}),
        ...(value.tokenUsage && typeof value.tokenUsage === "object" ? { tokenUsage: value.tokenUsage } : {}),
        ...(value.threadId ? { threadId: cleanText(value.threadId) } : {}),
        ...(value.turnId ? { turnId: cleanText(value.turnId) } : {}),
        ...(value.sessionId ? { sessionId: cleanText(value.sessionId) } : {}),
        ...(value.completedAt ? { completedAt: cleanText(value.completedAt) } : {}),
        ...(Number.isFinite(value.durationMs) ? { durationMs: value.durationMs } : {})
      };
    };
    const rawTraceJson = readJsonArtifact(result.tracePath);
    const traceJson = projectTraceJson(rawTraceJson);
    const traceText = traceJson ? "" : readArtifact(result.tracePath, 160000);
    const token = safeToken(streamId);
    return {
      eventsPath: path.join("codex-app-server", token + "-events.ndjson"),
      eventsText: readArtifact(result.eventsPath, 120000),
      reason: cleanText(state.reason || result.reason || ""),
      status: cleanText(state.status || result.status || ""),
      tracePath: path.join("codex-app-server", token + "-summary.json"),
      ...(traceJson ? { traceJson } : { traceText }),
      transcriptPath: path.join("codex-app-server", token + "-transcript.txt"),
      transcriptText: readArtifact(result.transcriptPath, 80000)
    };
  } catch {
    return null;
  }
})();
const nestedStepTraceSummary = (() => {
  try {
    const runRoot = path.dirname(path.dirname(String(nestedObserverPath || "")));
    const tracesDir = path.join(runRoot, "traces");
    if (!fs.existsSync(tracesDir)) return null;
    const traceNames = fs.readdirSync(tracesDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .slice(0, 8);
    if (!traceNames.length) return null;
    const surfaceSummaries = [];
    let scenario = null;
    for (const name of traceNames) {
      let trace = null;
      try {
        trace = JSON.parse(fs.readFileSync(path.join(tracesDir, name), "utf8"));
      } catch {
        continue;
      }
      if (!trace || typeof trace !== "object" || !Array.isArray(trace.steps)) continue;
      if (!scenario && trace.scenario && typeof trace.scenario === "object") {
        scenario = {
          id: cleanText(trace.scenario.id || "scenario"),
          ...(trace.scenario.source ? { source: safeRel(trace.scenario.source) } : {}),
          ...(trace.scenario.sourceDigest ? { sourceDigest: cleanText(trace.scenario.sourceDigest) } : {}),
          ...(Number.isFinite(trace.scenario.stepCount) ? { stepCount: trace.scenario.stepCount } : {}),
          ...(trace.scenario.title ? { title: cleanText(trace.scenario.title) } : {})
        };
      }
      const steps = trace.steps.slice(0, 20).map((step) => {
        const assertions = Array.isArray(step.assertions)
          ? step.assertions.slice(0, 12).map((assertion) => cleanText((assertion.id || "assertion") + ":" + (assertion.status || "unknown")))
          : [];
        return {
          action: cleanText(step.action || "action"),
          ...(assertions.length ? { assertionStatuses: assertions } : {}),
          id: cleanText(step.id || "step"),
          ...(step.label ? { label: cleanText(step.label) } : {}),
          reason: cleanText(step.reason || ""),
          status: step.status === "passed" || step.status === "blocked" ? step.status : "unknown"
        };
      });
      if (!steps.length) continue;
      surfaceSummaries.push({
        id: cleanText(trace.surface && trace.surface.id ? trace.surface.id : path.basename(name, ".json")),
        ...(trace.surface && trace.surface.label ? { label: cleanText(trace.surface.label) } : {}),
        ok: trace.ok === true,
        reason: cleanText(trace.reason || ""),
        steps
      });
    }
    if (!surfaceSummaries.length) return null;
    const totalSteps = surfaceSummaries.reduce((total, surface) => total + surface.steps.length, 0);
    const passedSteps = surfaceSummaries.reduce((total, surface) => total + surface.steps.filter((step) => step.status === "passed").length, 0);
    const blockedSteps = surfaceSummaries.reduce((total, surface) => total + surface.steps.filter((step) => step.status === "blocked").length, 0);
    return {
      schema: "mimetic.oss-meta-nested-step-trace-summary.v1",
      redaction: {
        status: "passed",
        notes: "Projected inside disposable sandbox from nested Mimetic trace JSON; URLs, screenshots, and remote paths are omitted."
      },
      counts: {
        blockedSteps,
        passedSteps,
        surfaces: surfaceSummaries.length,
        totalSteps,
        traces: traceNames.length
      },
      ...(scenario ? { scenario } : {}),
      status: blockedSteps > 0 ? "blocked" : passedSteps === totalSteps ? "passed" : "unknown",
      surfaces: surfaceSummaries
    };
  } catch {
    return null;
  }
})();
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
  ...(appServerActorEvidence ? { appServerActorEvidence } : {}),
  nestedObserverPresent: nestedObserverPresent === "true",
  ...(nestedStepTraceSummary ? { nestedStepTraceSummary } : {}),
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
  elif [[ "\${MIMETIC_OSS_META_CODEX_APP_SERVER:-0}" == "1" && "$ACTOR_STATUS" != "passed" ]]; then
    write_completion "blocked" "Codex app-server mode requires passed Codex app-server actor evidence." "$exit_code"
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
echo "codex_app_server_mode=\${MIMETIC_OSS_META_CODEX_APP_SERVER:-0}"
echo "codex_app_server_client=$([[ -n "$MIMETIC_PRIVATE_CODEX_APP_SERVER_URL" ]] && echo available || echo placeholder)"
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

open_codex_app_server_client() {
  if [[ "\${MIMETIC_OSS_META_CODEX_APP_SERVER:-0}" != "1" ]]; then
    return 0
  fi
  if [[ "$CODEX_APP_SERVER_CLIENT_OPENED" == "1" ]]; then
    return 0
  fi

  echo
  echo "== codex app-server client surface =="
  local client_url="\${CODEX_APP_SERVER_UI_URL:-$MIMETIC_PRIVATE_CODEX_APP_SERVER_URL}"
  if [[ -z "$client_url" ]]; then
    ACTOR_STATUS=blocked
    echo "codex_app_server_client=blocked reason=no real app-server UI URL available"
    return 1
  fi
  echo "codex_app_server_client=provided"
  open_browser_url "$client_url" codex-app-server 430 520 330 420
  CODEX_APP_SERVER_CLIENT_OPENED=1
}

arrange_lab_windows() {
  echo
  echo "== visual desktop layout =="
  VISUAL_STATUS=unknown
  VISUAL_REASON="Window manager proof was not collected."
  VISUAL_WINDOW_COUNT=0
  local expected_chrome_windows=2
  if [[ "\${MIMETIC_OSS_META_CODEX_APP_SERVER:-0}" == "1" ]]; then
    expected_chrome_windows=3
  fi
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
    if [[ "$VISUAL_WINDOW_COUNT" -ge "$expected_chrome_windows" && -n "$observer_window" ]]; then
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
  if [[ "$VISUAL_WINDOW_COUNT" -ge "$expected_chrome_windows" && -n "$observer_window" ]]; then
    VISUAL_STATUS=visible
    if [[ "\${MIMETIC_OSS_META_CODEX_APP_SERVER:-0}" == "1" ]]; then
      VISUAL_REASON="Detected $VISUAL_WINDOW_COUNT visible Chrome windows including target app, nested Observer, and Codex app-server client surface."
    else
      VISUAL_REASON="Detected $VISUAL_WINDOW_COUNT visible Chrome windows including nested Observer; app and Observer windows arranged for screenshot."
    fi
  else
    VISUAL_STATUS=blocked
    if [[ "\${MIMETIC_OSS_META_CODEX_APP_SERVER:-0}" == "1" ]]; then
      VISUAL_REASON="Expected target app, nested Observer, and Codex app-server client browser windows, detected $VISUAL_WINDOW_COUNT visible Chrome window(s)."
    else
      VISUAL_REASON="Expected app and nested Observer browser windows, detected $VISUAL_WINDOW_COUNT visible Chrome window(s)."
    fi
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
      if pnpm root -w >/dev/null 2>&1; then
        PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false npm_config_verify_deps_before_run=false pnpm add --save-dev --workspace-root "$spec" --ignore-scripts
      else
        PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false npm_config_verify_deps_before_run=false pnpm add --save-dev "$spec" --ignore-scripts
      fi
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
  .replace(/github_pat_[A-Za-z0-9_]{12,}/g, "[redacted-github-token]")
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

start_codex_app_server_actor_attempt() {
  echo "Codex app-server mode requested."
  mkdir -p "$CODEX_APP_SERVER_ROOT_PATH"
  cat > "$CODEX_APP_SERVER_PROMPT_PATH" <<'PROMPT'
You are a Mimetic meta-lab actor running through Codex app-server in a disposable authorized repo clone.

Goal: make Mimetic useful for this app, then run at least one meaningful public-safe user-test proof.

Work requirements:
- Inspect package.json, README, routes/components where lightweight, and the running app URL from APP_URL.
- Improve Mimetic setup beyond ceremonial init: app-aware coverage map/matrix, at least two app-specific synthetic personas, and at least two meaningful browser scenarios covering desktop/mobile or happy/friction states.
- Do not leave only starter persona/scenario filenames, ids, or names. Write app-specific persona and scenario files with app-specific ids, names, goals, selectors, and expectations.
- Use committed mimetic/ source files for personas/scenarios. Keep runtime output under ignored .mimetic/.
- Run at least one meaningful Mimetic proof against the running app URL when available: npx --no-install mimetic run --app-url "$APP_URL" --sims 2.
- Render or refresh the nested Observer with npx --no-install mimetic watch --run latest --detach --no-open when feasible.
- Finish with concise public-safe feedback: what user journey was tested, what evidence path proves it, and one useful product or Mimetic harness improvement.

Safety:
- Do not print secrets, environment values, raw private source, or private screenshots.
- Do not commit, push, file issues, or mutate remotes.
- Do not run provider-spend-heavy commands beyond the bounded Mimetic/Codex proof.
PROMPT

  local timeout_ms="\${MIMETIC_OSS_META_ACTOR_TIMEOUT_MS:-480000}"
  local command
  command="APP_URL=$(printf '%q' "$APP_URL") MIMETIC_PRIVATE_CODEX_API_KEY=$(printf '%q' "$MIMETIC_PRIVATE_CODEX_API_KEY") MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN=$(printf '%q' "$MIMETIC_PRIVATE_CODEX_ACCESS_TOKEN") npx --no-install mimetic codex app-server --cwd $(printf '%q' "$APP_DIR") --run-root $(printf '%q' "$CODEX_APP_SERVER_ROOT_PATH") --state-file $(printf '%q' "$CODEX_APP_SERVER_STATE_PATH") --prompt-file $(printf '%q' "$CODEX_APP_SERVER_PROMPT_PATH") --timeout-ms $(printf '%q' "$timeout_ms") --port $(printf '%q' "$CODEX_APP_SERVER_PORT") --sandbox danger-full-access --actor-command 'npx -y @openai/codex@latest app-server --listen stdio://' --keep-open"
  nohup bash -lc "$command" > "$CODEX_APP_SERVER_LOG_PATH" 2>&1 &
  ACTOR_PID=$!
  ACTOR_STATUS=running
  CODEX_APP_SERVER_UI_URL="http://127.0.0.1:$CODEX_APP_SERVER_PORT/"
  echo "actor_status=$ACTOR_STATUS source=codex-app-server pid=$ACTOR_PID log=$CODEX_APP_SERVER_LOG_PATH state=$CODEX_APP_SERVER_STATE_PATH"
  echo "codex_app_server_trace=codex-app-server/summary.json"
  echo "codex_app_server_events=codex-app-server/events.ndjson"
  echo "codex_app_server_transcript=codex-app-server/transcript.txt"
  wait_for_http "$CODEX_APP_SERVER_UI_URL" 60000 500 || true
  open_codex_app_server_client || true
}

write_app_specific_browser_scenario() {
  if [[ "$APP_STATUS" != "running" || -z "$APP_URL" ]]; then
    return 0
  fi

  node - "$APP_DIR" "$APP_URL" <<'NODE' || true
const fs = require("node:fs");
const path = require("node:path");
const [appDir, appUrl] = process.argv.slice(2);
const clean = (value, fallback = "") => String(value || fallback)
  .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[redacted-openai-key]")
  .replace(/e2b_[A-Za-z0-9_-]{12,}/g, "[redacted-e2b-key]")
  .replace(/(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})/g, "[redacted-github-token]")
  .replace(/https?:\\/\\/[^\\s]+/g, "[redacted-url]")
  .replace(/\\s+/g, " ")
  .trim()
  .slice(0, 160);
const yamlScalar = (value) => clean(value, "").replace(/'/g, "''");
const token = (value, fallback) => clean(value, fallback).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
const visibleTextFromHtml = (html) => clean(html
  .replace(/<script[\\s\\S]*?<\\/script>/gi, " ")
  .replace(/<style[\\s\\S]*?<\\/style>/gi, " ")
  .replace(/<[^>]+>/g, " "), "");
const titleFromHtml = (html) => {
  const match = html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i);
  return clean(match ? match[1] : "", "");
};
(async () => {
  try {
    const response = await fetch(appUrl);
    const html = await response.text();
    const title = titleFromHtml(html);
    const bodyText = visibleTextFromHtml(html);
    const expectedText = clean(bodyText.split(/[.!?\\n]/).find((part) => clean(part, "").length >= 4) || title, "");
    const scenarioId = token(title || "app-surface-browser", "app-surface-browser");
    const scenarioPath = path.join(appDir, "mimetic", "scenarios", "app-surface-browser.yaml");
    fs.mkdirSync(path.dirname(scenarioPath), { recursive: true });
    const lines = [
      "schema: mimetic.scenario.v1",
      "id: " + scenarioId,
      "title: App surface browser proof",
      "persona: synthetic-new-user",
      "goal: Prove the running app exposes a public-safe browser surface for synthetic users.",
      "mode: browser",
      "browser:",
      "  startPath: /",
      "  steps:",
      "    - id: app-surface-load",
      "      label: Load the running app surface",
      "      action: goto",
      "      path: /",
      "      expect:",
      "        selectorVisible: body",
      ...(expectedText ? [
        "        text: '" + yamlScalar(expectedText) + "'"
      ] : []),
      "    - id: app-surface-ready",
      "      label: Confirm the browser can observe the app body",
      "      action: waitForSelector",
      "      selector: body"
    ];
    fs.writeFileSync(scenarioPath, lines.join("\\n") + "\\n");
    console.log("browser_scenario=authored path=mimetic/scenarios/app-surface-browser.yaml expected_text=" + (expectedText ? "present" : "absent"));
  } catch (error) {
    console.log("browser_scenario=skipped reason=" + clean(error && error.message ? error.message : error, "unknown"));
  }
})();
NODE
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
    write_app_specific_browser_scenario || true
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
  if [[ "\${MIMETIC_OSS_META_CODEX_APP_SERVER:-0}" == "1" ]]; then
    start_codex_app_server_actor_attempt
    return 0
  fi

  local actor_script="$ROOT_DIR/actor-run.sh"
  cat > "$actor_script" <<ACTOR
#!/usr/bin/env bash
set +e
APP_DIR="$APP_DIR"
if [[ "\${MIMETIC_OSS_META_ACTOR_FIRST:-0}" == "1" ]]; then
  PROMPT='You are a Mimetic meta-lab actor running in a disposable public-safe repo clone. Your goal is useful product-specific user-study setup, not ceremonial install proof. Inspect package.json, README, routes, scripts, and the running app shape. Install mimetic-cli as a dev dependency with the repo package manager if needed; package=mimetic-cli, binary=mimetic. Run npx --no-install mimetic init --yes if Mimetic is not initialized. Replace starter mimetic/coverage-map.md and mimetic/coverage-matrix.md with app-aware screens, roles, states, happy paths, and at least one sad/friction path. Author at least two public-safe app-specific personas and two desktop/mobile browser scenarios; avoid generic first-run-smoke only. Start the local app if feasible. Run npx --no-install mimetic run --help and verify --app-url is available. If the local binary is missing, install mimetic-cli; one-shot fallback is npx --yes --package mimetic-cli@latest mimetic run --help. If the app is running locally, run npx --no-install mimetic run --app-url <loopback-url> --sims 2; do not use mimetic watch --sims as app behavior proof. After run --app-url, render or open the nested Mimetic Observer with npx --no-install mimetic watch --run latest --detach --no-open --json if feasible. Final summary must include personas/scenarios created, product journeys covered, one observed friction/improvement or none observed, and evidence paths. Do not stop at install/init proof. Do not wait on long-running watchers after rendering proof. Do not print secrets, do not commit, do not push, and do not file issues.'
else
  PROMPT='You are a Mimetic meta-lab actor. Inspect this repo, inspect the running app and Mimetic artifacts already generated here, and draft the best next public-safe personas and desktop/mobile browser scenarios for human users of this app. Once the draft is written, exit successfully. Do not wait on long-running watchers. Do not print secrets, do not commit, do not push, and do not file issues.'
fi
printf -v app_dir_q '%q' "\\$APP_DIR"
printf -v prompt_q '%q' "\\$PROMPT"
printf -v actor_message_q '%q' "$ACTOR_LAST_MESSAGE_PATH"
ACTOR_MODEL="\${MIMETIC_OSS_META_ACTOR_MODEL:-gpt-5.4-mini}"
ACTOR_TIMEOUT_MS="\${MIMETIC_OSS_META_ACTOR_TIMEOUT_MS:-480000}"
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
  if [[ "\${MIMETIC_OSS_META_REQUIRE_ACTOR:-0}" != "1" && "\${MIMETIC_OSS_META_CODEX_APP_SERVER:-0}" != "1" ]]; then
    return 0
  fi

  echo
  echo "== required codex actor readback =="
  if [[ "\${MIMETIC_OSS_META_CODEX_APP_SERVER:-0}" == "1" ]]; then
    local timeout_ms="\${MIMETIC_OSS_META_ACTOR_TIMEOUT_MS:-480000}"
    local started_ms
    started_ms="$(date +%s%3N)"
    local next_heartbeat_ms=$((started_ms + 15000))
    while true; do
      local status_line
      status_line="$(node - "$CODEX_APP_SERVER_STATE_PATH" <<'NODE' 2>/dev/null || true
const fs = require("node:fs");
const [statePath] = process.argv.slice(2);
if (!fs.existsSync(statePath)) process.exit(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
console.log(String(state.status || "unknown"));
NODE
)"
      if [[ "$status_line" != "starting" && "$status_line" != "running" && "$status_line" != "unknown" && -n "$status_line" ]]; then
        ACTOR_STATUS="$status_line"
        break
      fi
      local now_ms
      now_ms="$(date +%s%3N)"
      if [[ "$now_ms" -ge "$next_heartbeat_ms" ]]; then
        echo "actor_status=running source=codex-app-server elapsed_ms=$((now_ms - started_ms)) state=$CODEX_APP_SERVER_STATE_PATH log=$CODEX_APP_SERVER_LOG_PATH"
        echo "actor_log_tail_begin"
        tail -n 20 "$CODEX_APP_SERVER_LOG_PATH" || true
        echo "actor_log_tail_end"
        next_heartbeat_ms=$((now_ms + 15000))
      fi
      if [[ $((now_ms - started_ms)) -ge "$timeout_ms" ]]; then
        ACTOR_STATUS=timed_out
        echo "actor_status=$ACTOR_STATUS timeout_ms=$timeout_ms state=$CODEX_APP_SERVER_STATE_PATH log=$CODEX_APP_SERVER_LOG_PATH"
        return 1
      fi
      sleep 1
    done
    echo "actor_status=$ACTOR_STATUS source=codex-app-server state=$CODEX_APP_SERVER_STATE_PATH log=$CODEX_APP_SERVER_LOG_PATH"
    echo "actor_log_tail_begin"
    tail -n 80 "$CODEX_APP_SERVER_LOG_PATH" || true
    echo "actor_log_tail_end"
    if [[ -f "$CODEX_APP_SERVER_ROOT_PATH/codex-app-server/summary.json" ]]; then
      node - "$CODEX_APP_SERVER_ROOT_PATH/codex-app-server/summary.json" "$ACTOR_LAST_MESSAGE_PATH" <<'NODE' || true
const fs = require("node:fs");
const [summaryPath, outPath] = process.argv.slice(2);
const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const messages = Array.isArray(summary.messages) ? summary.messages : [];
const text = messages
  .slice(-4)
  .map((message) => typeof message?.text === "string" ? message.text : "")
  .filter(Boolean)
  .join("\\n\\n")
  .slice(-12000);
fs.writeFileSync(outPath, text || "No final Codex app-server agent message captured.\\n");
NODE
    elif [[ -f "$CODEX_APP_SERVER_ROOT_PATH/codex-app-server/transcript.txt" ]]; then
      tail -n 80 "$CODEX_APP_SERVER_ROOT_PATH/codex-app-server/transcript.txt" > "$ACTOR_LAST_MESSAGE_PATH" || true
    fi
    [[ "$ACTOR_STATUS" == "passed" ]]
    return $?
  fi

  if [[ -z "$ACTOR_PID" ]]; then
    ACTOR_STATUS=blocked
    echo "actor_status=$ACTOR_STATUS reason=no actor process was started"
    return 1
  fi

  local timeout_ms="\${MIMETIC_OSS_META_ACTOR_TIMEOUT_MS:-480000}"
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
clone_repo() {
  local repo_url=${shellQuote(repoUrl)}
  if GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ASKPASS=false SSH_ASKPASS=false GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone --depth=1 "$repo_url" "$APP_DIR"; then
    echo "clone_auth=anonymous"
    return 0
  fi
  echo "clone_auth=anonymous_failed retry=token_clone"
  rm -rf "$APP_DIR"

  if [[ -n "$MIMETIC_PRIVATE_GITHUB_TOKEN" ]]; then
    if GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 MIMETIC_GITHUB_TOKEN_RUNTIME="$MIMETIC_PRIVATE_GITHUB_TOKEN" git -c credential.helper= clone --depth=1 "$repo_url" "$APP_DIR"; then
      echo "clone_auth=token"
      return 0
    fi
    echo "clone_auth=token_failed"
    rm -rf "$APP_DIR"
  fi

  return 1
}
clone_repo
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
if [[ "\${MIMETIC_OSS_META_ACTOR_FIRST:-0}" == "1" && "\${MIMETIC_OSS_META_HOST_CODEX_ACTOR:-0}" != "1" && "\${MIMETIC_OSS_META_CODEX_APP_SERVER:-0}" != "1" ]]; then
  start_actor_attempt
  wait_for_actor_attempt_if_required || true
fi

echo
install_mimetic_cli

echo
echo "== mimetic init =="
npx --no-install mimetic init --yes
apply_host_actor_plan || true

start_target_app_surface

if [[ "\${MIMETIC_OSS_META_CODEX_APP_SERVER:-0}" == "1" && "\${MIMETIC_OSS_META_HOST_CODEX_ACTOR:-0}" != "1" ]]; then
  start_actor_attempt
  wait_for_actor_attempt_if_required || true
fi

echo
echo "== nested mimetic proof =="
if [[ "$APP_STATUS" == "running" && -n "$APP_URL" ]]; then
  npx --no-install mimetic run --app-url "$APP_URL" --sims 2 --run-id ${shellQuote(runId)}
else
  echo "app_not_running_for_browser_proof=$APP_REASON"
  npx --no-install mimetic run --dry-run --run-id ${shellQuote(runId)}
fi
if npx --no-install mimetic verify --run latest; then
  NESTED_VERIFY_STATUS=passed
else
  NESTED_VERIFY_STATUS=failed
  exit 1
fi
npx --no-install mimetic watch --run latest --detach --no-open
open_nested_observer "opening nested observer"
open_codex_app_server_client
arrange_lab_windows
if [[ "\${MIMETIC_OSS_META_ACTOR_FIRST:-0}" != "1" && "\${MIMETIC_OSS_META_HOST_CODEX_ACTOR:-0}" != "1" && "\${MIMETIC_OSS_META_CODEX_APP_SERVER:-0}" != "1" ]]; then
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
EXPECTED_CHROME_WINDOWS=2
if [[ "\${MIMETIC_OSS_META_CODEX_APP_SERVER:-0}" == "1" ]]; then
  EXPECTED_CHROME_WINDOWS=3
fi
if ! command -v xdotool >/dev/null 2>&1; then
  exit 0
fi
for attempt in $(seq 1 24); do
  CHROME_COUNT="$(xdotool search --onlyvisible --class google-chrome 2>/dev/null | wc -l | tr -d ' ')"
  OBSERVER_WINDOW="$(xdotool search --onlyvisible --name "Mimetic Observer" 2>/dev/null | tail -n 1 || true)"
  if [[ "$CHROME_COUNT" -ge "$EXPECTED_CHROME_WINDOWS" && -n "$OBSERVER_WINDOW" ]]; then
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

function formatLiveDesktopForResult(desktop: OssMetaLabLiveDesktop, redactRepoNames: boolean): OssMetaLabResult["sandboxes"][number] {
  return {
    ...(desktop.completion?.actorStatus ? { actorStatus: desktop.completion.actorStatus } : {}),
    ...(desktop.completion?.appStatus ? { appStatus: desktop.completion.appStatus } : {}),
    ...(desktop.bootstrap ? { bootstrapStatus: desktop.bootstrap.status } : {}),
    ...(desktop.completion ? { completionReason: desktop.completion.reason, completionStatus: desktop.completion.status } : {}),
    repo: desktop.repo,
    ...(desktop.screenshot ? { screenshotPresent: true } : {}),
    ...(!redactRepoNames && desktop.sandboxId ? { sandboxId: desktop.sandboxId } : {}),
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
    .replace(/github_pat_[A-Za-z0-9_]{12,}/g, "[redacted-github-token]")
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
  id?: string;
  metadata?: Record<string, string>;
  sandboxID?: string;
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
