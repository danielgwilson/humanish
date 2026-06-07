import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Browser, Page } from "playwright-core";
import { parse as parseYaml } from "yaml";

import {
  CODEX_APP_SERVER_TRACE_SCHEMA,
  type CodexAppServerRunResult,
  type CodexAppServerTrace
} from "./codex-app-server.js";
import { getActor } from "./actor-registry.js";
import type { ActorTrace } from "./actor-contract.js";
import { captureGitState, GIT_STATE_SCHEMA, type CapturedGitState } from "./core/git-state.js";
import { buildObserverData } from "./observer-data.js";
import { parseResolvedPersona, personaToDirectives, renderPersonaPromptSection, type ResolvedPersona } from "./persona.js";
import { containsSensitive, digestText, redactToSecretLabel } from "./redaction.js";

export const RUN_BUNDLE_SCHEMA = "mimetic.run-bundle.v1";
export const REVIEW_SCHEMA = "mimetic.review.v1";
export const VERIFY_SCHEMA = "mimetic.verify-result.v1";
export const RUNS_SCHEMA = "mimetic.runs-result.v1";
export const DOCTOR_SCHEMA = "mimetic.doctor-result.v1";
export const PUBLIC_TARGET_CWD = "[target-cwd]";
const SAFE_GIT_NOTES = new Set([
  "Git command could not be started.",
  "Git status command could not be captured.",
  "Git status command could not be started.",
  "Git work tree had changes; only counts were captured, not branch names, remotes, paths, or file names.",
  "Git work tree was clean; branch names, remotes, paths, and file names were not captured.",
  "No git work tree was detected.",
  "public-safe synthetic fixture",
  "public-safe synthetic OSS meta-lab fixture"
]);

export interface RunOptions {
  cwd: string;
  actor?: string;
  actorCommand?: string[];
  appUrl?: string;
  dryRun?: boolean;
  runId?: string;
  simCount?: number;
  timeoutMs?: number;
}

export type RunStreamKind = "ui" | "browser" | "terminal" | "tui" | "codex-ui" | "artifact" | "summary";

export type RunSimulationStatus =
  | "queued"
  | "preparing"
  | "running"
  | "passed"
  | "complete"
  | "blocked"
  | "timed_out"
  | "failed"
  | "contract_proof_only";

export interface RunStreamCompletion {
  actorLogPath?: string;
  actorLogTail?: string;
  actorLastMessageTail?: string;
  actorPid?: number;
  actorStatus?: "not_started" | "running" | "passed" | "failed" | "blocked" | "timed_out" | "suspended" | "unknown";
  appLogPath?: string;
  appPid?: number;
  appReason?: string;
  appStatus?: "not_started" | "running" | "blocked" | "failed" | "missing" | "unknown";
  appUrl?: string;
  checkedAt: string;
  exitCode?: number;
  logTail?: string;
  nestedObserverPresent?: boolean;
  nestedVerifyPassed?: boolean;
  reason: string;
  status: "running" | "passed" | "failed" | "blocked" | "timed_out";
  visualReason?: string;
  visualStatus?: "not_started" | "visible" | "blocked" | "unknown";
  visualWindowCount?: number;
  meaningfulUse?: RunMeaningfulUseScore;
}

export interface RunSetupQualitySnapshot {
  schema: "mimetic.setup-quality.v1";
  generatedAt: string;
  redaction: {
    status: "passed";
    rawPreviews: "included" | "suppressed";
    notes: string;
  };
  summary: string;
  status: "passed" | "needs_review" | "blocked";
  checks: Array<{
    id: string;
    label: string;
    ok: boolean;
    detail: string;
  }>;
  tree: Array<{
    path: string;
    type: "file" | "directory";
    sizeBytes?: number;
  }>;
  previews: Array<{
    path: string;
    language: "json" | "yaml" | "typescript" | "markdown" | "text";
    truncated: boolean;
    text: string;
  }>;
  studyQuality?: {
    schema: "mimetic.study-quality.v1";
    rating: "none" | "ceremonial" | "useful" | "high_leverage";
    summary: string;
    checks: Array<{
      id: string;
      label: string;
      ok: boolean;
      detail: string;
    }>;
    signals: {
      appUrlProofBlocked: boolean;
      appUrlProofMentioned: boolean;
      actorInsightCaptured: boolean;
      coverageCustomized: boolean;
      personaCustomized: boolean;
      scenarioCustomized: boolean;
    };
  };
  packageScripts: Record<string, string>;
  mimetic: {
    configPresent: boolean;
    personaCount: number;
    scenarioCount: number;
    packageScriptPresent: boolean;
    gitignoreContainsRuntimeIgnore: boolean;
  };
}

export interface RunMeaningfulUseScore {
  schema: "mimetic.meaningful-use-score.v1";
  status: "pass" | "partial" | "fail";
  score: number;
  summary: string;
  hardFailures: string[];
  components: Array<{
    id:
      | "setup-correctness"
      | "filesystem-evidence"
      | "nested-mimetic-evidence"
      | "actor-activity"
      | "product-surface"
      | "feedback-quality";
    label: string;
    status: "pass" | "partial" | "fail";
    score: number;
    detail: string;
  }>;
}

export interface RunFeedbackCandidate {
  schema: "mimetic.feedback-candidate.v1";
  id: string;
  run_id: string;
  stream_id?: string;
  adapter_id: string;
  scenario_id: string;
  persona_id: string;
  actor: "codex-tui" | "codex-exec" | "codex-app-server" | "synthetic-dry-run" | "unknown";
  substrate: "e2b-desktop" | "local-filesystem" | "codex-app-server" | "unknown";
  failure_owner: "harness" | "target-app" | "actor" | "environment" | "unknown";
  summary: string;
  expected: string;
  actual: string;
  evidence: Array<{
    path: string;
    kind: "review" | "state" | "log" | "trace" | "screenshot" | "filesystem";
    note: string;
  }>;
  redaction: {
    status: "passed";
    notes: string;
  };
  idempotency_key: string;
  proposed_next_state: "watch" | "adapter-hardening" | "target-app-setup" | "actor-auth" | "setup-quality-review" | "study-quality-review";
  acceptance_proof: string[];
}

export interface RunSimulation {
  id: string;
  index: number;
  personaId: string;
  scenarioId: string;
  status: RunSimulationStatus;
  streamKind: RunStreamKind;
  mode: "browser-sim" | "cli-sim" | "tui-sim" | "codex-app-sim";
  progress: number;
  currentStep: string;
  summary: string;
  streamIds: string[];
  startedAt: string;
  updatedAt: string;
}

export interface RunStream {
  id: string;
  simId: string;
  kind: RunStreamKind;
  label: string;
  status: RunSimulationStatus;
  transport: "snapshot" | "polling" | "sse" | "pty" | "app-server";
  updatedAt: string;
  url?: string;
  embed?: {
    kind: "iframe" | "terminal" | "screenshot" | "placeholder";
    url?: string;
    title?: string;
  };
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    isMobile?: boolean;
  };
  terminal?: {
    title: string;
    format: "ansi" | "plain";
    stdin: "disabled" | "planned" | "sent";
    tail: string;
  };
  ui?: {
    actorStatus?: string;
    appStatus?: string;
    appUrl?: string;
    route?: string;
    intent?: string;
    nestedObserverPath?: string;
    nestedObserverUrl?: string;
    screenshotUrl?: string;
    state?: string;
    visualStatus?: string;
  };
  codex?: {
    provider: "codex-app-server";
    eventCount?: number;
    experimentalApi?: boolean;
    model?: string;
    sessionId?: string;
    state: "not_connected" | "connecting" | "watching" | "running" | "completed" | "failed" | "blocked" | "timed_out";
    contract: string;
    threadId?: string;
    trace?: CodexAppServerTrace;
    tracePath?: string;
    turnId?: string;
  };
  // Provider-neutral projection of the actor's evidence (mimetic.actor-trace.v1).
  // Populated alongside the raw `codex` evidence; carries persona.traitsApplied.
  actor?: ActorTrace;
  completion?: RunStreamCompletion;
  artifacts: Array<{
    label: string;
    path: string;
    kind: "bundle" | "review" | "observer" | "events" | "screenshot" | "trace" | "log" | "filesystem";
  }>;
}

export interface RunEvent {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  type: string;
  message: string;
  simId?: string;
  streamId?: string;
}

export interface RunBundle {
  schema: typeof RUN_BUNDLE_SCHEMA;
  runId: string;
  mode: "dry-run" | "live";
  simCount: number;
  createdAt: string;
  cwd: string;
  artifactRoot: string;
  source: {
    packageName: string | null;
    mimeticSource: "present" | "missing";
    git: CapturedGitState;
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
  simulations: RunSimulation[];
  streams: RunStream[];
  events: RunEvent[];
  redaction: {
    status: "passed";
    notes: string;
  };
  artifacts: {
    run: string;
    reviewJson: string;
    reviewMarkdown: string;
    observerData: string;
    events: string;
  };
  review: ReviewSummary;
  feedbackCandidates: RunFeedbackCandidate[];
}

export interface ReviewSummary {
  schema: typeof REVIEW_SCHEMA;
  verdict: "contract_proof_only" | "pass" | "fail" | "blocked" | "timed_out";
  summary: string;
  gaps: string[];
}

export async function buildRunSource(args: {
  cwd: string;
  capturedAt?: Date | string;
  mimeticSource: RunBundle["source"]["mimeticSource"];
  packageName: string | null;
}): Promise<RunBundle["source"]> {
  const gitOptions = args.capturedAt === undefined ? {} : { capturedAt: args.capturedAt };
  return {
    packageName: args.packageName,
    mimeticSource: args.mimeticSource,
    git: await captureGitState(args.cwd, gitOptions)
  };
}

export interface RunResult {
  schema: "mimetic.run-result.v1";
  ok: boolean;
  runId?: string;
  mode?: "dry-run" | "live";
  simCount?: number;
  cwd: string;
  artifactRoot?: string;
  bundlePath?: string;
  reviewPath?: string;
  latestPath?: string;
  warnings: string[];
  error?: {
    code:
      | "MIMETIC_ACTOR_FANOUT_UNIMPLEMENTED"
      | "MIMETIC_APP_URL_OPTION_CONFLICT"
      | "MIMETIC_BROWSER_APP_CAPTURE_FAILED"
      | "MIMETIC_CODEX_APP_SERVER_FAILED"
      | "MIMETIC_LIVE_RUN_UNIMPLEMENTED"
      | "MIMETIC_LOCAL_CODEX_EXEC_FAILED"
      | "MIMETIC_LOCAL_CODEX_TUI_FAILED"
      | "MIMETIC_INVALID_APP_URL"
      | "MIMETIC_INVALID_ACTOR_CONCURRENCY"
      | "MIMETIC_INVALID_CWD"
      | "MIMETIC_INVALID_SIM_COUNT"
      | "MIMETIC_INVALID_TIMEOUT"
      | "MIMETIC_INVALID_PORT"
      | "MIMETIC_UNSUPPORTED_ACTOR"
      | "MIMETIC_WATCH_OPTION_CONFLICT";
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

const CODEX_APP_SERVER_PROJECTED_TRACE_SCHEMA = "mimetic.codex-app-server-trace.projected.v1";

const LOCAL_CODEX_TUI_DEFAULT_TIMEOUT_MS = 240_000;
const LOCAL_CODEX_TUI_MAX_TIMEOUT_MS = 600_000;
const LOCAL_ACTOR_TRANSCRIPT_MAX_CHARS = 80_000;
const LOCAL_CODEX_EXEC_DEFAULT_MAX_CONCURRENCY = 4;
const BROWSER_APP_DEFAULT_TIMEOUT_MS = 60_000;

const execFileAsync = promisify(execFile);

type LocalCodexActor = "codex-tui" | "codex-exec" | "codex-app-server";

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

  if (options.actor !== undefined && !isLocalCodexActor(options.actor)) {
    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd,
      warnings,
      error: {
        code: "MIMETIC_UNSUPPORTED_ACTOR",
        message: `Unsupported actor: ${options.actor}`
      }
    };
  }

  const simCount = normalizeSimCount(options.appUrl ? options.simCount ?? 2 : options.simCount);
  if (simCount === null) {
    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd,
      warnings,
      error: {
        code: "MIMETIC_INVALID_SIM_COUNT",
        message: "--sims must be a positive integer."
      }
    };
  }

  if (options.appUrl !== undefined) {
    if (options.dryRun) {
      return {
        schema: "mimetic.run-result.v1",
        ok: false,
        cwd,
        warnings,
        error: {
          code: "MIMETIC_APP_URL_OPTION_CONFLICT",
          message: "Use --app-url for a live browser app proof; remove --dry-run."
        }
      };
    }

    if (simCount > 2) {
      return {
        schema: "mimetic.run-result.v1",
        ok: false,
        cwd,
        warnings,
        error: {
          code: "MIMETIC_INVALID_SIM_COUNT",
          message: "--sims must be 1 or 2 when --app-url is used."
        }
      };
    }

    return runBrowserAppProof({ ...options, appUrl: options.appUrl, cwd, simCount });
  }

