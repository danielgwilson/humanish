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
import { runScope, type RunScope } from "../../run/run.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import type { ComputerUsePlan } from "../../lab/plan-types.js";
import type { LabConfig } from "../../lab/types.js";
import { planComputerUseLab } from "./plan.js";
import { finishCuaRun } from "./result.js";
import { runLabLanes } from "./run-lanes.js";
import { prepareCuaRun, refuseCuaLab } from "./setup.js";
import {
  type ComputerUseRunInput,
  CUA_ACTOR_LAB_SCHEMA,
  type CuaActorLabResult,
  type RunCuaActorLabOptions,
} from "./types.js";

export { inboxRecipientFor, laneHasInboxRecipient } from "./desktop-lane.js";
export { defaultPackLocalTree } from "./local-tree-pack.js";
export { resolveSubjectState } from "./subject-projection.js";

/**
 * Wrapped so a DIRECT library caller gets the same status-record lifetime the CLI does: returning
 * from this function finalizes any record the run opened, whichever of its fail-closed exits it
 * took. `runLab` establishes a scope too and nesting is harmless — the inner scope owns what it
 * opened. Without this a test or an adopter calling the backend directly leaves the 5s cadence
 * ticking into a directory something else is deleting, which surfaces as an unrelated ENOTEMPTY.
 */
export async function runCuaActorLab(options: RunCuaActorLabOptions): Promise<CuaActorLabResult> {
  return withTransientCommsSecrets(() => runCuaActorLabWithSecrets(options));
}

async function runCuaActorLabWithSecrets(
  options: RunCuaActorLabOptions,
): Promise<CuaActorLabResult> {
  const { config, dryRun, lab, ...input } = options;
  // planComputerUseLab makes every configuration refusal, in the order this route always has.
  const planned = planComputerUseLab(config, {
    dryRun,
    ...(lab === undefined ? {} : { lab }),
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
    ...(input.countOverride === undefined ? {} : { countOverride: input.countOverride }),
    ...(input.rerun === undefined ? {} : { rerun: input.rerun }),
  });
  if (planned.ok) return runPlanWithSecrets(planned.plan, input, config);

  const { refusal } = planned;
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
    options.automaticAnalysis,
    { trigger: config.review?.analysis === undefined ? "default" : "explicit" },
  );
}

/**
 * Run a computer-use plan. The run scope gives a direct library caller the same status-record
 * lifetime the CLI gets. `config` is read only to build participants and by the lane runner, whose
 * hooks take the whole config; step 2A replaces it with the plan's participants.
 */
export async function runComputerUsePlan(
  plan: ComputerUsePlan,
  input: ComputerUseRunInput,
  config: LabConfig,
): Promise<CuaActorLabResult> {
  return withTransientCommsSecrets(() => runPlanWithSecrets(plan, input, config));
}

async function runPlanWithSecrets(
  plan: ComputerUsePlan,
  input: ComputerUseRunInput,
  config: LabConfig,
): Promise<CuaActorLabResult> {
  const { result, finished } = await runScope((scope) =>
    runPlanInScope(plan, input, config, scope),
  );
  return completeAutomaticAnalysis(
    result,
    finished,
    plan.analysis?.config,
    input.automaticAnalysis,
    {
      ...(plan.analysis === undefined ? {} : { trigger: plan.analysis.trigger }),
      preferLargerOutput: plan.analysis?.preferLargerOutput === true,
    },
  );
}

async function runPlanInScope(
  plan: ComputerUsePlan,
  input: ComputerUseRunInput,
  config: LabConfig,
  scope: RunScope,
): Promise<CuaActorLabResult> {
  const prepared = await prepareCuaRun(plan, input, config, scope);
  if (!prepared.ok) return prepared.result;
  const lanes = await runLabLanes(prepared.setup);
  if (!lanes.ok) return lanes.result;
  return finishCuaRun(prepared.setup, lanes);
}
