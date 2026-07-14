// The deterministic scripted browser driver ("browser-persona") plus its actor-registry
// session wrapper. The driver code was MOVED here from src/run.ts unchanged (the journey
// parser, the surface capture engines, and their small private helpers) because the actor
// registry can never import run.ts: run.ts imports getActor from actor-registry.js, so a
// registry entry whose runSession lived in run.ts would be a module cycle through a
// const-initialized registry. This module is a LEAF — it imports only actor-contract.js and
// redaction.js, so both run.ts (the `run --app-url` path) and actor-registry.ts (the
// "scripted-browser" actor) can depend on it.
//
// One deliberate structural change from the move (the only one): the step executor's `page`
// is typed as the narrow structural ScriptedPageLike instead of playwright's Page (precedent:
// browserPersonaPageState already took { evaluate, url }; E2BDesktopLike is the repo's
// established seam pattern). playwright's real Page satisfies it; tests inject fakes and run
// the REAL step executor at $0 with zero browser dependence. playwright-core stays the lazy
// production default behind launchPlaywrightChromium.
//
// Spend posture: nothing in this module can spend provider money — no provider client is
// importable from this code path. tokenUsage on every projected trace records zeros as an
// affirmative $0 declaration that is TRUE by mechanism.

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Browser } from "playwright-core";

import {
  ACTOR_TRACE_SCHEMA,
  SCRIPTED_BROWSER_CAPABILITIES,
  type ActorCompletionReason,
  type ActorPersonaRef,
  type ActorStatus,
  type ActorTrace,
  type ActorTraceItem
} from "./actor-contract.js";
import { CHROMIUM_EVIDENCE_HYGIENE_FLAGS } from "./browser-evidence-hygiene.js";
import { assertScreenshotEvidence } from "./image-evidence.js";
import { digestText, redactText, redactToSecretLabel } from "./redaction.js";
import {
  assertPreparedSelectedOutputDirectory,
  assertSafeOutputPathSegment,
  prepareContainedOutputDirectory,
  prepareContainedOutputFile,
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
  type PreparedOutputDirectory,
  writeContainedOutputFile
} from "./selected-output-paths.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Structural DI seams. playwright's Browser/Page satisfy these; deterministic
// tests inject fakes and still exercise the real step executor + expectations.
// ---------------------------------------------------------------------------

export interface ScriptedLocatorLike {
  first(): ScriptedLocatorLike;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
  count(): Promise<number>;
  waitFor(options?: { state?: "visible"; timeout?: number }): Promise<void>;
  isVisible(options?: { timeout?: number }): Promise<boolean>;
}

export interface ScriptedPageLike {
  goto(url: string, options?: { waitUntil?: "domcontentloaded"; timeout?: number }): Promise<unknown>;
  locator(selector: string): ScriptedLocatorLike;
  waitForTimeout(ms: number): Promise<void>;
  waitForFunction(fn: string, arg: unknown, options?: { timeout?: number }): Promise<unknown>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
  url(): string;
  evaluate<T>(pageFunction: string): Promise<T>;
}

export interface ScriptedBrowserLike {
  newContext(options: {
    deviceScaleFactor: number;
    isMobile: boolean;
    viewport: { width: number; height: number };
  }): Promise<{ newPage(): Promise<ScriptedPageLike> }>;
  close(): Promise<void>;
}

export interface ScriptedBrowserLaunchArgs {
  browserCommand: string;
  timeoutMs: number;
}

export type ScriptedBrowserEvidenceUrlPolicy =
  | { kind: "loopback" }
  | { kind: "provisioned-subject"; evidenceOrigin: string };

const LOOPBACK_EVIDENCE_URL_POLICY: ScriptedBrowserEvidenceUrlPolicy = { kind: "loopback" };

/** Production default: lazy playwright-core import + chromium.launch, exactly as the driver
 *  always did. Kept in ONE place so the optional peer is touched by exactly one code path. */
export async function launchPlaywrightChromium(args: ScriptedBrowserLaunchArgs): Promise<ScriptedBrowserLike> {
  const { chromium } = await import("playwright-core");
  const browser: Browser = await chromium.launch({
    executablePath: args.browserCommand,
    headless: true,
    args: [
      ...CHROMIUM_EVIDENCE_HYGIENE_FLAGS,
      "--disable-gpu",
      "--disable-dev-shm-usage"
    ],
    timeout: args.timeoutMs
  });
  return browser as unknown as ScriptedBrowserLike;
}

// ---------------------------------------------------------------------------
// Driver types (moved from run.ts).
// ---------------------------------------------------------------------------

export interface BrowserSurface {
  id: "desktop" | "mobile";
  label: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    isMobile: boolean;
  };
}

export interface BrowserSurfaceCapture {
  capturedAt: string;
  durationMs: number;
  httpStatus?: number;
  ok: boolean;
  reason: string;
  /**
   * Surface-level screenshot the producer wrote (the last step's screenshot).
   * Omitted for a blocked capture whose evidence is the failure itself, so the
   * stream never claims a screenshot embed/ui reference that does not exist.
   * See src/artifact-reference.ts.
   */
  screenshotPath?: string;
  steps: BrowserPersonaStepCapture[];
  surface: BrowserSurface;
  tracePath: string;
}

