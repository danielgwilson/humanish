// The registry-facing session of the deterministic scripted browser ("browser-persona"). It runs
// the step executor, expectation evaluator, blocked-step builder and native trace writer against an
// injected or playwright-launched browser, and projects the result into humanish.actor-trace.v1.
// The parts live beside it: types.ts (seams and journey types), journey.ts (the scenario parser),
// steps.ts (the step executor) and browser-command.ts (finding Chromium). actors/registry.ts (the
// "scripted-browser" actor) depends on this module, and the registry is const-initialized, so no
// module in this folder may import the registry.
//
// The step executor's `page` is typed as the narrow structural ScriptedPageLike instead of
// playwright's Page (browserPersonaPageState already took { evaluate, url }; E2BDesktopLike is
// the same seam pattern). playwright's real Page satisfies it; tests inject fakes and run
// the real step executor at $0 with zero browser dependence. playwright-core stays the lazy
// production default behind launchPlaywrightChromium.
//
// Spend posture: nothing in this module can spend provider money — no provider client is
// importable from this code path. tokenUsage on every projected trace records zeros as an
// affirmative $0 declaration that is true by mechanism.

import { stat } from "node:fs/promises";
import path from "node:path";
import { CHROMIUM_EVIDENCE_HYGIENE_FLAGS } from "../../evidence/browser-hygiene.js";
import { redactText } from "../../evidence/redaction.js";
import {
  assertPreparedSelectedOutputDirectory,
  assertSafeOutputPathSegment,
  prepareContainedOutputDirectory,
  prepareContainedOutputFile,
  prepareSelectedOutputDirectory,
  writeContainedOutputFile,
  type PreparedOutputRoot,
} from "../../run/contained-output.js";
import {
  ACTOR_TRACE_SCHEMA,
  SCRIPTED_BROWSER_CAPABILITIES,
  type ActorCompletionReason,
  type ActorPersonaRef,
  type ActorSessionResult,
  type ActorStatus,
  type ActorTrace,
  type ActorTraceItem,
} from "../contract.js";
import {
  buildBlockedBrowserPersonaSteps,
  buildBrowserTrace,
  captureBlockedStepScreenshot,
  compactBrowserError,
  executeBrowserPersonaStep,
  probeAppUrl,
  sanitizeBrowserEvidenceUrl,
  screenshotPathForBrowserStep,
  surfaceScreenshotPath,
  tracePathForBrowserSurface,
} from "./steps.js";
import {
  LOOPBACK_EVIDENCE_URL_POLICY,
  type BrowserPersonaJourney,
  type BrowserPersonaStepCapture,
  type BrowserSurface,
  type BrowserSurfaceCapture,
  type ScriptedBrowserEvidenceUrlPolicy,
  type ScriptedBrowserLaunchArgs,
  type ScriptedBrowserLike,
  type ScriptedPageLike,
} from "./types.js";
import type { Browser } from "playwright-core";

/** Production default: lazy playwright-core import + chromium.launch, exactly as the driver
 *  always did. Kept in one place so the optional peer is touched by exactly one code path. */
async function launchPlaywrightChromium(
  args: ScriptedBrowserLaunchArgs,
): Promise<ScriptedBrowserLike> {
  const { chromium } = await import("playwright-core");
  const browser: Browser = await chromium.launch({
    executablePath: args.browserCommand,
    headless: true,
    args: [...CHROMIUM_EVIDENCE_HYGIENE_FLAGS, "--disable-gpu", "--disable-dev-shm-usage"],
    timeout: args.timeoutMs,
  });
  return browser as unknown as ScriptedBrowserLike;
}

function assertScriptedSessionPathIds(options: ScriptedBrowserSessionOptions): void {
  assertSafeOutputPathSegment(options.surface.id, "Browser surface id");
  for (const step of options.journey.steps) {
    assertSafeOutputPathSegment(step.id, "Browser journey step id");
  }
}

const SCRIPTED_BROWSER_PROVIDER = "browser-persona";

