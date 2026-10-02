// The computer-use lab backend: a subject (an app-url the caller provisioned, or a repo the
// lab clones AND serves in-sandbox) driven by a REGISTRY-RESOLVED computer-use actor inside a
// hosted E2B desktop. This is the path that makes `actors[].type` load-bearing — the
// descriptor returned by the registry runs the session; the lab provisions the desktop and
// subject, composes the prompt from config, persists the evidence bundle, and tears down.
//
// Substrate notes:
// - The desktop is created via the shared loader in src/substrates/e2b/sdk.ts with
//   kill-on-timeout lifecycle, so a dead host process can never orphan a sandbox past its
//   server-side deadline.
// - Env placement follows the doctrine (docs/principles/invariants-and-defaults.md): the
//   ACTOR's key never enters the sandbox (the model drives from outside via the provider API);
//   the SUBJECT's declared env NAMES are provisioned in on the clone route — values come from
//   the caller's environment and are never logged or persisted.
// - The live stream URL is runtime-only (carries an auth key) and is never persisted into run
//   artifacts — only its presence is recorded.
// - Evidence redaction is mode-aware (docs/principles/invariants-and-defaults.md, the
//   capture-vs-publish rule): screenshots persist RAW (full fidelity) by default into gitignored
//   .humanish/; `policies.redactScreenshots: true` opts into blur-at-capture for a share-as-is
//   bundle. Length-only typed text and text redaction of reasoning/messages are UNCONDITIONAL;
//   harness errors are redacted at THIS boundary; the bundle's `stream.actor` carries the
//   conformant humanish.actor-trace.v1 projection, whose `redaction.screenshots` records the
//   run's actual mode ("raw" | "blurred" | "n/a") — every label downstream derives from it.

import { withTransientCommsSecrets } from "../../run/transient-comms-secrets.js";
import path from "node:path";
import { completeAutomaticAnalysis } from "../../analysis/automatic-completion.js";
import { type FinishedRun, runScope, type RunScope } from "../../run/run.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import type { ComputerUsePlan } from "../../lab/plan-types.js";
import { browserRouteScorer } from "../../lab/adapter-scorer-loader.js";
import { withLateScorer } from "../../lab/route-inputs.js";
import type { AdmittedPlan } from "../../run-lab.js";
import type { LabConfig } from "../../lab/types.js";
import { callerDrivingOf, planComputerUseLab, type ComputerUseRefusal } from "./plan.js";
import { finishCuaRun } from "./result.js";
import { runLabParticipants } from "./live-phase.js";
import { admitCuaRun, type AdmittedCuaRun, refuseCuaLab, startCuaRun } from "./setup.js";
import {
  type ComputerUseRunInput,
  CUA_ACTOR_LAB_SCHEMA,
  type CuaActorLabResult,
  type RunCuaActorLabOptions,
} from "./types.js";

/**
 * The library entry for a computer-use lab. It plans the config with planComputerUseLab and runs
 * the plan with runComputerUsePlan, whose run scope and withTransientCommsSecrets wrapper cover the
 * run and its analysis.
 */
export async function runCuaActorLab(options: RunCuaActorLabOptions): Promise<CuaActorLabResult> {
  const { config, dryRun, ...input } = options;
  // planComputerUseLab makes every configuration refusal, in the order this route always has.
  const planned = planComputerUseLab(config, {
    dryRun,
    hasRunSession: input.deps?.runSession !== undefined,
    driving: callerDrivingOf(input),
    ...(input.countOverride === undefined ? {} : { countOverride: input.countOverride }),
    ...(input.rerun === undefined ? {} : { rerun: input.rerun }),
  });
  if (planned.ok) return runComputerUsePlan(planned.plan, input, config);
  return computerUseLabRefusal(options, planned.refusal);
}

/**
 * A refused computer-use lab's result, at the refusal's stage: a before-scope refusal has its own
 * envelope and no analysis record; the others come after the cwd checks, and the lane cap after
 * the personas are read.
 */
