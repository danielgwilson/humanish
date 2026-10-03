// The terminal-product route: a real autonomous agent (Codex) studies a CLI or product from its
// public surfaces only, inside an E2B shell. The flow:
//   1. admit: planTerminalStudy refuses what the plan cannot hold, then a live plan's machine checks
//      (checkLiveTerminalMachine) run before any run scope opens, so the CLI can refuse before it
//      loads a declared scorer;
//   2. open the run scope;
//   3. a live plan runs its session in an E2B sandbox (runLiveTerminalSession, session.ts, with
//      live-sandbox.ts and live-finish.ts); a dry plan publishes its contract bundle (dry-run.ts);
//   4. automatic analysis of a run that published its final bundle.
//
// The safety contract (`docs/history/goals/terminal-product-lane/goal.md`) is enforced by construction in
// the files each item names, and checked by the verifier (verify/actor.ts
// validateTerminalProductEvidence):
//   1. Explicit key placement. openai-env (default) injects the raw runtime key command-scoped,
//      never through Sandbox.create({envs}). Opt-in openai-egress sends it only in the host-side E2B
//      header transform and passes an inert command placeholder. The proxy is spendable by every
//      sandbox process from creation; this protects the raw key, not provider spending.
//      Enforced in credentials.ts and runtime-auth.ts.
//   2. Fail-closed cap. The live key is never exercised without scenario.caps in force: maxUsd
//      (default/require 0 = no-spend) + maxMinutes (wall-clock kill of the codex command).
//      Enforced in plan.ts (caps required), live-sandbox.ts and lifetime.ts (the wall clock).
//   3. Public surfaces only. The mission references only subject.product.publicSurfaces + the
//      author mission. No clone and no private-source access: nothing is git-cloned on this route.
//      Enforced in session.ts, which composes the prompt.
//   4. Deny-by-default credentials. The command envs are built from an allowlist holding only the
//      declared runtime key; GITHUB_TOKEN/GH_TOKEN/payment/deploy/db/media keys are excluded by
//      construction (a banned-name guard also fails closed if one is ever requested).
//      Enforced in credentials.ts.
//   5. No secret values in evidence. Every captured byte (event stream, transcript, command logs,
//      agent report, metadata) passes scrubKnownValues (literal scrub of the runtime key + any
//      provisioned values, >=4 chars, before truncation), then redactText (shape patterns), before
//      persisting. The transport is labeled exec-stream/snapshot; there is no interactive pty.
//      Enforced in recorder.ts, with the scrubber session.ts builds.
//   6. Metadata positive allowlist. buildSandboxMetadata(allowlist) is the only way metadata is
//      set; it carries solely non-secret labels (mode/tool/labId/simId/provider/runId).
//      Enforced in credentials.ts.
//   7. Stdin disabled + interventions ledger. stdin is never wired to the codex command; the
//      bundle always carries an interventions ledger (empty array is valid + required-present).
//      Enforced in live-sandbox.ts (stdin) and recorder.ts (the ledger).
//   8. Proven cleanup, by id, never account-wide. Sandbox.kill(id) in a finally; the cleanup
//      proof is by exact id: kill(id)'s own found-and-killed boolean, confirmed further by
//      Sandbox.getInfo(id) when the SDK exposes it (a thrown SandboxNotFoundError means gone).
//      humanish never calls Sandbox.list to prove cleanup, so a shared operator key never reaches a
//      sandbox it did not create. A live run that cannot prove teardown fails closed.
//      Enforced in sandbox.ts.

import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { completeAutomaticAnalysis } from "../../analysis/automatic-completion.js";
import path from "node:path";
import { runScope, type FinishedRun, type RunScope } from "../../run/run.js";
import { planTerminalStudy, type TerminalRefusal } from "./plan.js";
import { runDryTerminalStudy } from "./dry-run.js";
import { checkLiveTerminalMachine, runLiveTerminalSession } from "./session.js";
import type { TerminalPlan } from "../../study/plan-types.js";
import { terminalRouteScorer } from "../../study/adapter-scorer-loader.js";
import { withLateScorer } from "../../study/route-inputs.js";
import type { AdmittedPlan } from "../../run-study.js";
import {
  type LiveTerminalAuth,
  type LiveTerminalPlan,
  type RunLiveTerminalSessionArgs,
  type RunTerminalProductStudyOptions,
  type TerminalProductStudyResult,
  type TerminalRunInput,
} from "./types.js";
import { studyResultIdentity } from "../../run/study-result.js";

/**
 * The config-taking entry point. It plans, returns a refusal with the same envelope and analysis
 * record the route has always returned, and otherwise runs the plan.
 */
export async function runTerminalProductStudy(
  options: RunTerminalProductStudyOptions,
): Promise<TerminalProductStudyResult> {
  const { config, dryRun, ...input } = options;
  const planned = planTerminalStudy(config, {
    dryRun,
    hasCostProbe: input.deps?.costProbe !== undefined,
  });
  if (planned.ok) return runTerminalPlan(planned.plan, input);
  return terminalStudyRefusal(options, planned.refusal);
}

/** A refused terminal study's result: the route's envelope, and the analysis record a refusal gets. */
export function terminalStudyRefusal(
  options: RunTerminalProductStudyOptions,
  refusal: TerminalRefusal,
): Promise<TerminalProductStudyResult> {
  const { config, dryRun } = options;
  const refused: TerminalProductStudyResult = {
    ...studyResultIdentity("terminal", config.id),
    ok: false,
    cwd: path.resolve(options.cwd),
    actor: refusal.actor ?? config.actors[0]?.type ?? "",
    product: config.subject.product?.name ?? "",
    dryRun,
    runId: options.runId ?? "not-created",
    warnings: [],
    error: { code: refusal.code, message: refusal.message },
  };
  // A refusal starts no run, so a declared or default analysis is recorded as skipped.
  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  return completeAutomaticAnalysis(
    refused,
    undefined,
    analysis.ok ? analysis.config : undefined,
    options,
    { trigger: config.review?.analysis === undefined ? "default" : "explicit" },
  );
}