  if (!options.dryRun) {
    const actor = resolveRequestedLocalCodexActor(options.actor);
    if (actor === "codex-tui") {
      return runLocalCodexTui({ ...options, actor, cwd, simCount });
    }
    if (actor === "codex-exec") {
      return runLocalCodexExec({ ...options, actor, cwd, simCount });
    }
    if (actor === "codex-app-server") {
      return runLocalCodexAppServer({ ...options, actor, cwd, simCount });
    }

    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd,
      warnings,
      error: {
        code: "MIMETIC_LIVE_RUN_UNIMPLEMENTED",
        message: "Only run --dry-run is implemented unless --actor codex-tui, --actor codex-exec, --actor codex-app-server, or the matching MIMETIC_ENABLE_LOCAL_CODEX_* env var is set."
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
  const source = await buildRunSource({ cwd, capturedAt: createdAt, mimeticSource, packageName });
  const selection = await loadDryRunSelection(cwd, mimeticSource);

  if (mimeticSource === "missing") {
    warnings.push("Committed mimetic/ source was not found; using built-in synthetic dry-run defaults.");
  }
  warnings.push(...selection.warnings);

  const observerFixtures = buildSyntheticObserverFixtures({
    createdAt,
    personaId: selection.persona.id,
    scenarioId: selection.scenario.id,
    simCount
  });

  const bundle: RunBundle = {
    schema: RUN_BUNDLE_SCHEMA,
    runId,
    mode: "dry-run",
    simCount,
    createdAt,
    cwd,
    artifactRoot,
    source,
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
    simulations: observerFixtures.simulations,
    streams: observerFixtures.streams,
    events: observerFixtures.events,
    redaction: {
      status: "passed",
      notes: "Dry-run bundle contains synthetic contract proof only."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review: createReviewSummary(),
    feedbackCandidates: []
  };

  await mkdir(absoluteArtifactRoot, { recursive: true });
  await writeRunBundleArtifacts(absoluteArtifactRoot, bundle);
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

interface BrowserSurface {
  id: "desktop" | "mobile";
  label: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    isMobile: boolean;
  };
}

interface BrowserSurfaceCapture {
  capturedAt: string;
  durationMs: number;
  httpStatus?: number;
  ok: boolean;
  reason: string;
  screenshotPath: string;
  steps: BrowserPersonaStepCapture[];
  surface: BrowserSurface;
  tracePath: string;
}

type BrowserPersonaAction = "goto" | "click" | "fill" | "assertText" | "waitForText" | "waitForSelector";

interface BrowserPersonaAssertionCapture {
  id: string;
  reason: string;
  status: "passed" | "blocked";
}

interface BrowserPersonaStepCapture {
  action: string;
  assertions?: BrowserPersonaAssertionCapture[];
  completedAt: string;
  durationMs: number;
  id: string;
  label: string;
  reason: string;
  screenshotPath: string;
  status: "passed" | "blocked";
  url: string;
}

interface BrowserPersonaStepExpectation {
  selectorVisible?: string;
  stateChanged?: boolean;
  text?: string;
  urlIncludes?: string;
}

interface BrowserPersonaStepManifest {
  action: BrowserPersonaAction;
  expectation?: BrowserPersonaStepExpectation;
  id: string;
  label: string;
  path?: string;
  selector?: string;
  value?: string;
}

interface BrowserPersonaJourney {
  goal: string;
  scenarioId: string;
  scenarioTitle: string;
  source: string;
  sourceDigest: string;
  startPath: string;
  steps: BrowserPersonaStepManifest[];
}

const browserSurfaces: BrowserSurface[] = [
  {
    id: "desktop",
    label: "Desktop browser surface",
    viewport: {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      isMobile: false
    }
  },
  {
    id: "mobile",
    label: "Mobile browser surface",
    viewport: {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      isMobile: true
    }
  }
];

async function runBrowserAppProof(options: RunOptions & {
  appUrl: string;
  cwd: string;
  simCount: number;
}): Promise<RunResult> {
  const warnings: string[] = [];
  const appUrl = normalizeLocalAppUrl(options.appUrl);
  if (!appUrl) {
    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "MIMETIC_INVALID_APP_URL",
        message: "--app-url must be an http(s) loopback URL such as http://127.0.0.1:5173."
      }
    };
  }

  const browserCommand = await resolveBrowserCommand();
  if (!browserCommand) {
    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "MIMETIC_BROWSER_APP_CAPTURE_FAILED",
        message: "No Chrome/Chromium browser command was found. Set MIMETIC_BROWSER_COMMAND to a browser binary that supports --headless and --screenshot."
      }
    };
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const runId = options.runId ?? `browser-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const artifactRoot = path.join(".mimetic", "runs", runId);
  const absoluteArtifactRoot = path.join(options.cwd, artifactRoot);
  const packageName = await readPackageName(options.cwd);
  const mimeticSource = await directoryExists(path.join(options.cwd, "mimetic")) ? "present" : "missing";
  const source = await buildRunSource({ cwd: options.cwd, capturedAt: createdAt, mimeticSource, packageName });
  const selection = await loadDryRunSelection(options.cwd, mimeticSource);
  if (selection.browserJourneyFailure) {
    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings: [...warnings, ...selection.warnings],
      error: {
        code: "MIMETIC_BROWSER_APP_CAPTURE_FAILED",
        message: selection.browserJourneyFailure
      }
    };
  }

  const browserJourney = selection.browserJourney ?? builtinBrowserPersonaJourney();
  if (mimeticSource === "missing") {
    warnings.push("Committed mimetic/ source was not found; using built-in synthetic browser-app defaults.");
  }
  if (!selection.browserJourney) {
    warnings.push("No executable browser scenario manifest was found; using built-in browser persona two-step journey.");
  }
  warnings.push(...selection.warnings);

  await mkdir(path.join(absoluteArtifactRoot, "screenshots"), { recursive: true });
  await mkdir(path.join(absoluteArtifactRoot, "traces"), { recursive: true });

  const surfaces = browserSurfaces.slice(0, options.simCount);
  const captures = await Promise.all(surfaces.map((surface) => captureBrowserSurface({
    absoluteArtifactRoot,
    appUrl,
    browserCommand,
    browserJourney,
    surface,
    timeoutMs: options.timeoutMs ?? BROWSER_APP_DEFAULT_TIMEOUT_MS
  })));
  const completedAt = new Date().toISOString();
  const events = buildBrowserAppEvents({ appUrl, captures, createdAt });
  const allPassed = captures.every((capture) => capture.ok);
  const review = createBrowserAppReviewSummary({ appUrl, browserJourney, captures });
  const bundle: RunBundle = {
    schema: RUN_BUNDLE_SCHEMA,
    runId,
    mode: "live",
    simCount: captures.length,
    createdAt,
    cwd: options.cwd,
    artifactRoot,
    source,
    persona: {
      id: selection.persona.id,
      name: selection.persona.name,
      source: selection.persona.source,
      sourceDigest: selection.persona.sourceDigest
    },
    scenario: {
      id: browserJourney.scenarioId,
      title: browserJourney.scenarioTitle,
      goal: browserJourney.goal,
      source: browserJourney.source,
      sourceDigest: browserJourney.sourceDigest
    },
    lifecycle: [
      {
        at: createdAt,
        event: "run.created",
        message: `Live browser persona proof created for ${appUrl}.`
      },
      {
        at: createdAt,
        event: "app.url.accepted",
        message: "Accepted public-safe loopback app URL for browser persona journey."
      },
      {
        at: completedAt,
        event: "review.created",
        message: allPassed
          ? "Created review from desktop/mobile browser persona step evidence."
          : "Created review with missing or blocked browser persona step evidence."
      }
    ],
    simulations: captures.map((capture, index) => {
      const simId = `browser-${capture.surface.id}`;
      const streamId = `${simId}-stream`;
      return {
        id: simId,
        index: index + 1,
        personaId: selection.persona.id,
        scenarioId: browserJourney.scenarioId,
        status: capture.ok ? "passed" : "blocked",
        streamKind: "browser",
        mode: "browser-sim",
        progress: 100,
        currentStep: capture.ok
          ? `${capture.surface.label} completed ${capture.steps.length} persona steps`
          : `${capture.surface.label} journey blocked`,
        summary: capture.reason,
        streamIds: [streamId],
        startedAt: createdAt,
        updatedAt: capture.capturedAt
      };
    }),
    streams: captures.map((capture) => {
      const simId = `browser-${capture.surface.id}`;
      const streamId = `${simId}-stream`;
      const screenshotUrl = `../${capture.screenshotPath}`;
      return {
        id: streamId,
        simId,
        kind: "browser",
        label: capture.surface.label,
        status: capture.ok ? "passed" : "blocked",
        transport: "snapshot",
        updatedAt: capture.capturedAt,
        embed: {
          kind: "screenshot",
          url: screenshotUrl,
          title: capture.surface.label
        },
        viewport: capture.surface.viewport,
        ui: {
          appStatus: capture.ok ? "running" : "blocked",
          appUrl,
          route: appUrl,
          intent: browserJourney.goal,
          screenshotUrl,
          state: capture.reason,
          visualStatus: capture.ok ? "visible" : "blocked"
        },
        completion: {
          checkedAt: capture.capturedAt,
          exitCode: capture.ok ? 0 : 1,
          reason: capture.reason,
          status: capture.ok ? "passed" : "blocked"
        },
        artifacts: [
          { label: "run bundle", path: "run.json", kind: "bundle" },
          { label: "review", path: "review.md", kind: "review" },
          { label: "event log", path: "events.ndjson", kind: "events" },
          { label: `${capture.surface.id} browser trace`, path: capture.tracePath, kind: "trace" },
          ...capture.steps.map((step) => ({
            label: `${capture.surface.id} ${step.id} screenshot`,
            path: step.screenshotPath,
            kind: "screenshot" as const
          }))
        ]
      } satisfies RunStream;
    }),
    events,
    redaction: {
      status: "passed",
      notes: "Browser persona proof stores loopback app URLs, screenshots, and generated traces only; secret-like text is rejected by verify."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review,
    feedbackCandidates: []
  };

  await writeRunBundleArtifacts(absoluteArtifactRoot, bundle);
  await writeJson(path.join(options.cwd, ".mimetic", "runs", "latest.json"), {
    schema: "mimetic.latest-run.v1",
    runId,
    path: artifactRoot,
    updatedAt: completedAt
  } satisfies RunPointer);

  return {
    schema: "mimetic.run-result.v1",
    ok: allPassed,
    runId,
    mode: "live",
    simCount: captures.length,
    cwd: options.cwd,
    artifactRoot,
    bundlePath: path.join(artifactRoot, "run.json"),
    reviewPath: path.join(artifactRoot, "review.md"),
    latestPath: path.join(".mimetic", "runs", "latest.json"),
    warnings,
    ...(allPassed
      ? {}
      : {
          error: {
            code: "MIMETIC_BROWSER_APP_CAPTURE_FAILED" as const,
            message: review.summary
          }
      })
  };
}

async function captureBrowserSurface(args: {
  absoluteArtifactRoot: string;
  appUrl: string;
  browserCommand: string;
  browserJourney: BrowserPersonaJourney;
  surface: BrowserSurface;
  timeoutMs: number;
}): Promise<BrowserSurfaceCapture> {
  if (process.env.MIMETIC_BROWSER_PERSONA_DRIVER === "fixture") {
    return captureBrowserSurfaceFixture(args);
  }

  return captureBrowserSurfaceWithPlaywright(args);
}

async function captureBrowserSurfaceFixture(args: {
  absoluteArtifactRoot: string;
  appUrl: string;
  browserCommand: string;
  browserJourney: BrowserPersonaJourney;
  surface: BrowserSurface;
  timeoutMs: number;
}): Promise<BrowserSurfaceCapture> {
  const started = Date.now();
  const tracePath = path.join("traces", `${args.surface.id}.json`);
  const absoluteTracePath = path.join(args.absoluteArtifactRoot, tracePath);
  const httpProbe = await probeAppUrl(args.appUrl, Math.min(args.timeoutMs, 15_000));
  const capturedAt = new Date().toISOString();
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "mimetic-browser-profile-"));
  const steps: BrowserPersonaStepCapture[] = [];
  let currentUrl = args.appUrl;

  try {
    for (const [index, step] of args.browserJourney.steps.entries()) {
      if (step.action === "goto") {
        currentUrl = resolveBrowserStepUrl(args.appUrl, step.path ?? args.browserJourney.startPath);
      }
      const stepStarted = Date.now();
      const screenshotPath = screenshotPathForBrowserStep(args.surface, step);
      const absoluteScreenshotPath = path.join(args.absoluteArtifactRoot, screenshotPath);
      await captureScreenshotWithBrowser({
        args: browserScreenshotArgs({
          appUrl: currentUrl,
          profileDir,
          screenshotPath: absoluteScreenshotPath,
          surface: args.surface
        }),
        browserCommand: args.browserCommand,
        screenshotPath: absoluteScreenshotPath,
        timeoutMs: args.timeoutMs
      });
      const assertions = fixtureAssertionsForBrowserStep(step, httpProbe.ok);
      steps.push({
        action: step.action,
        ...(assertions.length === 0 ? {} : { assertions }),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStarted,
        id: step.id,
        label: step.label,
        reason: httpProbe.ok
          ? `Fixture driver captured ${step.action} step ${index + 1}/${args.browserJourney.steps.length}.`
          : httpProbe.reason,
        screenshotPath,
        status: httpProbe.ok && assertions.every((assertion) => assertion.status === "passed") ? "passed" : "blocked",
        url: sanitizeLoopbackUrl(currentUrl)
      });
    }
  } catch (error) {
    const reason = `Browser screenshot command failed for ${args.surface.id}: ${compactBrowserError(error)}`;
    const blockedSteps = buildBlockedBrowserPersonaSteps({
      browserJourney: args.browserJourney,
      currentUrl,
      reason,
      surface: args.surface,
      timestamp: capturedAt
    });
    await writeJson(absoluteTracePath, buildBrowserTrace({
      appUrl: args.appUrl,
      browserCommand: path.basename(args.browserCommand),
      browserJourney: args.browserJourney,
      capturedAt,
      durationMs: Date.now() - started,
      ...(httpProbe.status === undefined ? {} : { httpStatus: httpProbe.status }),
      ok: false,
      reason,
      screenshotPath: blockedSteps.at(-1)?.screenshotPath ?? screenshotPathForBrowserStep(args.surface, args.browserJourney.steps[0]),
      steps: blockedSteps,
      surface: args.surface
    }));
    return {
      capturedAt,
      durationMs: Date.now() - started,
      ...(httpProbe.status === undefined ? {} : { httpStatus: httpProbe.status }),
      ok: false,
      reason,
      screenshotPath: blockedSteps.at(-1)?.screenshotPath ?? screenshotPathForBrowserStep(args.surface, args.browserJourney.steps[0]),
      steps: blockedSteps,
      surface: args.surface,
      tracePath
    };
  } finally {
    await rm(profileDir, { force: true, recursive: true }).catch(() => undefined);
  }

  const screenshotStats = await Promise.all(steps.map((step) => stat(path.join(args.absoluteArtifactRoot, step.screenshotPath)).catch(() => null)));
  const screenshotsOk = screenshotStats.every((stats) => stats?.isFile() && stats.size > 0);
  const ok = Boolean(screenshotsOk && httpProbe.ok && steps.every((step) => step.status === "passed"));
  const reason = ok
    ? `${args.surface.label} completed ${steps.length}/${steps.length} browser persona steps from ${args.appUrl}${httpProbe.status === undefined ? "" : ` with HTTP ${httpProbe.status}`}.`
    : screenshotsOk
      ? `${args.surface.label} persona screenshots exist, but app HTTP readiness was not proven: ${httpProbe.reason}.`
      : `${args.surface.label} persona screenshot artifacts were missing or empty.`;
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - started;

  await writeJson(absoluteTracePath, buildBrowserTrace({
    appUrl: args.appUrl,
    browserCommand: path.basename(args.browserCommand),
    browserJourney: args.browserJourney,
    capturedAt: completedAt,
    durationMs,
    ...(httpProbe.status === undefined ? {} : { httpStatus: httpProbe.status }),
    ok,
    reason,
    screenshotPath: steps.at(-1)?.screenshotPath ?? screenshotPathForBrowserStep(args.surface, args.browserJourney.steps[0]),
    steps,
    surface: args.surface
  }));

  return {
    capturedAt: completedAt,
    durationMs,
    ...(httpProbe.status === undefined ? {} : { httpStatus: httpProbe.status }),
    ok,
    reason,
    screenshotPath: steps.at(-1)?.screenshotPath ?? screenshotPathForBrowserStep(args.surface, args.browserJourney.steps[0]),
    steps,
    surface: args.surface,
    tracePath
  };
}

async function captureBrowserSurfaceWithPlaywright(args: {
  absoluteArtifactRoot: string;
  appUrl: string;
  browserCommand: string;
  browserJourney: BrowserPersonaJourney;
  surface: BrowserSurface;
  timeoutMs: number;
}): Promise<BrowserSurfaceCapture> {
  const started = Date.now();
  const tracePath = path.join("traces", `${args.surface.id}.json`);
  const absoluteTracePath = path.join(args.absoluteArtifactRoot, tracePath);
  const httpProbe = await probeAppUrl(args.appUrl, Math.min(args.timeoutMs, 15_000));
  let browser: Browser | null = null;
  let page: Page | null = null;
  const steps: BrowserPersonaStepCapture[] = [];

  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      executablePath: args.browserCommand,
      headless: true,
      args: [
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check"
      ],
      timeout: args.timeoutMs
    });
    const context = await browser.newContext({
      deviceScaleFactor: args.surface.viewport.deviceScaleFactor,
      isMobile: args.surface.viewport.isMobile,
      viewport: {
        width: args.surface.viewport.width,
        height: args.surface.viewport.height
      }
    });
    page = await context.newPage();

    for (const step of args.browserJourney.steps) {
      steps.push(await executeBrowserPersonaStep({
        absoluteArtifactRoot: args.absoluteArtifactRoot,
        appUrl: args.appUrl,
        browserJourney: args.browserJourney,
        page,
        step,
        surface: args.surface,
        timeoutMs: args.timeoutMs
      }));
    }
  } catch (error) {
    const now = new Date().toISOString();
    const reason = compactBrowserError(error);
    if (steps.length === 0) {
      steps.push(...buildBlockedBrowserPersonaSteps({
        browserJourney: args.browserJourney,
        currentUrl: args.appUrl,
        reason,
        surface: args.surface,
        timestamp: now
      }));
    } else if (steps.length < args.browserJourney.steps.length) {
      const nextStep = args.browserJourney.steps[steps.length];
      if (nextStep) {
        const screenshotPath = screenshotPathForBrowserStep(args.surface, nextStep);
        await page?.screenshot({ path: path.join(args.absoluteArtifactRoot, screenshotPath), fullPage: true }).catch(() => undefined);
        steps.push({
          action: nextStep.action,
          completedAt: now,
          durationMs: Date.now() - started,
          id: nextStep.id,
          label: nextStep.label,
          reason,
          screenshotPath,
          status: "blocked",
          url: page ? sanitizeLoopbackUrl(page.url()) : args.appUrl
        });
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
  }

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - started;
  const ok = httpProbe.ok && steps.length === args.browserJourney.steps.length && steps.every((step) => step.status === "passed");
  const reason = ok
    ? `${args.surface.label} completed ${steps.length}/${steps.length} browser persona steps from ${args.appUrl}${httpProbe.status === undefined ? "" : ` with HTTP ${httpProbe.status}`}.`
    : `${args.surface.label} browser persona journey blocked: ${steps.find((step) => step.status !== "passed")?.reason ?? httpProbe.reason}`;

  await writeJson(absoluteTracePath, buildBrowserTrace({
    appUrl: args.appUrl,
    browserCommand: path.basename(args.browserCommand),
    browserJourney: args.browserJourney,
    capturedAt: completedAt,
    durationMs,
    ...(httpProbe.status === undefined ? {} : { httpStatus: httpProbe.status }),
    ok,
    reason,
    screenshotPath: steps.at(-1)?.screenshotPath ?? screenshotPathForBrowserStep(args.surface, args.browserJourney.steps[0]),
    steps,
    surface: args.surface
  }));

  return {
    capturedAt: completedAt,
    durationMs,
    ...(httpProbe.status === undefined ? {} : { httpStatus: httpProbe.status }),
    ok,
    reason,
    screenshotPath: steps.at(-1)?.screenshotPath ?? screenshotPathForBrowserStep(args.surface, args.browserJourney.steps[0]),
    steps,
    surface: args.surface,
    tracePath
  };
}

async function executeBrowserPersonaStep(args: {
  absoluteArtifactRoot: string;
  appUrl: string;
  browserJourney: BrowserPersonaJourney;
  page: Page;
  step: BrowserPersonaStepManifest;
  surface: BrowserSurface;
  timeoutMs: number;
}): Promise<BrowserPersonaStepCapture> {
  const started = Date.now();
  const beforeState = await browserPersonaPageState(args.page);
  const stepTimeoutMs = Math.min(args.timeoutMs, 8_000);
  if (args.step.action === "goto") {
    await args.page.goto(resolveBrowserStepUrl(args.appUrl, args.step.path ?? args.browserJourney.startPath), {
      waitUntil: "domcontentloaded",
      timeout: args.timeoutMs
    });
  } else if (args.step.action === "fill") {
    if (!args.step.selector) {
      throw new Error(`${args.step.id} fill step is missing selector`);
    }
    await args.page.locator(args.step.selector).first().fill(args.step.value ?? "synthetic.user@example.test", {
      timeout: stepTimeoutMs
    });
  } else if (args.step.action === "click") {
    let target = args.step.selector
      ? args.page.locator(args.step.selector).first()
      : args.page.locator("button, input[type='submit'], input[type='button'], [role='button']").first();
    if (!args.step.selector) {
      const textInput = args.page.locator("input:not([type='hidden']):not([type='submit']):not([type='button']), textarea").first();
      if (await textInput.count() > 0) {
        await textInput.fill(args.step.value ?? "synthetic.user@example.test", { timeout: stepTimeoutMs });
      }
    }
    if (await target.count() === 0) {
      throw new Error(`${args.step.id} click step found no target`);
    }
    await target.click({ timeout: stepTimeoutMs });
    await args.page.waitForTimeout(300);
  } else if (args.step.action === "assertText" || args.step.action === "waitForText") {
    const expectedText = args.step.expectation?.text ?? args.step.value;
    if (!expectedText) {
      throw new Error(`${args.step.id} text assertion step is missing expected text`);
    }
    await waitForPageText(args.page, expectedText, stepTimeoutMs);
  } else if (args.step.action === "waitForSelector") {
    if (!args.step.selector) {
      throw new Error(`${args.step.id} selector wait step is missing selector`);
    }
    await args.page.locator(args.step.selector).first().waitFor({ state: "visible", timeout: stepTimeoutMs });
  } else {
    const exhaustive: never = args.step.action;
    throw new Error(`Unsupported browser persona action: ${exhaustive}`);
  }

  const afterState = await browserPersonaPageState(args.page);
  const screenshotPath = screenshotPathForBrowserStep(args.surface, args.step);
  await args.page.screenshot({
    path: path.join(args.absoluteArtifactRoot, screenshotPath),
    fullPage: true
  });
  const assertions = await evaluateBrowserStepExpectations({
    afterState,
    beforeState,
    page: args.page,
    step: args.step,
    timeoutMs: stepTimeoutMs
  });
  const blockedAssertion = assertions.find((assertion) => assertion.status !== "passed");
  return {
    action: args.step.action,
    ...(assertions.length === 0 ? {} : { assertions }),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    id: args.step.id,
    label: args.step.label,
    reason: blockedAssertion?.reason ?? `${args.step.action} completed for ${args.step.label}.`,
    screenshotPath,
    status: blockedAssertion ? "blocked" : "passed",
    url: sanitizeLoopbackUrl(args.page.url())
  };
}

async function evaluateBrowserStepExpectations(args: {
  afterState: { bodyDigest: string; url: string };
  beforeState: { bodyDigest: string; url: string };
  page: Page;
  step: BrowserPersonaStepManifest;
  timeoutMs: number;
}): Promise<BrowserPersonaAssertionCapture[]> {
  const assertions: BrowserPersonaAssertionCapture[] = [];
  const expectation = args.step.expectation;
  if (!expectation) {
    return assertions;
  }

  if (expectation.stateChanged === true) {
    const changed = args.beforeState.url !== args.afterState.url || args.beforeState.bodyDigest !== args.afterState.bodyDigest;
    assertions.push({
      id: "state-changed",
      reason: changed ? "Visible page state changed." : "Visible page state did not change.",
      status: changed ? "passed" : "blocked"
    });
  }
  if (expectation.text) {
    assertions.push(await pageTextAssertion(args.page, expectation.text, args.timeoutMs));
  }
  if (expectation.selectorVisible) {
    const visible = await args.page.locator(expectation.selectorVisible).first().isVisible({ timeout: args.timeoutMs }).catch(() => false);
    assertions.push({
      id: "selector-visible",
      reason: visible ? "Expected selector was visible." : "Expected selector was not visible.",
      status: visible ? "passed" : "blocked"
    });
  }
  if (expectation.urlIncludes) {
    const includes = args.afterState.url.includes(expectation.urlIncludes);
    assertions.push({
      id: "url-includes",
      reason: includes ? "URL included expected public-safe substring." : "URL did not include expected public-safe substring.",
      status: includes ? "passed" : "blocked"
    });
  }

  return assertions;
}

async function pageTextAssertion(page: Page, expectedText: string, timeoutMs: number): Promise<BrowserPersonaAssertionCapture> {
  const passed = await waitForPageText(page, expectedText, timeoutMs).then(() => true).catch(() => false);
  return {
    id: "text-present",
    reason: passed ? "Expected text was present." : "Expected text was not present.",
    status: passed ? "passed" : "blocked"
  };
}

async function waitForPageText(page: Page, expectedText: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    "(needle) => typeof needle === 'string' && Boolean(document.body?.innerText.includes(needle))",
    expectedText,
    { timeout: timeoutMs }
  );
}

function browserScreenshotArgs(args: {
  appUrl: string;
  profileDir: string;
  screenshotPath: string;
  surface: BrowserSurface;
}): string[] {
  return [
    "--headless=new",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    `--user-data-dir=${args.profileDir}`,
    `--window-size=${args.surface.viewport.width},${args.surface.viewport.height}`,
    `--force-device-scale-factor=${args.surface.viewport.deviceScaleFactor}`,
    `--screenshot=${args.screenshotPath}`,
    args.appUrl
  ];
}

function buildBlockedBrowserPersonaSteps(args: {
  browserJourney: BrowserPersonaJourney;
  currentUrl: string;
  reason: string;
  surface: BrowserSurface;
  timestamp: string;
}): BrowserPersonaStepCapture[] {
  return args.browserJourney.steps.map((step) => ({
    action: step.action,
    completedAt: args.timestamp,
    durationMs: 0,
    id: step.id,
    label: step.label,
    reason: args.reason,
    screenshotPath: screenshotPathForBrowserStep(args.surface, step),
    status: "blocked",
    url: sanitizeLoopbackUrl(args.currentUrl)
  }));
}

function fixtureAssertionsForBrowserStep(step: BrowserPersonaStepManifest, httpOk: boolean): BrowserPersonaAssertionCapture[] {
  const assertions: BrowserPersonaAssertionCapture[] = [];
  const expectation = step.expectation;
  if (!expectation) {
    return assertions;
  }
  const ids: Array<BrowserPersonaAssertionCapture["id"]> = [];
  if (expectation.stateChanged === true) ids.push("state-changed");
  if (expectation.text) ids.push("text-present");
  if (expectation.selectorVisible) ids.push("selector-visible");
  if (expectation.urlIncludes) ids.push("url-includes");
  return ids.map((id) => ({
    id,
    reason: httpOk
      ? "Fixture driver recorded the expected assertion shape."
      : "Fixture driver could not prove the assertion because app HTTP readiness failed.",
    status: httpOk ? "passed" : "blocked"
  }));
}

function screenshotPathForBrowserStep(surface: BrowserSurface, step: BrowserPersonaStepManifest | undefined): string {
  return path.join("screenshots", `${surface.id}-${step?.id ?? "step"}.png`);
}

function resolveBrowserStepUrl(appUrl: string, value: string | undefined): string {
  const url = new URL(value?.trim() || "", appUrl);
  const normalized = normalizeLocalAppUrl(url.toString());
  if (!normalized) {
    throw new Error("browser step URL must resolve to a loopback HTTP URL");
  }
  return normalized;
}

async function browserPersonaPageState(page: {
  evaluate<T>(pageFunction: string): Promise<T>;
  url(): string;
}): Promise<{ bodyDigest: string; url: string }> {
  const bodyText = await page.evaluate<string>("document.body ? document.body.innerText : ''");
  return {
    bodyDigest: digestText(bodyText.slice(0, 4_000)),
    url: sanitizeLoopbackUrl(page.url())
  };
}

function buildBrowserTrace(args: {
  appUrl: string;
  browserCommand: string;
  browserJourney: BrowserPersonaJourney;
  capturedAt: string;
  durationMs: number;
  httpStatus?: number;
  ok: boolean;
  reason: string;
  screenshotPath: string;
  steps: BrowserPersonaStepCapture[];
  surface: BrowserSurface;
}): Record<string, unknown> {
  return {
    schema: "mimetic.browser-persona-trace.v1",
    capturedAt: args.capturedAt,
    appUrl: args.appUrl,
    browserCommand: args.browserCommand,
    durationMs: args.durationMs,
    ...(args.httpStatus === undefined ? {} : { httpStatus: args.httpStatus }),
    ok: args.ok,
    reason: args.reason,
    scenario: {
      id: args.browserJourney.scenarioId,
      title: args.browserJourney.scenarioTitle,
      source: args.browserJourney.source,
      sourceDigest: args.browserJourney.sourceDigest,
      stepCount: args.browserJourney.steps.length
    },
    screenshotPath: args.screenshotPath,
    steps: args.steps,
    surface: args.surface,
    redaction: "passed"
  };
}

function sanitizeLoopbackUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1") {
      parsed.username = "";
      parsed.password = "";
      parsed.search = parsed.search ? "?[redacted-query]" : "";
      parsed.hash = parsed.hash ? "#[redacted-hash]" : "";
      return parsed.toString();
    }
  } catch {}

  return "[redacted-url]";
}

async function captureScreenshotWithBrowser(args: {
  args: string[];
  browserCommand: string;
  screenshotPath: string;
  timeoutMs: number;
}): Promise<void> {
  const child = spawn(args.browserCommand, args.args, {
    detached: true,
    stdio: "ignore"
  });
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  child.once("exit", (code, childSignal) => {
    exitCode = code;
    signal = childSignal;
  });
  child.unref();

  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() <= deadline) {
    const stats = await stat(args.screenshotPath).catch(() => null);
    if (stats?.isFile() && stats.size > 0) {
      terminateProcessGroup(child.pid);
      return;
    }
    if (exitCode !== null || signal !== null) {
      break;
    }
    await wait(250);
  }

  terminateProcessGroup(child.pid, true);
  const stats = await stat(args.screenshotPath).catch(() => null);
  if (stats?.isFile() && stats.size > 0) {
    return;
  }

  throw new Error(
    exitCode !== null || signal !== null
      ? `browser exited before screenshot was written (exit=${exitCode ?? "null"} signal=${signal ?? "null"})`
      : `timed out after ${args.timeoutMs}ms waiting for screenshot`
  );
}

function terminateProcessGroup(pid: number | undefined, force = false): void {
  if (!pid) {
    return;
  }

  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    return;
  } catch {}

  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch {}
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildBrowserAppEvents(args: {
  appUrl: string;
  captures: BrowserSurfaceCapture[];
  createdAt: string;
}): RunEvent[] {
  const events: RunEvent[] = [
    {
      id: "event-001",
      at: args.createdAt,
      level: "info",
      type: "browser-persona.run.created",
      message: "Created live browser persona proof run against a loopback URL."
    }
  ];

  args.captures.forEach((capture) => {
    events.push({
      id: `event-${String(events.length + 1).padStart(3, "0")}`,
      at: capture.capturedAt,
      level: capture.ok ? "info" : "warn",
      type: capture.ok ? "browser-persona.journey.passed" : "browser-persona.journey.blocked",
      message: `${capture.surface.id}: ${capture.reason}`,
      simId: `browser-${capture.surface.id}`,
      streamId: `browser-${capture.surface.id}-stream`
    });
    for (const step of capture.steps) {
      events.push({
        id: `event-${String(events.length + 1).padStart(3, "0")}`,
        at: step.completedAt,
        level: step.status === "passed" ? "info" : "warn",
        type: step.status === "passed" ? "browser-persona.step.passed" : "browser-persona.step.blocked",
        message: `${capture.surface.id} ${step.id}: ${step.reason}`,
        simId: `browser-${capture.surface.id}`,
        streamId: `browser-${capture.surface.id}-stream`
      });
    }
  });

  return events;
}

function createBrowserAppReviewSummary(args: {
  appUrl: string;
  browserJourney: BrowserPersonaJourney;
  captures: BrowserSurfaceCapture[];
}): ReviewSummary {
  const passed = args.captures.filter((capture) => capture.ok).length;
  const allPassed = passed === args.captures.length;
  const usedBuiltinFallback = args.browserJourney.source.startsWith("builtin:");
  return {
    schema: REVIEW_SCHEMA,
    verdict: allPassed ? "pass" : "blocked",
    summary: allPassed
      ? `Completed ${passed}/${args.captures.length} live browser persona journey${args.captures.length === 1 ? "" : "s"} from ${args.appUrl} using ${args.browserJourney.scenarioId}.`
      : `Completed ${passed}/${args.captures.length} live browser persona journeys from ${args.appUrl} using ${args.browserJourney.scenarioId}; at least one required journey was blocked.`,
    gaps: [
      usedBuiltinFallback
        ? "This proof used the built-in two-step fallback because no executable browser scenario manifest was found."
        : `This proof used executable browser steps from ${args.browserJourney.source}.`,
      "Only loopback app URLs are accepted so generated bundles do not preserve private external targets.",
      ...args.captures
        .filter((capture) => !capture.ok)
        .map((capture) => `${capture.surface.id}: ${capture.reason}`)
    ]
  };
}

async function probeAppUrl(appUrl: string, timeoutMs: number): Promise<{ ok: boolean; reason: string; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(appUrl, {
      signal: controller.signal
    });
    return {
      ok: response.status < 500,
      reason: `HTTP ${response.status}`,
      status: response.status
    };
  } catch (error) {
    return {
      ok: false,
      reason: compactBrowserError(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveBrowserCommand(): Promise<string | null> {
  const candidates = [
    await resolveBrowserCandidate(process.env.MIMETIC_BROWSER_COMMAND),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    await resolveExecutableFromPath("google-chrome"),
    await resolveExecutableFromPath("chromium"),
    await resolveExecutableFromPath("chromium-browser")
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--version"], {
        timeout: 5_000,
        maxBuffer: 256 * 1024
      });
      return candidate;
    } catch {}
  }

  return null;
}

async function resolveBrowserCandidate(value: string | undefined): Promise<string | null> {
  const candidate = value?.trim();
  if (!candidate) {
    return null;
  }

  return path.isAbsolute(candidate) ? candidate : resolveExecutableFromPath(candidate);
}

async function resolveExecutableFromPath(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("sh", ["-lc", `command -v ${shellQuote(command)}`], {
      timeout: 5_000,
      maxBuffer: 256 * 1024
    });
    const resolved = stdout.trim().split(/\r?\n/)[0]?.trim();
    return resolved ? resolved : null;
  } catch {
    return null;
  }
}

function normalizeLocalAppUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      return null;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function compactBrowserError(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message).replace(/\s+/g, " ").slice(0, 240);
  }

  return redactSensitiveText(String(error)).replace(/\s+/g, " ").slice(0, 240);
}

function isLocalCodexActor(value: string): value is LocalCodexActor {
  return value === "codex-tui" || value === "codex-exec" || value === "codex-app-server";
}

function resolveRequestedLocalCodexActor(actor: string | undefined): LocalCodexActor | undefined {
  if (actor && isLocalCodexActor(actor)) {
    return actor;
  }

  if (process.env.MIMETIC_ENABLE_LOCAL_CODEX_TUI === "1") {
    return "codex-tui";
  }

  if (process.env.MIMETIC_ENABLE_LOCAL_CODEX_EXEC === "1") {
    return "codex-exec";
  }

  if (process.env.MIMETIC_ENABLE_LOCAL_CODEX_APP_SERVER === "1") {
    return "codex-app-server";
  }

  return undefined;
}

async function runLocalCodexTui(options: RunOptions & {
  actor: "codex-tui";
  cwd: string;
  simCount: number;
}): Promise<RunResult> {
  const warnings: string[] = [];

  if (options.simCount !== 1) {
    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "MIMETIC_ACTOR_FANOUT_UNIMPLEMENTED",
        message: "Local Codex TUI actor support is currently single-lane because it owns one PTY/UI session. Use codex-exec for bounded-concurrency fanout."
      }
    };
  }

  const timeoutMs = normalizeActorTimeout(options.timeoutMs ?? readEnvInteger("MIMETIC_CODEX_ACTOR_TIMEOUT_MS") ?? LOCAL_CODEX_TUI_DEFAULT_TIMEOUT_MS);
  if (timeoutMs === null) {
    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "MIMETIC_INVALID_TIMEOUT",
        message: `--timeout-ms must be an integer between 1 and ${LOCAL_CODEX_TUI_MAX_TIMEOUT_MS}.`
      }
    };
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const runId = options.runId ?? `codex-tui-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const artifactRoot = path.join(".mimetic", "runs", runId);
  const absoluteArtifactRoot = path.join(options.cwd, artifactRoot);
  const transcriptPath = path.join(absoluteArtifactRoot, "transcripts", "codex-tui-sanitized.txt");
  const actorTracePath = path.join(absoluteArtifactRoot, "actor.json");
  const eventsPath = path.join(absoluteArtifactRoot, "events.ndjson");
  const packageName = await readPackageName(options.cwd);
  const mimeticSource = await directoryExists(path.join(options.cwd, "mimetic")) ? "present" : "missing";
  const source = await buildRunSource({ cwd: options.cwd, capturedAt: createdAt, mimeticSource, packageName });
  const selection = await loadDryRunSelection(options.cwd, mimeticSource);
  if (mimeticSource === "missing") {
    warnings.push("Committed mimetic/ source was not found; using built-in synthetic local actor defaults.");
  }
  warnings.push(...selection.warnings);
  const verdictNonce = randomUUID().slice(0, 12);
  const prompt = buildLocalCodexTuiPrompt(selection, verdictNonce);
  const promptDigest = digestText(prompt);
  const command = resolveLocalCodexTuiCommand(options.cwd, prompt, options.actorCommand);
  const usesDefaultCodexCommand = options.actorCommand === undefined && process.env.MIMETIC_CODEX_ACTOR_COMMAND === undefined;
  const simId = "sim-01";
  const streamId = "sim-01-codex-tui";
  const events: RunEvent[] = [];
  const appendEvent = async (
    type: string,
    message: string,
    level: RunEvent["level"] = "info"
  ): Promise<void> => {
    events.push({
      id: `event-${String(events.length + 1).padStart(3, "0")}`,
      at: new Date().toISOString(),
      level,
      type,
      message,
      simId,
      streamId
    });
    await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  };