export type BrowserPersonaAction = "goto" | "click" | "fill" | "assertText" | "waitForText" | "waitForSelector";

export interface BrowserPersonaAssertionCapture {
  id: string;
  reason: string;
  status: "passed" | "blocked";
}

export interface BrowserPersonaStepCapture {
  action: string;
  assertions?: BrowserPersonaAssertionCapture[];
  completedAt: string;
  durationMs: number;
  id: string;
  label: string;
  reason: string;
  /**
   * Path to the step screenshot the producer actually wrote. Omitted for blocked
   * steps where the failure itself is the recorded evidence and no screenshot was
   * written — the bundle must not reference an artifact that does not exist (see
   * src/artifact-reference.ts). A step that ran and attempted a screenshot keeps
   * this even when its assertions failed, so a broken producer still fails verify.
   */
  screenshotPath?: string;
  status: "passed" | "blocked";
  url: string;
}

export interface BrowserPersonaStepExpectation {
  selectorVisible?: string;
  stateChanged?: boolean;
  text?: string;
  urlIncludes?: string;
}

export interface BrowserPersonaStepManifest {
  action: BrowserPersonaAction;
  expectation?: BrowserPersonaStepExpectation;
  id: string;
  label: string;
  path?: string;
  selector?: string;
  value?: string;
}

export interface BrowserPersonaJourney {
  goal: string;
  scenarioId: string;
  scenarioTitle: string;
  source: string;
  sourceDigest: string;
  startPath: string;
  steps: BrowserPersonaStepManifest[];
}

export const browserSurfaces: BrowserSurface[] = [
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

// ---------------------------------------------------------------------------
// Surface capture engines (moved from run.ts). The HUMANISH_BROWSER_PERSONA_DRIVER=fixture env
// switch stays a `run --app-url` affordance only; the lab route never consults it (its test
// seam is the launchBrowser DI hook — an env-switched semi-real driver inside a lab would blur
// what the evidence claims).
// ---------------------------------------------------------------------------

export async function captureBrowserSurface(args: {
  absoluteArtifactRoot: PreparedOutputDirectory;
  appUrl: string;
  browserCommand: string;
  browserJourney: BrowserPersonaJourney;
  surface: BrowserSurface;
  timeoutMs: number;
}): Promise<BrowserSurfaceCapture> {
  if (process.env.HUMANISH_BROWSER_PERSONA_DRIVER === "fixture") {
    return captureBrowserSurfaceFixture(args);
  }

  return captureBrowserSurfaceWithPlaywright(args);
}

export async function captureBrowserSurfaceFixture(args: {
  absoluteArtifactRoot: PreparedOutputDirectory;
  appUrl: string;
  browserCommand: string;
  browserJourney: BrowserPersonaJourney;
  surface: BrowserSurface;
  timeoutMs: number;
}): Promise<BrowserSurfaceCapture> {
  const started = Date.now();
  const tracePath = path.join("traces", `${args.surface.id}.json`);
  await assertScriptedOutputRoot(args.absoluteArtifactRoot);
  const httpProbe = await probeAppUrl(args.appUrl, Math.min(args.timeoutMs, 15_000));
  const capturedAt = new Date().toISOString();
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "humanish-browser-profile-"));
  const steps: BrowserPersonaStepCapture[] = [];
  let currentUrl = args.appUrl;

  try {
    for (const [index, step] of args.browserJourney.steps.entries()) {
      if (step.action === "goto") {
        currentUrl = resolveBrowserStepUrl(args.appUrl, step.path ?? args.browserJourney.startPath);
      }
      const stepStarted = Date.now();
      const screenshotPath = screenshotPathForBrowserStep(args.surface, step);
      await prepareContainedOutputFile(args.absoluteArtifactRoot, screenshotPath);
      const screenshotBytes = await captureBrowserCommandScreenshot({
        appUrl: currentUrl,
        browserCommand: args.browserCommand,
        profileDir,
        surface: args.surface,
        timeoutMs: args.timeoutMs
      });
      assertScreenshotEvidence(screenshotPath, screenshotBytes);
      await writeContainedOutputFile(args.absoluteArtifactRoot, screenshotPath, screenshotBytes);
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
    const blockedScreenshotPath = surfaceScreenshotPath(blockedSteps);
    await writeContainedOutputFile(args.absoluteArtifactRoot, tracePath, `${JSON.stringify(buildBrowserTrace({
      appUrl: args.appUrl,
      browserCommand: path.basename(args.browserCommand),
      browserJourney: args.browserJourney,
      capturedAt,
      durationMs: Date.now() - started,
      ...(httpProbe.status === undefined ? {} : { httpStatus: httpProbe.status }),
      ok: false,
      reason,
      ...(blockedScreenshotPath === undefined ? {} : { screenshotPath: blockedScreenshotPath }),
      steps: blockedSteps,
      surface: args.surface
    }), null, 2)}\n`, "utf8");
    return {
      capturedAt,
      durationMs: Date.now() - started,
      ...(httpProbe.status === undefined ? {} : { httpStatus: httpProbe.status }),
      ok: false,
      reason,
      ...(blockedScreenshotPath === undefined ? {} : { screenshotPath: blockedScreenshotPath }),
      steps: blockedSteps,
      surface: args.surface,
      tracePath
    };
  } finally {
    await rm(profileDir, { force: true, recursive: true }).catch(() => undefined);
  }

  // Every step in the success path attempts a screenshot, so each carries a
  // screenshotPath. A step claiming success whose screenshot is missing or empty
  // must still drag the capture out of `ok` — the strict verifier then catches it.
  const screenshotStats = await Promise.all(
    steps.map(async (step) => {
      if (!step.screenshotPath) return null;
      const screenshotFile = await prepareContainedOutputFile(args.absoluteArtifactRoot, step.screenshotPath);
      return stat(screenshotFile);
    }).map((result) => result.catch(() => null))
  );
  const screenshotsOk = screenshotStats.every((stats) => stats?.isFile() && stats.size > 0);
  const ok = Boolean(screenshotsOk && httpProbe.ok && steps.every((step) => step.status === "passed"));
  const reason = ok
    ? `${args.surface.label} completed ${steps.length}/${steps.length} browser persona steps from ${args.appUrl}${httpProbe.status === undefined ? "" : ` with HTTP ${httpProbe.status}`}.`
    : screenshotsOk
      ? `${args.surface.label} persona screenshots exist, but app HTTP readiness was not proven: ${httpProbe.reason}.`
      : `${args.surface.label} persona screenshot artifacts were missing or empty.`;
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - started;
  const fixtureScreenshotPath = surfaceScreenshotPath(steps);

  await writeContainedOutputFile(args.absoluteArtifactRoot, tracePath, `${JSON.stringify(buildBrowserTrace({
    appUrl: args.appUrl,
    browserCommand: path.basename(args.browserCommand),
    browserJourney: args.browserJourney,
    capturedAt: completedAt,
    durationMs,
    ...(httpProbe.status === undefined ? {} : { httpStatus: httpProbe.status }),
    ok,
    reason,
    ...(fixtureScreenshotPath === undefined ? {} : { screenshotPath: fixtureScreenshotPath }),
    steps,
    surface: args.surface
  }), null, 2)}\n`, "utf8");

  return {
    capturedAt: completedAt,
    durationMs,
    ...(httpProbe.status === undefined ? {} : { httpStatus: httpProbe.status }),
    ok,
    reason,
    ...(fixtureScreenshotPath === undefined ? {} : { screenshotPath: fixtureScreenshotPath }),
    steps,
    surface: args.surface,
    tracePath
  };
}

