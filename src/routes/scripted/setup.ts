// What a scripted run needs before it starts: the checks the plan cannot make (the scenario file,
// the E2B key and subject env of a live clone, a browser to launch) and the values the run reads
// (the evidence URL policy, the run's known secrets, the persona and the session budget).

import { realpath } from "node:fs/promises";
import { firstLiveRefusal, keysCheck, subjectEnvCheck } from "../../study/requirements.js";
import path from "node:path";
import type { ActorPersonaRef } from "../../actors/contract.js";
import { resolveBrowserCommand } from "../../actors/scripted-browser/browser-command.js";
import { publicSafeToken } from "../../actors/scripted-browser/journey.js";
import type {
  BrowserPersonaJourney,
  BrowserPersonaStepManifest,
  ScriptedBrowserEvidenceUrlPolicy,
} from "../../actors/scripted-browser/types.js";
import type { ScriptedPlan } from "../../study/plan-types.js";
import { prepareSelectedOutputDirectory } from "../../run/contained-output.js";
import { RunSecrets } from "../../run/secrets.js";
import { evidenceAppUrlOf } from "./plan.js";
import { resolveScriptedScenario } from "./scenario.js";
import { type ScriptedBrowserStudyResult, type ScriptedRunInput } from "./types.js";
import type { StudyDeps } from "../../study/study-deps.js";
import { refusedResult } from "../../run/study-result.js";

// Journey wall-clock budget per surface: 5 minutes. A scripted surface has zero model cost and
// sandbox-seconds are pennies; a short default only truncated slow-loading subjects.
const DEFAULT_SESSION_TIMEOUT_MS = 300_000;

/** What setup hands the run: the plan's subject and scenario, keys and the browser to launch. */
export interface ScriptedRunSetup {
  cwd: string;
  physicalCwd: string;
  deps: StudyDeps;
  warnings: string[];
  failed: (
    code: NonNullable<ScriptedBrowserStudyResult["error"]>["code"],
    message: string,
  ) => ScriptedBrowserStudyResult;
  clone: Extract<ScriptedPlan["subject"], { readonly kind: "clone" }> | undefined;
  evidenceAppUrl: string;
  urlPolicy: ScriptedBrowserEvidenceUrlPolicy;
  subjectEnvNames: string[];
  env: Record<string, string | undefined>;
  e2bApiKey: string;
  hasGithubToken: boolean;
  redactRepoLabel: boolean;
  secrets: RunSecrets;
  /** The loopback app URL, or the clone's serve URL until its getHost URL replaces it. */
  appUrl: string;
  scenario: { source: string; sourceDigest: string };
  journey: BrowserPersonaJourney;
  surfaces: ScriptedPlan["surfaces"];
  timeoutMs: number;
  persona: ActorPersonaRef;
  browserCommand: string | undefined;
}

/**
 * Checks what the plan cannot: the scenario file, the E2B key and subject env of a live clone,
 * and a browser to launch. Returns the refusal, or what the run needs.
 */
export async function prepareScriptedRun(
  plan: ScriptedPlan,
  input: ScriptedRunInput,
): Promise<
  { ok: false; result: ScriptedBrowserStudyResult } | { ok: true; setup: ScriptedRunSetup }
