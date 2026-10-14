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
import { redactEncodedText } from "../../evidence/encoded-text.js";
import { evidenceAppUrlOf } from "./plan.js";
import { resolveScriptedScenario } from "./scenario.js";
import { type ScriptedBrowserStudyResult, type ScriptedRunInput } from "./types.js";
import type { StudyDeps } from "../../study/study-deps.js";
import { refusedResult } from "../../run/study-result.js";

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
  const steps = recordedStepIds(scenario.journey.steps, secrets);
  if (!steps.ok)
    return { ok: false, result: failed("HUMANISH_SCRIPTED_SCENARIO_INVALID", steps.message) };
  // The goal, title and step labels are recorded; a step's path, selector, value and expected text
  // drive the browser and stay as written.
  const journey: BrowserPersonaJourney = {
    ...scenario.journey,
    scenarioId: idHoldsKnownValue(scenario.journey.scenarioId, secrets)
      ? "scenario"
      : scenario.journey.scenarioId,
    goal: recordedText(scenario.journey.goal, secrets),
    scenarioTitle: recordedText(scenario.journey.scenarioTitle, secrets),
    steps: steps.steps,
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
  const timeoutMs = plan.sessionTimeoutMs;
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
 * Scenario text the run records, without the run's known values and then without keys as written
 * or encoded, since verify decodes the files that record it.
 */
function recordedText(text: string, secrets: RunSecrets): string {
  return redactEncodedText(secrets.scrub(text));
}

/**
 * Whether an id holds a known value as written or as the parser's id token of it, lower-cased with
 * other characters as `-`, which the scrub would not find.
 */
function idHoldsKnownValue(id: string, secrets: RunSecrets): boolean {
  return (
    secrets.scrub(id) !== id ||
    secrets.values().some((value) => {
      const token = publicSafeToken(value, "");
      return token.length > 0 && id.includes(token);
    })
  );
}

/**
 * The steps with their labels redacted and their ids safe to record, or why the run is refused. A
 * step id names the step's screenshot file and is recorded beside it, and the parser derives an
 * omitted id from the label, lower-cased and cut to 80 characters, so the scrub may not find a
 * value in it. A step whose label changes under recordedText, or whose id holds a known value, is
 * renamed by its position instead.
 */
function recordedStepIds(
  steps: readonly BrowserPersonaStepManifest[],
  secrets: RunSecrets,
): { ok: true; steps: BrowserPersonaStepManifest[] } | { ok: false; message: string } {
  const taken = new Set(steps.map((step) => step.id));
  const recorded: BrowserPersonaStepManifest[] = [];
  for (const [index, step] of steps.entries()) {
    const label = recordedText(step.label, secrets);
    if (label === step.label && !idHoldsKnownValue(step.id, secrets)) {
      recorded.push({ ...step, label });
      continue;
    }
    const id = positionId(index, taken, secrets);
    if (id === undefined)
      return {
        ok: false,
        message: `The label or id of scenario step ${index + 1} holds a key, a local path or a value this run keeps out of its files, so the run renames the step by its position, and each id that position gives holds one of those values too. Remove it from the step's label and id.`,
      };
    taken.add(id);
    recorded.push({ ...step, id, label });
  }
  return { ok: true, steps: recorded };
}

/**
 * The id a renamed step takes by its position, such as step-03 for the third step, then step-03-2,
 * step-03-3 and on when another step has it. A known value can be one of these ids, so one that
 * holds a known value is passed over. Every id holds the position id, so a position id that holds a
 * known value gives undefined at once. Otherwise taken.size + 1 ids that hold no known value are
 * tried, which includes a free one, as long as known values pass over at most
 * MAX_KNOWN_VALUE_SKIPS of them; a value such as `-01-` that every numbered id holds gives undefined.
 */
function positionId(
  index: number,
  taken: ReadonlySet<string>,
  secrets: RunSecrets,
): string | undefined {
  const position = `step-${String(index + 1).padStart(2, "0")}`;
  if (idHoldsKnownValue(position, secrets)) return undefined;
  let skips = 0;
  for (let suffix = 1; suffix <= taken.size + 1 + skips; suffix += 1) {
    const id = suffix === 1 ? position : `${position}-${suffix}`;
    if (taken.has(id)) continue;
    if (!idHoldsKnownValue(id, secrets)) return id;
    if (skips === MAX_KNOWN_VALUE_SKIPS) return undefined;
    skips += 1;
  }
  return undefined;
}

// Known values are few, and a numbered id holds one only when the value matches its digits.
const MAX_KNOWN_VALUE_SKIPS = 32;
