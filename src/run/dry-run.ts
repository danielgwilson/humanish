import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ObserverResult } from "../observer/render.js";
import { runScope, type FinishedRun, type RunScope } from "./run.js";
import {
  assertPreparedSelectedOutputDirectory,
  prepareSelectedOutputDirectory,
} from "./contained-output.js";
import {
  REVIEW_SCHEMA,
  RUN_BUNDLE_FILE,
  buildRunSource,
  type ReviewSummary,
  type RunBundle,
  type RunEvent,
  type RunSimulation,
  bundleArtifacts,
  bundleHead,
} from "./bundle.js";
import { type RunOptions, type RunResult } from "./results.js";
import { type RunSimulationStatus, type RunStream, type RunStreamKind } from "./streams.js";
import {
  participantEvent,
  participantIdsOf,
  participantRecord,
  participantStream,
} from "./participant-records.js";
import { implicitProjectDirectoryExists, readPackageName, validateCwd } from "./project.js";
import { loadDryRunInputs } from "./dry-run-inputs.js";
import {
  judgeExecution,
  judgePreview,
  OUTCOME_POLICIES,
  resultOk,
  type Verdict,
  verdictText,
} from "./judge.js";

/**
 * The preview route's run. The run scope closes the run it started on every exit, including
 * the fail-closed ones. It renders an Observer only when `options.observer` asks for one.
 */
export async function runDryRun(options: RunOptions): Promise<RunResult> {
  const { result } = await runScope((scope) => runDryRunInScope(options, scope));
  return result;
}

function refused(
  cwd: string,
  warnings: string[],
  error: NonNullable<RunResult["error"]>,
): RunResult {
  return {
    schema: "humanish.run-result.v1",
    ok: false,
    cwd,
    warnings,
    error: { code: error.code, message: error.message },
  };
}

