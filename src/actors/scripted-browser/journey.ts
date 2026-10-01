// Parse a scenario's `browser.steps` into a BrowserPersonaJourney: the actions, text assertions and
// expectations the scripted browser runs. The journey is the actor's whole behavior.

import path from "node:path";
import { isRecord } from "../../run/type-guards.js";
import type {
  BrowserPersonaAction,
  BrowserPersonaJourney,
  BrowserPersonaStepExpectation,
  BrowserPersonaStepManifest,
} from "./types.js";

export function parseBrowserPersonaJourneyFromScenario(args: {
  raw: unknown;
  relativePath: string;
  sourceDigest: string;
}): { failure?: string; journey?: BrowserPersonaJourney } {
  if (!isRecord(args.raw)) {
    return {};
  }
  const scenarioId = publicSafeToken(
    stringValue(args.raw.id),
    path.basename(args.relativePath, path.extname(args.relativePath)),
  );
  const scenarioTitle = stringValue(args.raw.title) ?? scenarioId;
  const goal =
    stringValue(args.raw.goal) ?? "Drive a public-safe browser persona through the local app.";
  const browser = isRecord(args.raw.browser) ? args.raw.browser : undefined;
  const declaredBrowser =
    args.raw.mode === "browser" || browser !== undefined || hasInlineBrowserSteps(args.raw.steps);
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
    return {
      failure: `${args.relativePath} declared browser steps, but no executable steps were found.`,
    };
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
      steps,
    },
  };
}

function parseBrowserPersonaStep(
  rawStep: unknown,
  index: number,
): { failure?: string; step?: BrowserPersonaStepManifest } {
  if (!isRecord(rawStep)) {
    return { failure: `browser step ${index + 1} must be an object.` };
  }
  const inlineBrowser = isRecord(rawStep.browser) ? rawStep.browser : undefined;
  const source = inlineBrowser ?? rawStep;
  const hasExecutableFields =
    inlineBrowser !== undefined ||
    "action" in rawStep ||
    "selector" in rawStep ||
    "path" in rawStep ||
    "expect" in rawStep;
  if (!hasExecutableFields) {
    return {};
  }

  const action = browserPersonaActionValue(source.action);
  if (!action) {
    return { failure: `browser step ${index + 1} has unsupported or missing action.` };
  }

  const label =
    stringValue(rawStep.name) ??
    stringValue(rawStep.label) ??
    stringValue(source.label) ??
    `Step ${index + 1}`;
  const id = publicSafeToken(
    stringValue(rawStep.id) ?? stringValue(source.id),
    `step-${String(index + 1).padStart(2, "0")}-${label}`,
  );
  const selector = stringValue(source.selector);
  const pathValue = stringValue(source.path);
  const value = stringValue(source.value);
  const key = stringValue(source.key);
  const expectation = browserStepExpectationValue(source.expect ?? source.expectation);

  if (action === "press" && !key) {
    return { failure: `${id} press action requires key (for example Enter).` };
  }
  if (action !== "press" && "key" in source) {
    return {
      failure: `${id} sets key, which only a press step sends. Supported actions: ${SUPPORTED_ACTIONS}.`,
    };
  }
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
      ...(value === undefined ? {} : { value }),
      ...(key === undefined ? {} : { key }),
    },
  };
}

function hasInlineBrowserSteps(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => isRecord(entry) && isRecord(entry.browser));
}

const SUPPORTED_ACTIONS = "goto, fill, click, press, assertText, waitForText, waitForSelector";

function browserPersonaActionValue(value: unknown): BrowserPersonaAction | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, "");
  if (normalized === "goto" || normalized === "open" || normalized === "navigate") return "goto";
  if (normalized === "click") return "click";
  if (normalized === "press") return "press";
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
    ...(urlIncludes === undefined ? {} : { urlIncludes }),
  };
  return Object.keys(expectation).length === 0 ? undefined : expectation;
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
