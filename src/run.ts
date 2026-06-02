import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildObserverData } from "./observer-data.js";

export const RUN_BUNDLE_SCHEMA = "mimetic.run-bundle.v1";
export const REVIEW_SCHEMA = "mimetic.review.v1";
export const VERIFY_SCHEMA = "mimetic.verify-result.v1";
export const RUNS_SCHEMA = "mimetic.runs-result.v1";
export const DOCTOR_SCHEMA = "mimetic.doctor-result.v1";

export interface RunOptions {
  cwd: string;
  actor?: string;
  actorCommand?: string[];
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
  checkedAt: string;
  exitCode?: number;
  logTail?: string;
  nestedObserverPresent?: boolean;
  nestedVerifyPassed?: boolean;
  reason: string;
  status: "running" | "passed" | "failed" | "blocked" | "timed_out";
}

export interface RunSimulation {
  id: string;
  index: number;
  personaId: string;
  scenarioId: string;
  status: RunSimulationStatus;
  streamKind: RunStreamKind;
  mode: "ui-sim" | "cli-sim" | "tui-sim" | "codex-ui-sim";
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
    route?: string;
    intent?: string;
    screenshotUrl?: string;
    state?: string;
  };
  codex?: {
    provider: "codex-app-server";
    sessionId?: string;
    state: "not_connected" | "connecting" | "watching";
    contract: string;
  };
  completion?: RunStreamCompletion;
  artifacts: Array<{
    label: string;
    path: string;
    kind: "bundle" | "review" | "observer" | "events" | "screenshot" | "trace" | "log";
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
  feedbackCandidates: Array<unknown>;
}

export interface ReviewSummary {
  schema: typeof REVIEW_SCHEMA;
  verdict: "contract_proof_only" | "pass" | "fail" | "blocked" | "timed_out";
  summary: string;
  gaps: string[];
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
      | "MIMETIC_LIVE_RUN_UNIMPLEMENTED"
      | "MIMETIC_LOCAL_CODEX_EXEC_FAILED"
      | "MIMETIC_LOCAL_CODEX_TUI_FAILED"
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

const sensitivePatterns = [
  /sk-[a-z0-9_-]{12,}/i,
  /gho_[a-z0-9_]{12,}/i,
  /BEGIN (RSA|OPENSSH|PRIVATE) KEY/i
];

const LOCAL_CODEX_TUI_DEFAULT_TIMEOUT_MS = 240_000;
const LOCAL_CODEX_TUI_MAX_TIMEOUT_MS = 600_000;
const LOCAL_ACTOR_TRANSCRIPT_MAX_CHARS = 80_000;

type LocalCodexActor = "codex-tui" | "codex-exec";

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