  await mkdir(path.dirname(transcriptPath), { recursive: true });

  let actor: LocalActorCommandResult;
  const trustPreflight = usesDefaultCodexCommand ? await checkCodexWorkspaceTrust(options.cwd) : { ok: true as const };
  if (!trustPreflight.ok) {
    actor = {
      durationMs: 0,
      reason: trustPreflight.message,
      status: "blocked",
      transcript: `${trustPreflight.message}\nRecovery: ${trustPreflight.recoveryCommand}\n`,
      transcriptBytes: Buffer.byteLength(trustPreflight.message)
    };
    await appendEvent("actor.preflight.blocked", redactSensitiveText(trustPreflight.message), "warn");
  } else {
    await appendEvent(
      "actor.spawned",
      `Spawned local Codex TUI actor command ${command.name} in explicit opt-in mode.`
    );
    await appendEvent(
      "actor.prompt.submitted",
      `Submitted bounded public-safe dogfood prompt digest ${promptDigest}; raw prompt omitted from event log.`
    );
    await appendEvent(
      "actor.running",
      "Published local Codex TUI running snapshot for Observer polling."
    );

    const runningAt = new Date().toISOString();
    const runningBundle: RunBundle = {
      schema: RUN_BUNDLE_SCHEMA,
      runId,
      mode: "live",
      simCount: 1,
      createdAt,
      cwd: options.cwd,
      artifactRoot,
      source,
      persona: selection.persona,
      scenario: selection.scenario,
      lifecycle: [
        {
          at: createdAt,
          event: "run.created",
          message: "Live local Codex TUI run created with one explicit opt-in actor."
        },
        {
          at: createdAt,
          event: "actor.selected",
          message: "Selected local codex-tui actor."
        },
        {
          at: runningAt,
          event: "actor.running",
          message: "Local Codex TUI actor is running; Observer data will refresh with sanitized evidence after completion."
        }
      ],
      simulations: [
        {
          id: simId,
          index: 1,
          personaId: selection.persona.id,
          scenarioId: selection.scenario.id,
          status: "running",
          streamKind: "tui",
          mode: "tui-sim",
          progress: 35,
          currentStep: "Local Codex TUI actor running",
          summary: "Local Codex TUI actor is running.",
          streamIds: [streamId],
          startedAt: createdAt,
          updatedAt: runningAt
        }
      ],
      streams: [
        {
          id: streamId,
          simId,
          kind: "tui",
          label: "Local Codex TUI actor",
          status: "running",
          transport: "pty",
          updatedAt: runningAt,
          embed: {
            kind: "terminal",
            title: "Local Codex TUI actor"
          },
          terminal: {
            title: "Local Codex TUI actor",
            format: "ansi",
            stdin: "sent",
            tail: "Codex TUI actor is running; sanitized transcript evidence will be linked after completion."
          },
          completion: {
            checkedAt: runningAt,
            reason: "actor process is still running",
            status: "running"
          },
          artifacts: [
            { label: "run bundle", path: "run.json", kind: "bundle" },
            { label: "review", path: "review.md", kind: "review" },
            { label: "event log", path: "events.ndjson", kind: "events" }
          ]
        }
      ],
      events,
      redaction: {
        status: "passed",
        notes: "Running TUI bundle contains no raw transcript yet; final actor output will be redacted before persistence."
      },
      artifacts: {
        run: "run.json",
        reviewJson: "review.json",
        reviewMarkdown: "review.md",
        observerData: "observer/observer-data.json",
        events: "events.ndjson"
      },
      review: createLocalActorRunningReviewSummary("Codex TUI"),
      feedbackCandidates: []
    };
    await writeRunBundleArtifacts(absoluteArtifactRoot, runningBundle);
    await writeJson(path.join(options.cwd, ".mimetic", "runs", "latest.json"), {
      schema: "mimetic.latest-run.v1",
      runId,
      path: artifactRoot,
      updatedAt: runningAt
    } satisfies RunPointer);

    actor = await executeLocalActorCommand(command, {
      cwd: options.cwd,
      timeoutMs,
      verdictNonce
    });
  }
  const completedAt = new Date().toISOString();
  const redactedTranscript = redactSensitiveText(actor.transcript);
  const tail = tailText(redactedTranscript, 6_000);
  const status = actor.status;
  // Redact the reason before it flows into the persisted event, simulation
  // summary, completion reason, review, and lifecycle. For a trust-preflight
  // block the reason embeds the absolute workspace path; the live CLI reason can
  // still show the real path, but the public-safe bundle must not.
  const verdictReason = redactSensitiveText(actor.reason);