export interface ScriptedBrowserSessionOptions {
  /** Pre-normalized loopback URL, or a harness-minted provisioned subject URL. */
  appUrl: string;
  /** Stable redacted URL label persisted in public-safe evidence when appUrl is private. */
  evidenceAppUrl?: string;
  /** Defaults to loopback. Provisioned subjects drive a private URL but persist redacted labels. */
  urlPolicy?: ScriptedBrowserEvidenceUrlPolicy;
  /** Parsed + validated by the backend (scenario.ref is consumed there, fail-closed). */
  journey: BrowserPersonaJourney;
  /** One session per surface. */
  surface: BrowserSurface;
  /** id = actors[0].persona ?? "scripted-journey"; promptDigest = journey.sourceDigest prefix
   *  (the step manifest is the "prompt"; no model prompt exists on this route). */
  persona: ActorPersonaRef;
  /** Journey wall-clock budget in ms; the lab route passes execution.timeoutMs or 300_000. */
  timeoutMs: number;
  /** Absolute; the session writes screenshots/ and traces/<surface>.json beneath it. */
  artifactRoot: string;
  /** Default resolveBrowserCommand(); recorded as "injected-browser" when launchBrowser is injected. */
  browserCommand?: string;
  /** DI seam; production default is launchPlaywrightChromium. */
  launchBrowser?: (args: ScriptedBrowserLaunchArgs) => Promise<ScriptedBrowserLike>;
  now?: () => number;
}

export interface ScriptedBrowserSessionResult extends ActorSessionResult {
  /** Native evidence incl. tracePath (humanish.browser-persona-trace.v1, written to disk). */
  capture: BrowserSurfaceCapture;
}

/** Thrown between/around steps when the journey exceeds its wall-clock budget. */
class ScriptedJourneyTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`journey exceeded its ${timeoutMs}ms wall-clock budget`);
    this.name = "ScriptedJourneyTimeoutError";
  }
}

/**
 * Run the scripted journey for one surface and return native capture + ActorTrace projection.
 *
 * Completion semantics (the contract the projection tests pin):
 * - every step executed, every assertion passed, HTTP probe ok -> passed / goal_satisfied
 *   (the scenario's expect blocks are the success predicate; a pass claims "the app still
 *   affords this exact journey", nothing about user behavior);
 * - a step's expectation evaluated false, a step target missing/unactionable, or an
 *   unreachable subject -> failed / step_failed (the harness executed faithfully; the subject
 *   did not satisfy the script — distinct from actor_error/harness_error);
 * - journey exceeded timeoutMs -> timed_out / timed_out;
 * - browser launch/import crash -> failed / harness_error;
 * - gave_up / blocked_approval are unreachable from this actor (no persona patience, no
 *   approvals exist on a deterministic replay) — asserted in tests.
 */
export async function runScriptedBrowserSession(
  options: ScriptedBrowserSessionOptions,
): Promise<ScriptedBrowserSessionResult> {
  assertScriptedSessionPathIds(options);
  const preparedArtifactRoot = await prepareSelectedOutputDirectory(
    process.cwd(),
    options.artifactRoot,
  );
  return runScriptedBrowserSessionInPreparedRoot(options, preparedArtifactRoot);
}