export async function captureBrowserSurfaceWithPlaywright(args: {
  absoluteArtifactRoot: PreparedOutputDirectory;
  appUrl: string;
  browserCommand: string;
  browserJourney: BrowserPersonaJourney;
  surface: BrowserSurface;
  timeoutMs: number;
}): Promise<BrowserSurfaceCapture> {
  const started = Date.now();
  const tracePath = path.join("traces", `${args.surface.id}.json`);
  await assertScriptedOutputRoot(args.absoluteArtifactRoot);
  const httpProbe = await probeAppUrl(args.appUrl, Math.min(args.timeoutMs, 15_000));
  let browser: ScriptedBrowserLike | null = null;
  let page: ScriptedPageLike | null = null;
  const steps: BrowserPersonaStepCapture[] = [];

  try {
    browser = await launchPlaywrightChromium({
      browserCommand: args.browserCommand,
      timeoutMs: args.timeoutMs
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
        const { screenshotPath, written: blockedShotWritten } =
          await captureBlockedStepScreenshot(page, args.absoluteArtifactRoot, args.surface, nextStep);
        steps.push({
          action: nextStep.action,
          completedAt: now,
          durationMs: Date.now() - started,
          id: nextStep.id,
          label: nextStep.label,
          reason,
          ...(blockedShotWritten ? { screenshotPath } : {}),
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
  const playwrightScreenshotPath = surfaceScreenshotPath(steps);

  await writeContainedOutputFile(args.absoluteArtifactRoot, tracePath, `${JSON.stringify(buildBrowserTrace({
    appUrl: args.appUrl,
    browserCommand: path.basename(args.browserCommand),
    browserJourney: args.browserJourney,
    capturedAt: completedAt,
    durationMs,
    ...(httpProbe.status === undefined ? {} : { httpStatus: httpProbe.status }),
    ok,
    reason,
    ...(playwrightScreenshotPath === undefined ? {} : { screenshotPath: playwrightScreenshotPath }),
    steps,
    surface: args.surface
  }), null, 2)}\n`, "utf8");

  return {
    capturedAt: completedAt,
    durationMs,
    ...(httpProbe.status === undefined ? {} : { httpStatus: httpProbe.status }),
    ok,
    reason,
    ...(playwrightScreenshotPath === undefined ? {} : { screenshotPath: playwrightScreenshotPath }),
    steps,
    surface: args.surface,
    tracePath
  };
}

export async function executeBrowserPersonaStep(args: {
  absoluteArtifactRoot: PreparedOutputDirectory;
  appUrl: string;
  browserJourney: BrowserPersonaJourney;
  page: ScriptedPageLike;
  step: BrowserPersonaStepManifest;
  surface: BrowserSurface;
  timeoutMs: number;
  urlPolicy?: ScriptedBrowserEvidenceUrlPolicy;
}): Promise<BrowserPersonaStepCapture> {
  const started = Date.now();
  const urlPolicy = args.urlPolicy ?? LOOPBACK_EVIDENCE_URL_POLICY;
  const beforeState = await browserPersonaPageState(args.page, urlPolicy);
  const stepTimeoutMs = Math.min(args.timeoutMs, 8_000);
  if (args.step.action === "goto") {
    await args.page.goto(resolveBrowserStepUrlForPolicy(args.appUrl, args.step.path ?? args.browserJourney.startPath, urlPolicy), {
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

  const afterState = await browserPersonaPageState(args.page, urlPolicy);
  const screenshotPath = screenshotPathForBrowserStep(args.surface, args.step);
  await prepareContainedOutputFile(args.absoluteArtifactRoot, screenshotPath);
  const screenshotBytes = await captureScriptedPageScreenshot(args.page);
  assertScreenshotEvidence(screenshotPath, screenshotBytes);
  await writeContainedOutputFile(args.absoluteArtifactRoot, screenshotPath, screenshotBytes);
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
    url: sanitizeBrowserEvidenceUrl(args.page.url(), urlPolicy)
  };
}

export async function evaluateBrowserStepExpectations(args: {
  afterState: { bodyDigest: string; url: string };
  beforeState: { bodyDigest: string; url: string };
  page: ScriptedPageLike;
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

async function pageTextAssertion(page: ScriptedPageLike, expectedText: string, timeoutMs: number): Promise<BrowserPersonaAssertionCapture> {
  const passed = await waitForPageText(page, expectedText, timeoutMs).then(() => true).catch(() => false);
  return {
    id: "text-present",
    reason: passed ? "Expected text was present." : "Expected text was not present.",
    status: passed ? "passed" : "blocked"
  };
}

async function waitForPageText(page: ScriptedPageLike, expectedText: string, timeoutMs: number): Promise<void> {
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
    ...CHROMIUM_EVIDENCE_HYGIENE_FLAGS,
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    `--user-data-dir=${args.profileDir}`,
    `--window-size=${args.surface.viewport.width},${args.surface.viewport.height}`,
    `--force-device-scale-factor=${args.surface.viewport.deviceScaleFactor}`,
    `--screenshot=${args.screenshotPath}`,
    args.appUrl
  ];
}

export function buildBlockedBrowserPersonaSteps(args: {
  browserJourney: BrowserPersonaJourney;
  currentUrl: string;
  reason: string;
  surface: BrowserSurface;
  timestamp: string;
  urlPolicy?: ScriptedBrowserEvidenceUrlPolicy;
}): BrowserPersonaStepCapture[] {
  // The journey never ran, so no screenshot was written for these steps. The
  // failure IS the evidence: keep the blocked status + reason, but omit the
  // screenshot reference so the bundle never claims an artifact that does not
  // exist (otherwise verify's missingLocalEvidenceArtifacts fails closed on
  // evidence that was never meant to exist). See src/artifact-reference.ts.
  return args.browserJourney.steps.map((step) => ({
    action: step.action,
    completedAt: args.timestamp,
    durationMs: 0,
    id: step.id,
    label: step.label,
    reason: args.reason,
    status: "blocked" as const,
    url: sanitizeBrowserEvidenceUrl(args.currentUrl, args.urlPolicy)
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

export function screenshotPathForBrowserStep(surface: BrowserSurface, step: BrowserPersonaStepManifest | undefined): string {
  assertSafeOutputPathSegment(surface.id, "Browser surface id");
  if (step) {
    assertSafeOutputPathSegment(step.id, "Browser journey step id");
  }
  return path.join("screenshots", `${surface.id}-${step?.id ?? "step"}.png`);
}

function tracePathForBrowserSurface(surface: BrowserSurface): string {
  assertSafeOutputPathSegment(surface.id, "Browser surface id");
  return path.join("traces", `${surface.id}.json`);
}

function assertScriptedSessionPathIds(options: ScriptedBrowserSessionOptions): void {
  assertSafeOutputPathSegment(options.surface.id, "Browser surface id");
  for (const step of options.journey.steps) {
    assertSafeOutputPathSegment(step.id, "Browser journey step id");
  }
}

/**
 * Best-effort screenshot of a blocked step. The step is blocked, so its failure is
 * the evidence; the shot is a bonus. Returns the relative path plus whether the
 * write actually produced a non-empty file, so the caller only references the path
 * when the file truly exists (never claim a screenshot that is not there --
 * src/artifact-reference.ts).
 */
async function captureBlockedStepScreenshot(
  page: ScriptedPageLike | null,
  artifactRoot: PreparedOutputDirectory,
  surface: BrowserSurface,
  step: BrowserPersonaStepManifest
): Promise<{ screenshotPath: string; written: boolean }> {
  const screenshotPath = screenshotPathForBrowserStep(surface, step);
  await prepareContainedOutputFile(artifactRoot, screenshotPath);
  if (!page) {
    return { screenshotPath, written: false };
  }
  try {
    const screenshotBytes = await captureScriptedPageScreenshot(page);
    assertScreenshotEvidence(screenshotPath, screenshotBytes);
    await writeContainedOutputFile(artifactRoot, screenshotPath, screenshotBytes);
    return { screenshotPath, written: true };
  } catch {
    return { screenshotPath, written: false };
  }
}

/**
 * Surface-level screenshot path = the last step that actually wrote one. Returns
 * undefined when no step wrote a screenshot (a fully blocked capture whose evidence
 * is the failure itself), so the producer never synthesizes a path to a file it did
 * not write. See src/artifact-reference.ts.
 */
export function surfaceScreenshotPath(steps: BrowserPersonaStepCapture[]): string | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const candidate = steps[index]?.screenshotPath?.trim();
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

export function resolveBrowserStepUrl(appUrl: string, value: string | undefined): string {
  return resolveBrowserStepUrlForPolicy(appUrl, value, LOOPBACK_EVIDENCE_URL_POLICY);
}

export function resolveBrowserStepUrlForPolicy(
  appUrl: string,
  value: string | undefined,
  urlPolicy: ScriptedBrowserEvidenceUrlPolicy = LOOPBACK_EVIDENCE_URL_POLICY
): string {
  const url = new URL(value?.trim() || "", appUrl);
  if (urlPolicy.kind === "provisioned-subject") {
    const subjectOrigin = new URL(appUrl).origin;
    if (url.origin !== subjectOrigin) {
      throw new Error("browser step URL must resolve within the provisioned subject origin");
    }
    return url.toString();
  }
  const normalized = normalizeLocalAppUrl(url.toString());
  if (!normalized) {
    throw new Error("browser step URL must resolve to a loopback HTTP URL");
  }
  return normalized;
}

async function browserPersonaPageState(page: {
  evaluate<T>(pageFunction: string): Promise<T>;
  url(): string;
}, urlPolicy: ScriptedBrowserEvidenceUrlPolicy = LOOPBACK_EVIDENCE_URL_POLICY): Promise<{ bodyDigest: string; url: string }> {
  const bodyText = await page.evaluate<string>("document.body ? document.body.innerText : ''");
  return {
    bodyDigest: digestText(bodyText.slice(0, 4_000)),
    url: sanitizeBrowserEvidenceUrl(page.url(), urlPolicy)
  };
}

export function buildBrowserTrace(args: {
  appUrl: string;
  browserCommand: string;
  browserJourney: BrowserPersonaJourney;
  capturedAt: string;
  durationMs: number;
  httpStatus?: number;
  ok: boolean;
  reason: string;
  screenshotPath?: string;
  steps: BrowserPersonaStepCapture[];
  surface: BrowserSurface;
}): Record<string, unknown> {
  return {
    schema: "humanish.browser-persona-trace.v1",
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
    ...(args.screenshotPath === undefined ? {} : { screenshotPath: args.screenshotPath }),
    steps: args.steps,
    surface: args.surface,
    redaction: "passed"
  };
}

export function sanitizeLoopbackUrl(value: string): string {
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

export function sanitizeBrowserEvidenceUrl(
  value: string,
  urlPolicy: ScriptedBrowserEvidenceUrlPolicy = LOOPBACK_EVIDENCE_URL_POLICY
): string {
  if (urlPolicy.kind === "loopback") {
    return sanitizeLoopbackUrl(value);
  }
  const evidenceOrigin = urlPolicy.evidenceOrigin.trim() || "[provisioned-subject]";
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname || "/";
    const search = parsed.search ? "?[redacted-query]" : "";
    const hash = parsed.hash ? "#[redacted-hash]" : "";
    return `${evidenceOrigin}${pathname}${search}${hash}`;
  } catch {
    return evidenceOrigin;
  }
}

export async function captureScreenshotWithBrowser(args: {
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

async function captureBrowserCommandScreenshot(args: {
  appUrl: string;
  browserCommand: string;
  profileDir: string;
  surface: BrowserSurface;
  timeoutMs: number;
}): Promise<Buffer> {
  const stagingPath = await mkdtemp(path.join(os.tmpdir(), "humanish-browser-command-shot-"));
  const stagingRoot = await prepareSelectedOutputDirectory(path.dirname(stagingPath), stagingPath);
  try {
    const screenshotPath = path.join(stagingRoot.physicalPath, "capture.png");
    await captureScreenshotWithBrowser({
      args: browserScreenshotArgs({
        appUrl: args.appUrl,
        profileDir: args.profileDir,
        screenshotPath,
        surface: args.surface
      }),
      browserCommand: args.browserCommand,
      screenshotPath,
      timeoutMs: args.timeoutMs
    });
    const bytes = await readContainedRegularFile(stagingRoot, "capture.png");
    if (!bytes) {
      throw new Error("Browser screenshot command did not write a single-link staging file.");
    }
    return bytes;
  } finally {
    await assertPreparedSelectedOutputDirectory(stagingRoot)
      .then(() => rm(stagingRoot.physicalPath, { force: true, recursive: true }))
      .catch(() => undefined);
  }
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

export async function probeAppUrl(appUrl: string, timeoutMs: number): Promise<{ ok: boolean; reason: string; status?: number }> {
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

export async function resolveBrowserCommand(): Promise<string | null> {
  const candidates = [
    await resolveBrowserCandidate(process.env.HUMANISH_BROWSER_COMMAND),
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

export function normalizeLocalAppUrl(value: string): string | null {
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

// ---------------------------------------------------------------------------
// Journey parser (moved from run.ts).
// ---------------------------------------------------------------------------

export function parseBrowserPersonaJourneyFromScenario(args: {
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

export function parseBrowserPersonaStep(rawStep: unknown, index: number): { failure?: string; step?: BrowserPersonaStepManifest } {
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

export function builtinBrowserPersonaJourney(): BrowserPersonaJourney {
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

// ---------------------------------------------------------------------------
// The registry-facing actor session. NEW code (not moved): it reuses the moved
// primitives — the REAL step executor, expectation evaluator, blocked-step
// builder, native trace writer — against an injected or playwright-launched
// browser, and projects the result into humanish.actor-trace.v1.
// ---------------------------------------------------------------------------

export const SCRIPTED_BROWSER_PROVIDER = "browser-persona";

export interface ScriptedBrowserSessionOptions {
  /** Pre-normalized loopback URL, or a harness-minted provisioned subject URL. */
  appUrl: string;
  /** Stable redacted URL label persisted in public-safe evidence when appUrl is private. */
  evidenceAppUrl?: string;
  /** Defaults to loopback. Provisioned subjects drive a private URL but persist redacted labels. */
  urlPolicy?: ScriptedBrowserEvidenceUrlPolicy;
  /** Parsed + validated by the backend (scenario.ref is consumed there, fail-closed). */
  journey: BrowserPersonaJourney;
  /** ONE session per surface lane. */
  surface: BrowserSurface;
  /** id = actors[0].persona ?? "scripted-journey"; promptDigest = journey.sourceDigest prefix
   *  (the step manifest IS the "prompt" — no model prompt exists on this lane). */
  persona: ActorPersonaRef;
  /** Journey wall-clock budget (default upstream: 60_000, today's run --app-url default). */
  timeoutMs: number;
  /** Absolute; the session writes screenshots/ and traces/<surface>.json beneath it. */
  artifactRoot: string;
  /** Default resolveBrowserCommand(); recorded as "injected-browser" when launchBrowser is injected. */
  browserCommand?: string;
  /** DI seam; production default is launchPlaywrightChromium. */
  launchBrowser?: (args: ScriptedBrowserLaunchArgs) => Promise<ScriptedBrowserLike>;
  now?: () => number;
}

export interface ScriptedBrowserSessionResult {
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  /** Native evidence incl. tracePath (humanish.browser-persona-trace.v1, written to disk). */
  capture: BrowserSurfaceCapture;
  /** humanish.actor-trace.v1 projection. */
  trace: ActorTrace;
}

/** Thrown between/around steps when the journey exceeds its wall-clock budget. */
class ScriptedJourneyTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`journey exceeded its ${timeoutMs}ms wall-clock budget`);
    this.name = "ScriptedJourneyTimeoutError";
  }
}

/**
 * Run the scripted journey for ONE surface and return native capture + ActorTrace projection.
 *
 * Completion semantics (the contract the projection tests pin):
 * - every step executed, every assertion passed, HTTP probe ok -> passed / goal_satisfied
 *   (the scenario's expect blocks ARE the success predicate; a pass claims "the app still
 *   affords this exact journey", nothing about user behavior);
 * - a step's expectation evaluated false, a step target missing/unactionable, or an
 *   unreachable subject -> failed / step_failed (the harness executed faithfully; the SUBJECT
 *   did not satisfy the script — distinct from actor_error/harness_error);
 * - journey exceeded timeoutMs -> timed_out / timed_out;
 * - browser launch/import crash -> failed / harness_error;
 * - gave_up / blocked_approval are UNREACHABLE from this actor (no persona patience, no
 *   approvals exist on a deterministic replay) — asserted in tests.
 */
export async function runScriptedBrowserSession(options: ScriptedBrowserSessionOptions): Promise<ScriptedBrowserSessionResult> {
  assertScriptedSessionPathIds(options);
  const preparedArtifactRoot = await prepareSelectedOutputDirectory(process.cwd(), options.artifactRoot);
  return runScriptedBrowserSessionInPreparedRoot(options, preparedArtifactRoot);
}

/** Internal lab seam: the run root is already prepared and must stay bound to that identity. */
export async function runScriptedBrowserSessionInPreparedRoot(
  options: ScriptedBrowserSessionOptions,
  preparedArtifactRoot: PreparedOutputDirectory
): Promise<ScriptedBrowserSessionResult> {
  assertScriptedSessionPathIds(options);
  await prepareContainedOutputDirectory(preparedArtifactRoot, "screenshots");
  await prepareContainedOutputDirectory(preparedArtifactRoot, "traces");
  await prepareContainedOutputFile(preparedArtifactRoot, tracePathForBrowserSurface(options.surface));
  await Promise.all(
    options.journey.steps.map((step) =>
      prepareContainedOutputFile(preparedArtifactRoot, screenshotPathForBrowserStep(options.surface, step))
    )
  );
  await assertScriptedOutputRoot(preparedArtifactRoot);
  const now = options.now ?? (() => Date.now());
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const launch = options.launchBrowser ?? launchPlaywrightChromium;
  const browserCommand = options.browserCommand ?? (options.launchBrowser ? "injected-browser" : "");
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
      status: args.status
    });
    return {
      status: args.status,
      completionReason: args.completionReason,
      reason: args.reason,
      capture: args.capture,
      trace
    };
  };

  // Launch FIRST: a browser that cannot start is a harness failure, never subject evidence.
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
      urlPolicy
    });
    return finish({ capture, executedSteps: 0, status: "failed", completionReason: "harness_error", reason });
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
    urlPolicy
  });

  if (journeyRun.timedOut) {
    return finish({
      capture: journeyRun.capture,
      executedSteps: journeyRun.executedSteps,
      status: "timed_out",
      completionReason: "timed_out",
      reason: `${options.surface.label} ${new ScriptedJourneyTimeoutError(options.timeoutMs).message}.`
    });
  }

  if (journeyRun.capture.ok) {
    return finish({
      capture: journeyRun.capture,
      executedSteps: journeyRun.executedSteps,
      status: "passed",
      completionReason: "goal_satisfied",
      reason: journeyRun.capture.reason
    });
  }

  const firstFailing = journeyRun.capture.steps.find((step) => step.status !== "passed");
  return finish({
    capture: journeyRun.capture,
    executedSteps: journeyRun.executedSteps,
    status: "failed",
    completionReason: "step_failed",
    reason: firstFailing ? `${firstFailing.id}: ${firstFailing.reason}` : journeyRun.capture.reason
  });
}

/** Drive the journey on an already-launched browser, mirroring the driver's capture
 *  semantics (partial blocked steps on error, trace written exactly once, browser closed). */
async function runScriptedJourney(args: {
  appUrl: string;
  artifactRoot: PreparedOutputDirectory;
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
        height: args.surface.viewport.height
      }
    });
    page = await context.newPage();

    for (const step of args.journey.steps) {
      await assertScriptedOutputRoot(args.artifactRoot);
      executedSteps += 1;
      steps.push(await withJourneyDeadline(
        executeBrowserPersonaStep({
          absoluteArtifactRoot: args.artifactRoot,
          appUrl: args.appUrl,
          browserJourney: args.journey,
          page,
          step,
          surface: args.surface,
          timeoutMs: args.timeoutMs,
          urlPolicy: args.urlPolicy
        }),
        deadline,
        args.timeoutMs
      ));
    }
  } catch (error) {
    await assertScriptedOutputRoot(args.artifactRoot);
    timedOut = error instanceof ScriptedJourneyTimeoutError;
    const now = new Date().toISOString();
    const reason = compactBrowserError(error);
    if (steps.length === 0) {
      steps.push(...buildBlockedBrowserPersonaSteps({
        browserJourney: args.journey,
        currentUrl: args.appUrl,
        reason,
        surface: args.surface,
        timestamp: now,
        urlPolicy: args.urlPolicy
      }));
    } else if (steps.length < args.journey.steps.length) {
      const nextStep = args.journey.steps[steps.length];
      if (nextStep) {
        const { screenshotPath, written: blockedShotWritten } =
          await captureBlockedStepScreenshot(page, args.artifactRoot, args.surface, nextStep);
        steps.push({
          action: nextStep.action,
          completedAt: now,
          durationMs: Date.now() - started,
          id: nextStep.id,
          label: nextStep.label,
          reason,
          ...(blockedShotWritten ? { screenshotPath } : {}),
          status: "blocked",
          url: page ? sanitizeBrowserEvidenceUrl(page.url(), args.urlPolicy) : args.evidenceAppUrl
        });
      }
    }
  } finally {
    await args.browser.close().catch(() => undefined);
  }

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - started;
  const ok = !timedOut && httpProbe.ok && steps.length === args.journey.steps.length && steps.every((step) => step.status === "passed");
  const reason = ok
    ? `${args.surface.label} completed ${steps.length}/${steps.length} scripted browser steps from ${args.evidenceAppUrl}${httpProbe.status === undefined ? "" : ` with HTTP ${httpProbe.status}`}.`
    : `${args.surface.label} scripted browser journey blocked: ${steps.find((step) => step.status !== "passed")?.reason ?? httpProbe.reason}`;
  const scriptedScreenshotPath = surfaceScreenshotPath(steps);

  await writeContainedOutputFile(args.artifactRoot, tracePath, `${JSON.stringify(buildBrowserTrace({
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
    surface: args.surface
  }), null, 2)}\n`, "utf8");

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
      tracePath
    },
    executedSteps,
    timedOut
  };
}

/** Race one step against the journey's remaining wall-clock budget. A hanging step rejects
 *  with the timeout error; the journey's catch path then records honest blocked steps. */
async function withJourneyDeadline<T>(promise: Promise<T>, deadline: number, timeoutMs: number): Promise<T> {
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
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Persist the all-steps-blocked capture + native trace for failures that happen before any
 *  journey actuation (browser launch crash). Mirrors the driver's failure shape. */
async function persistScriptedFailureCapture(args: {
  appUrl: string;
  artifactRoot: PreparedOutputDirectory;
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
    urlPolicy: args.urlPolicy
  });
  // Pre-actuation failure: no screenshots were written, so the surface omits the
  // screenshot reference and the failure itself stands as the evidence.
  const screenshotPath = surfaceScreenshotPath(blockedSteps);
  await writeContainedOutputFile(args.artifactRoot, tracePath, `${JSON.stringify(buildBrowserTrace({
    appUrl: args.evidenceAppUrl,
    browserCommand: path.basename(args.browserCommand || "injected-browser"),
    browserJourney: args.journey,
    capturedAt,
    durationMs: 0,
    ok: false,
    reason: args.reason,
    ...(screenshotPath === undefined ? {} : { screenshotPath }),
    steps: blockedSteps,
    surface: args.surface
  }), null, 2)}\n`, "utf8");
  return {
    capturedAt,
    durationMs: 0,
    ok: false,
    reason: args.reason,
    ...(screenshotPath === undefined ? {} : { screenshotPath }),
    steps: blockedSteps,
    surface: args.surface,
    tracePath
  };
}

/** Project one surface capture into humanish.actor-trace.v1. screenshotRefs are attached only
 *  for frames that actually exist on disk (honest counts; blocked-not-executed steps name a
 *  path that was never written). */
async function projectScriptedActorTrace(args: {
  artifactRoot: PreparedOutputDirectory;
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
    const screenshotFile = await prepareContainedOutputFile(args.artifactRoot, step.screenshotPath).catch(() => null);
    const stats = screenshotFile ? await stat(screenshotFile).catch(() => null) : null;
    if (stats?.isFile() && stats.size > 0) {
      writtenScreenshots.add(step.screenshotPath);
    }
  }

  let assertionCount = 0;
  const items: ActorTraceItem[] = args.capture.steps.map((step) => {
    const assertions = step.assertions ?? [];
    assertionCount += assertions.length;
    const assertionLines = assertions.map((assertion) => `${assertion.id}: ${assertion.status} — ${assertion.reason}`);
    return {
      id: step.id,
      kind: "ui_action" as const,
      lifecycle: "completed" as const,
      status: step.status,
      title: redactText(`${step.action}: ${step.label}`).slice(0, 120),
      ...(step.screenshotPath && writtenScreenshots.has(step.screenshotPath)
        ? { screenshotRef: { path: step.screenshotPath, redaction: "none" as const } }
        : {}),
      text: redactText([step.reason, ...assertionLines].join("\n"))
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
      notes: "Deterministic scripted steps. Step URLs sanitized to loopback origin+path (query/hash redacted); fill values are committed-scenario constants passed through redactText; screenshots are full-fidelity raw in gitignored .humanish."
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
      screenshots: writtenScreenshots.size
    },
    items,
    // Affirmative $0 declaration, TRUE by mechanism: no provider client is importable from
    // this code path, so zeros are a recorded fact, not an estimate.
    tokenUsage: { input: 0, output: 0, total: 0, costUsd: 0 },
    capabilities: SCRIPTED_BROWSER_CAPABILITIES
  };
}

// ---------------------------------------------------------------------------
// Small private helpers (moved with the driver; run.ts keeps its own copies for
// the code that stayed behind — this module must remain a leaf).
// ---------------------------------------------------------------------------

async function assertScriptedOutputRoot(root: PreparedOutputDirectory): Promise<string> {
  if ("physicalRunRoot" in root) {
    await prepareContainedOutputDirectory(root, "");
    return root.physicalRunRoot;
  }
  await assertPreparedSelectedOutputDirectory(root);
  return root.physicalPath;
}

function browserScreenshotBytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new Error("Browser screenshot did not return image bytes.");
}

async function captureScriptedPageScreenshot(page: ScriptedPageLike): Promise<Buffer> {
  const stagingPath = await mkdtemp(path.join(os.tmpdir(), "humanish-browser-shot-"));
  const stagingRoot = await prepareSelectedOutputDirectory(path.dirname(stagingPath), stagingPath);
  try {
    const returned = await page.screenshot({
      path: path.join(stagingRoot.physicalPath, "capture.png"),
      fullPage: true
    });
    if (Buffer.isBuffer(returned) || returned instanceof Uint8Array) {
      return browserScreenshotBytes(returned);
    }
    const stagedBytes = await readContainedRegularFile(stagingRoot, "capture.png");
    if (!stagedBytes) {
      throw new Error("Browser screenshot did not return bytes or write a single-link staging file.");
    }
    return stagedBytes;
  } finally {
    await assertPreparedSelectedOutputDirectory(stagingRoot)
      .then(() => rm(stagingRoot.physicalPath, { force: true, recursive: true }))
      .catch(() => undefined);
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function redactSensitiveText(text: string): string {
  return redactToSecretLabel(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
