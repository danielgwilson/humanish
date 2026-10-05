// The computer-use route: a subject (an app-url the caller provisioned, or a repo the
// humanish clones and serves in the sandbox) driven by a registry-resolved computer-use actor inside a
// hosted E2B desktop. On this path `actor.type` selects the actor: the
// descriptor returned by the registry runs the session; the route provisions the desktop and
// subject, composes the prompt from config, persists the evidence bundle, and tears down.
//
// Substrate notes:
// - The desktop is created via the shared loader in src/substrates/e2b/sdk.ts with
//   kill-on-timeout lifecycle, so a dead host process can never orphan a sandbox past its
//   server-side deadline.
// - Env placement follows the placement rule (docs/principles/invariants-and-defaults.md): the
//   actor's key never enters the sandbox (the model drives from outside via the provider API);
//   the subject's declared env names are provisioned in on the clone route; values come from
//   the caller's environment and are never logged or persisted.
// - The live stream URL is runtime-only (carries an auth key) and is never persisted into run
//   artifacts; only its presence is recorded.
// - Evidence redaction is mode-aware (docs/principles/invariants-and-defaults.md, the
//   capture-vs-publish rule): screenshots persist raw (full fidelity) by default into gitignored
//   .humanish/; `policies.redactScreenshots: true` opts into blur-at-capture for a share-as-is
//   bundle. Length-only typed text and text redaction of reasoning/messages are unconditional;
//   harness errors are redacted at this boundary; the bundle's `stream.actor` carries the
//   conformant humanish.actor-trace.v1 projection, whose `redaction.screenshots` records the
//   run's actual mode ("raw" | "blurred" | "n/a"), and every label downstream derives from it.

import path from "node:path";
import { type RunScope } from "../../run/run.js";
import { admitRoute, completeRefusalAnalysis, type RefusedStudy } from "../../run/route-shell.js";
import type { ComputerUsePlan } from "../../study/plan-types.js";
import { browserRouteScorer } from "../../study/adapter-scorer-loader.js";
import { withLateScorer } from "../../study/route-inputs.js";
import type { AdmittedPlan } from "../../run-study.js";
import type { StudyConfig } from "../../study/types.js";
import { type ComputerUseRefusal } from "./plan.js";
import { finishCuaRun } from "./result.js";
import { runStudyParticipants } from "./live-phase.js";
import { admitCuaRun, type AdmittedCuaRun, refuseCuaStudy, startCuaRun } from "./setup.js";
import { type ComputerUseRunInput, type CuaActorStudyResult } from "./types.js";
import { studyResultIdentity } from "../../run/study-result.js";

/**
 * A refused computer-use study's result, at the refusal's stage: a before-scope refusal has its own
 * envelope and no analysis record; the others come after the cwd checks, and the participant cap after
 * the personas are read.
 */
export async function computerUseStudyRefusal(
  options: ComputerUseRunInput & RefusedStudy,
  refusal: ComputerUseRefusal,
): Promise<CuaActorStudyResult> {
  const { config, dryRun } = options;
  if (refusal.stage === "before-scope")
    return {
      ...studyResultIdentity("computer-use", config.id),
      ok: false,
      cwd: path.resolve(options.cwd),
      actor: config.actor?.type ?? "",
      dryRun,
      runId: options.runId ?? "not-created",
      appUrl: config.subject.appUrl ?? config.subject.serve?.url ?? "",
      lanes: [],
      warnings: [],
      error: { code: refusal.code, message: refusal.message },
    };
  // The other refusals come after the cwd checks, and the participant cap after the personas are read.
  return completeRefusalAnalysis(await refuseCuaStudy(options, refusal), config, options);
}

/**
 * runStudyWith's step for a computer-use plan. It runs the plan's local checks (admitCuaRun: the
 * participants, the preflight plan, the keys, the local agent, subject env and caps, and the
 * local-tree archive) before any run scope opens, so the CLI can present their refusal before it
 * loads a declared scorer, and returns the run that continues from them with that scorer. The
 * run and its analysis share one scope for the email secrets it registers.
 */
export function admitComputerUsePlan(
  plan: ComputerUsePlan,
  input: ComputerUseRunInput,
  config: StudyConfig,
): Promise<AdmittedPlan<"computer-use">> {
  // A local VM study whose cleanup is unconfirmed records a skip instead of analyzing.
  const analysisRefusal = input.localVm?.analysisRefusal;
  return admitRoute({
    route: "computer-use",
    analysis: plan.analysis,
    input,
    admit: () => admitCuaRun(plan, input, config),
    withScorer: (base, scorer) => withLateScorer(base, scorer, browserRouteScorer),
    runInScope: (admitted, running, scope) => runPlanInScope(plan, running, admitted, scope),
    ...(analysisRefusal === undefined ? {} : { analysisRefusal }),
    commsSecrets: true,
  });
}

async function runPlanInScope(
  plan: ComputerUsePlan,
  input: ComputerUseRunInput,
  admitted: AdmittedCuaRun,
  scope: RunScope,
): Promise<CuaActorStudyResult> {
  const prepared = await startCuaRun(plan, input, admitted, scope);
  if (!prepared.ok) return prepared.result;
  const ran = await runStudyParticipants(prepared.setup, prepared.participants);
  if (!ran.ok) return ran.result;
  return finishCuaRun(prepared.setup, prepared.finish, ran);
}
