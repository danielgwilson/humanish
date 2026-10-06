// The terminal route's dry run: a contract-only bundle with the persona and prompt digest bound,
// published through the run scope with no sandbox, key or spend. session.ts holds the live path.

import type { ActorPersonaRef } from "../../actors/contract.js";
import { digestText, redactText } from "../../evidence/redaction.js";
import { participantAssignment } from "../../study/participant-assignment.js";
import type { TerminalPlan } from "../../study/plan-types.js";
import { type RunEvent } from "../../run/bundle.js";
import { judgeExecution, judgeTerminal, OUTCOME_POLICIES, resultOk } from "../../run/judge.js";
import { validatePreparedRunArtifactPaths } from "../../run/paths.js";
import type { RunScope } from "../../run/run.js";
import { RunSecrets } from "../../run/secrets.js";
import { buildTerminalProductBundle, renderTerminalReviewMarkdown } from "./bundle.js";
import { resolveTerminalPersona, terminalPersonaRef } from "./persona.js";
import { declaredRuntimeProvenance } from "./runtime.js";
import { defaultMission } from "./session.js";
import {
  type RunLiveTerminalSessionArgs,
  type TerminalProductStudyResult,
  type TerminalRunInput,
} from "./types.js";
import { studyResultIdentity } from "../../run/study-result.js";

/**
 * The dry-run path: a contract bundle with the persona and prompt digest bound, published through
 * the run scope with no sandbox, key or spend.
 */
export async function runDryTerminalStudy(args: {
  plan: Extract<TerminalPlan, { readonly dryRun: true }>;
  input: TerminalRunInput;
  cwd: string;
  warnings: string[];
  failed: RunLiveTerminalSessionArgs["failed"];
  scope: RunScope;
}): Promise<TerminalProductStudyResult> {
  const { plan, input, cwd, warnings, failed, scope } = args;
  const { product } = plan;
  const { evidenceMission, physicalCwd, persona, secrets } = await prepareDryPersona({
    plan,
    cwd,
    env: input.env ?? process.env,
    warnings,
  });

  const started = await scope.startRun(plan, input, {
    cwd: physicalCwd,
    prefix: "terminal",
    renderReview: renderTerminalReviewMarkdown,
    secrets,
  });
  if (!started.ok) return failed(started.code, started.message);
  const { run } = started;
  const { runId, createdAt, source } = run;

  const policies = plan.residual.policies;
  const judgment = judgeTerminal({ dryRun: true, participant: undefined });
  const bundle = buildTerminalProductBundle({
    run,
    actorId: plan.actor,
    dryRun: true,
    studyId: plan.studyId,
    ...(plan.title ? { studyTitle: plan.title } : {}),
    mission: evidenceMission,
    persona,
    productName: product.name,
    publicSurfaces: product.publicSurfaces,
    ...(plan.caps ? { caps: plan.caps } : {}),
    ...(plan.runtime.auth ? { runtimeAuth: plan.runtime.auth } : {}),
    stdin: plan.stdin ?? "disabled",
    policies: {
      allowPrivateRepoAccess: policies?.allowPrivateRepoAccess ?? false,
      allowProviderCredentials: policies?.allowProviderCredentials ?? false,
      allowPaymentCredentials: policies?.allowPaymentCredentials ?? false,
      allowGitHubMutation: policies?.allowGitHubMutation ?? false,
    },
    source,
    verdict: judgment.verdict,
  });
  bundle.events.push(runtimeDeclaredEvent(plan.runtime, createdAt));

  const policy = OUTCOME_POLICIES.terminal;
  const execution = judgeExecution([], policy);
  const finished = await run.finish(bundle, {
    ok: resultOk({ judgment, execution, scorerFailures: [], policy }),
    execution,
    policy,
  });
  const observer = await finished.renderObserver();
  await validatePreparedRunArtifactPaths(finished.paths);
  const { ok } = finished.outcome;

  return {
    ...studyResultIdentity("terminal", plan.studyId),
    ok,
    cwd,
    actor: plan.actor,
    product: product.name,
    dryRun: true,
    runId,
    observer,
    warnings: [...warnings, ...observer.warnings],
    ...(ok
      ? {}
      : {
          error: {
            code: "HUMANISH_TERMINAL_FAILED" as const,
            message: observer.error?.message ?? "Observer failed for the terminal-product run.",
          },
        }),
  };
}

/**
 * The persona and prompt digest a dry run records: the author mission with known key values
 * scrubbed, and the committed persona's traits and brief.
 */
async function prepareDryPersona(args: {
  plan: TerminalPlan;
  cwd: string;
  env: Record<string, string | undefined>;
  warnings: string[];
}): Promise<{
  evidenceMission: string;
  physicalCwd: string;
  persona: ActorPersonaRef;
  secrets: RunSecrets;
}> {
  const { plan, cwd, env, warnings } = args;
  const { product } = plan;
  const mission = plan.mission ?? defaultMission(product.name);
  // A dry run checks no key, so it scrubs every key the live run could read.
  const secrets = new RunSecrets(
    [env.CODEX_API_KEY, env.OPENAI_API_KEY, env.E2B_API_KEY].map((value) => value?.trim() ?? ""),
  );
  const evidenceMission = participantAssignment({ mission }, secrets.scrub).mission;
  const terminalPersona = await resolveTerminalPersona({ plan, cwd, warnings });
  // The composed prompt = mission + persona + public-surface manifest. Only the author mission
  // goes plaintext into evidence (it is public-safe committed study text); the full composed prompt
  // is recorded as a digest (the safety contract's mission ruling).
  const composedPrompt = composePrompt({
    mission,
    personaLine: terminalPersona.personaLine,
    productName: product.name,
    publicSurfaces: product.publicSurfaces,
  });
  const persona = terminalPersonaRef(terminalPersona, digestText(composedPrompt), secrets.scrub);
  const { physicalCwd } = terminalPersona;
  return { evidenceMission, physicalCwd, persona, secrets };
}

/** The declared runtime provenance as a dry-run event; nothing is observed without a sandbox. */
function runtimeDeclaredEvent(runtime: TerminalPlan["runtime"], createdAt: string): RunEvent {
  const { version, model, modelSource, reasoningEffort } = runtime;
  return {
    id: "event-terminal-runtime-declared",
    at: createdAt,
    level: "info",
    type: "terminal-lab.runtime.declared",
    message: redactText(
      JSON.stringify(
        declaredRuntimeProvenance({
          ...(version === undefined ? {} : { version }),
          model,
          modelSource,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        }),
      ),
    ),
  };
}

/** Compose the full prompt the agent would run. Bound to evidence by digest only. */
export function composePrompt(args: {
  mission: string;
  personaLine: string;
  productName: string;
  publicSurfaces: readonly string[];
}): string {
  return [
    args.personaLine,
    `product: ${args.productName}`,
    `public-surfaces: ${args.publicSurfaces.join(" ")}`,
    `mission: ${args.mission}`,
  ].join("\n");
}
