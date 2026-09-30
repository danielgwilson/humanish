import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ObserverResult } from "./render.js";

/**
 * The Observer result for a run's in-progress files, handed to `onObserverReady` before the
 * participants start. Nothing is rendered: the live server builds the page from run.json on each
 * request, so only the paths are needed.
 */
export function liveObserverResult(
  cwd: string,
  runId: string,
  artifactRoot: string,
  warnings: string[] = [],
): ObserverResult & { ok: true } {
  const observerPath = path.join(artifactRoot, "observer", "index.html");
  const observerDataPath = path.join(artifactRoot, "observer", "observer-data.json");
  const eventsPath = path.join(artifactRoot, "events.ndjson");
  return {
    schema: "humanish.observer-result.v1",
    ok: true,
    cwd,
    run: runId,
    observerPath: path.relative(cwd, observerPath),
    observerDataPath: path.relative(cwd, observerDataPath),
    eventsPath: path.relative(cwd, eventsPath),
    observerUrl: pathToFileURL(observerPath).href,
    bundlePath: path.join(artifactRoot, "run.json"),
    opened: false,
    warnings,
  };
}