async function runDryRunInScope(options: RunOptions, scope: RunScope): Promise<RunResult> {
  const requestedCwd = path.resolve(options.cwd);
  const cwdError = await validateCwd(requestedCwd);
  const warnings: string[] = [];

  if (cwdError) return refused(requestedCwd, warnings, cwdError);

  const participants = normalizeParticipantCount(options.participantCount);
  if (participants === null) {
    return refused(requestedCwd, warnings, {
      code: "HUMANISH_INVALID_PARTICIPANT_COUNT",
      message: "--count must be a positive integer.",
    });
  }

  // Bind the physical project, as the routes do: a symlinked cwd retargeted mid-run cannot
  // redirect source reads or run storage into another project.
  const physicalCwd = await realpath(requestedCwd);
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const cwd = projectRoot.physicalPath;

  if (!options.dryRun) {
    return refused(requestedCwd, warnings, {
      code: "HUMANISH_LIVE_RUN_UNIMPLEMENTED",
      message:
        "humanish run needs a study. List studies with humanish study list, or run humanish run --dry-run for a sample bundle.",
    });
  }

  const createdAt = new Date().toISOString();
  const packageName = await readPackageName(projectRoot);
  const humanishSource = (await implicitProjectDirectoryExists(projectRoot, "humanish"))
    ? "present"
    : "missing";
  const source = await buildRunSource({ cwd, capturedAt: createdAt, humanishSource, packageName });
  const inputs = await loadDryRunInputs(projectRoot, humanishSource);
  await assertPreparedSelectedOutputDirectory(projectRoot);
  const started = await scope.startRun({
    cwd,
    runId: options.runId,
    mintRunId: () => `dryrun-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    mode: options.dryRun ? "dry-run" : "live",
    study: options.study,
    renderReview: renderReviewMarkdown,
    // The run starts at the time its id and source were stamped with.
    now: () => Date.parse(createdAt),
    ...(options.observer === undefined ? {} : { observer: { open: options.observer.open } }),
  });
  if (!started.ok) return refused(cwd, warnings, started);
  const { run } = started;
  const { runId, paths: runPaths } = run;
  const artifactRoot = runPaths.relativeRunRoot;

  if (humanishSource === "missing") {
    warnings.push(
      "Committed humanish/ source was not found; using built-in synthetic dry-run defaults.",
    );
  }
  warnings.push(...inputs.warnings);

  const observerFixtures = buildSyntheticObserverFixtures({
    createdAt,
    personaId: inputs.persona.id,
    scenarioId: inputs.scenario.id,
    count: participants,
  });

  const judgment = judgePreview();
  const bundle: RunBundle = {
    ...bundleHead(run, { participants, cwd, artifactRoot, source }),
    persona: inputs.persona,
    scenario: inputs.scenario,
    lifecycle: [
      {
        at: createdAt,
        event: "run.created",
        message: `Synthetic dry-run bundle created with ${participants} simulated participant${participants === 1 ? "" : "s"}.`,
      },
      {
        at: createdAt,
        event: "persona.selected",
        message: "Selected public-safe synthetic persona.",
      },
      {
        at: createdAt,
        event: "scenario.selected",
        message: "Selected public-safe first-run scenario.",
      },
      {
        at: createdAt,
        event: "review.skeleton.created",
        message: "Created review skeleton without claiming product proof.",
      },
    ],
    simulations: observerFixtures.simulations,
    streams: observerFixtures.streams,
    events: observerFixtures.events,
    redaction: {
      status: "passed",
      notes: "Dry-run bundle: synthetic data only, nothing from a product.",
    },
    artifacts: bundleArtifacts(),
    review: createReviewSummary(judgment.verdict),
    feedbackCandidates: [],
  };

  const finished = await run.finish(bundle);
  const observer =
    options.observer === undefined ? undefined : await renderPreviewObserver(finished, warnings);
  // The preview's policy keeps an Observer that did not render a warning: the bundle is still
  // evidence, and `export` can render it later.
  const policy = OUTCOME_POLICIES.preview;
  const execution = judgeExecution(
    observer === undefined || observer.ok
      ? []
      : [{ kind: "evidence", message: observer.error?.message ?? "render failed" }],
    policy,
  );
  const ok = resultOk({ judgment, execution, scorerFailures: [], policy });
  await finished.recordOutcome({ ok, execution });

  return {
    schema: "humanish.run-result.v1",
    ok,
    runId,
    mode: "dry-run",
    // The run result's public field for how many participants the run had.
    simCount: participants,
    cwd,
    artifactRoot,
    bundlePath: path.join(artifactRoot, RUN_BUNDLE_FILE),
    reviewPath: path.join(artifactRoot, "review.md"),
    latestPath: runPaths.relativeLatestPointer,
    ...(observer === undefined ? {} : { observer }),
    warnings,
  };
}

/**
 * The preview's review, with the verdict judgePreview gave it. It claims only that the run's
 * files were written, never product behavior.
 */
function createReviewSummary(verdict: Verdict): ReviewSummary {
  return {
    schema: REVIEW_SCHEMA,
    verdict,
    summary: "Dry run: humanish wrote a synthetic run bundle. No product behavior was tested.",
    gaps: [
      "No browser was launched.",
      "No product state was verified.",
      "No model, provider, or E2B substrate was used.",
    ],
  };
}

/** The preview's review.md. */
function renderReviewMarkdown(bundle: RunBundle): string {
  return `# humanish Run Review

Run: ${bundle.runId}

Mode: ${bundle.mode}

Verdict: ${verdictText(bundle.review.verdict, bundle.mode)}

${bundle.review.summary}

## Public-Safety

- Redaction: ${bundle.redaction.status}
- Notes: ${bundle.redaction.notes}

## Gaps

${bundle.review.gaps.map((gap) => `- ${gap}`).join("\n")}
`;
}

/**
 * Render through the finished run, so a directory swapped in under the same id is never rendered.
 * A failure is a warning: the bundle is still evidence, and `export` can render its Observer later.
 */
async function renderPreviewObserver(
  finished: FinishedRun,
  warnings: string[],
): Promise<ObserverResult | undefined> {
  try {
    const rendered = await finished.renderObserver();
    if (!rendered.ok) {
      warnings.push(
        `observer/index.html was not written: ${rendered.error?.message ?? "render failed"}`,
      );
    }
    return rendered;
  } catch (error) {
    warnings.push(
      `observer/index.html was not written: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** One synthetic stream per stream kind (UI, terminal and the rest); the preview cycles through them. */
const SYNTHETIC_STREAM_TEMPLATES = [
  {
    kind: "ui" as const,
    mode: "browser-sim" as const,
    label: "UI journey",
    currentStep: "Route and viewport recorded",
    summary:
      "Simulated browser participant reserved for VNC playback, screenshots, route state, and interaction trace.",
    tail: "open target app\nresolve first-run route\ncapture viewport state\nrecord interaction trace",
    viewport: { width: 1440, height: 960, deviceScaleFactor: 1 },
  },
  {
    kind: "terminal" as const,
    mode: "cli-sim" as const,
    label: "CLI actor",
    currentStep: "Command transcript recorded",
    summary:
      "Simulated CLI participant reserved for command-by-command persona runs with stdout/stderr and artifact links.",
    // Every command in a shipped sample tail must be one the CLI actually accepts: participants
    // read and run them. tests/surface/shipped-command-strings.test.ts checks this against the
    // command table.
    tail: "$ humanish doctor\nok target cwd\nok humanish source\n$ humanish run first-run\nhumanish run dry-run",
    viewport: undefined,
  },
  {
    kind: "tui" as const,
    mode: "tui-sim" as const,
    label: "TUI actor",
    currentStep: "Terminal UI frame recorded",
    summary:
      "Simulated TUI participant reserved for PTY bytes, ANSI rendering, focus replay, and optional assisted attach.",
    tail: "\u001b[2mhumanish TUI frame\u001b[0m\n> persona: skeptical-power-user\n> scenario: onboarding-regression\nstatus: awaiting live PTY transport",
    viewport: undefined,
  },
  {
    kind: "codex-ui" as const,
    mode: "codex-app-sim" as const,
    label: "Codex UI",
    currentStep: "App-server embed recorded",
    summary:
      "Simulated Codex UI participant reserved for app-server sessions that can be watched beside terminal evidence.",
    tail: "codex-app-server session (dry run)\nstate: not_connected\nembed: pending provider URL\nreceipts: planned",
    viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
  },
] as const;

function buildSyntheticObserverFixtures(args: {
  createdAt: string;
  personaId: string;
  scenarioId: string;
  count: number;
}): {
  events: RunEvent[];
  simulations: RunSimulation[];
  streams: RunStream[];
} {
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events: RunEvent[] = [
    {
      id: "event-000",
      at: args.createdAt,
      level: "info",
      type: "observer.contract.created",
      message: "Created the public-safe Observer streams.",
    },
  ];

  for (let index = 0; index < args.count; index += 1) {
    const template = SYNTHETIC_STREAM_TEMPLATES[index % SYNTHETIC_STREAM_TEMPLATES.length];
    if (!template) {
      throw new Error("Synthetic observer template missing.");
    }
    const recordId = `sim-${String(index + 1).padStart(2, "0")}`;
    const ids = participantIdsOf(recordId, `${recordId}-${template.kind}`);
    const status: RunSimulationStatus = "contract_proof_only";

    simulations.push(
      participantRecord(ids, index + 1, {
        personaId: args.personaId,
        scenarioId: args.scenarioId,
        status,
        streamKind: template.kind,
        mode: template.mode,
        progress: 100,
        currentStep: template.currentStep,
        summary: template.summary,
        startedAt: args.createdAt,
        updatedAt: args.createdAt,
      }),
    );

    streams.push(
      participantStream(ids, {
        kind: template.kind,
        label: template.label,
        status,
        transport: streamTransport(template.kind),
        updatedAt: args.createdAt,
        embed: {
          kind:
            template.kind === "terminal" || template.kind === "tui" ? "terminal" : "placeholder",
          title: template.label,
        },
        ...(template.viewport ? { viewport: { ...template.viewport } } : {}),
        terminal: {
          title: template.label,
          format: template.kind === "tui" ? "ansi" : "plain",
          stdin: "disabled",
          tail: template.tail,
        },
        ...(template.kind === "ui" || template.kind === "codex-ui"
          ? {
              ui: {
                route: template.kind === "ui" ? "/first-run" : "/codex/session",
                intent: template.summary,
                state: "contract-only",
              },
            }
          : {}),
        ...(template.kind === "codex-ui"
          ? {
              codex: {
                provider: "codex-app-server" as const,
                state: "not_connected" as const,
                contract:
                  "Observer accepts an app-server embed URL, session id, status feed, terminal receipt feed, and artifact links.",
              },
            }
          : {}),
        artifacts: [
          { label: "run bundle", path: RUN_BUNDLE_FILE, kind: "bundle" },
          { label: "review", path: "review.md", kind: "review" },
          { label: "event log", path: "events.ndjson", kind: "events" },
        ],
      }),
    );

    events.push(
      participantEvent(ids, {
        id: `event-${String(index + 1).padStart(3, "0")}-a`,
        at: args.createdAt,
        level: "info",
        type: "sim.contract.ready",
        message: `${template.label} stream ready.`,
      }),
      participantEvent(ids, {
        id: `event-${String(index + 1).padStart(3, "0")}-b`,
        at: args.createdAt,
        level: "warn",
        type: "sim.live-substrate.missing",
        message:
          "No live actor launched in dry-run mode; the observer stream is ready for real substrate evidence.",
      }),
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

function normalizeParticipantCount(value: number | undefined): number | null {
  if (value === undefined) {
    return 1;
  }

  if (!Number.isSafeInteger(value) || value < 1) {
    return null;
  }

  return value;
}