/** Internal lab seam: the run root is already prepared and must stay bound to that identity. */
export async function runScriptedBrowserSessionInPreparedRoot(
  options: ScriptedBrowserSessionOptions,
  preparedArtifactRoot: PreparedOutputRoot,
): Promise<ScriptedBrowserSessionResult> {
  assertScriptedSessionPathIds(options);
  await prepareContainedOutputDirectory(preparedArtifactRoot, "screenshots");
  await prepareContainedOutputDirectory(preparedArtifactRoot, "traces");
  await prepareContainedOutputFile(
    preparedArtifactRoot,
    tracePathForBrowserSurface(options.surface),
  );
  await Promise.all(
    options.journey.steps.map((step) =>
      prepareContainedOutputFile(
        preparedArtifactRoot,
        screenshotPathForBrowserStep(options.surface, step),
      ),
    ),
  );
  await assertScriptedOutputRoot(preparedArtifactRoot);
  const now = options.now ?? (() => Date.now());
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const launch = options.launchBrowser ?? launchPlaywrightChromium;
  const browserCommand =
    options.browserCommand ?? (options.launchBrowser ? "injected-browser" : "");
  const evidenceAppUrl = options.evidenceAppUrl ?? options.appUrl;
  const urlPolicy = options.urlPolicy ?? LOOPBACK_EVIDENCE_URL_POLICY;

  const finish = async (args: {
    capture: BrowserSurfaceCapture;
    executedSteps: number;
    status: ActorStatus;
    completionReason: ActorCompletionReason;
    reason: string;
  }): Promise<ScriptedBrowserSessionResult> => {
    const completedAtMs = now();
    const trace = await projectScriptedActorTrace({
      artifactRoot: preparedArtifactRoot,
      capture: args.capture,
      completedAt: new Date(completedAtMs).toISOString(),
      completionReason: args.completionReason,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      executedSteps: args.executedSteps,
      journey: options.journey,
      persona: options.persona,
      reason: args.reason,
      startedAt,
      status: args.status,
    });
    return {
      status: args.status,
      completionReason: args.completionReason,
      reason: args.reason,
      capture: args.capture,
      trace,
    };
  };

  // Launch first: a browser that cannot start is a harness failure, never subject evidence.
  let browser: ScriptedBrowserLike;
  try {
    browser = await launch({ browserCommand, timeoutMs: options.timeoutMs });
  } catch (error) {
    const reason = `Scripted browser launch failed: ${compactBrowserError(error)}`;
    const capture = await persistScriptedFailureCapture({
      appUrl: options.appUrl,
      artifactRoot: preparedArtifactRoot,
      browserCommand,
      evidenceAppUrl,
      journey: options.journey,
      reason,
      surface: options.surface,
      urlPolicy,
    });
    return finish({
      capture,
      executedSteps: 0,
      status: "failed",
      completionReason: "harness_error",
      reason,
    });
  }
  try {
    await assertScriptedOutputRoot(preparedArtifactRoot);
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }

  const journeyRun = await runScriptedJourney({
    appUrl: options.appUrl,
    artifactRoot: preparedArtifactRoot,
    browser,
    browserCommand,
    evidenceAppUrl,
    journey: options.journey,
    surface: options.surface,
    timeoutMs: options.timeoutMs,
    urlPolicy,
  });

  if (journeyRun.timedOut) {
    return finish({
      capture: journeyRun.capture,
      executedSteps: journeyRun.executedSteps,
      status: "timed_out",
      completionReason: "timed_out",
      reason: `${options.surface.label} ${new ScriptedJourneyTimeoutError(options.timeoutMs).message}.`,
    });
  }

  if (journeyRun.capture.ok) {
    return finish({
      capture: journeyRun.capture,
      executedSteps: journeyRun.executedSteps,
      status: "passed",
      completionReason: "goal_satisfied",
      reason: journeyRun.capture.reason,
    });
  }

  const firstFailing = journeyRun.capture.steps.find((step) => step.status !== "passed");
  return finish({
    capture: journeyRun.capture,
    executedSteps: journeyRun.executedSteps,
    status: "failed",
    completionReason: "step_failed",
    reason: firstFailing ? `${firstFailing.id}: ${firstFailing.reason}` : journeyRun.capture.reason,
  });
}

/** Drive the journey on an already-launched browser, mirroring the driver's capture
 *  semantics (partial blocked steps on error, trace written exactly once, browser closed). */
