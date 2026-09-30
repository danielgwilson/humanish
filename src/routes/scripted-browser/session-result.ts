// Check a scripted-browser session result before the route persists it: every screenshot and trace
// path it names must be a safe path inside the run's artifact root. A result that fails is unsafe,
// and the route stops without writing a bundle from it.

import path from "node:path";
import type { ScriptedBrowserSessionResult } from "../../actors/scripted-browser/actor.js";
import type { BrowserSurface } from "../../actors/scripted-browser/types.js";
import type { PreparedRunArtifactPaths } from "../../run/paths.js";
import { readContainedRegularFile } from "../../run/contained-output.js";

export class UnsafeScriptedSessionResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeScriptedSessionResultError";
  }
}

export async function existingScreenshots(
  runPaths: PreparedRunArtifactPaths,
  result: ScriptedBrowserSessionResult,
): Promise<string[]> {
  const existing: string[] = [];
  for (const step of result.capture.steps) {
    // Blocked steps whose evidence is the failure itself recorded no screenshot path.
    if (!step.screenshotPath) {
      continue;
    }
    const screenshot = await readContainedRegularFile(runPaths, step.screenshotPath);
    if (screenshot && screenshot.byteLength > 0) {
      existing.push(step.screenshotPath);
    }
  }
  return existing;
}

export function validateScriptedSessionResult(
  expectedSurface: BrowserSurface,
  result: ScriptedBrowserSessionResult,
): void {
  if (
    result.capture.surface.id !== expectedSurface.id ||
    !isSafeOutputSegment(result.capture.surface.id)
  ) {
    throw new UnsafeScriptedSessionResultError(
      "Scripted session returned an unexpected or unsafe surface id.",
    );
  }
  const paths = [
    result.capture.tracePath,
    ...(result.capture.screenshotPath ? [result.capture.screenshotPath] : []),
    ...result.capture.steps.flatMap((step) => (step.screenshotPath ? [step.screenshotPath] : [])),
  ];
  if (!paths.every(isSafeRelativeArtifactPath)) {
    throw new UnsafeScriptedSessionResultError(
      "Scripted session returned an unsafe artifact path.",
    );
  }
}

function isSafeOutputSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function isSafeRelativeArtifactPath(value: string): boolean {
  if (
    !value ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    return false;
  }
  return !value
    .replace(/\\/g, "/")
    .split("/")
    .some((part) => !part || part === "." || part === "..");
}
