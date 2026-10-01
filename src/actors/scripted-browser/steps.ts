// The scripted browser's step executor: run one journey step on a page, evaluate its expectations,
// build blocked steps after a failure, capture screenshots, and turn the steps into the native
// browser trace. Evidence URLs pass through the run's URL policy before they are recorded.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertScreenshotEvidence, stripPngMetadataChunks } from "../../evidence/image.js";
import { digestText, redactToSecretLabel } from "../../evidence/redaction.js";
import {
  assertPreparedSelectedOutputDirectory,
  assertSafeOutputPathSegment,
  prepareContainedOutputFile,
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
  writeContainedOutputFile,
  type PreparedOutputRoot,
} from "../../run/contained-output.js";
import {
  LOOPBACK_EVIDENCE_URL_POLICY,
  type BrowserPersonaAssertionCapture,
  type BrowserPersonaJourney,
  type BrowserPersonaStepCapture,
  type BrowserPersonaStepManifest,
  type BrowserSurface,
  type ScriptedBrowserEvidenceUrlPolicy,
  type ScriptedPageLike,
} from "./types.js";

export async function executeBrowserPersonaStep(args: {
  absoluteArtifactRoot: PreparedOutputRoot;
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
    await args.page.goto(
      resolveBrowserStepUrlForPolicy(
        args.appUrl,
        args.step.path ?? args.browserJourney.startPath,
        urlPolicy,
      ),
      {
        waitUntil: "domcontentloaded",
        timeout: args.timeoutMs,
      },
    );
  } else if (args.step.action === "fill") {
    if (!args.step.selector) {
      throw new Error(`${args.step.id} fill step is missing selector`);
    }
    await args.page
      .locator(args.step.selector)
      .first()
      .fill(args.step.value ?? "synthetic.user@example.test", {
        timeout: stepTimeoutMs,
      });
  } else if (args.step.action === "click") {
    let target = args.step.selector
      ? args.page.locator(args.step.selector).first()
      : args.page
          .locator("button, input[type='submit'], input[type='button'], [role='button']")
          .first();
    if (!args.step.selector) {
      const textInput = args.page
        .locator("input:not([type='hidden']):not([type='submit']):not([type='button']), textarea")
        .first();
      if ((await textInput.count()) > 0) {
        await textInput.fill(args.step.value ?? "synthetic.user@example.test", {
          timeout: stepTimeoutMs,
        });
      }
    }
    if ((await target.count()) === 0) {
      throw new Error(`${args.step.id} click step found no target`);
    }
    await target.click({ timeout: stepTimeoutMs });
    await args.page.waitForTimeout(300);
  } else if (args.step.action === "press") {
    if (!args.step.key) {
      throw new Error(`${args.step.id} press step is missing key`);
    }
    // With a selector, Playwright focuses that element first; without one, the key goes to
    // whatever has focus, such as the input a fill step just typed into.
    if (args.step.selector) {
      const target = args.page.locator(args.step.selector).first();
      if ((await target.count()) === 0) {
        throw new Error(`${args.step.id} press step found no target`);
      }
      await target.press(args.step.key, { timeout: stepTimeoutMs });
    } else {
      await args.page.keyboard.press(args.step.key);
    }
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
    await args.page
      .locator(args.step.selector)
      .first()
      .waitFor({ state: "visible", timeout: stepTimeoutMs });
  } else {
    const exhaustive: never = args.step.action;
    throw new Error(`Unsupported browser persona action: ${String(exhaustive)}`);
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
    timeoutMs: stepTimeoutMs,
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
    url: sanitizeBrowserEvidenceUrl(args.page.url(), urlPolicy),
  };
}

async function evaluateBrowserStepExpectations(args: {
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
    const changed =
      args.beforeState.url !== args.afterState.url ||
      args.beforeState.bodyDigest !== args.afterState.bodyDigest;
    assertions.push({
      id: "state-changed",
      reason: changed ? "Visible page state changed." : "Visible page state did not change.",
      status: changed ? "passed" : "blocked",
    });
  }
  if (expectation.text) {
    assertions.push(await pageTextAssertion(args.page, expectation.text, args.timeoutMs));
  }
  if (expectation.selectorVisible) {
    const visible = await args.page
      .locator(expectation.selectorVisible)
      .first()
      .isVisible({ timeout: args.timeoutMs })
      .catch(() => false);
    assertions.push({
      id: "selector-visible",
      reason: visible ? "Expected selector was visible." : "Expected selector was not visible.",
      status: visible ? "passed" : "blocked",
    });
  }
  if (expectation.urlIncludes) {
    const includes = args.afterState.url.includes(expectation.urlIncludes);
    assertions.push({
      id: "url-includes",
      reason: includes
        ? "URL included expected public-safe substring."
        : "URL did not include expected public-safe substring.",
      status: includes ? "passed" : "blocked",
    });
  }

  return assertions;
}

