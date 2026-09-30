import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  browserSurfaces,
  builtinBrowserPersonaJourney,
  captureBrowserSurface,
  normalizeLocalAppUrl,
  resolveBrowserCommand,
  type BrowserPersonaJourney,
  type BrowserSurfaceCapture,
} from "../actors/scripted-browser.js";
import {
  artifactReferenceIfWritten,
  hasWrittenScreenshot,
} from "../evidence/artifact-reference.js";
import { prepareRunArtifactPaths, validatePreparedRunArtifactPaths } from "./paths.js";
import { beginRunStatus, type RunStatusHandle } from "./status.js";
import {
  assertPreparedSelectedOutputDirectory,
  prepareContainedOutputDirectory,
  type PreparedSelectedOutputDirectory,
  writePreparedRunLatestPointer,
} from "./selected-output-paths.js";
import {
  buildRunSource,
  REVIEW_SCHEMA,
  type ReviewSummary,
  RUN_BUNDLE_SCHEMA,
  type RunBundle,
  type RunEvent,
  type RunOptions,
  type RunPointer,
  type RunResult,
  type RunStream,
} from "./bundle.js";
import { implicitProjectDirectoryExists, readPackageName } from "./locate.js";
import { loadDryRunSelection } from "./selection.js";
import { writeRunBundleArtifacts } from "./write-bundle.js";

const BROWSER_APP_DEFAULT_TIMEOUT_MS = 300_000;