  await writeFile(transcriptPath, redactedTranscript.length > 0 ? redactedTranscript : "No transcript output captured.\n", "utf8");
  await writeJson(actorTracePath, {
    schema: "mimetic.local-codex-tui-actor.v1",
    actor: "codex-tui",
    commandName: command.name,
    promptDigest,
    verdictNonce,
    startedAt: createdAt,
    completedAt,
    durationMs: actor.durationMs,
    exitCode: actor.exitCode,
    signal: actor.signal,
    status,
    timeoutMs,
    transcriptBytes: actor.transcriptBytes,
    transcriptPath: "transcripts/codex-tui-sanitized.txt",
    redaction: "passed"
  });

  await appendEvent(
    "actor.observation",
    `Captured ${actor.transcriptBytes} output byte${actor.transcriptBytes === 1 ? "" : "s"}; sanitized transcript tail recorded with redaction=passed.`
  );
  await appendEvent(
    "actor.artifact",
    "Wrote sanitized Codex TUI transcript and actor trace artifacts under the ignored run directory."
  );
  await appendEvent(
    "actor.verdict",
    `Local Codex TUI actor verdict ${status}: ${verdictReason}`,
    status === "passed" ? "info" : status === "timed_out" ? "warn" : "error"
  );
  await appendEvent(
    status === "timed_out" ? "actor.timeout" : status === "blocked" && !trustPreflight.ok ? "actor.blocked" : "actor.exited",
    status === "timed_out"
      ? `Actor timed out after ${timeoutMs}ms; last safe observation retained.`
      : status === "blocked" && !trustPreflight.ok
        ? "Actor launch was blocked by preflight before spawn."
        : `Actor exited with code ${actor.exitCode ?? "null"}${actor.signal ? ` and signal ${actor.signal}` : ""}.`,
    status === "passed" ? "info" : "warn"
  );

