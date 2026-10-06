// One browser session per surface, and the provider-neutral trace each surface writes beside the
// session's native traces/<surface>.json.

import {
  runScriptedBrowserSessionInPreparedRoot,
  type ScriptedBrowserSessionOptions,
  type ScriptedBrowserSessionResult,
} from "../../actors/scripted-browser/actor.js";
import type { ScriptedPlan } from "../../study/plan-types.js";
import { writeContainedOutputFile } from "../../run/contained-output.js";
import {
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths,
} from "../../run/paths.js";
import { validateScriptedSessionResult } from "./session-result.js";
import type { StudyDeps } from "../../study/study-deps.js";

/** One session per surface, in parallel. */
export function runScriptedSessions(
  session: Required<
    Pick<
      ScriptedBrowserSessionOptions,
      | "appUrl"
      | "evidenceAppUrl"
      | "urlPolicy"
      | "journey"
      | "persona"
      | "timeoutMs"
      | "artifactRoot"
      | "scrubKnownValues"
    >
  >,
  run: {
    surfaces: ScriptedPlan["surfaces"];
    deps: StudyDeps;
    browserCommand: string | undefined;
    runPaths: PreparedRunArtifactPaths;
    /** Called as each surface's session starts, before it can throw or return. */
    onSessionStart: () => void;
  },
): Promise<ScriptedBrowserSessionResult[]> {
  const { appUrl, evidenceAppUrl, urlPolicy, journey, persona, timeoutMs, artifactRoot } = session;
  const { scrubKnownValues } = session;
  const { surfaces, deps, browserCommand, runPaths, onSessionStart } = run;
  const runSession = deps.runScriptedSession;
  return Promise.all(
    surfaces.map((surface) => {
      onSessionStart();
      const sessionOptions: ScriptedBrowserSessionOptions = {
        appUrl,
        evidenceAppUrl,
        urlPolicy,
        journey,
        surface,
        persona,
        timeoutMs,
        artifactRoot,
        scrubKnownValues,
        ...(browserCommand === undefined ? {} : { browserCommand }),
        ...(deps.launchBrowser === undefined ? {} : { launchBrowser: deps.launchBrowser }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
      };
      return runSession
        ? runSession(sessionOptions).then(async (result) => {
            await validatePreparedRunArtifactPaths(runPaths);
            validateScriptedSessionResult(surface, result);
            return result;
          })
        : runScriptedBrowserSessionInPreparedRoot(sessionOptions, runPaths);
    }),
  );
}

/** Writes each surface's actor-<surface>.json, as the computer-use route writes actor.json. */
export async function writeSurfaceTraces(
  runPaths: PreparedRunArtifactPaths,
  results: readonly ScriptedBrowserSessionResult[],
): Promise<void> {
  for (const result of results) {
    await writeContainedOutputFile(
      runPaths,
      `actor-${result.capture.surface.id}.json`,
      `${JSON.stringify(result.trace, null, 2)}\n`,
      "utf8",
    );
  }
}