export async function runBrowserAppProof(
  options: RunOptions & {
    appUrl: string;
    cwd: string;
    projectRoot: PreparedSelectedOutputDirectory;
    simCount: number;
  },
): Promise<RunResult> {
  const warnings: string[] = [];
  const appUrl = normalizeLocalAppUrl(options.appUrl);
  if (!appUrl) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "HUMANISH_INVALID_APP_URL",
        message: "--app-url must be an http(s) loopback URL such as http://127.0.0.1:5173.",
      },
    };
  }

  const browserCommand = await resolveBrowserCommand();
  if (!browserCommand) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "HUMANISH_BROWSER_APP_CAPTURE_FAILED",
        message:
          "No Chrome/Chromium browser command was found. Set HUMANISH_BROWSER_COMMAND to a browser binary that supports --headless and --screenshot.",
      },
    };
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const runId =
    options.runId ?? `browser-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const packageName = await readPackageName(options.projectRoot);
  const humanishSource = (await implicitProjectDirectoryExists(options.projectRoot, "humanish"))
    ? "present"
    : "missing";
  const source = await buildRunSource({
    cwd: options.cwd,
    capturedAt: createdAt,
    humanishSource,
    packageName,
  });
  const selection = await loadDryRunSelection(options.projectRoot, humanishSource);
  await assertPreparedSelectedOutputDirectory(options.projectRoot);
  const runPaths = await prepareRunArtifactPaths(options.cwd, runId);
  // Identity + liveness on disk (#455): uniform across every route, so a reader classifies any
  // run from one small file instead of parsing bundles.
  const runStatus: RunStatusHandle = beginRunStatus(runPaths, {
    runId,
    mode: options.dryRun ? "dry-run" : "live",
    ...(options.lab === undefined ? {} : { lab: options.lab }),
  });
  const artifactRoot = runPaths.relativeRunRoot;
  if (selection.browserJourneyFailure) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings: [...warnings, ...selection.warnings],
      error: {
        code: "HUMANISH_BROWSER_APP_CAPTURE_FAILED",
        message: selection.browserJourneyFailure,
      },
    };
  }

  const browserJourney = selection.browserJourney ?? builtinBrowserPersonaJourney();
  if (humanishSource === "missing") {
    warnings.push(
      "Committed humanish/ source was not found; using built-in synthetic browser-app defaults.",
    );
  }
  if (!selection.browserJourney) {
    warnings.push(
      "No executable browser scenario manifest was found; using built-in browser persona two-step journey.",
    );
  }
  warnings.push(...selection.warnings);

  await prepareContainedOutputDirectory(runPaths, "screenshots");
  await prepareContainedOutputDirectory(runPaths, "traces");

  const surfaces = browserSurfaces.slice(0, options.simCount);
  const captures = await Promise.all(
    surfaces.map((surface) =>
      captureBrowserSurface({
        absoluteArtifactRoot: runPaths,
        appUrl,
        browserCommand,
        browserJourney,
        surface,
        timeoutMs: options.timeoutMs ?? BROWSER_APP_DEFAULT_TIMEOUT_MS,
      }),
    ),
  );
  await validatePreparedRunArtifactPaths(runPaths);
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
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    source,
    persona: {
      id: selection.persona.id,
      name: selection.persona.name,
      source: selection.persona.source,
      sourceDigest: selection.persona.sourceDigest,
    },
    scenario: {
      id: browserJourney.scenarioId,
      title: browserJourney.scenarioTitle,
      goal: browserJourney.goal,
      source: browserJourney.source,
      sourceDigest: browserJourney.sourceDigest,
    },
    lifecycle: [
      {
        at: createdAt,
        event: "run.created",
        message: `Live browser persona proof created for ${appUrl}.`,
      },
      {
        at: createdAt,
        event: "app.url.accepted",
        message: "Accepted public-safe loopback app URL for browser persona journey.",
      },
      {
        at: completedAt,
        event: "review.created",
        message: allPassed
          ? "Created review from desktop/mobile browser persona step evidence."
          : "Created review with missing or blocked browser persona step evidence.",
      },
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
        updatedAt: capture.capturedAt,
      };
    }),
    streams: captures.map((capture) => {
      const simId = `browser-${capture.surface.id}`;
      const streamId = `${simId}-stream`;
      // Never reference a screenshot the producer did not write (artifact-reference.ts).
      // A blocked capture whose evidence IS the failure carries no surface screenshot, so
      // we omit the embed URL + ui.screenshotUrl and keep the stream present with its
      // blocked status — instead of claiming an artifact that verify would fail closed on.
      // A capture that claims success but is missing its screenshot still keeps the
      // reference so missingLocalEvidenceArtifacts can catch the broken producer.
      const surfaceScreenshot = hasWrittenScreenshot(capture) ? capture.screenshotPath : undefined;
      const screenshotUrl = surfaceScreenshot ? `../${surfaceScreenshot}` : undefined;
      return {
        id: streamId,
        simId,
        kind: "browser",
        label: capture.surface.label,
        status: capture.ok ? "passed" : "blocked",
        transport: "snapshot",
        updatedAt: capture.capturedAt,
        embed: screenshotUrl
          ? { kind: "screenshot", url: screenshotUrl, title: capture.surface.label }
          : {
              kind: "placeholder",
              title: `${capture.surface.label} (blocked — no screenshot captured)`,
            },
        viewport: capture.surface.viewport,
        ui: {
          appStatus: capture.ok ? "running" : "blocked",
          appUrl,
          route: appUrl,
          intent: browserJourney.goal,
          ...(screenshotUrl ? { screenshotUrl } : {}),
          state: capture.reason,
          visualStatus: capture.ok ? "visible" : "blocked",
        },
        completion: {
          checkedAt: capture.capturedAt,
          exitCode: capture.ok ? 0 : 1,
          reason: capture.reason,
          status: capture.ok ? "passed" : "blocked",
        },
        artifacts: [
          { label: "run bundle", path: "run.json", kind: "bundle" },
          { label: "review", path: "review.md", kind: "review" },
          { label: "event log", path: "events.ndjson", kind: "events" },
          { label: `${capture.surface.id} browser trace`, path: capture.tracePath, kind: "trace" },
          // Per-step screenshot artifacts only for steps whose screenshot was actually
          // written; blocked-not-executed steps recorded no path and claim nothing.
          ...capture.steps.flatMap((step) => {
            const stepScreenshot = artifactReferenceIfWritten(
              step.screenshotPath,
              hasWrittenScreenshot(step),
            );
            return stepScreenshot
              ? [
                  {
                    label: `${capture.surface.id} ${step.id} screenshot`,
                    path: stepScreenshot,
                    kind: "screenshot" as const,
                  },
                ]
              : [];
          }),
        ],
      } satisfies RunStream;
    }),
    events,
    redaction: {
      status: "passed",
      notes:
        "Browser persona proof stores loopback app URLs, screenshots, and generated traces only; secret-like text is rejected by verify.",
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson",
    },
    review,
    feedbackCandidates: [],
  };

  await writeRunBundleArtifacts(runPaths, bundle, runStatus);
  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify(
      {
        schema: "humanish.latest-run.v1",
        runId,
        path: artifactRoot,
        updatedAt: completedAt,
      } satisfies RunPointer,
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    schema: "humanish.run-result.v1",
    ok: allPassed,
    runId,
    mode: "live",
    simCount: captures.length,
    cwd: options.cwd,
    artifactRoot,
    bundlePath: path.join(artifactRoot, "run.json"),
    reviewPath: path.join(artifactRoot, "review.md"),
    latestPath: runPaths.relativeLatestPointer,
    warnings,
    ...(allPassed
      ? {}
      : {
          error: {
            code: "HUMANISH_BROWSER_APP_CAPTURE_FAILED" as const,
            message: review.summary,
          },
        }),
  };
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
      message: "Created live browser persona proof run against a loopback URL.",
    },
  ];

  args.captures.forEach((capture) => {
    events.push({
      id: `event-${String(events.length + 1).padStart(3, "0")}`,
      at: capture.capturedAt,
      level: capture.ok ? "info" : "warn",
      type: capture.ok ? "browser-persona.journey.passed" : "browser-persona.journey.blocked",
      message: `${capture.surface.id}: ${capture.reason}`,
      simId: `browser-${capture.surface.id}`,
      streamId: `browser-${capture.surface.id}-stream`,
    });
    for (const step of capture.steps) {
      events.push({
        id: `event-${String(events.length + 1).padStart(3, "0")}`,
        at: step.completedAt,
        level: step.status === "passed" ? "info" : "warn",
        type:
          step.status === "passed" ? "browser-persona.step.passed" : "browser-persona.step.blocked",
        message: `${capture.surface.id} ${step.id}: ${step.reason}`,
        simId: `browser-${capture.surface.id}`,
        streamId: `browser-${capture.surface.id}-stream`,
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
        .map((capture) => `${capture.surface.id}: ${capture.reason}`),
    ],
  };
}
