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
import { planComputerUseLab, type ComputerUseRefusal } from "./plan.js";
import { finishCuaRun } from "./result.js";
import { runLabLanes } from "./run-lanes.js";
import { prepareCuaRun } from "./setup.js";
import {
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
  // planComputerUseLab makes every configuration refusal, in the order this route always has.
  const planned = planComputerUseLab(options.config, {
    dryRun: options.dryRun,
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.countOverride === undefined ? {} : { countOverride: options.countOverride }),
    ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
  });
  const refusal = planned.ok ? undefined : planned.refusal;
  if (refusal?.stage === "before-scope")
    return {
      schema: CUA_ACTOR_LAB_SCHEMA,
      ok: false,
      cwd: path.resolve(options.cwd),
      labId: options.config.id,
      actor: options.config.actors[0]?.type ?? "",
      dryRun: options.dryRun,
      runId: options.runId ?? "not-created",
      appUrl: options.config.subject.appUrl ?? options.config.subject.serve?.url ?? "",
      lanes: [],
      warnings: [],
      error: { code: refusal.code, message: refusal.message },
    };
  const analysis = resolveAutomaticAnalysis(options.config.review?.analysis);
  const { result, finished } = await runScope((scope) =>
    runCuaActorLabInScope(options, refusal, scope),
  );
  return completeAutomaticAnalysis(
    result,
    finished,
    analysis.ok ? analysis.config : undefined,
    options.automaticAnalysis,
    {
      trigger: options.config.review?.analysis === undefined ? "default" : "explicit",
      preferLargerOutput: analysis.ok && analysis.preferLargerOutput === true,
    },
  );
}

async function runCuaActorLabInScope(
  options: RunCuaActorLabOptions,
  refusal: ComputerUseRefusal | undefined,
  scope: RunScope,
): Promise<CuaActorLabResult> {
  const prepared = await prepareCuaRun(options, refusal, scope);
  if (!prepared.ok) return prepared.result;
  const lanes = await runLabLanes(prepared.setup);
  if (!lanes.ok) return lanes.result;
  return finishCuaRun(prepared.setup, lanes);
}