async function pageTextAssertion(
  page: ScriptedPageLike,
  expectedText: string,
  timeoutMs: number,
): Promise<BrowserPersonaAssertionCapture> {
  const passed = await waitForPageText(page, expectedText, timeoutMs)
    .then(() => true)
    .catch(() => false);
  return {
    id: "text-present",
    reason: passed ? "Expected text was present." : "Expected text was not present.",
    status: passed ? "passed" : "blocked",
  };
}

async function waitForPageText(
  page: ScriptedPageLike,
  expectedText: string,
  timeoutMs: number,
): Promise<void> {
  // Playwright evaluates a string predicate as an expression and never calls it, so a
  // function-shaped string resolves at once to a truthy function. The needle is inlined instead.
  await page.waitForFunction(
    `document.body?.innerText.includes(${JSON.stringify(expectedText)}) === true`,
    undefined,
    { timeout: timeoutMs },
  );
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
  // evidence that was never meant to exist).
  return args.browserJourney.steps.map((step) => ({
    action: step.action,
    completedAt: args.timestamp,
    durationMs: 0,
    id: step.id,
    label: step.label,
    reason: args.reason,
    status: "blocked" as const,
    url: sanitizeBrowserEvidenceUrl(args.currentUrl, args.urlPolicy),
  }));
}

export function screenshotPathForBrowserStep(
  surface: BrowserSurface,
  step: BrowserPersonaStepManifest | undefined,
): string {
  assertSafeOutputPathSegment(surface.id, "Browser surface id");
  if (step) {
    assertSafeOutputPathSegment(step.id, "Browser journey step id");
  }
  return path.join("screenshots", `${surface.id}-${step?.id ?? "step"}.png`);
}

export function tracePathForBrowserSurface(surface: BrowserSurface): string {
  assertSafeOutputPathSegment(surface.id, "Browser surface id");
  return path.join("traces", `${surface.id}.json`);
}

/**
 * Best-effort screenshot of a blocked step. The step is blocked, so its failure is
 * the evidence; the shot is a bonus. Returns the relative path plus whether the
 * write actually produced a non-empty file, so the caller only references the path
 * when the file truly exists (never claim a screenshot that is not there).
 */
export async function captureBlockedStepScreenshot(
  page: ScriptedPageLike | null,
  artifactRoot: PreparedOutputRoot,
  surface: BrowserSurface,
  step: BrowserPersonaStepManifest,
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
 * not write.
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

function resolveBrowserStepUrlForPolicy(
  appUrl: string,
  value: string | undefined,
  urlPolicy: ScriptedBrowserEvidenceUrlPolicy = LOOPBACK_EVIDENCE_URL_POLICY,
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

async function browserPersonaPageState(
  page: {
    evaluate<T>(pageFunction: string): Promise<T>;
    url(): string;
  },
  urlPolicy: ScriptedBrowserEvidenceUrlPolicy = LOOPBACK_EVIDENCE_URL_POLICY,
): Promise<{ bodyDigest: string; url: string }> {
  const bodyText = await page.evaluate<string>("document.body ? document.body.innerText : ''");
  return {
    bodyDigest: digestText(bodyText.slice(0, 4_000)),
    url: sanitizeBrowserEvidenceUrl(page.url(), urlPolicy),
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
      stepCount: args.browserJourney.steps.length,
    },
    ...(args.screenshotPath === undefined ? {} : { screenshotPath: args.screenshotPath }),
    steps: args.steps,
    surface: args.surface,
    redaction: "passed",
  };
}

function sanitizeLoopbackUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1"
    ) {
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
  urlPolicy: ScriptedBrowserEvidenceUrlPolicy = LOOPBACK_EVIDENCE_URL_POLICY,
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

export async function probeAppUrl(
  appUrl: string,
  timeoutMs: number,
): Promise<{ ok: boolean; reason: string; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(appUrl, {
      signal: controller.signal,
    });
    return {
      ok: response.status < 500,
      reason: `HTTP ${response.status}`,
      status: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      reason: compactBrowserError(error),
    };
  } finally {
    clearTimeout(timer);
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

export function compactBrowserError(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message).replace(/\s+/g, " ").slice(0, 240);
  }

  return redactSensitiveText(String(error)).replace(/\s+/g, " ").slice(0, 240);
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
      fullPage: true,
    });
    // Evidence holds image data only; see stripPngMetadataChunks.
    if (Buffer.isBuffer(returned) || returned instanceof Uint8Array) {
      return stripPngMetadataChunks(browserScreenshotBytes(returned));
    }
    const stagedBytes = await readContainedRegularFile(stagingRoot, "capture.png");
    if (!stagedBytes) {
      throw new Error(
        "Browser screenshot did not return bytes or write a single-link staging file.",
      );
    }
    return stripPngMetadataChunks(stagedBytes);
  } finally {
    await assertPreparedSelectedOutputDirectory(stagingRoot)
      .then(() => rm(stagingRoot.physicalPath, { force: true, recursive: true }))
      .catch(() => undefined);
  }
}

function redactSensitiveText(text: string): string {
  return redactToSecretLabel(text);
}