  if (!options.dryRun) {
    const actor = resolveRequestedLocalCodexActor(options.actor);
    if (actor === "codex-tui") {
      return runLocalCodexTui({ ...options, actor, cwd, simCount });
    }
    if (actor === "codex-exec") {
      return runLocalCodexExec({ ...options, actor, cwd, simCount });
    }

    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd,
      warnings,
      error: {
        code: "MIMETIC_LIVE_RUN_UNIMPLEMENTED",
        message: "Only run --dry-run is implemented unless --actor codex-tui, --actor codex-exec, or the matching MIMETIC_ENABLE_LOCAL_CODEX_* env var is set."
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
  await writeJson(path.join(absoluteArtifactRoot, "run.json"), bundle);
  await writeJson(path.join(absoluteArtifactRoot, "review.json"), bundle.review);
  await writeFile(path.join(absoluteArtifactRoot, "review.md"), renderReviewMarkdown(bundle), "utf8");
  await writeFile(path.join(absoluteArtifactRoot, "events.ndjson"), `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
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

function isLocalCodexActor(value: string): value is LocalCodexActor {
  return value === "codex-tui" || value === "codex-exec";
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
        message: "Local Codex TUI actor support is intentionally limited to --sims 1 in this slice. Split 4x fanout after the 1x lifecycle is deterministic."
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
    await appendEvent("actor.preflight.blocked", trustPreflight.message, "warn");
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
  const verdictReason = actor.reason;

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
}): RunBundle {
  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: "live",
    simCount: args.simCount,
    createdAt: args.createdAt,
    cwd: args.cwd,
    artifactRoot: args.artifactRoot,
    source: {
      packageName: args.packageName,
      mimeticSource: args.mimeticSource,
      git: {
        status: "not_captured",
        note: "Source git state capture is planned for the core primitives slice."
      }
    },
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

  if (options.simCount > 4) {
    return {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "MIMETIC_ACTOR_FANOUT_UNIMPLEMENTED",
        message: "Local Codex exec actor fanout is intentionally limited to --sims 4 in this slice."
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
  const runId = options.runId ?? `codex-exec-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const artifactRoot = path.join(".mimetic", "runs", runId);
  const absoluteArtifactRoot = path.join(options.cwd, artifactRoot);
  const eventsPath = path.join(absoluteArtifactRoot, "events.ndjson");
  const packageName = await readPackageName(options.cwd);
  const mimeticSource = await directoryExists(path.join(options.cwd, "mimetic")) ? "present" : "missing";
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
      message: `Live local Codex exec run created with ${options.simCount} explicit opt-in actor${options.simCount === 1 ? "" : "s"}.`
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
    persona: selection.persona,
    scenario: selection.scenario,
    lifecycle: [
      ...baseLifecycle,
      {
        at: runningAt,
        event: "actor.running",
        message: "Local Codex exec actor lanes are running; Observer data will refresh as sanitized evidence arrives."
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

  const laneResults = await Promise.all(lanes.map(async (lane): Promise<ExecLaneResult> => {
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
  }));

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
      mode: "ui-sim" as const,
      label: "UI journey",
      currentStep: "Route and viewport contract captured",
      summary: "UI sim lane reserved for browser/VNC playback, screenshots, route state, and interaction trace.",
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
      mode: "codex-ui-sim" as const,
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
  if (!Number.isInteger(value) || value === undefined || value < 1 || value > LOCAL_CODEX_TUI_MAX_TIMEOUT_MS) {
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

function buildLocalCodexTuiPrompt(selection: {
  persona: RunBundle["persona"];
  scenario: RunBundle["scenario"];
}, verdictNonce: string): string {
  return [
    "You are a Mimetic local Codex TUI dogfood actor.",
    `Persona: ${selection.persona.name}.`,
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
    `Persona: ${selection.persona.name}.`,
    `Scenario: ${selection.scenario.title}.`,
    ...(lane ? [`Fanout lane ${lane.index}/${lane.total}. Focus: ${lane.focus.instruction}.`] : []),
    "Run at most two read-only local inspection commands.",
    `Suggested commands: \`${suggestedCommands[0]}\` and \`${suggestedCommands[1]}\`.`,
    "Do not edit files, do not run network commands, do not commit, do not push, do not open GitHub issues, and do not print secrets.",
    "Do not inspect additional files unless one suggested command fails.",
    "Finish within three sentences with exactly one public-safe verdict line using passed, blocked, or failed."
  ].join(" ");
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

async function writeRunBundleArtifacts(absoluteArtifactRoot: string, bundle: RunBundle): Promise<void> {
  await writeJson(path.join(absoluteArtifactRoot, "run.json"), bundle);
  await writeJson(path.join(absoluteArtifactRoot, "review.json"), bundle.review);
  await writeFile(path.join(absoluteArtifactRoot, "review.md"), renderReviewMarkdown(bundle), "utf8");
  await mkdir(path.join(absoluteArtifactRoot, "observer"), { recursive: true });
  await writeJson(path.join(absoluteArtifactRoot, "observer", "observer-data.json"), buildObserverData(bundle));
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

function redactSensitiveText(text: string): string {
  return sensitivePatterns.reduce((current, pattern) => {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    return current.replace(new RegExp(pattern.source, flags), "[REDACTED_SECRET]");
  }, text);
}

function isRunBundle(value: unknown): value is RunBundle {
  return isRecord(value)
    && value.schema === RUN_BUNDLE_SCHEMA
    && typeof value.runId === "string"
    && (value.mode === "dry-run" || value.mode === "live")
    && typeof value.createdAt === "string"
    && isRecord(value.review)
    && isReviewSummary(value.review)
    && isRecord(value.redaction)
    && value.redaction.status === "passed";
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