async function runScriptedJourney(args: {
  appUrl: string;
  artifactRoot: PreparedOutputRoot;
  browser: ScriptedBrowserLike;
  browserCommand: string;
  evidenceAppUrl: string;
  journey: BrowserPersonaJourney;
  surface: BrowserSurface;
  timeoutMs: number;
  urlPolicy: ScriptedBrowserEvidenceUrlPolicy;
}): Promise<{ capture: BrowserSurfaceCapture; executedSteps: number; timedOut: boolean }> {
  const started = Date.now();
  const deadline = started + args.timeoutMs;
  const tracePath = tracePathForBrowserSurface(args.surface);
  const httpProbe = await probeAppUrl(args.appUrl, Math.min(args.timeoutMs, 15_000));
  let page: ScriptedPageLike | null = null;
  const steps: BrowserPersonaStepCapture[] = [];
  let executedSteps = 0;
  let timedOut = false;

  try {
    const context = await args.browser.newContext({
      deviceScaleFactor: args.surface.viewport.deviceScaleFactor,
      isMobile: args.surface.viewport.isMobile,
      viewport: {
        width: args.surface.viewport.width,
        height: args.surface.viewport.height,
      },
    });
    page = await context.newPage();

    for (const step of args.journey.steps) {
      await assertScriptedOutputRoot(args.artifactRoot);
      executedSteps += 1;
      steps.push(
        await withJourneyDeadline(
          executeBrowserPersonaStep({
            absoluteArtifactRoot: args.artifactRoot,
            appUrl: args.appUrl,
            browserJourney: args.journey,
            page,
            step,
            surface: args.surface,
            timeoutMs: args.timeoutMs,
            urlPolicy: args.urlPolicy,
          }),
          deadline,
          args.timeoutMs,
        ),
      );
    }
  } catch (error) {
    await assertScriptedOutputRoot(args.artifactRoot);
    timedOut = error instanceof ScriptedJourneyTimeoutError;
    const now = new Date().toISOString();
    const reason = compactBrowserError(error);
    if (steps.length === 0) {
      steps.push(
        ...buildBlockedBrowserPersonaSteps({
          browserJourney: args.journey,
          currentUrl: args.appUrl,
          reason,
          surface: args.surface,
          timestamp: now,
          urlPolicy: args.urlPolicy,
        }),
      );
    } else if (steps.length < args.journey.steps.length) {
      const nextStep = args.journey.steps[steps.length];
      if (nextStep) {
        const { screenshotPath, written: blockedShotWritten } = await captureBlockedStepScreenshot(
          page,
          args.artifactRoot,
          args.surface,
          nextStep,
        );
        steps.push({
          action: nextStep.action,
          completedAt: now,
          durationMs: Date.now() - started,
          id: nextStep.id,
          label: nextStep.label,
          reason,
          ...(blockedShotWritten ? { screenshotPath } : {}),
          status: "blocked",
          url: page ? sanitizeBrowserEvidenceUrl(page.url(), args.urlPolicy) : args.evidenceAppUrl,
        });
      }
    }
  } finally {
    await args.browser.close().catch(() => undefined);
  }

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - started;
  const ok =
    !timedOut &&
    httpProbe.ok &&
    steps.length === args.journey.steps.length &&
    steps.every((step) => step.status === "passed");
  const reason = ok
    ? `${args.surface.label} completed ${steps.length}/${steps.length} scripted browser steps from ${args.evidenceAppUrl}${httpProbe.status === undefined ? "" : ` with HTTP ${httpProbe.status}`}.`
    : `${args.surface.label} scripted browser journey blocked: ${steps.find((step) => step.status !== "passed")?.reason ?? httpProbe.reason}`;
  const scriptedScreenshotPath = surfaceScreenshotPath(steps);

  await writeContainedOutputFile(
    args.artifactRoot,
    tracePath,
    `${JSON.stringify(
      buildBrowserTrace({
        appUrl: args.evidenceAppUrl,
        browserCommand: path.basename(args.browserCommand || "injected-browser"),
        browserJourney: args.journey,
        capturedAt: completedAt,
        durationMs,
        ...(httpProbe.status === undefined ? {} : { httpStatus: httpProbe.status }),
        ok,
        reason,
        ...(scriptedScreenshotPath === undefined ? {} : { screenshotPath: scriptedScreenshotPath }),
        steps,
        surface: args.surface,
      }),
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    capture: {
      capturedAt: completedAt,
      durationMs,
      ...(httpProbe.status === undefined ? {} : { httpStatus: httpProbe.status }),
      ok,
      reason,
      ...(scriptedScreenshotPath === undefined ? {} : { screenshotPath: scriptedScreenshotPath }),
      steps,
      surface: args.surface,
      tracePath,
    },
    executedSteps,
    timedOut,
  };
}

/** Race one step against the journey's remaining wall-clock budget. A hanging step rejects
 *  with the timeout error; the journey's catch path then records honest blocked steps. */
async function withJourneyDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  timeoutMs: number,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    // Swallow the eventual settlement so an abandoned step can never surface an unhandled rejection.
    promise.catch(() => undefined);
    throw new ScriptedJourneyTimeoutError(timeoutMs);
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          promise.catch(() => undefined);
          reject(new ScriptedJourneyTimeoutError(timeoutMs));
        }, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Persist the all-steps-blocked capture + native trace for failures that happen before any
 *  journey actuation (browser launch crash). Mirrors the driver's failure shape. */
async function persistScriptedFailureCapture(args: {
  appUrl: string;
  artifactRoot: PreparedOutputRoot;
  browserCommand: string;
  evidenceAppUrl: string;
  journey: BrowserPersonaJourney;
  reason: string;
  surface: BrowserSurface;
  urlPolicy: ScriptedBrowserEvidenceUrlPolicy;
}): Promise<BrowserSurfaceCapture> {
  const capturedAt = new Date().toISOString();
  const tracePath = tracePathForBrowserSurface(args.surface);
  const blockedSteps = buildBlockedBrowserPersonaSteps({
    browserJourney: args.journey,
    currentUrl: args.appUrl,
    reason: args.reason,
    surface: args.surface,
    timestamp: capturedAt,
    urlPolicy: args.urlPolicy,
  });
  // Pre-actuation failure: no screenshots were written, so the surface omits the
  // screenshot reference and the failure itself stands as the evidence.
  const screenshotPath = surfaceScreenshotPath(blockedSteps);
  await writeContainedOutputFile(
    args.artifactRoot,
    tracePath,
    `${JSON.stringify(
      buildBrowserTrace({
        appUrl: args.evidenceAppUrl,
        browserCommand: path.basename(args.browserCommand || "injected-browser"),
        browserJourney: args.journey,
        capturedAt,
        durationMs: 0,
        ok: false,
        reason: args.reason,
        ...(screenshotPath === undefined ? {} : { screenshotPath }),
        steps: blockedSteps,
        surface: args.surface,
      }),
      null,
      2,
    )}\n`,
    "utf8",
  );
  return {
    capturedAt,
    durationMs: 0,
    ok: false,
    reason: args.reason,
    ...(screenshotPath === undefined ? {} : { screenshotPath }),
    steps: blockedSteps,
    surface: args.surface,
    tracePath,
  };
}

/** Project one surface capture into humanish.actor-trace.v1. screenshotRefs are attached only
 *  for frames that actually exist on disk (honest counts; blocked-not-executed steps name a
 *  path that was never written). */
async function projectScriptedActorTrace(args: {
  artifactRoot: PreparedOutputRoot;
  capture: BrowserSurfaceCapture;
  completedAt: string;
  completionReason: ActorCompletionReason;
  durationMs: number;
  executedSteps: number;
  journey: BrowserPersonaJourney;
  persona: ActorPersonaRef;
  reason: string;
  startedAt: string;
  status: ActorStatus;
}): Promise<ActorTrace> {
  const writtenScreenshots = new Set<string>();
  for (const step of args.capture.steps) {
    if (!step.screenshotPath) {
      continue;
    }
    const screenshotFile = await prepareContainedOutputFile(
      args.artifactRoot,
      step.screenshotPath,
    ).catch(() => null);
    const stats = screenshotFile ? await stat(screenshotFile).catch(() => null) : null;
    if (stats?.isFile() && stats.size > 0) {
      writtenScreenshots.add(step.screenshotPath);
    }
  }

  let assertionCount = 0;
  const items: ActorTraceItem[] = args.capture.steps.map((step) => {
    const assertions = step.assertions ?? [];
    assertionCount += assertions.length;
    const assertionLines = assertions.map(
      (assertion) => `${assertion.id}: ${assertion.status} — ${assertion.reason}`,
    );
    return {
      id: step.id,
      kind: "ui_action" as const,
      lifecycle: "completed" as const,
      status: step.status,
      title: redactText(`${step.action}: ${step.label}`).slice(0, 120),
      ...(step.screenshotPath && writtenScreenshots.has(step.screenshotPath)
        ? { screenshotRef: { path: step.screenshotPath, redaction: "none" as const } }
        : {}),
      text: redactText([step.reason, ...assertionLines].join("\n")),
    };
  });

  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: SCRIPTED_BROWSER_PROVIDER,
    protocol: "scripted-steps",
    lane: "scripted-browser",
    persona: args.persona,
    redaction: {
      status: "passed",
      screenshots: writtenScreenshots.size > 0 ? "raw" : "n/a",
      notes:
        "Deterministic scripted steps. Step URLs sanitized to loopback origin+path (query/hash redacted); fill values are committed-scenario constants passed through redactText; screenshots are full-fidelity raw in gitignored .humanish.",
    },
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    durationMs: args.durationMs,
    status: args.status,
    completionReason: args.completionReason,
    reason: redactText(args.reason),
    // No session/model ids exist on a deterministic replay — absence declared by omission.
    ids: {},
    counts: {
      steps: args.journey.steps.length,
      // `actions` mirrors the engagement-check contract (verifyRun counts it as engagement).
      actions: args.executedSteps,
      assertions: assertionCount,
      blocked: args.capture.steps.filter((step) => step.status !== "passed").length,
      screenshots: writtenScreenshots.size,
    },
    items,
    // Affirmative $0 declaration, true by mechanism: no provider client is importable from
    // this code path, so zeros are a recorded fact, not an estimate.
    tokenUsage: { input: 0, output: 0, total: 0, costUsd: 0 },
    capabilities: SCRIPTED_BROWSER_CAPABILITIES,
  };
}

async function assertScriptedOutputRoot(root: PreparedOutputRoot): Promise<string> {
  if ("physicalRunRoot" in root) {
    await prepareContainedOutputDirectory(root, "");
    return root.physicalRunRoot;
  }
  await assertPreparedSelectedOutputDirectory(root);
  return root.physicalPath;
}