/** A terminal plan past its local checks, with the warnings those checks wrote. */
type AdmittedTerminalRun =
  | { readonly plan: DryTerminalPlan; readonly warnings: string[] }
  | {
      readonly plan: LiveTerminalPlan;
      readonly warnings: string[];
      readonly runtimeEnv: LiveTerminalAuth;
    };

type DryTerminalPlan = Extract<TerminalPlan, { readonly dryRun: true }>;

/**
 * Run a terminal plan. The run scope gives a direct library caller the same run lifetime the CLI
 * gets: whichever of its fail-closed exits the run takes, the run it started is closed, and only a
 * run that published its final bundle reaches automatic analysis.
 */
export async function runTerminalPlan(
  plan: TerminalPlan,
  input: TerminalRunInput,
): Promise<TerminalProductStudyResult> {
  const admission = await admitTerminalRun(plan, input);
  return admission.ok ? runAdmittedTerminalRun(admission.admitted, input) : admission.result;
}

/**
 * runStudyWith's step for a terminal plan. It runs a live plan's local checks (checkLiveTerminalMachine)
 * before any run scope opens, so the CLI can present their refusal before it loads a declared
 * scorer, and returns the run that continues from them with that scorer.
 */
export async function admitTerminalPlan(
  plan: TerminalPlan,
  input: TerminalRunInput,
): Promise<AdmittedPlan<"terminal">> {
  const admission = await admitTerminalRun(plan, input);
  if (!admission.ok) return { ok: false, outcome: terminalOutcome(admission.result) };
  return {
    ok: true,
    run: async (scorer) =>
      terminalOutcome(
        await runAdmittedTerminalRun(
          admission.admitted,
          withLateScorer(input, scorer, terminalRouteScorer),
        ),
      ),
  };
}

function terminalOutcome(result: TerminalProductStudyResult) {
  return { route: "terminal", result } as const;
}

/**
 * A live plan's local checks, made outside any run scope. A refusal is the result runTerminalPlan
 * returns for it, with the analysis record of a run that never started.
 */
async function admitTerminalRun(
  plan: TerminalPlan,
  input: TerminalRunInput,
): Promise<
  | { readonly ok: false; readonly result: TerminalProductStudyResult }
  | { readonly ok: true; readonly admitted: AdmittedTerminalRun }
> {
  const warnings: string[] = [];
  if (plan.dryRun) return { ok: true, admitted: { plan, warnings } };
  const checked = checkLiveTerminalMachine(plan, input, warnings);
  if (checked.ok) return { ok: true, admitted: { plan, warnings, runtimeEnv: checked.runtimeEnv } };
  const refused = terminalFailure(plan, input, warnings)(checked.code, checked.message);
  return { ok: false, result: await completeTerminalAnalysis(plan, input, refused, undefined) };
}

/** Runs an admitted plan in its own run scope, then its automatic analysis. */
async function runAdmittedTerminalRun(
  admitted: AdmittedTerminalRun,
  input: TerminalRunInput,
): Promise<TerminalProductStudyResult> {
  const { result, finished } = await runScope((scope) =>
    runTerminalPlanInScope(admitted, input, scope),
  );
  return completeTerminalAnalysis(admitted.plan, input, result, finished);
}

function completeTerminalAnalysis(
  plan: TerminalPlan,
  input: TerminalRunInput,
  result: TerminalProductStudyResult,
  finished: FinishedRun | undefined,
): Promise<TerminalProductStudyResult> {
  return completeAutomaticAnalysis(result, finished, plan.analysis?.config, input, {
    ...(plan.analysis === undefined ? {} : { trigger: plan.analysis.trigger }),
    preferLargerOutput: plan.analysis?.preferLargerOutput === true,
  });
}

/** The route's envelope for a run that stops before its bundle. */
function terminalFailure(
  plan: TerminalPlan,
  input: TerminalRunInput,
  warnings: string[],
): RunLiveTerminalSessionArgs["failed"] {
  const cwd = path.resolve(input.cwd);
  return (code, message) => ({
    ...studyResultIdentity("terminal", plan.studyId),
    ok: false,
    cwd,
    actor: plan.actor,
    product: plan.product.name,
    dryRun: plan.dryRun,
    runId: input.runId ?? "not-created",
    warnings,
    error: { code, message },
  });
}

async function runTerminalPlanInScope(
  admitted: AdmittedTerminalRun,
  input: TerminalRunInput,
  scope: RunScope,
): Promise<TerminalProductStudyResult> {
  const cwd = path.resolve(input.cwd);
  const { warnings } = admitted;
  const failed = terminalFailure(admitted.plan, input, warnings);

  // Live path: the real in-sandbox agent session. A separate orchestrator owns the
  // create -> inject (command-scoped) -> run -> capture -> teardown lifecycle so the dry-run path
  // below stays a pure contract builder. It enforces the safety contract by construction (the
  // keyPlacement-routed command-scoped key, the deny-by-default allowlist, the fail-closed cap,
  // the proven cleanup) and fails closed before any sandbox/key/spend on any precondition miss.
  if ("runtimeEnv" in admitted) {
    const { plan, runtimeEnv } = admitted;
    return runLiveTerminalSession({ plan, input, cwd, warnings, failed, scope, runtimeEnv });
  }
  return runDryTerminalStudy({ plan: admitted.plan, input, cwd, warnings, failed, scope });
}