  const bundle: RunBundle = {
    schema: RUN_BUNDLE_SCHEMA,
    runId,
    mode: "live",
    simCount: 1,
    createdAt,
    cwd: options.cwd,
    artifactRoot,
    source,
    persona: selection.persona,
    scenario: selection.scenario,
    lifecycle: [
      {
        at: createdAt,
        event: "run.created",
        message: "Live local Codex TUI run created with one explicit opt-in actor."
      },
      {
        at: createdAt,
        event: "actor.selected",
        message: "Selected local codex-tui actor."
      },
      {
        at: completedAt,
        event: "review.skeleton.created",
        message: "Created review skeleton from sanitized actor lifecycle evidence."
      }
    ],
    simulations: [
      {
        id: simId,
        index: 1,
        personaId: selection.persona.id,
        scenarioId: selection.scenario.id,
        status,
        streamKind: "tui",
        mode: "tui-sim",
        progress: 100,
        currentStep: status === "passed" ? "Local Codex TUI actor completed" : "Local Codex TUI actor needs review",
        summary: `Local Codex TUI actor ${status}: ${verdictReason}`,
        streamIds: [streamId],
        startedAt: createdAt,
        updatedAt: completedAt
      }
    ],
    streams: [
      {
        id: streamId,
        simId,
        kind: "tui",
        label: "Local Codex TUI actor",
        status,
        transport: "pty",
        updatedAt: completedAt,
        embed: {
          kind: "terminal",
          title: "Local Codex TUI actor"
        },
        terminal: {
          title: "Local Codex TUI actor",
          format: "ansi",
          stdin: "sent",
          tail
        },
        completion: {
          checkedAt: completedAt,
          ...(actor.exitCode === undefined ? {} : { exitCode: actor.exitCode }),
          logTail: tail,
          reason: verdictReason,
          status
        },
        artifacts: [
          { label: "run bundle", path: "run.json", kind: "bundle" },
          { label: "review", path: "review.md", kind: "review" },
          { label: "event log", path: "events.ndjson", kind: "events" },
          { label: "sanitized transcript", path: "transcripts/codex-tui-sanitized.txt", kind: "log" },
          { label: "actor trace", path: "actor.json", kind: "trace" }
        ]
      }
    ],
    events,
    redaction: {
      status: "passed",
      notes: "Actor output was redacted before transcript and bundle persistence; raw prompt is omitted from event log."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review: createLocalActorReviewSummary("Codex TUI", status, verdictReason),
    feedbackCandidates: []
  };

  await writeRunBundleArtifacts(absoluteArtifactRoot, bundle);
  await writeJson(path.join(options.cwd, ".mimetic", "runs", "latest.json"), {
    schema: "mimetic.latest-run.v1",
    runId,
    path: artifactRoot,
    updatedAt: completedAt
  } satisfies RunPointer);

  return {
    schema: "mimetic.run-result.v1",
    ok: status === "passed",
    runId,
    mode: "live",
    simCount: 1,
    cwd: options.cwd,
    artifactRoot,
    bundlePath: path.join(artifactRoot, "run.json"),
    reviewPath: path.join(artifactRoot, "review.md"),
    latestPath: path.join(".mimetic", "runs", "latest.json"),
    warnings,
    ...(status === "passed"
      ? {}
      : {
          error: {
            code: "MIMETIC_LOCAL_CODEX_TUI_FAILED" as const,
            message: `Local Codex TUI actor ${status}: ${verdictReason}`
          }
      })
  };
}

interface LocalCodexExecLaneBundleInput {
  completion?: RunStreamCompletion;
  currentStep: string;
  focus: LocalCodexExecFocus;
  progress: number;
  simId: string;
  status: RunSimulationStatus;
  streamId: string;
  summary: string;
  terminalTail: string;
  tracePath?: string;
  transcriptPath?: string;
  updatedAt: string;
}

function buildLocalCodexExecBundle(args: {
  artifactRoot: string;
  createdAt: string;
  cwd: string;
  events: RunEvent[];
  lanes: LocalCodexExecLaneBundleInput[];
  lifecycle: RunBundle["lifecycle"];
  mimeticSource: RunBundle["source"]["mimeticSource"];
  packageName: string | null;
  review: ReviewSummary;
  runId: string;
  scenario: RunBundle["scenario"];
  persona: RunBundle["persona"];
  simCount: number;
  source: RunBundle["source"];
}): RunBundle {
  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: "live",
    simCount: args.simCount,
    createdAt: args.createdAt,
    cwd: args.cwd,
    artifactRoot: args.artifactRoot,
    source: args.source,
    persona: args.persona,
    scenario: args.scenario,
    lifecycle: args.lifecycle,
    simulations: args.lanes.map((lane, index): RunSimulation => ({
      id: lane.simId,
      index: index + 1,
      personaId: `codex-exec-${lane.focus.id}`,
      scenarioId: args.scenario.id,
      status: lane.status,
      streamKind: "terminal",
      mode: "cli-sim",
      progress: lane.progress,
      currentStep: lane.currentStep,
      summary: lane.summary,
      streamIds: [lane.streamId],
      startedAt: args.createdAt,
      updatedAt: lane.updatedAt
    })),
    streams: args.lanes.map((lane): RunStream => {
      const artifacts: RunStream["artifacts"] = [
        { label: "run bundle", path: "run.json", kind: "bundle" },
        { label: "review", path: "review.md", kind: "review" },
        { label: "event log", path: "events.ndjson", kind: "events" },
        ...(lane.transcriptPath ? [{ label: "sanitized transcript", path: lane.transcriptPath, kind: "log" as const }] : []),
        ...(lane.tracePath ? [{ label: "actor trace", path: lane.tracePath, kind: "trace" as const }] : [])
      ];

      return {
        id: lane.streamId,
        simId: lane.simId,
        kind: "terminal",
        label: `Local Codex exec - ${lane.focus.label}`,
        status: lane.status,
        transport: "snapshot",
        updatedAt: lane.updatedAt,
        embed: {
          kind: "terminal",
          title: `Local Codex exec - ${lane.focus.label}`
        },
        terminal: {
          title: `Local Codex exec - ${lane.focus.label}`,
          format: "plain",
          stdin: "sent",
          tail: lane.terminalTail
        },
        ...(lane.completion ? { completion: lane.completion } : {}),
        artifacts
      };
    }),
    events: args.events,
    redaction: {
      status: "passed",
      notes: "Actor output was redacted before transcript and bundle persistence; raw prompt is omitted from event log."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review: args.review,
    feedbackCandidates: []
  };
}

async function runLocalCodexExec(options: RunOptions & {
  actor: "codex-exec";
  cwd: string;
  simCount: number;
}): Promise<RunResult> {
  const warnings: string[] = [];

  const timeoutMs = normalizeActorTimeout(options.timeoutMs ?? readEnvInteger("MIMETIC_CODEX_ACTOR_TIMEOUT_MS") ?? LOCAL_CODEX_TUI_DEFAULT_TIMEOUT_MS);
  if (timeoutMs === null) {
    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "MIMETIC_INVALID_TIMEOUT",
        message: `--timeout-ms must be an integer between 1 and ${LOCAL_CODEX_TUI_MAX_TIMEOUT_MS}.`
      }
    };
  }
  const maxConcurrency = normalizePositiveInteger(
    readEnvInteger("MIMETIC_LOCAL_CODEX_EXEC_MAX_CONCURRENCY") ?? LOCAL_CODEX_EXEC_DEFAULT_MAX_CONCURRENCY
  );
  if (maxConcurrency === null) {
    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "MIMETIC_INVALID_ACTOR_CONCURRENCY",
        message: "MIMETIC_LOCAL_CODEX_EXEC_MAX_CONCURRENCY must be a positive integer."
      }
    };
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const runId = options.runId ?? `codex-exec-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const artifactRoot = path.join(".mimetic", "runs", runId);
  const absoluteArtifactRoot = path.join(options.cwd, artifactRoot);
  const eventsPath = path.join(absoluteArtifactRoot, "events.ndjson");
  const packageName = await readPackageName(options.cwd);
  const mimeticSource = await directoryExists(path.join(options.cwd, "mimetic")) ? "present" : "missing";
  const source = await buildRunSource({ cwd: options.cwd, capturedAt: createdAt, mimeticSource, packageName });
  const selection = await loadDryRunSelection(options.cwd, mimeticSource);
  if (mimeticSource === "missing") {
    warnings.push("Committed mimetic/ source was not found; using built-in synthetic local actor defaults.");
  }
  warnings.push(...selection.warnings);
  const events: RunEvent[] = [];
  const pushEvent = (
    type: string,
    message: string,
    level: RunEvent["level"] = "info",
    simId?: string,
    streamId?: string
  ): void => {
    events.push({
      id: `event-${String(events.length + 1).padStart(3, "0")}`,
      at: new Date().toISOString(),
      level,
      type,
      message,
      ...(simId === undefined ? {} : { simId }),
      ...(streamId === undefined ? {} : { streamId })
    });
  };

  await mkdir(path.join(absoluteArtifactRoot, "transcripts"), { recursive: true });
  await mkdir(path.join(absoluteArtifactRoot, "actors"), { recursive: true });
  await mkdir(path.join(absoluteArtifactRoot, "observer"), { recursive: true });
  await writeJson(path.join(options.cwd, ".mimetic", "runs", "latest.json"), {
    schema: "mimetic.latest-run.v1",
    runId,
    path: artifactRoot,
    updatedAt: createdAt
  } satisfies RunPointer);

  interface ExecLaneResult {
    actor: LocalActorCommandResult;
    command: LocalActorCommand;
    focus: LocalCodexExecFocus;
    promptDigest: string;
    simId: string;
    streamId: string;
    tail: string;
    tracePath: string;
    transcriptPath: string;
  }

  const lanes = Array.from({ length: options.simCount }, (_, index) => {
    const focus = localCodexExecFocus(index);
    const simId = `sim-${String(index + 1).padStart(2, "0")}`;
    const streamId = `${simId}-codex-exec`;
    const prompt = buildLocalCodexExecPrompt(selection, {
      focus,
      index: index + 1,
      total: options.simCount
    });
    const promptDigest = digestText(prompt);
    const command = resolveLocalCodexExecCommand(options.cwd, prompt, options.actorCommand);
    pushEvent(
      "actor.spawned",
      `Spawned local Codex exec actor lane ${index + 1}/${options.simCount} (${focus.label}) command ${command.name} in explicit opt-in mode.`,
      "info",
      simId,
      streamId
    );
    pushEvent(
      "actor.prompt.submitted",
      `Submitted bounded public-safe dogfood prompt digest ${promptDigest}; raw prompt omitted from event log.`,
      "info",
      simId,
      streamId
    );

    return { command, focus, promptDigest, simId, streamId };
  });

  for (const lane of lanes) {
    pushEvent(
      "actor.running",
      "Published local Codex exec running snapshot for Observer polling.",
      "info",
      lane.simId,
      lane.streamId
    );
  }
  await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  const baseLifecycle: RunBundle["lifecycle"] = [
    {
      at: createdAt,
      event: "run.created",
      message: `Live local Codex exec run created with ${options.simCount} explicit opt-in actor${options.simCount === 1 ? "" : "s"} and max concurrency ${maxConcurrency}.`
    },
    {
      at: createdAt,
      event: "actor.selected",
      message: "Selected local codex-exec actor."
    }
  ];
  const runningAt = new Date().toISOString();
  const runningBundle = buildLocalCodexExecBundle({
    runId,
    simCount: options.simCount,
    createdAt,
    cwd: options.cwd,
    artifactRoot,
    packageName,
    mimeticSource,
    source,
    persona: selection.persona,
    scenario: selection.scenario,
    lifecycle: [
      ...baseLifecycle,
    {
      at: runningAt,
      event: "actor.running",
      message: `Local Codex exec actor lanes are running with max concurrency ${maxConcurrency}; Observer data will refresh as sanitized evidence arrives.`
    }
    ],
    lanes: lanes.map((lane): LocalCodexExecLaneBundleInput => ({
      focus: lane.focus,
      simId: lane.simId,
      streamId: lane.streamId,
      status: "running",
      progress: 35,
      currentStep: "Local Codex exec actor running",
      summary: `Local Codex exec actor ${lane.focus.label} is running.`,
      terminalTail: "Codex exec actor is running; sanitized transcript evidence will be linked after completion.",
      updatedAt: runningAt,
      completion: {
        checkedAt: runningAt,
        reason: "actor process is still running",
        status: "running"
      }
    })),
    events,
    review: createLocalActorRunningReviewSummary(options.simCount === 1 ? "Codex exec" : "Codex exec fanout")
  });
  await writeRunBundleArtifacts(absoluteArtifactRoot, runningBundle);

  const laneResults = await mapWithConcurrency(lanes, maxConcurrency, async (lane): Promise<ExecLaneResult> => {
    const actor = await executeLocalActorCommand(lane.command, {
      cwd: options.cwd,
      timeoutMs
    });
    const redactedTranscript = redactSensitiveText(actor.transcript);
    const tail = tailText(redactedTranscript, 6_000);
    const transcriptPath = options.simCount === 1
      ? "transcripts/codex-exec-sanitized.jsonl"
      : `transcripts/${lane.streamId}-sanitized.jsonl`;
    const tracePath = options.simCount === 1 ? "actor.json" : `actors/${lane.streamId}.json`;
    await writeFile(
      path.join(absoluteArtifactRoot, transcriptPath),
      redactedTranscript.length > 0 ? redactedTranscript : "No transcript output captured.\n",
      "utf8"
    );
    await writeJson(path.join(absoluteArtifactRoot, tracePath), {
      schema: "mimetic.local-codex-exec-actor.v1",
      actor: "codex-exec",
      commandName: lane.command.name,
      focusId: lane.focus.id,
      promptDigest: lane.promptDigest,
      startedAt: createdAt,
      completedAt: new Date().toISOString(),
      durationMs: actor.durationMs,
      exitCode: actor.exitCode,
      signal: actor.signal,
      status: actor.status,
      timeoutMs,
      transcriptBytes: actor.transcriptBytes,
      transcriptPath,
      redaction: "passed"
    });
    return {
      actor,
      command: lane.command,
      focus: lane.focus,
      promptDigest: lane.promptDigest,
      simId: lane.simId,
      streamId: lane.streamId,
      tail,
      tracePath,
      transcriptPath
    };
  });

  const completedAt = new Date().toISOString();
  const laneStatuses = laneResults.map((result) => result.actor.status);
  const status = aggregateActorStatus(laneStatuses);
  const verdictReason = options.simCount === 1
    ? laneResults[0]?.actor.reason ?? "actor did not return a result"
    : summarizeExecFanout(laneStatuses);
  for (const result of laneResults) {
    pushEvent(
      "actor.observation",
      `Captured ${result.actor.transcriptBytes} output byte${result.actor.transcriptBytes === 1 ? "" : "s"}; sanitized transcript tail recorded with redaction=passed.`,
      "info",
      result.simId,
      result.streamId
    );
    pushEvent(
      "actor.artifact",
      "Wrote sanitized Codex exec transcript and actor trace artifacts under the ignored run directory.",
      "info",
      result.simId,
      result.streamId
    );
    pushEvent(
      "actor.verdict",
      `Local Codex exec actor lane ${result.focus.label} verdict ${result.actor.status}: ${result.actor.reason}`,
      result.actor.status === "passed" ? "info" : result.actor.status === "timed_out" ? "warn" : "error",
      result.simId,
      result.streamId
    );
    pushEvent(
      result.actor.status === "timed_out" ? "actor.timeout" : "actor.exited",
      result.actor.status === "timed_out"
        ? `Actor timed out after ${timeoutMs}ms; last safe observation retained.`
        : `Actor exited with code ${result.actor.exitCode ?? "null"}${result.actor.signal ? ` and signal ${result.actor.signal}` : ""}.`,
      result.actor.status === "passed" ? "info" : "warn",
      result.simId,
      result.streamId
    );
  }
  await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  const bundle = buildLocalCodexExecBundle({
    runId,
    simCount: options.simCount,
    createdAt,
    cwd: options.cwd,
    artifactRoot,
    packageName,
    mimeticSource,
    source,
    persona: selection.persona,
    scenario: selection.scenario,
    lifecycle: [
      ...baseLifecycle,
      {
        at: completedAt,
        event: "review.skeleton.created",
        message: "Created review skeleton from sanitized actor lifecycle evidence."
      }
    ],
    lanes: laneResults.map((result): LocalCodexExecLaneBundleInput => ({
      focus: result.focus,
      simId: result.simId,
      streamId: result.streamId,
      status: result.actor.status,
      progress: 100,
      currentStep: result.actor.status === "passed" ? "Local Codex exec actor completed" : "Local Codex exec actor needs review",
      summary: `Local Codex exec actor ${result.focus.label} ${result.actor.status}: ${result.actor.reason}`,
      terminalTail: result.tail,
      updatedAt: completedAt,
      transcriptPath: result.transcriptPath,
      tracePath: result.tracePath,
      completion: {
        checkedAt: completedAt,
        ...(result.actor.exitCode === undefined ? {} : { exitCode: result.actor.exitCode }),
        logTail: result.tail,
        reason: result.actor.reason,
        status: result.actor.status
      }
    })),
    events,
    review: createLocalActorReviewSummary(options.simCount === 1 ? "Codex exec" : "Codex exec fanout", status, verdictReason)
  });

  await writeRunBundleArtifacts(absoluteArtifactRoot, bundle);

  return {
    schema: "mimetic.run-result.v1",
    ok: status === "passed",
    runId,
    mode: "live",
    simCount: options.simCount,
    cwd: options.cwd,
    artifactRoot,
    bundlePath: path.join(artifactRoot, "run.json"),
    reviewPath: path.join(artifactRoot, "review.md"),
    latestPath: path.join(".mimetic", "runs", "latest.json"),
    warnings,
    ...(status === "passed"
      ? {}
      : {
          error: {
            code: "MIMETIC_LOCAL_CODEX_EXEC_FAILED" as const,
            message: `Local Codex exec actor ${status}: ${verdictReason}`
          }
        })
  };
}

interface LocalCodexAppServerLane {
  focus: LocalCodexExecFocus;
  prefix: string;
  prompt: string;
  promptDigest: string;
  simId: string;
  streamId: string;
}

interface LocalCodexAppServerLaneBundleInput {
  completion?: RunStreamCompletion;
  currentStep: string;
  focus: LocalCodexExecFocus;
  progress: number;
  result?: CodexAppServerRunResult;
  simId: string;
  status: RunSimulationStatus;
  streamId: string;
  summary: string;
  terminalTail: string;
  updatedAt: string;
}

function buildLocalCodexAppServerBundle(args: {
  artifactRoot: string;
  createdAt: string;
  cwd: string;
  events: RunEvent[];
  lanes: LocalCodexAppServerLaneBundleInput[];
  lifecycle: RunBundle["lifecycle"];
  mimeticSource: RunBundle["source"]["mimeticSource"];
  packageName: string | null;
  persona: RunBundle["persona"];
  resolvedPersona: ResolvedPersona;
  review: ReviewSummary;
  runId: string;
  scenario: RunBundle["scenario"];
  simCount: number;
  source: RunBundle["source"];
}): RunBundle {
  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: "live",
    simCount: args.simCount,
    createdAt: args.createdAt,
    cwd: args.cwd,
    artifactRoot: args.artifactRoot,
    source: args.source,
    persona: args.persona,
    scenario: args.scenario,
    lifecycle: args.lifecycle,
    simulations: args.lanes.map((lane, index): RunSimulation => ({
      id: lane.simId,
      index: index + 1,
      personaId: `codex-app-server-${lane.focus.id}`,
      scenarioId: args.scenario.id,
      status: lane.status,
      streamKind: "codex-ui",
      mode: "codex-app-sim",
      progress: lane.progress,
      currentStep: lane.currentStep,
      summary: lane.summary,
      streamIds: [lane.streamId],
      startedAt: args.createdAt,
      updatedAt: lane.updatedAt
    })),
    streams: args.lanes.map((lane): RunStream => {
      const result = lane.result;
      // Provider-neutral projection of the actor evidence, with the persona's
      // applied traits threaded in. Only present once the lane has a result.
      const actor: ActorTrace | undefined = result
        ? getActor("codex-app-server").toActorTrace(result, {
            id: args.persona.id,
            traitsApplied: personaToDirectives(args.resolvedPersona).traitsApplied,
            promptDigest: result.trace.promptDigest
          })
        : undefined;
      const artifacts: RunStream["artifacts"] = [
        { label: "run bundle", path: "run.json", kind: "bundle" },
        { label: "review", path: "review.md", kind: "review" },
        { label: "event log", path: "events.ndjson", kind: "events" },
        ...(result ? [
          { label: "codex app-server trace", path: result.tracePath, kind: "trace" as const },
          { label: "codex app-server events", path: result.eventsPath, kind: "events" as const },
          { label: "codex app-server transcript", path: result.transcriptPath, kind: "log" as const }
        ] : [])
      ];

      return {
        id: lane.streamId,
        simId: lane.simId,
        kind: "codex-ui",
        label: `Codex app-server - ${lane.focus.label}`,
        status: lane.status,
        transport: "app-server",
        updatedAt: lane.updatedAt,
        embed: {
          kind: "placeholder",
          title: `Codex app-server - ${lane.focus.label}`
        },
        terminal: {
          title: `Codex app-server - ${lane.focus.label}`,
          format: "plain",
          stdin: "sent",
          tail: lane.terminalTail
        },
        codex: {
          provider: "codex-app-server",
          contract: "Mimetic captures Codex app-server Thread, Turn, Item, approval, command, file, tool, message, and reasoning evidence as redacted local artifacts.",
          state: codexStateForStream(lane.status),
          ...(result?.experimentalApi === undefined ? {} : { experimentalApi: result.experimentalApi }),
          ...(result?.counts === undefined ? {} : { eventCount: result.counts.envelopes }),
          ...(result?.model === undefined ? {} : { model: result.model }),
          ...(result?.sessionId === undefined ? {} : { sessionId: result.sessionId }),
          ...(result?.threadId === undefined ? {} : { threadId: result.threadId }),
          ...(result?.trace === undefined ? {} : { trace: result.trace }),
          ...(result?.tracePath === undefined ? {} : { tracePath: result.tracePath }),
          ...(result?.turnId === undefined ? {} : { turnId: result.turnId })
        },
        ...(actor === undefined ? {} : { actor }),
        ...(lane.completion ? { completion: lane.completion } : {}),
        artifacts
      };
    }),
    events: args.events,
    redaction: {
      status: "passed",
      notes: "Codex app-server envelopes and transcript summaries were redacted before persistence; raw prompts and secret-bearing fields are not stored in run events."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review: args.review,
    feedbackCandidates: []
  };
}

async function runLocalCodexAppServer(options: RunOptions & {
  actor: "codex-app-server";
  cwd: string;
  simCount: number;
}): Promise<RunResult> {
  const warnings: string[] = [];
  const timeoutMs = normalizeActorTimeout(options.timeoutMs ?? readEnvInteger("MIMETIC_CODEX_ACTOR_TIMEOUT_MS") ?? LOCAL_CODEX_TUI_DEFAULT_TIMEOUT_MS);
  if (timeoutMs === null) {
    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "MIMETIC_INVALID_TIMEOUT",
        message: `--timeout-ms must be an integer between 1 and ${LOCAL_CODEX_TUI_MAX_TIMEOUT_MS}.`
      }
    };
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const runId = options.runId ?? `codex-app-server-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const artifactRoot = path.join(".mimetic", "runs", runId);
  const absoluteArtifactRoot = path.join(options.cwd, artifactRoot);
  const eventsPath = path.join(absoluteArtifactRoot, "events.ndjson");
  const packageName = await readPackageName(options.cwd);
  const mimeticSource = await directoryExists(path.join(options.cwd, "mimetic")) ? "present" : "missing";
  const source = await buildRunSource({ cwd: options.cwd, capturedAt: createdAt, mimeticSource, packageName });
  const selection = await loadDryRunSelection(options.cwd, mimeticSource);
  if (mimeticSource === "missing") {
    warnings.push("Committed mimetic/ source was not found; using built-in synthetic Codex app-server actor defaults.");
  }
  warnings.push(...selection.warnings);

  const events: RunEvent[] = [];
  const pushEvent = (
    type: string,
    message: string,
    level: RunEvent["level"] = "info",
    simId?: string,
    streamId?: string
  ): void => {
    events.push({
      id: `event-${String(events.length + 1).padStart(3, "0")}`,
      at: new Date().toISOString(),
      level,
      type,
      message,
      ...(simId === undefined ? {} : { simId }),
      ...(streamId === undefined ? {} : { streamId })
    });
  };

  await mkdir(path.join(absoluteArtifactRoot, "observer"), { recursive: true });
  await mkdir(path.join(absoluteArtifactRoot, "actors"), { recursive: true });
  await writeJson(path.join(options.cwd, ".mimetic", "runs", "latest.json"), {
    schema: "mimetic.latest-run.v1",
    runId,
    path: artifactRoot,
    updatedAt: createdAt
  } satisfies RunPointer);

  const lanes: LocalCodexAppServerLane[] = Array.from({ length: options.simCount }, (_, index) => {
    const focus = localCodexExecFocus(index);
    const simId = `sim-${String(index + 1).padStart(2, "0")}`;
    const streamId = `${simId}-codex-app-server`;
    const prompt = buildLocalCodexAppServerPrompt(selection, {
      focus,
      index: index + 1,
      total: options.simCount
    });
    const promptDigest = digestText(prompt);
    pushEvent(
      "codex-app-server.spawned",
      `Spawned Codex app-server lane ${index + 1}/${options.simCount} (${focus.label}) in explicit opt-in mode.`,
      "info",
      simId,
      streamId
    );
    pushEvent(
      "codex-app-server.prompt.submitted",
      `Submitted bounded public-safe app-server prompt digest ${promptDigest}; raw prompt omitted from event log.`,
      "info",
      simId,
      streamId
    );
    return {
      focus,
      prefix: options.simCount === 1 ? "" : `actors/${streamId}/`,
      prompt,
      promptDigest,
      simId,
      streamId
    };
  });

  for (const lane of lanes) {
    pushEvent(
      "codex-app-server.running",
      "Published Codex app-server running snapshot for Observer polling.",
      "info",
      lane.simId,
      lane.streamId
    );
  }
  await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  const baseLifecycle: RunBundle["lifecycle"] = [
    {
      at: createdAt,
      event: "run.created",
      message: `Live Codex app-server run created with ${options.simCount} explicit opt-in lane${options.simCount === 1 ? "" : "s"}.`
    },
    {
      at: createdAt,
      event: "actor.selected",
      message: "Selected local codex-app-server actor."
    }
  ];
  const runningAt = new Date().toISOString();
  const runningBundle = buildLocalCodexAppServerBundle({
    runId,
    simCount: options.simCount,
    createdAt,
    cwd: options.cwd,
    artifactRoot,
    packageName,
    mimeticSource,
    source,
    persona: selection.persona,
    resolvedPersona: selection.resolvedPersona,
    scenario: selection.scenario,
    lifecycle: [
      ...baseLifecycle,
      {
        at: runningAt,
        event: "codex-app-server.running",
        message: "Codex app-server lanes are running; Observer data will refresh as redacted app-server evidence arrives."
      }
    ],
    lanes: lanes.map((lane): LocalCodexAppServerLaneBundleInput => ({
      focus: lane.focus,
      simId: lane.simId,
      streamId: lane.streamId,
      status: "running",
      progress: 35,
      currentStep: "Codex app-server actor running",
      summary: `Codex app-server actor ${lane.focus.label} is running.`,
      terminalTail: "Codex app-server actor is running; redacted Thread/Turn/Item trace evidence will be linked after completion.",
      updatedAt: runningAt,
      completion: {
        checkedAt: runningAt,
        reason: "Codex app-server turn is still running",
        status: "running"
      }
    })),
    events,
    review: createLocalActorRunningReviewSummary("Codex app-server")
  });
  await writeRunBundleArtifacts(absoluteArtifactRoot, runningBundle);

  const laneResults = await mapWithConcurrency(lanes, options.simCount, async (lane) => {
    const laneRunRoot = lane.prefix ? path.join(absoluteArtifactRoot, lane.prefix) : absoluteArtifactRoot;
    const result = await getActor("codex-app-server").runSession({
      cwd: options.cwd,
      prompt: lane.prompt,
      runRoot: laneRunRoot,
      timeoutMs,
      ...(options.actorCommand === undefined ? {} : { actorCommand: options.actorCommand }),
      approvalPolicy: "never",
      experimentalApi: process.env.MIMETIC_CODEX_APP_SERVER_EXPERIMENTAL === "1",
      ...(process.env.MIMETIC_CODEX_APP_SERVER_MODEL ? { model: process.env.MIMETIC_CODEX_APP_SERVER_MODEL } : {}),
      sandbox: readCodexAppServerSandboxFromEnv(),
      serviceName: "mimetic-cli"
    });
    return {
      lane,
      result: prefixCodexAppServerResultPaths(result, lane.prefix)
    };
  });

  const completedAt = new Date().toISOString();
  const statuses = laneResults.map((entry) => entry.result.status);
  const status = aggregateActorStatus(statuses);
  const verdictReason = options.simCount === 1
    ? laneResults[0]?.result.reason ?? "Codex app-server actor did not return a result"
    : summarizeExecFanout(statuses);
  for (const entry of laneResults) {
    pushEvent(
      "codex-app-server.artifact",
      `Captured ${entry.result.counts.envelopes} app-server envelope${entry.result.counts.envelopes === 1 ? "" : "s"}; trace summary and transcript were redacted before persistence.`,
      "info",
      entry.lane.simId,
      entry.lane.streamId
    );
    pushEvent(
      "codex-app-server.verdict",
      `Codex app-server actor lane ${entry.lane.focus.label} verdict ${entry.result.status}: ${entry.result.reason}`,
      entry.result.status === "passed" ? "info" : entry.result.status === "timed_out" ? "warn" : "error",
      entry.lane.simId,
      entry.lane.streamId
    );
  }
  await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  const bundle = buildLocalCodexAppServerBundle({
    runId,
    simCount: options.simCount,
    createdAt,
    cwd: options.cwd,
    artifactRoot,
    packageName,
    mimeticSource,
    source,
    persona: selection.persona,
    resolvedPersona: selection.resolvedPersona,
    scenario: selection.scenario,
    lifecycle: [
      ...baseLifecycle,
      {
        at: completedAt,
        event: "review.skeleton.created",
        message: "Created review skeleton from redacted Codex app-server lifecycle evidence."
      }
    ],
    lanes: laneResults.map((entry): LocalCodexAppServerLaneBundleInput => ({
      focus: entry.lane.focus,
      simId: entry.lane.simId,
      streamId: entry.lane.streamId,
      status: entry.result.status,
      progress: 100,
      currentStep: entry.result.status === "passed" ? "Codex app-server actor completed" : "Codex app-server actor needs review",
      summary: `Codex app-server actor ${entry.lane.focus.label} ${entry.result.status}: ${entry.result.reason}`,
      terminalTail: entry.result.tail,
      updatedAt: completedAt,
      result: entry.result,
      completion: {
        checkedAt: completedAt,
        ...(entry.result.exitCode === undefined ? {} : { exitCode: entry.result.exitCode }),
        logTail: entry.result.tail,
        reason: entry.result.reason,
        status: entry.result.status
      }
    })),
    events,
    review: createLocalActorReviewSummary(options.simCount === 1 ? "Codex app-server" : "Codex app-server fanout", status, verdictReason)
  });

  await writeRunBundleArtifacts(absoluteArtifactRoot, bundle);

  return {
    schema: "mimetic.run-result.v1",
    ok: status === "passed",
    runId,
    mode: "live",
    simCount: options.simCount,
    cwd: options.cwd,
    artifactRoot,
    bundlePath: path.join(artifactRoot, "run.json"),
    reviewPath: path.join(artifactRoot, "review.md"),
    latestPath: path.join(".mimetic", "runs", "latest.json"),
    warnings,
    ...(status === "passed"
      ? {}
      : {
          error: {
            code: "MIMETIC_CODEX_APP_SERVER_FAILED" as const,
            message: `Codex app-server actor ${status}: ${verdictReason}`
          }
        })
  };
}