> {
  const { dryRun } = plan;
  const cwd = path.resolve(input.cwd);
  const physicalCwd = await realpath(cwd);
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const deps = input.deps ?? {};
  const warnings: string[] = [];
  const clone = plan.subject.kind === "clone" ? plan.subject : undefined;
  const subjectEnvNames = [...(clone?.env ?? [])];
  const env = input.env ?? process.env;
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";
  const secrets = new RunSecrets([
    e2bApiKey,
    ...(clone ? [clone.repo] : []),
    ...subjectEnvNames.map((name) => env[name] ?? ""),
  ]);
  // An app-url run records the URL it was given, in the bundle and every summary.
  const evidenceAppUrl = secrets.scrub(evidenceAppUrlOf(plan.subject));
  const failed = (
    code: NonNullable<ScriptedBrowserStudyResult["error"]>["code"],
    message: string,
  ): ScriptedBrowserStudyResult =>
    refusedResult(
      "scripted",
      { studyId: plan.studyId, cwd, warnings, error: { code, message } },
      {
        actor: plan.actor,
        appUrl: evidenceAppUrl,
        dryRun,
        runId: input.runId ?? "not-created",
        sessions: [],
      },
    );

  const urlPolicy: ScriptedBrowserEvidenceUrlPolicy = clone
    ? { kind: "provisioned-subject", evidenceOrigin: evidenceAppUrl }
    : { kind: "loopback" };
  const hasGithubToken = subjectEnvNames.includes("GITHUB_TOKEN");
  const redactRepoLabel = plan.residual.policies?.redactRepos ?? hasGithubToken;

  // A clone's URL is replaced by its getHost URL once it is served.
  let appUrl = plan.subject.kind === "clone" ? plan.subject.serve.url : plan.subject.appUrl;

  const scenario = await resolveScriptedScenario(projectRoot, plan.scenarioRef);
  if (!scenario.ok) {
    return {
      ok: false,
      result: failed("HUMANISH_SCRIPTED_SCENARIO_INVALID", scenario.message),
    };
  }
  // The goal, title and step labels are recorded; a step's path, selector, value and expected text
  // drive the browser and stay as written.
  const journey: BrowserPersonaJourney = {
    ...scenario.journey,
    goal: secrets.scrub(scenario.journey.goal),
    scenarioTitle: secrets.scrub(scenario.journey.scenarioTitle),
    steps: recordedStepIds(scenario.journey.steps, secrets),
  };

  // The plan lists E2B_API_KEY and the subject env only for a live clone.
  const { requirements } = plan;
  const refusal = await firstLiveRefusal<Parameters<ScriptedRunSetup["failed"]>[0]>([
    () =>
      keysCheck({
        requirements,
        env,
        code: "HUMANISH_SCRIPTED_KEYS_MISSING",
        need: (names) =>
          `Live clone scripted-browser studies require ${names} (dry-run remains $0 and does not provision a subject).`,
      }),
    () => subjectEnvCheck({ requirements, env, code: "HUMANISH_SCRIPTED_SUBJECT_ENV_MISSING" }),
  ]);
  if (refusal) return { ok: false, result: failed(refusal.code, refusal.message) };

  const surfaces = plan.surfaces;
  const timeoutMs = plan.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const persona: ActorPersonaRef = {
    id: plan.personaId ?? "scripted-journey",
    traitsApplied: [],
    // The step manifest is the "prompt" on this route; the digest binds the trace to the
    // committed scenario text.
    promptDigest: journey.sourceDigest.slice(0, 16),
  };

  // Live runs need a browser before any actuation (unless one is injected).
  let browserCommand = deps.browserCommand;
  if (!dryRun && !deps.launchBrowser && !browserCommand) {
    const resolved = await resolveBrowserCommand();
    if (!resolved) {
      return {
        ok: false,
        result: failed(
          "HUMANISH_SCRIPTED_BROWSER_MISSING",
          "No Chrome/Chromium browser command was found for the scripted-browser actor. Set HUMANISH_BROWSER_COMMAND to a browser binary playwright-core can launch.",
        ),
      };
    }
    browserCommand = resolved;
  }
  return {
    ok: true,
    setup: {
      cwd,
      physicalCwd,
      deps,
      warnings,
      failed,
      clone,
      evidenceAppUrl,
      urlPolicy,
      subjectEnvNames,
      env,
      e2bApiKey,
      hasGithubToken,
      redactRepoLabel,
      secrets,
      appUrl,
      scenario,
      journey,
      surfaces,
      timeoutMs,
      persona,
      browserCommand,
    },
  };
}

/**
 * The steps with their labels scrubbed and their ids safe to record. A step id names the step's
 * screenshot file and is recorded beside it, and the parser derives an omitted id from the label,
 * lower-cased and cut to 80 characters, so the scrub may not find a value in it. A step whose
 * label or id holds a known value is renamed by its position instead.
 */
function recordedStepIds(
  steps: readonly BrowserPersonaStepManifest[],
  secrets: RunSecrets,
): BrowserPersonaStepManifest[] {
  const tokens = secrets.values().map((value) => publicSafeToken(value, ""));
  const taken = new Set(steps.map((step) => step.id));
  return steps.map((step, index) => {
    const label = secrets.scrub(step.label);
    const holds =
      label !== step.label ||
      secrets.scrub(step.id) !== step.id ||
      tokens.some((token) => token.length > 0 && step.id.includes(token));
    if (!holds) return { ...step, label };
    const position = `step-${String(index + 1).padStart(2, "0")}`;
    let id = position;
    for (let suffix = 2; taken.has(id); suffix += 1) id = `${position}-${suffix}`;
    taken.add(id);
    return { ...step, id, label };
  });
}