export async function computerUseLabRefusal(
  options: RunCuaActorLabOptions,
  refusal: ComputerUseRefusal,
): Promise<CuaActorLabResult> {
  const { config, dryRun } = options;
  if (refusal.stage === "before-scope")
    return {
      schema: CUA_ACTOR_LAB_SCHEMA,
      ok: false,
      cwd: path.resolve(options.cwd),
      labId: config.id,
      actor: config.actors[0]?.type ?? "",
      dryRun,
      runId: options.runId ?? "not-created",
      appUrl: config.subject.appUrl ?? config.subject.serve?.url ?? "",
      lanes: [],
      warnings: [],
      error: { code: refusal.code, message: refusal.message },
    };
  // The other refusals come after the cwd checks, and the lane cap after the personas are read.
  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  return completeAutomaticAnalysis(
    await refuseCuaLab(options, refusal),
    undefined,
    analysis.ok ? analysis.config : undefined,
    options,
    { trigger: config.review?.analysis === undefined ? "default" : "explicit" },
  );
}

/**
 * runLab's step for a computer-use plan. It runs the plan's local checks (admitCuaRun: the
 * participants, the preflight plan, the keys, the local agent, subject env and caps, and the
 * local-tree archive) before any run scope opens, so the CLI can present their refusal before it
 * loads a declared scorer, and returns the run that continues from them with that scorer.
 */
export async function admitComputerUsePlan(
  plan: ComputerUsePlan,
  input: ComputerUseRunInput,
  config: LabConfig,
): Promise<AdmittedPlan<"computer-use">> {
  const admission = await admitCuaRun(plan, input, config);
  if (!admission.ok)
    return {
      ok: false,
      outcome: cuaOutcome(await completeCuaAnalysis(plan, input, admission.result, undefined)),
    };
  return {
    ok: true,
    run: async (scorer) => {
      // The scorer joins the input only; the runSession, provider and desktop the checks admitted
      // stay the ones the run uses.
      const running = withLateScorer(input, scorer, browserRouteScorer);
      return cuaOutcome(await runAdmittedCuaRun(plan, running, admission.admitted));
    },
  };
}

function cuaOutcome(result: CuaActorLabResult) {
  return { route: "computer-use", result } as const;
}

/**
 * Run a computer-use plan: its local checks, then the run. The run scope in runAdmittedCuaRun
 * finalizes any status record the run opened, on every exit, so a test or library caller does not
 * leave the 5 s status cadence writing into a directory something else is deleting (an unrelated
 * ENOTEMPTY). Participants, the brain, the subject, the caps and the residual config come from the
 * plan. `config` is what the caller's createProvider and inProcess executor receive.
 */
export async function runComputerUsePlan(
  plan: ComputerUsePlan,
  input: ComputerUseRunInput,
  config: LabConfig,
): Promise<CuaActorLabResult> {
  const admission = await admitCuaRun(plan, input, config);
  if (!admission.ok) return completeCuaAnalysis(plan, input, admission.result, undefined);
  return runAdmittedCuaRun(plan, input, admission.admitted);
}

/**
 * Runs an admitted plan in its own run scope, then its automatic analysis. The
 * withTransientCommsSecrets wrapper scopes any email secret the run registers to this run and its
 * analysis.
 */
function runAdmittedCuaRun(
  plan: ComputerUsePlan,
  input: ComputerUseRunInput,
  admitted: AdmittedCuaRun,
): Promise<CuaActorLabResult> {
  return withTransientCommsSecrets(async () => {
    const { result, finished } = await runScope((scope) =>
      runPlanInScope(plan, input, admitted, scope),
    );
    return completeCuaAnalysis(plan, input, result, finished);
  });
}

function completeCuaAnalysis(
  plan: ComputerUsePlan,
  input: ComputerUseRunInput,
  result: CuaActorLabResult,
  finished: FinishedRun | undefined,
): Promise<CuaActorLabResult> {
  // A local VM study whose cleanup is unconfirmed records a skip instead of analyzing.
  const refusal = input.localVm?.analysisRefusal;
  return completeAutomaticAnalysis(result, finished, plan.analysis?.config, input, {
    ...(plan.analysis === undefined ? {} : { trigger: plan.analysis.trigger }),
    preferLargerOutput: plan.analysis?.preferLargerOutput === true,
    ...(refusal === undefined ? {} : { refusal }),
  });
}

async function runPlanInScope(
  plan: ComputerUsePlan,
  input: ComputerUseRunInput,
  admitted: AdmittedCuaRun,
  scope: RunScope,
): Promise<CuaActorLabResult> {
  const prepared = await startCuaRun(plan, input, admitted, scope);
  if (!prepared.ok) return prepared.result;
  const ran = await runLabParticipants(prepared.setup, prepared.participants);
  if (!ran.ok) return ran.result;
  return finishCuaRun(prepared.setup, prepared.finish, ran);
}