function buildSyntheticObserverFixtures(args: {
  createdAt: string;
  personaId: string;
  scenarioId: string;
  simCount: number;
}): {
  events: RunEvent[];
  simulations: RunSimulation[];
  streams: RunStream[];
} {
  const templates = [
    {
      kind: "ui" as const,
      mode: "browser-sim" as const,
      label: "UI journey",
      currentStep: "Route and viewport contract captured",
      summary: "Browser lane reserved for VNC playback, screenshots, route state, and interaction trace.",
      tail: "open target app\nresolve first-run route\ncapture viewport state\nrecord interaction trace",
      viewport: { width: 1440, height: 960, deviceScaleFactor: 1 }
    },
    {
      kind: "terminal" as const,
      mode: "cli-sim" as const,
      label: "CLI actor",
      currentStep: "Command transcript contract captured",
      summary: "CLI lane reserved for command-by-command persona runs with stdout/stderr and artifact links.",
      tail: "$ mimetic doctor\nok target cwd\nok mimetic source\n$ mimetic run --scenario first-run-smoke\ncontract proof emitted",
      viewport: undefined
    },
    {
      kind: "tui" as const,
      mode: "tui-sim" as const,
      label: "TUI actor",
      currentStep: "Terminal UI frame contract captured",
      summary: "TUI lane reserved for PTY bytes, ANSI rendering, focus replay, and optional assisted attach.",
      tail: "\u001b[2mMimetic TUI frame\u001b[0m\n> persona: skeptical-power-user\n> scenario: onboarding-regression\nstatus: awaiting live PTY transport",
      viewport: undefined
    },
    {
      kind: "codex-ui" as const,
      mode: "codex-app-sim" as const,
      label: "Codex UI",
      currentStep: "App-server embed contract captured",
      summary: "Codex UI lane reserved for app-server sessions that can be watched beside terminal evidence.",
      tail: "codex-app-server session contract\nstate: not_connected\nembed: pending provider URL\nreceipts: planned",
      viewport: { width: 1280, height: 900, deviceScaleFactor: 1 }
    }
  ];

  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events: RunEvent[] = [
    {
      id: "event-000",
      at: args.createdAt,
      level: "info",
      type: "observer.contract.created",
      message: "Created public-safe observer stream contract."
    }
  ];

  for (let index = 0; index < args.simCount; index += 1) {
    const template = templates[index % templates.length];
    if (!template) {
      throw new Error("Synthetic observer template missing.");
    }
    const simId = `sim-${String(index + 1).padStart(2, "0")}`;
    const streamId = `${simId}-${template.kind}`;
    const status: RunSimulationStatus = "contract_proof_only";

    simulations.push({
      id: simId,
      index: index + 1,
      personaId: args.personaId,
      scenarioId: args.scenarioId,
      status,
      streamKind: template.kind,
      mode: template.mode,
      progress: 100,
      currentStep: template.currentStep,
      summary: template.summary,
      streamIds: [streamId],
      startedAt: args.createdAt,
      updatedAt: args.createdAt
    });

    streams.push({
      id: streamId,
      simId,
      kind: template.kind,
      label: template.label,
      status,
      transport: streamTransport(template.kind),
      updatedAt: args.createdAt,
      embed: {
        kind: template.kind === "terminal" || template.kind === "tui" ? "terminal" : "placeholder",
        title: template.label
      },
      ...(template.viewport ? { viewport: template.viewport } : {}),
      terminal: {
        title: template.label,
        format: template.kind === "tui" ? "ansi" : "plain",
        stdin: "disabled",
        tail: template.tail
      },
      ...(template.kind === "ui" || template.kind === "codex-ui"
        ? {
            ui: {
              route: template.kind === "ui" ? "/first-run" : "/codex/session",
              intent: template.summary,
              state: "contract-only"
            }
          }
        : {}),
      ...(template.kind === "codex-ui"
        ? {
            codex: {
              provider: "codex-app-server" as const,
              state: "not_connected" as const,
              contract: "Observer accepts an app-server embed URL, session id, status feed, terminal receipt feed, and artifact links."
            }
          }
        : {}),
      artifacts: [
        { label: "run bundle", path: "run.json", kind: "bundle" },
        { label: "review", path: "review.md", kind: "review" },
        { label: "event log", path: "events.ndjson", kind: "events" }
      ]
    });

    events.push(
      {
        id: `event-${String(index + 1).padStart(3, "0")}-a`,
        at: args.createdAt,
        level: "info",
        type: "sim.contract.ready",
        message: `${template.label} stream contract ready.`,
        simId,
        streamId
      },
      {
        id: `event-${String(index + 1).padStart(3, "0")}-b`,
        at: args.createdAt,
        level: "warn",
        type: "sim.live-substrate.missing",
        message: "No live actor launched in dry-run mode; observer lane is ready for real substrate evidence.",
        simId,
        streamId
      }
    );
  }

  return { events, simulations, streams };
}

function streamTransport(kind: RunStreamKind): RunStream["transport"] {
  if (kind === "tui") return "pty";
  if (kind === "codex-ui") return "app-server";
  if (kind === "ui" || kind === "browser") return "polling";
  return "snapshot";
}

interface LocalActorCommand {
  args: string[];
  command: string;
  name: string;
}

interface LocalActorCommandResult {
  durationMs: number;
  exitCode?: number;
  reason: string;
  signal?: NodeJS.Signals;
  status: LocalActorTerminalStatus;
  transcript: string;
  transcriptBytes: number;
}

type LocalActorTerminalStatus = Extract<RunSimulationStatus, "passed" | "failed" | "blocked" | "timed_out">;

interface LocalCodexExecFocus {
  id: string;
  label: string;
  instruction: string;
  suggestedCommands: [string, string];
}

type CodexTrustPreflight =
  | { ok: true }
  | {
      ok: false;
      message: string;
      recoveryCommand: string;
      trustRoot: string;
    };

function resolveLocalCodexTuiCommand(
  cwd: string,
  prompt: string,
  overrideCommand: string[] | undefined
): LocalActorCommand {
  const envCommand = process.env.MIMETIC_CODEX_ACTOR_COMMAND;
  const commandParts = overrideCommand && overrideCommand.length > 0
    ? overrideCommand
    : envCommand
      ? parseCommandLine(envCommand)
      : defaultLocalCodexTuiCommand(cwd, prompt);
  const [command, ...args] = commandParts;

  if (!command) {
    const [fallbackCommand, ...fallbackArgs] = defaultLocalCodexTuiCommand(cwd, prompt);
    return {
      command: fallbackCommand ?? "codex",
      args: fallbackArgs,
      name: fallbackCommand ? path.basename(fallbackCommand) : "codex"
    };
  }

  return {
    command,
    args,
    name: path.basename(command)
  };
}

function defaultLocalCodexTuiCommand(cwd: string, prompt: string): string[] {
  const codexParts = [
    "codex",
    "--no-alt-screen",
    "-C",
    cwd,
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    prompt
  ];

  if (process.platform === "linux") {
    return ["script", "-qfec", shellJoin(codexParts), "/dev/null"];
  }

  return codexParts;
}

function resolveLocalCodexExecCommand(
  cwd: string,
  prompt: string,
  overrideCommand: string[] | undefined
): LocalActorCommand {
  const envCommand = process.env.MIMETIC_CODEX_ACTOR_COMMAND;
  const commandParts = overrideCommand && overrideCommand.length > 0
    ? overrideCommand
    : envCommand
      ? parseCommandLine(envCommand)
      : defaultLocalCodexExecCommand(cwd, prompt);
  const [command, ...args] = commandParts;

  if (!command) {
    const [fallbackCommand, ...fallbackArgs] = defaultLocalCodexExecCommand(cwd, prompt);
    return {
      command: fallbackCommand ?? "codex",
      args: fallbackArgs,
      name: fallbackCommand ? path.basename(fallbackCommand) : "codex"
    };
  }

  return {
    command,
    args,
    name: path.basename(command)
  };
}

function defaultLocalCodexExecCommand(cwd: string, prompt: string): string[] {
  return [
    "codex",
    "exec",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--ephemeral",
    "-C",
    cwd,
    "--sandbox",
    "read-only",
    "--json",
    prompt
  ];
}

function executeLocalActorCommand(
  command: LocalActorCommand,
  options: {
    cwd: string;
    timeoutMs: number;
    verdictNonce?: string;
  }
): Promise<LocalActorCommandResult> {
  const startedAt = Date.now();
  let transcript = "";
  let transcriptBytes = 0;
  let terminalQueryBuffer = "";
  let observedMarkerStatus: LocalActorTerminalStatus | null = null;
  let stoppingAfterMarker = false;
  let timedOut = false;
  let settled = false;
  let timer: NodeJS.Timeout;
  let markerKillTimer: NodeJS.Timeout | undefined;

  return new Promise((resolve) => {
    const finish = (result: Omit<LocalActorCommandResult, "durationMs" | "transcript" | "transcriptBytes">): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(markerKillTimer);
      const normalizedTranscript = normalizeLocalActorTranscript(transcript);
      resolve({
        ...result,
        durationMs: Date.now() - startedAt,
        transcript: redactSensitiveText(normalizedTranscript),
        transcriptBytes
      });
    };

    const child = spawn(command.command, command.args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        TERM: process.env.TERM ?? "xterm-256color",
        COLUMNS: process.env.COLUMNS ?? "120",
        LINES: process.env.LINES ?? "40",
        ...(options.verdictNonce ? { MIMETIC_ACTOR_VERDICT_NONCE: options.verdictNonce } : {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (timedOut) {
          child.kill("SIGKILL");
        }
      }, 2_000).unref();
    }, options.timeoutMs);
    timer.unref();

    const capture = (chunk: Buffer): void => {
      transcriptBytes += chunk.byteLength;
      transcript = limitTranscript(transcript + chunk.toString("utf8"));
      terminalQueryBuffer = respondToTerminalQueries(terminalQueryBuffer, chunk, child.stdin);
      const markerStatus = observedMarkerStatus ?? extractLocalActorVerdict(
        normalizeLocalActorTranscript(transcript),
        options.verdictNonce
      );
      if (markerStatus && !observedMarkerStatus) {
        observedMarkerStatus = markerStatus;
        stoppingAfterMarker = true;
        child.kill("SIGTERM");
        markerKillTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 2_000);
        markerKillTimer.unref();
      }
    };

    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("error", (error) => {
      finish({
        status: "blocked",
        reason: `actor command could not start: ${error.message}`
      });
    });
    child.once("close", (code, signal) => {
      if (timedOut || (Date.now() - startedAt >= options.timeoutMs && code === null)) {
        timedOut = false;
        finish({
          status: "timed_out",
          reason: `actor exceeded ${options.timeoutMs}ms timeout`,
          ...(signal === null ? {} : { signal })
        });
        return;
      }

      const markerStatus = observedMarkerStatus ?? extractLocalActorVerdict(
        normalizeLocalActorTranscript(transcript),
        options.verdictNonce
      );
      const processFailed = code !== 0 && !(stoppingAfterMarker && markerStatus);
      const status = processFailed
        ? markerStatus === "blocked" ? "blocked" : "failed"
        : markerStatus ?? "passed";
      finish({
        status,
        reason: processFailed
          ? markerStatus === "blocked"
            ? `actor reported blocked verdict marker and exited with code ${code ?? "null"}`
            : `actor process exited with code ${code ?? "null"}`
          : markerStatus
            ? `actor reported ${markerStatus} verdict marker`
            : "actor process exited successfully",
        ...(code === null ? {} : { exitCode: code }),
        ...(signal === null ? {} : { signal })
      });
    });
  });
}

function respondToTerminalQueries(
  currentBuffer: string,
  chunk: Buffer,
  stdin: NodeJS.WritableStream | null
): string {
  if (!stdin || !stdin.writable) {
    return "";
  }

  let buffer = `${currentBuffer}${chunk.toString("latin1")}`;

  while (true) {
    const cprIndex = buffer.indexOf("\x1b[6n");
    const oscMatch = /\x1b\](10|11|12);\?(?:\x07|\x1b\\)/.exec(buffer);
    const oscIndex = oscMatch?.index ?? -1;

    if (cprIndex === -1 && oscIndex === -1) {
      break;
    }

    if (cprIndex !== -1 && (oscIndex === -1 || cprIndex < oscIndex)) {
      stdin.write("\x1b[24;120R");
      buffer = buffer.slice(cprIndex + "\x1b[6n".length);
      continue;
    }

    const colorSlot = oscMatch?.[1] ?? "10";
    stdin.write(terminalColorResponse(colorSlot));
    buffer = buffer.slice((oscIndex === -1 ? 0 : oscIndex) + (oscMatch?.[0].length ?? 0));
  }

  return buffer.slice(-128);
}

function terminalColorResponse(slot: string): string {
  if (slot === "11") {
    return "\x1b]11;rgb:0000/0000/0000\x07";
  }

  return `\x1b]${slot};rgb:ffff/ffff/ffff\x07`;
}

function normalizeLocalActorTranscript(transcript: string): string {
  return transcript
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[78=>]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function extractLocalActorVerdict(transcript: string, verdictNonce?: string): LocalActorTerminalStatus | null {
  const compactTranscript = transcript.replace(/\s+/g, "");
  const match = verdictNonce
    ? new RegExp(
      `MIMETIC_ACTOR_VERDICT=(passed|blocked|failed)MIMETIC_ACTOR_NONCE=${escapeRegExp(verdictNonce)}`,
      "i"
    ).exec(compactTranscript)
    : /MIMETIC_ACTOR_VERDICT=(passed|blocked|failed)/i.exec(compactTranscript);
  if (!match) {
    return null;
  }

  return match[1]?.toLowerCase() as LocalActorTerminalStatus;
}

async function checkCodexWorkspaceTrust(cwd: string): Promise<CodexTrustPreflight> {
  if (process.env.MIMETIC_SKIP_CODEX_TRUST_PREFLIGHT === "1") {
    return { ok: true };
  }

  const trustRoot = await detectCodexTrustRoot(cwd);
  if (!trustRoot) {
    return { ok: true };
  }

  const configPath = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "config.toml");
  const configText = await readTextIfExists(configPath);

  if (configText && codexConfigTrustsProject(configText, trustRoot)) {
    return { ok: true };
  }

  return {
    ok: false,
    trustRoot,
    message: `Codex workspace trust preflight blocked local TUI launch; trust root is not explicitly trusted as an exact Codex project root: ${trustRoot}`,
    recoveryCommand: `codex --no-alt-screen -C ${shellQuote(trustRoot)}`
  };
}

async function detectCodexTrustRoot(cwd: string): Promise<string | null> {
  const worktreeRoot = await findGitWorktreeRoot(cwd);
  if (!worktreeRoot) {
    return null;
  }

  const dotGitPath = path.join(worktreeRoot, ".git");
  if (await directoryExists(dotGitPath)) {
    return worktreeRoot;
  }

  const gitFile = await readTextIfExists(dotGitPath);
  if (!gitFile?.startsWith("gitdir:")) {
    return worktreeRoot;
  }

  const gitDir = gitFile.slice("gitdir:".length).trim();
  const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(worktreeRoot, gitDir);
  const commonDirText = await readTextIfExists(path.join(absoluteGitDir, "commondir"));
  if (!commonDirText) {
    return worktreeRoot;
  }

  const commonDir = commonDirText.trim();
  const absoluteCommonDir = path.resolve(absoluteGitDir, commonDir);
  return path.basename(absoluteCommonDir) === ".git" ? path.dirname(absoluteCommonDir) : worktreeRoot;
}

async function findGitWorktreeRoot(cwd: string): Promise<string | null> {
  let current = path.resolve(cwd);

  while (true) {
    if (await fileExists(path.join(current, ".git")) || await directoryExists(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function codexConfigTrustsProject(configText: string, trustRoot: string): boolean {
  const sectionPattern = /^\[projects\."((?:\\.|[^"\\])*)"\]\s*$/gm;
  let sectionMatch: RegExpExecArray | null;

  while ((sectionMatch = sectionPattern.exec(configText)) !== null) {
    const projectPath = unescapeTomlString(sectionMatch[1] ?? "");
    const afterSection = configText.slice(sectionMatch.index + sectionMatch[0].length);
    const nextSectionIndex = afterSection.search(/^\[/m);
    const sectionBody = nextSectionIndex === -1 ? afterSection : afterSection.slice(0, nextSectionIndex);

    if (/^trust_level\s*=\s*"trusted"\s*$/m.test(sectionBody) && isSamePath(projectPath, trustRoot)) {
      return true;
    }
  }

  return false;
}

function unescapeTomlString(value: string): string {
  return value.replace(/\\(["\\])/g, "$1");
}

function isSamePath(candidatePath: string, targetPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const target = path.resolve(targetPath);
  return candidate === target;
}

function normalizeActorTimeout(value: number | undefined): number | null {
  if (normalizePositiveInteger(value) === null || value === undefined || value > LOCAL_CODEX_TUI_MAX_TIMEOUT_MS) {
    return null;
  }

  return value;
}

function normalizePositiveInteger(value: number | undefined): number | null {
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return null;
  }

  return value;
}

function readEnvInteger(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      const item = items[index];
      if (item === undefined) {
        return;
      }
      results[index] = await mapper(item, index);
    }
  }));

  return results;
}

function personaPromptLine(selection: { resolvedPersona: ResolvedPersona }): string {
  return renderPersonaPromptSection(selection.resolvedPersona);
}

function buildLocalCodexTuiPrompt(selection: {
  persona: RunBundle["persona"];
  resolvedPersona: ResolvedPersona;
  scenario: RunBundle["scenario"];
}, verdictNonce: string): string {
  return [
    "You are a Mimetic local Codex TUI dogfood actor.",
    personaPromptLine(selection),
    `Scenario: ${selection.scenario.title}.`,
    "Inspect this public repository's Mimetic setup, run evidence, and Observer affordances.",
    "Run at most two read-only inspection commands; prefer file reads, `node dist/cli.js --help`, or `pnpm typecheck` when available.",
    "Do not run commands that write runtime artifacts or temp config, including `pnpm mimetic`, `mimetic watch`, `mimetic feedback`, `mimetic init`, tests, builds, installs, or commands that write `.mimetic/`.",
    "If the strongest proof would require writes in this read-only sandbox, inspect existing artifacts instead and name the write-required proof as a follow-up.",
    "Use passed when read-only inspection confirms the committed harness and existing evidence contract; write-required follow-ups alone are not blockers.",
    "Do not print secrets, do not commit, do not push, do not open GitHub issues, and do not use private data.",
    "Finish by summarizing one public-safe harness improvement.",
    `Then print exactly one final machine-readable line in this format: MIMETIC_ACTOR_VERDICT=<status> MIMETIC_ACTOR_NONCE=${verdictNonce}.`,
    "Replace <status> with exactly one lowercase word: passed, blocked, or failed."
  ].join(" ");
}

function localCodexExecFocus(index: number): LocalCodexExecFocus {
  const focuses = [
    {
      id: "install-readability",
      label: "install/readability",
      instruction: "audit whether a new user can understand the committed Mimetic dogfood setup quickly",
      suggestedCommands: [
        "test -r mimetic/README.md && sed -n '1,40p' mimetic/README.md",
        "test -r mimetic/config.ts && wc -l mimetic/config.ts"
      ]
    },
    {
      id: "public-safety-trust",
      label: "public-safety/trust",
      instruction: "check the local actor boundaries, public-safety claims, and trust-bootstrap language",
      suggestedCommands: [
        "test -r mimetic/coverage-map.md && sed -n '1,80p' mimetic/coverage-map.md",
        "test -r docs/architecture/local-codex-tui-actor.md && sed -n '1,80p' docs/architecture/local-codex-tui-actor.md"
      ]
    },
    {
      id: "observer-evidence",
      label: "Observer/evidence",
      instruction: "inspect whether run evidence and Observer expectations are easy to verify",
      suggestedCommands: [
        "test -r mimetic/coverage-matrix.md && sed -n '1,80p' mimetic/coverage-matrix.md",
        "test -r mimetic/scenarios/onboarding-regression.yaml && sed -n '1,120p' mimetic/scenarios/onboarding-regression.yaml"
      ]
    },
    {
      id: "verification-release",
      label: "verification/release",
      instruction: "inspect the verification and release-gate promises exposed to local dogfood actors",
      suggestedCommands: [
        "test -r package.json && node -e \"const p=require('./package.json'); console.log(p.scripts.check); console.log(p.scripts['public-surface:scan']);\"",
        "test -r mimetic/README.md && sed -n '1,80p' mimetic/README.md"
      ]
    }
  ] satisfies [LocalCodexExecFocus, LocalCodexExecFocus, LocalCodexExecFocus, LocalCodexExecFocus];

  return focuses[index % focuses.length] ?? focuses[0];
}

function aggregateActorStatus(statuses: LocalActorTerminalStatus[]): LocalActorTerminalStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("timed_out")) return "timed_out";
  if (statuses.includes("blocked")) return "blocked";
  return statuses.length > 0 && statuses.every((status) => status === "passed") ? "passed" : "failed";
}

