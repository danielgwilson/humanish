// What a scripted run needs before it starts: the checks the plan cannot make (the scenario file,
// the E2B key and subject env of a live clone, a browser to launch) and the values the run reads
// (the evidence URL policy, the scrubber for clone values, the persona and the session budget).

import { realpath } from "node:fs/promises";
import { missingKeys, missingSubjectEnv } from "../../lab/requirements.js";
import path from "node:path";
import type { ActorPersonaRef } from "../../actors/contract.js";
import { resolveBrowserCommand } from "../../actors/scripted-browser/browser-command.js";
import type {
  BrowserPersonaJourney,
  ScriptedBrowserEvidenceUrlPolicy,
} from "../../actors/scripted-browser/types.js";
import { describeMissingKeys } from "../../keys/key-resolution.js";
import type { ScriptedPlan } from "../../lab/plan-types.js";
import { prepareSelectedOutputDirectory } from "../../run/contained-output.js";
import { evidenceAppUrlOf } from "./plan.js";
import { resolveScriptedScenario } from "./scenario.js";
import { type ScriptedBrowserLabResult, type ScriptedRunInput } from "./types.js";
import type { LabDeps } from "../../lab/lab-deps.js";
import { studyResultIdentity } from "../../run/study-result.js";

// Journey wall-clock budget per surface: 5 minutes. A scripted surface has zero model cost and
// sandbox-seconds are pennies; a short default only truncated slow-loading subjects.
const DEFAULT_SESSION_TIMEOUT_MS = 300_000;

/** What setup hands the run: the plan's subject and scenario, keys and the browser to launch. */
export interface ScriptedRunSetup {
  cwd: string;
  physicalCwd: string;
  deps: LabDeps;
  warnings: string[];
  failed: (
    code: NonNullable<ScriptedBrowserLabResult["error"]>["code"],
    message: string,
  ) => ScriptedBrowserLabResult;
  clone: Extract<ScriptedPlan["subject"], { readonly kind: "clone" }> | undefined;
  evidenceAppUrl: string;
  urlPolicy: ScriptedBrowserEvidenceUrlPolicy;
  subjectEnvNames: string[];
  env: Record<string, string | undefined>;
  e2bApiKey: string;
  hasGithubToken: boolean;
  redactRepoLabel: boolean;
  scrubKnownValues: (text: string) => string;
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
  { ok: false; result: ScriptedBrowserLabResult } | { ok: true; setup: ScriptedRunSetup }
> {
  const { dryRun } = plan;
  const cwd = path.resolve(input.cwd);
  const physicalCwd = await realpath(cwd);
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const deps = input.deps ?? {};
  const warnings: string[] = [];
  const clone = plan.subject.kind === "clone" ? plan.subject : undefined;
  const evidenceAppUrl = evidenceAppUrlOf(plan.subject);
  const failed = (
    code: NonNullable<ScriptedBrowserLabResult["error"]>["code"],
    message: string,
  ): ScriptedBrowserLabResult => ({
    ...studyResultIdentity("scripted", plan.labId),
    ok: false,
    cwd,
    actor: plan.actor,
    appUrl: evidenceAppUrl,
    dryRun,
    runId: input.runId ?? "not-created",
    sessions: [],
    warnings,
    error: { code, message },
  });

  const urlPolicy: ScriptedBrowserEvidenceUrlPolicy = clone
    ? { kind: "provisioned-subject", evidenceOrigin: evidenceAppUrl }
    : { kind: "loopback" };
  const subjectEnvNames = [...(clone?.env ?? [])];
  const env = input.env ?? process.env;
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";
  const hasGithubToken = subjectEnvNames.includes("GITHUB_TOKEN");
  const redactRepoLabel = plan.residual.policies?.redactRepos ?? hasGithubToken;
  const scrubSourceValues = [
    ...(clone ? [clone.repo] : []),
    ...subjectEnvNames.map((name) => env[name] ?? ""),
  ].filter(Boolean);
  const scrubKnownValues = (text: string): string =>
    scrubSourceValues.reduce((acc, value) => acc.split(value).join("[redacted]"), text);

  // A clone's URL is replaced by its getHost URL once it is served.
  let appUrl = plan.subject.kind === "clone" ? plan.subject.serve.url : plan.subject.appUrl;

  const scenario = await resolveScriptedScenario(projectRoot, plan.scenarioRef);
  if (!scenario.ok) {
    return {
      ok: false,
      result: failed("HUMANISH_SCRIPTED_SCENARIO_INVALID", scenario.message),
    };
  }
  const journey = scenario.journey;

  // The plan lists E2B_API_KEY and the subject env only for a live clone.
  const missing = missingKeys(plan.requirements, env);
  if (missing.length > 0) {
    return {
      ok: false,
      result: failed(
        "HUMANISH_SCRIPTED_KEYS_MISSING",
        `Live clone scripted-browser labs require ${missing.join(" and ")} (dry-run remains $0 and does not provision a subject). ${describeMissingKeys(missing, env)}`,
      ),
    };
  }
  const unsetSubjectEnv = missingSubjectEnv(plan.requirements, env);
  if (unsetSubjectEnv.length > 0) {
    return {
      ok: false,
      result: failed(
        "HUMANISH_SCRIPTED_SUBJECT_ENV_MISSING",
        `Subject env values missing for live clone scripted-browser lab: ${unsetSubjectEnv.join(", ")}.`,
      ),
    };
  }

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
      scrubKnownValues,
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