function summarizeExecFanout(statuses: LocalActorTerminalStatus[]): string {
  if (statuses.length === 1) {
    return statuses[0] === "passed" ? "actor process exited successfully" : `actor lane ${statuses[0]}`;
  }

  const counts = statuses.reduce<Record<LocalActorTerminalStatus, number>>(
    (current, status) => ({ ...current, [status]: current[status] + 1 }),
    { passed: 0, failed: 0, blocked: 0, timed_out: 0 }
  );
  const summary = (Object.keys(counts) as LocalActorTerminalStatus[])
    .filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${status}`)
    .join(", ");

  return statuses.every((status) => status === "passed")
    ? `all ${statuses.length} Codex exec lanes passed`
    : `${statuses.length} Codex exec lanes completed with ${summary}`;
}

function buildLocalCodexExecPrompt(selection: {
  persona: RunBundle["persona"];
  resolvedPersona: ResolvedPersona;
  scenario: RunBundle["scenario"];
}, lane?: {
  focus: LocalCodexExecFocus;
  index: number;
  total: number;
}): string {
  const suggestedCommands: [string, string] = lane?.focus.suggestedCommands ?? [
    "test -r mimetic/config.ts && wc -l mimetic/config.ts",
    "test -r mimetic/README.md && sed -n '1,40p' mimetic/README.md"
  ];

  return [
    "You are a Mimetic local Codex exec dogfood actor running noninteractively.",
    personaPromptLine(selection),
    `Scenario: ${selection.scenario.title}.`,
    ...(lane ? [`Fanout lane ${lane.index}/${lane.total}. Focus: ${lane.focus.instruction}.`] : []),
    "Run at most two read-only local inspection commands.",
    `Suggested commands: \`${suggestedCommands[0]}\` and \`${suggestedCommands[1]}\`.`,
    "Do not edit files, do not run network commands, do not commit, do not push, do not open GitHub issues, and do not print secrets.",
    "Do not inspect additional files unless one suggested command fails.",
    "Finish within three sentences with exactly one public-safe verdict line using passed, blocked, or failed."
  ].join(" ");
}

function buildLocalCodexAppServerPrompt(selection: {
  persona: RunBundle["persona"];
  resolvedPersona: ResolvedPersona;
  scenario: RunBundle["scenario"];
}, lane: {
  focus: LocalCodexExecFocus;
  index: number;
  total: number;
}): string {
  return [
    "You are a Mimetic Codex app-server dogfood actor running through the official Codex app-server protocol.",
    personaPromptLine(selection),
    `Scenario: ${selection.scenario.title}.`,
    `Fanout lane ${lane.index}/${lane.total}. Focus: ${lane.focus.instruction}.`,
    "Work read-only unless the host explicitly configured a stronger sandbox.",
    "Inspect the current repository's Mimetic setup, Observer proof contract, and public-safety posture.",
    "Use at most two lightweight local commands or file reads.",
    `Suggested commands: \`${lane.focus.suggestedCommands[0]}\` and \`${lane.focus.suggestedCommands[1]}\`.`,
    "Do not print secrets, keys, raw private transcripts, private screenshots, or private source snippets.",
    "Do not commit, push, open GitHub issues, mutate remote systems, or run provider-spend-heavy commands.",
    "End with one concise public-safe recommendation for improving Mimetic as a closed-loop user-study harness."
  ].join(" ");
}

function readCodexAppServerSandboxFromEnv(): "read-only" | "workspace-write" | "danger-full-access" {
  const value = process.env.MIMETIC_CODEX_APP_SERVER_SANDBOX;
  if (value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return "read-only";
}

function codexStateForStream(status: RunSimulationStatus): NonNullable<RunStream["codex"]>["state"] {
  if (status === "running" || status === "preparing" || status === "queued") {
    return "running";
  }
  if (status === "passed" || status === "complete") {
    return "completed";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "timed_out") {
    return "timed_out";
  }
  if (status === "blocked") {
    return "blocked";
  }
  return "watching";
}

function prefixCodexAppServerResultPaths(result: CodexAppServerRunResult, prefix: string): CodexAppServerRunResult {
  if (!prefix) {
    return result;
  }

  return {
    ...result,
    eventsPath: `${prefix}${result.eventsPath}`,
    tracePath: `${prefix}${result.tracePath}`,
    transcriptPath: `${prefix}${result.transcriptPath}`
  };
}

function parseCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaping = false;

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current !== "") {
    tokens.push(current);
  }

  return quote ? [] : tokens;
}

function shellJoin(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function limitTranscript(value: string): string {
  if (value.length <= LOCAL_ACTOR_TRANSCRIPT_MAX_CHARS) {
    return value;
  }

  return `[...sanitized transcript truncated to last ${LOCAL_ACTOR_TRANSCRIPT_MAX_CHARS} characters...]\n${value.slice(-LOCAL_ACTOR_TRANSCRIPT_MAX_CHARS)}`;
}

function tailText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(-maxChars);
}

function normalizeSimCount(value: number | undefined): number | null {
  if (value === undefined) {
    return 1;
  }

  if (!Number.isSafeInteger(value) || value < 1) {
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
    name: "run bundle shape",
    ok: isRunBundle(bundle),
    message: "run bundle must include source, persona, scenario, lifecycle, simulations, streams, events, artifacts, review, and feedback candidates"
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
  const publicSafetyFindings = await scanRunPublicSafetyArtifacts(resolved);
  checks.push({
    name: "public-safety scan",
    ok: publicSafetyFindings.length === 0,
    message: publicSafetyFindings.length === 0
      ? "run text artifacts and public-proof paths must not match known secret or browser-profile patterns"
      : `public-safety findings: ${publicSafetyFindings.slice(0, 5).join(", ")}`
  });
  const missingEvidenceArtifacts = isRunBundle(bundle)
    ? await missingLocalEvidenceArtifacts(resolved, bundle)
    : [];
  const invalidEvidenceReferences = isRunBundle(bundle)
    ? invalidRunEvidenceReferences(bundle)
    : [];
  checks.push({
    name: "local evidence artifacts exist",
    ok: missingEvidenceArtifacts.length === 0 && invalidEvidenceReferences.length === 0,
    message: missingEvidenceArtifacts.length === 0 && invalidEvidenceReferences.length === 0
      ? "referenced local screenshot/trace/log/filesystem artifacts are present"
      : invalidEvidenceReferences.length > 0
      ? `invalid evidence artifact references: ${invalidEvidenceReferences.join(", ")}`
      : `missing local evidence artifacts: ${missingEvidenceArtifacts.join(", ")}`
  });
  const codexAppServerFindings = isRunBundle(bundle)
    ? await validateCodexAppServerEvidence(resolved, bundle)
    : [];
  checks.push({
    name: "codex app-server evidence",
    ok: codexAppServerFindings.length === 0,
    message: codexAppServerFindings.length === 0
      ? "live Codex app-server streams either are absent or include valid redacted trace evidence"
      : `codex app-server findings: ${codexAppServerFindings.join(", ")}`
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

function createLocalActorRunningReviewSummary(actorLabel: string): ReviewSummary {
  return {
    schema: REVIEW_SCHEMA,
    verdict: "contract_proof_only",
    summary: `Live local ${actorLabel} actor is running. This is an in-progress Observer snapshot; final verdict will be written after sanitized actor evidence is captured.`,
    gaps: [
      "Final actor verdict and transcript artifacts are not available until the run completes.",
      "Live Observer follow depends on polling observer/observer-data.json while this run is active.",
      "No GitHub mutation, target OSS mutation, E2B substrate, or production data is used by this local actor contract."
    ]
  };
}

function createLocalActorReviewSummary(actorLabel: string, status: LocalActorTerminalStatus, reason: string): ReviewSummary {
  const verdict = status === "passed"
    ? "pass"
    : status === "timed_out"
      ? "timed_out"
      : status === "blocked"
        ? "blocked"
        : "fail";
  const isTui = actorLabel.toLowerCase().includes("tui");
  const isFanout = actorLabel.toLowerCase().includes("fanout");

  return {
    schema: REVIEW_SCHEMA,
    verdict,
    summary: `Live local ${actorLabel} actor ${status}: ${reason}. This proves the local actor lifecycle and sanitized evidence path${isFanout ? " across requested fanout lanes" : ""}, not target product behavior.`,
    gaps: [
      isTui
        ? "Only one local Codex TUI actor is supported in this slice."
        : "Codex TUI trust bootstrap, PTY rendering, and keyboard-focus proof remain separate from the noninteractive exec actor.",
      "Live follow uses polling Observer snapshots; raw interactive terminal streaming remains a follow-up hardening step.",
      "No GitHub mutation, target OSS mutation, E2B substrate, or production data was used by this local actor contract."
    ]
  };
}

async function loadDryRunSelection(
  cwd: string,
  mimeticSource: "present" | "missing"
): Promise<{
  browserJourney?: BrowserPersonaJourney;
  browserJourneyFailure?: string;
  persona: RunBundle["persona"];
  resolvedPersona: ResolvedPersona;
  scenario: RunBundle["scenario"];
  warnings: string[];
}> {
  const warnings: string[] = [];

  if (mimeticSource === "missing") {
    return {
      persona: builtinPersona,
      resolvedPersona: parseResolvedPersona({}, { id: builtinPersona.id, name: builtinPersona.name }),
      scenario: builtinScenario,
      warnings
    };
  }

  const personaPath = "mimetic/personas/synthetic-new-user.yaml";
  const scenarioPath = "mimetic/scenarios/first-run-smoke.yaml";
  const personaText = await readTextIfExists(path.join(cwd, personaPath));
  const scenarioText = await readTextIfExists(path.join(cwd, scenarioPath));
  const browserJourneySelection = await loadBrowserPersonaJourneySelection(cwd);

  if (personaText === null) {
    warnings.push(`${personaPath} was not found; using built-in persona defaults.`);
  }

  if (scenarioText === null) {
    warnings.push(`${scenarioPath} was not found; using built-in scenario defaults.`);
  }

  let resolvedPersona: ResolvedPersona;
  if (personaText === null) {
    resolvedPersona = parseResolvedPersona({}, { id: builtinPersona.id, name: builtinPersona.name });
  } else {
    const parsedPersona = parsePersonaYaml(personaText);
    if (parsedPersona.failed) {
      warnings.push(`${personaPath} could not be parsed as YAML; using built-in persona trait defaults.`);
    }
    resolvedPersona = parseResolvedPersona(parsedPersona.value, {
      id: "synthetic-new-user",
      name: "Synthetic New User"
    });
  }

  return {
    ...(browserJourneySelection.journey ? { browserJourney: browserJourneySelection.journey } : {}),
    ...(browserJourneySelection.failure ? { browserJourneyFailure: browserJourneySelection.failure } : {}),
    persona: personaText === null
      ? builtinPersona
      : {
          id: readYamlScalar(personaText, "id") ?? "synthetic-new-user",
          name: readYamlScalar(personaText, "name") ?? "Synthetic New User",
          source: personaPath,
          sourceDigest: digestText(personaText)
        },
    resolvedPersona,
    scenario: scenarioText === null
      ? builtinScenario
      : {
          id: readYamlScalar(scenarioText, "id") ?? "first-run-smoke",
          title: readYamlScalar(scenarioText, "title") ?? "First-run smoke",
          goal: readYamlScalar(scenarioText, "goal") ?? "Run a public-safe first-run smoke scenario.",
          source: scenarioPath,
          sourceDigest: digestText(scenarioText)
        },
    warnings: [...warnings, ...browserJourneySelection.warnings]
  };
}

async function loadBrowserPersonaJourneySelection(cwd: string): Promise<{
  failure?: string;
  journey?: BrowserPersonaJourney;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const scenarioDir = path.join(cwd, "mimetic", "scenarios");
  const names = await readdir(scenarioDir).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [] as string[];
    }
    throw error;
  });
  const files = names
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort((left, right) => {
      if (left === "first-run-smoke.yaml") return -1;
      if (right === "first-run-smoke.yaml") return 1;
      return left.localeCompare(right);
    });

  for (const name of files) {
    const relativePath = path.join("mimetic", "scenarios", name);
    const absolutePath = path.join(cwd, relativePath);
    const text = await readTextIfExists(absolutePath);
    if (text === null) {
      continue;
    }
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (error) {
      return {
        failure: `${relativePath} could not be parsed as YAML; browser persona journey failed closed.`,
        warnings
      };
    }

    const parsed = parseBrowserPersonaJourneyFromScenario({
      raw,
      relativePath,
      sourceDigest: digestText(text)
    });
    if (parsed.failure) {
      return {
        failure: parsed.failure,
        warnings
      };
    }
    if (parsed.journey) {
      return {
        journey: parsed.journey,
        warnings
      };
    }
  }

  return { warnings };
}

function parseBrowserPersonaJourneyFromScenario(args: {
  raw: unknown;
  relativePath: string;
  sourceDigest: string;
}): { failure?: string; journey?: BrowserPersonaJourney } {
  if (!isRecord(args.raw)) {
    return {};
  }
  const scenarioId = publicSafeToken(stringValue(args.raw.id), path.basename(args.relativePath, path.extname(args.relativePath)));
  const scenarioTitle = stringValue(args.raw.title) ?? scenarioId;
  const goal = stringValue(args.raw.goal) ?? "Drive a public-safe browser persona through the local app.";
  const browser = isRecord(args.raw.browser) ? args.raw.browser : undefined;
  const declaredBrowser = args.raw.mode === "browser" || browser !== undefined || hasInlineBrowserSteps(args.raw.steps);
  if (!declaredBrowser) {
    return {};
  }

  let startPath = "/";
  let rawSteps: unknown[] = [];
  if (browser !== undefined) {
    const parsedStartPath = stringValue(browser.startPath) ?? stringValue(browser.start_path);
    if (parsedStartPath !== undefined) {
      startPath = parsedStartPath;
    }
    if (Array.isArray(browser.steps)) {
      rawSteps = browser.steps;
    } else if ("steps" in browser) {
      return { failure: `${args.relativePath} browser.steps must be a non-empty array.` };
    }
  }
  if (rawSteps.length === 0 && Array.isArray(args.raw.steps)) {
    rawSteps = args.raw.steps;
  }

  const steps: BrowserPersonaStepManifest[] = [];
  for (const [index, rawStep] of rawSteps.entries()) {
    const parsed = parseBrowserPersonaStep(rawStep, index);
    if (parsed.failure) {
      return { failure: `${args.relativePath}: ${parsed.failure}` };
    }
    if (parsed.step) {
      steps.push(parsed.step);
    }
  }

  if (browser !== undefined && steps.length === 0) {
    return { failure: `${args.relativePath} declared browser steps, but no executable steps were found.` };
  }
  if (steps.length === 0) {
    return {};
  }

  return {
    journey: {
      goal,
      scenarioId,
      scenarioTitle,
      source: args.relativePath,
      sourceDigest: args.sourceDigest,
      startPath,
      steps
    }
  };
}

function parseBrowserPersonaStep(rawStep: unknown, index: number): { failure?: string; step?: BrowserPersonaStepManifest } {
  if (!isRecord(rawStep)) {
    return { failure: `browser step ${index + 1} must be an object.` };
  }
  const inlineBrowser = isRecord(rawStep.browser) ? rawStep.browser : undefined;
  const source = inlineBrowser ?? rawStep;
  const hasExecutableFields = inlineBrowser !== undefined || "action" in rawStep || "selector" in rawStep || "path" in rawStep || "expect" in rawStep;
  if (!hasExecutableFields) {
    return {};
  }

  const action = browserPersonaActionValue(source.action);
  if (!action) {
    return { failure: `browser step ${index + 1} has unsupported or missing action.` };
  }

  const label = stringValue(rawStep.name)
    ?? stringValue(rawStep.label)
    ?? stringValue(source.label)
    ?? `Step ${index + 1}`;
  const id = publicSafeToken(stringValue(rawStep.id) ?? stringValue(source.id), `step-${String(index + 1).padStart(2, "0")}-${label}`);
  const selector = stringValue(source.selector);
  const pathValue = stringValue(source.path);
  const value = stringValue(source.value);
  const expectation = browserStepExpectationValue(source.expect ?? source.expectation);

  if (action === "fill" && !selector) {
    return { failure: `${id} fill action requires selector.` };
  }
  if (action === "waitForSelector" && !selector) {
    return { failure: `${id} waitForSelector action requires selector.` };
  }
  if ((action === "assertText" || action === "waitForText") && !expectation?.text && !value) {
    return { failure: `${id} ${action} action requires expect.text or value.` };
  }

  return {
    step: {
      action,
      ...(expectation ? { expectation } : {}),
      id,
      label,
      ...(pathValue === undefined ? {} : { path: pathValue }),
      ...(selector === undefined ? {} : { selector }),
      ...(value === undefined ? {} : { value })
    }
  };
}

function hasInlineBrowserSteps(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => isRecord(entry) && isRecord(entry.browser));
}

function browserPersonaActionValue(value: unknown): BrowserPersonaAction | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/[-_\s]+/g, "");
  if (normalized === "goto" || normalized === "open" || normalized === "navigate") return "goto";
  if (normalized === "click" || normalized === "press") return "click";
  if (normalized === "fill" || normalized === "type") return "fill";
  if (normalized === "asserttext" || normalized === "expecttext") return "assertText";
  if (normalized === "waitfortext") return "waitForText";
  if (normalized === "waitforselector") return "waitForSelector";
  return null;
}

function browserStepExpectationValue(value: unknown): BrowserPersonaStepExpectation | undefined {
  if (typeof value === "string" && value.trim()) {
    return { text: value.trim() };
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const text = stringValue(value.text);
  const selectorVisible = stringValue(value.selectorVisible) ?? stringValue(value.selector_visible);
  const urlIncludes = stringValue(value.urlIncludes) ?? stringValue(value.url_includes);
  const stateChanged = booleanValue(value.stateChanged) ?? booleanValue(value.state_changed);
  const expectation: BrowserPersonaStepExpectation = {
    ...(selectorVisible === undefined ? {} : { selectorVisible }),
    ...(stateChanged === undefined ? {} : { stateChanged }),
    ...(text === undefined ? {} : { text }),
    ...(urlIncludes === undefined ? {} : { urlIncludes })
  };
  return Object.keys(expectation).length === 0 ? undefined : expectation;
}

function builtinBrowserPersonaJourney(): BrowserPersonaJourney {
  return {
    goal: "Drive a synthetic persona through a two-step browser journey against a running local app URL.",
    scenarioId: "browser-persona-two-step",
    scenarioTitle: "Browser Persona Two-Step Journey",
    source: "builtin:browser-persona-two-step",
    sourceDigest: digestText("browser-persona-two-step"),
    startPath: "",
    steps: [
      {
        action: "goto",
        id: "step-01-load",
        label: "Load app"
      },
      {
        action: "click",
        expectation: {
          stateChanged: true
        },
        id: "step-02-interact",
        label: "Complete primary action",
        value: "synthetic.user@example.test"
      }
    ]
  };
}

function renderReviewMarkdown(bundle: RunBundle): string {
  return `# Mimetic Run Review

Run: ${bundle.runId}

Mode: ${bundle.mode}

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

function parsePersonaYaml(text: string): { value: unknown; failed: boolean } {
  try {
    return { value: parseYaml(text), failed: false };
  } catch {
    return { value: {}, failed: true };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function publicSafeToken(value: string | undefined, fallback: string): string {
  const candidate = (value ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return candidate || fallback;
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

async function writeRunBundleArtifacts(absoluteArtifactRoot: string, bundle: RunBundle): Promise<void> {
  const publicBundle: RunBundle = {
    ...bundle,
    cwd: PUBLIC_TARGET_CWD
  };
  await writeJson(path.join(absoluteArtifactRoot, "run.json"), publicBundle);
  await writeJson(path.join(absoluteArtifactRoot, "review.json"), publicBundle.review);
  await writeFile(path.join(absoluteArtifactRoot, "review.md"), renderReviewMarkdown(publicBundle), "utf8");
  await writeFile(path.join(absoluteArtifactRoot, "events.ndjson"), `${publicBundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await mkdir(path.join(absoluteArtifactRoot, "observer"), { recursive: true });
  await writeJson(path.join(absoluteArtifactRoot, "observer", "observer-data.json"), buildObserverData(publicBundle));
}

async function missingLocalEvidenceArtifacts(runRoot: string, bundle: RunBundle): Promise<string[]> {
  const requiredPaths = new Set<string>();
  for (const stream of bundle.streams) {
    for (const artifact of stream.artifacts) {
      if (isLocalEvidenceArtifactPath(artifact.path)) {
        requiredPaths.add(artifact.path);
      }
    }

    const embedPath = normalizeLocalEvidenceReference(stream.embed?.kind === "screenshot" ? stream.embed.url : undefined);
    if (embedPath) {
      requiredPaths.add(embedPath);
    }

    const uiScreenshotPath = normalizeLocalEvidenceReference(stream.ui?.screenshotUrl);
    if (uiScreenshotPath) {
      requiredPaths.add(uiScreenshotPath);
    }

    if (stream.ui?.nestedObserverPath && isLocalEvidenceArtifactPath(stream.ui.nestedObserverPath)) {
      requiredPaths.add(stream.ui.nestedObserverPath);
    }
  }

  const missing: string[] = [];
  for (const artifactPath of requiredPaths) {
    const absolutePath = path.join(runRoot, artifactPath);
    const stats = await stat(absolutePath).catch(() => null);
    if (!stats?.isFile() || stats.size <= 0) {
      missing.push(artifactPath);
    }
  }

  return missing;
}

function invalidRunEvidenceReferences(bundle: RunBundle): string[] {
  const findings: string[] = [];
  if (path.isAbsolute(bundle.cwd)) {
    findings.push(`run bundle persists absolute cwd ${bundle.cwd}`);
  }
  for (const stream of bundle.streams) {
    const seen = new Set<string>();
    for (const artifact of stream.artifacts) {
      const key = `${artifact.kind}:${artifact.path}`;
      if (seen.has(key)) {
        findings.push(`${stream.id} duplicate artifact ${artifact.kind}:${artifact.path}`);
      }
      seen.add(key);
      if (!isLocalEvidenceArtifactPath(artifact.path)) {
        findings.push(`${stream.id} nonlocal artifact ${artifact.kind}:${artifact.path}`);
      }
    }

    if (stream.ui?.nestedObserverPath && !isLocalEvidenceArtifactPath(stream.ui.nestedObserverPath)) {
      findings.push(`${stream.id} nonlocal nested observer reference ${stream.ui.nestedObserverPath}`);
    }
    if (stream.embed?.kind === "screenshot" && stream.embed.url && !normalizeLocalEvidenceReference(stream.embed.url)) {
      findings.push(`${stream.id} nonlocal screenshot embed ${stream.embed.url}`);
    }
    if (stream.ui?.screenshotUrl && !normalizeLocalEvidenceReference(stream.ui.screenshotUrl)) {
      findings.push(`${stream.id} nonlocal screenshot reference ${stream.ui.screenshotUrl}`);
    }
  }
  return findings.slice(0, 50);
}

async function validateCodexAppServerEvidence(runRoot: string, bundle: RunBundle): Promise<string[]> {
  if (bundle.mode !== "live") {
    return [];
  }

  const findings: string[] = [];
  const appServerStreams = bundle.streams.filter((stream) =>
    stream.status !== "contract_proof_only"
    && (
      stream.codex?.provider === "codex-app-server"
      || stream.artifacts.some((artifact) => artifact.path.includes("codex-app-server"))
    )
  );

  for (const stream of appServerStreams) {
    if (stream.codex?.provider !== "codex-app-server") {
      findings.push(`${stream.id} missing first-class codex app-server metadata`);
    }
    if (stream.status === "running" || stream.codex?.state === "connecting" || stream.codex?.state === "running") {
      continue;
    }
    const traceArtifact = stream.artifacts.find((artifact) =>
      artifact.kind === "trace"
      && artifact.path.includes("codex-app-server")
    );
    const eventsArtifact = stream.artifacts.find((artifact) =>
      artifact.kind === "events"
      && artifact.path.includes("codex-app-server")
    );
    const logArtifact = stream.artifacts.find((artifact) =>
      artifact.kind === "log"
      && artifact.path.includes("codex-app-server")
    );

    if (!traceArtifact) {
      findings.push(`${stream.id} missing codex app-server trace artifact`);
      continue;
    }

    const trace = await readJsonIfExists(path.join(runRoot, traceArtifact.path));
    if (!isRecord(trace) || ![CODEX_APP_SERVER_TRACE_SCHEMA, CODEX_APP_SERVER_PROJECTED_TRACE_SCHEMA].includes(String(trace.schema))) {
      findings.push(`${stream.id} trace artifact must use ${CODEX_APP_SERVER_TRACE_SCHEMA} or ${CODEX_APP_SERVER_PROJECTED_TRACE_SCHEMA}`);
    }
    if (!isRecord(trace) || !isRecord(trace.redaction) || trace.redaction.status !== "passed") {
      findings.push(`${stream.id} trace redaction status must be passed`);
    }
    if (!eventsArtifact) {
      findings.push(`${stream.id} missing codex app-server event envelope log`);
    }
    if (!logArtifact) {
      findings.push(`${stream.id} missing codex app-server transcript summary log`);
    }
  }

  return findings;
}

const riskyPublicArtifactPathSegments = new Set([
  ".git",
  "Cookies",
  "Login Data",
  "Local Storage",
  "Preferences",
  "Secure Preferences",
  "profiles"
]);

async function scanRunPublicSafetyArtifacts(runRoot: string): Promise<string[]> {
  const findings: string[] = [];
  await scanRunPublicSafetyDirectory(runRoot, runRoot, findings);
  return findings;
}

async function scanRunPublicSafetyDirectory(root: string, current: string, findings: string[]): Promise<void> {
  if (findings.length >= 50) {
    return;
  }

  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
    if (isRiskyPublicArtifactPath(relativePath) || containsSensitivePattern(relativePath)) {
      findings.push(`risky artifact path ${relativePath}`);
      if (findings.length >= 50) return;
    }

    if (entry.isDirectory()) {
      await scanRunPublicSafetyDirectory(root, absolutePath, findings);
      if (findings.length >= 50) return;
      continue;
    }

    if (!entry.isFile() || !shouldScanTextArtifact(relativePath)) {
      continue;
    }

    const text = await readFile(absolutePath, "utf8").catch(() => null);
    if (text !== null && containsSensitivePattern(text)) {
      findings.push(`sensitive text ${relativePath}`);
      if (findings.length >= 50) return;
    }
  }
}

function isRiskyPublicArtifactPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => riskyPublicArtifactPathSegments.has(segment));
}

function shouldScanTextArtifact(relativePath: string): boolean {
  const extension = path.extname(relativePath).toLowerCase();
  return ![".png", ".jpg", ".jpeg", ".webp", ".gif", ".tgz", ".gz", ".zip"].includes(extension);
}

function isLocalEvidenceArtifactPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return value.length > 0
    && !/^\[[a-z0-9._-]+\]$/i.test(normalized)
    && !path.isAbsolute(normalized)
    && !normalized.includes("://")
    && !normalized.startsWith("..")
    && !normalized.split("/").includes("..")
    && !isRiskyPublicArtifactPath(normalized);
}

function normalizeLocalEvidenceReference(value: string | undefined): string | null {
  if (!value || value.includes("://") || path.isAbsolute(value)) {
    return null;
  }

  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("../")) {
    return isLocalEvidenceArtifactPath(normalized.slice(3)) ? normalized.slice(3) : null;
  }

  return isLocalEvidenceArtifactPath(normalized) ? normalized : null;
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
  return containsSensitive(text);
}

function redactSensitiveText(text: string): string {
  return redactToSecretLabel(text);
}

function isRunBundle(value: unknown): value is RunBundle {
  return isRecord(value)
    && value.schema === RUN_BUNDLE_SCHEMA
    && typeof value.runId === "string"
    && (value.mode === "dry-run" || value.mode === "live")
    && isPositiveSafeInteger(value.simCount)
    && typeof value.createdAt === "string"
    && value.cwd === PUBLIC_TARGET_CWD
    && typeof value.artifactRoot === "string"
    && isRunSource(value.source)
    && isPersonaSummary(value.persona)
    && isScenarioSummary(value.scenario)
    && Array.isArray(value.lifecycle)
    && value.lifecycle.every(isLifecycleEvent)
    && Array.isArray(value.simulations)
    && value.simulations.length === value.simCount
    && value.simulations.every(isRunSimulation)
    && Array.isArray(value.streams)
    && value.streams.every(isRunStream)
    && hasConsistentSimulationStreams(value.simulations, value.streams)
    && Array.isArray(value.events)
    && value.events.every(isRunEvent)
    && isRunArtifactIndex(value.artifacts)
    && isRecord(value.review)
    && isReviewSummary(value.review)
    && isRecord(value.redaction)
    && value.redaction.status === "passed"
    && Array.isArray(value.feedbackCandidates)
    && value.feedbackCandidates.every(isRunFeedbackCandidate);
}

function isRunSource(value: unknown): value is RunBundle["source"] {
  return isRecord(value)
    && (typeof value.packageName === "string" || value.packageName === null)
    && (value.mimeticSource === "present" || value.mimeticSource === "missing")
    && isCapturedGitState(value.git);
}

function isCapturedGitState(value: unknown): value is CapturedGitState {
  return isRecord(value)
    && value.schema === GIT_STATE_SCHEMA
    && (value.status === "clean" || value.status === "dirty" || value.status === "missing" || value.status === "unavailable")
    && typeof value.capturedAt === "string"
    && isRecord(value.head)
    && (isSafeGitShortSha(value.head.shortSha) || value.head.shortSha === null)
    && (value.head.refState === "attached" || value.head.refState === "detached" || value.head.refState === "unborn" || value.head.refState === "unknown")
    && isRecord(value.changes)
    && isNonNegativeSafeInteger(value.changes.staged)
    && isNonNegativeSafeInteger(value.changes.unstaged)
    && isNonNegativeSafeInteger(value.changes.untracked)
    && isNonNegativeSafeInteger(value.changes.total)
    && typeof value.note === "string"
    && SAFE_GIT_NOTES.has(value.note);
}

function isPersonaSummary(value: unknown): value is RunBundle["persona"] {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.source === "string"
    && typeof value.sourceDigest === "string";
}

function isScenarioSummary(value: unknown): value is RunBundle["scenario"] {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.title === "string"
    && typeof value.goal === "string"
    && typeof value.source === "string"
    && typeof value.sourceDigest === "string";
}

function isLifecycleEvent(value: unknown): value is RunBundle["lifecycle"][number] {
  return isRecord(value)
    && typeof value.at === "string"
    && typeof value.event === "string"
    && typeof value.message === "string";
}

function isRunSimulation(value: unknown): value is RunSimulation {
  return isRecord(value)
    && typeof value.id === "string"
    && isPositiveSafeInteger(value.index)
    && typeof value.personaId === "string"
    && typeof value.scenarioId === "string"
    && isRunSimulationStatus(value.status)
    && isRunStreamKind(value.streamKind)
    && (value.mode === "browser-sim" || value.mode === "cli-sim" || value.mode === "tui-sim" || value.mode === "codex-app-sim")
    && typeof value.progress === "number"
    && typeof value.currentStep === "string"
    && typeof value.summary === "string"
    && Array.isArray(value.streamIds)
    && value.streamIds.every((streamId) => typeof streamId === "string")
    && typeof value.startedAt === "string"
    && typeof value.updatedAt === "string";
}

function isRunStream(value: unknown): value is RunStream {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.simId === "string"
    && isRunStreamKind(value.kind)
    && typeof value.label === "string"
    && isRunSimulationStatus(value.status)
    && (value.transport === "snapshot" || value.transport === "polling" || value.transport === "sse" || value.transport === "pty" || value.transport === "app-server")
    && typeof value.updatedAt === "string"
    && Array.isArray(value.artifacts)
    && value.artifacts.every(isRunStreamArtifact);
}

function isRunStreamArtifact(value: unknown): value is RunStream["artifacts"][number] {
  return isRecord(value)
    && typeof value.label === "string"
    && typeof value.path === "string"
    && (
      value.kind === "bundle"
      || value.kind === "review"
      || value.kind === "observer"
      || value.kind === "events"
      || value.kind === "screenshot"
      || value.kind === "trace"
      || value.kind === "log"
      || value.kind === "filesystem"
    );
}

function isRunEvent(value: unknown): value is RunEvent {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.at === "string"
    && (value.level === "info" || value.level === "warn" || value.level === "error")
    && typeof value.type === "string"
    && typeof value.message === "string";
}

function isRunArtifactIndex(value: unknown): value is RunBundle["artifacts"] {
  return isRecord(value)
    && typeof value.run === "string"
    && typeof value.reviewJson === "string"
    && typeof value.reviewMarkdown === "string"
    && typeof value.observerData === "string"
    && typeof value.events === "string";
}

function isRunFeedbackCandidate(value: unknown): value is RunFeedbackCandidate {
  return isRecord(value)
    && value.schema === "mimetic.feedback-candidate.v1"
    && typeof value.id === "string"
    && typeof value.run_id === "string"
    && (typeof value.stream_id === "string" || value.stream_id === undefined)
    && typeof value.adapter_id === "string"
    && typeof value.scenario_id === "string"
    && typeof value.persona_id === "string"
    && isFeedbackActor(value.actor)
    && isFeedbackSubstrate(value.substrate)
    && isFeedbackFailureOwner(value.failure_owner)
    && typeof value.summary === "string"
    && typeof value.expected === "string"
    && typeof value.actual === "string"
    && Array.isArray(value.evidence)
    && value.evidence.every(isRunFeedbackEvidence)
    && isRecord(value.redaction)
    && value.redaction.status === "passed"
    && typeof value.redaction.notes === "string"
    && typeof value.idempotency_key === "string"
    && isFeedbackNextState(value.proposed_next_state)
    && Array.isArray(value.acceptance_proof)
    && value.acceptance_proof.every((item) => typeof item === "string");
}

function isRunFeedbackEvidence(value: unknown): value is RunFeedbackCandidate["evidence"][number] {
  return isRecord(value)
    && typeof value.path === "string"
    && value.path.length > 0
    && !path.isAbsolute(value.path)
    && !value.path.includes("://")
    && !value.path.includes("..")
    && (
      value.kind === "review"
      || value.kind === "state"
      || value.kind === "log"
      || value.kind === "trace"
      || value.kind === "screenshot"
      || value.kind === "filesystem"
    )
    && typeof value.note === "string";
}

function hasConsistentSimulationStreams(
  simulations: unknown[],
  streams: unknown[]
): boolean {
  const simIds = new Set<string>();
  const expectedStreamSimIds = new Map<string, string>();
  const streamById = new Map<string, RunStream>();

  for (const simulation of simulations) {
    if (!isRunSimulation(simulation)) {
      return false;
    }

    simIds.add(simulation.id);
    for (const streamId of simulation.streamIds) {
      if (expectedStreamSimIds.has(streamId)) {
        return false;
      }

      expectedStreamSimIds.set(streamId, simulation.id);
    }
  }

  for (const stream of streams) {
    if (!isRunStream(stream) || !simIds.has(stream.simId) || streamById.has(stream.id)) {
      return false;
    }

    const expectedSimId = expectedStreamSimIds.get(stream.id);
    if (expectedSimId === undefined || stream.simId !== expectedSimId) {
      return false;
    }

    streamById.set(stream.id, stream);
  }

  return streamById.size === expectedStreamSimIds.size;
}

function isRunSimulationStatus(value: unknown): value is RunSimulationStatus {
  return value === "queued"
    || value === "preparing"
    || value === "running"
    || value === "passed"
    || value === "complete"
    || value === "blocked"
    || value === "timed_out"
    || value === "failed"
    || value === "contract_proof_only";
}

function isRunStreamKind(value: unknown): value is RunStreamKind {
  return value === "ui"
    || value === "browser"
    || value === "terminal"
    || value === "tui"
    || value === "codex-ui"
    || value === "artifact"
    || value === "summary";
}

function isSafeGitShortSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{7,12}$/.test(value);
}

function isFeedbackActor(value: unknown): value is RunFeedbackCandidate["actor"] {
  return value === "codex-tui"
    || value === "codex-exec"
    || value === "codex-app-server"
    || value === "synthetic-dry-run"
    || value === "unknown";
}

function isFeedbackSubstrate(value: unknown): value is RunFeedbackCandidate["substrate"] {
  return value === "e2b-desktop"
    || value === "local-filesystem"
    || value === "codex-app-server"
    || value === "unknown";
}

function isFeedbackFailureOwner(value: unknown): value is RunFeedbackCandidate["failure_owner"] {
  return value === "harness"
    || value === "target-app"
    || value === "actor"
    || value === "environment"
    || value === "unknown";
}

function isFeedbackNextState(value: unknown): value is RunFeedbackCandidate["proposed_next_state"] {
  return value === "watch"
    || value === "adapter-hardening"
    || value === "target-app-setup"
    || value === "actor-auth"
    || value === "setup-quality-review"
    || value === "study-quality-review";
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isReviewSummary(value: unknown): value is ReviewSummary {
  return isRecord(value)
    && value.schema === REVIEW_SCHEMA
    && (
      value.verdict === "contract_proof_only"
      || value.verdict === "pass"
      || value.verdict === "fail"
      || value.verdict === "blocked"
      || value.verdict === "timed_out"
    )
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
