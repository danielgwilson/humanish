// The terminal route's plan: every configuration refusal the route makes before a run starts, in
// its order and with its codes, then the plan the run uses. The route checks nothing here again;
// what stays in the route reads external state (keys, the runtime env, the sandbox).

import { DEFAULT_OPENAI_CU_MODEL } from "../../actors/computer-use/openai-provider.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { isReasoningEffort } from "../../actors/reasoning-effort.js";
import { actorRegistry, isTerminalActorDescriptor } from "../../actors/registry.js";
import { isNonEmpty, planBase } from "../../study/plan-base.js";
import type { RoutePlanResult, RouteRefusal, TerminalPlan } from "../../study/plan-types.js";
import type { StudyConfig } from "../../study/types.js";
import {
  desktopMediaValidationReason,
  taskProtocolValidationReason,
} from "../../study/validation.js";
import { MAX_SANDBOX_MS } from "../../substrates/e2b/lifetime.js";
import { NODE_BOOTSTRAP_TIMEOUT_MS } from "../../subject/node-bootstrap.js";
import { terminalSandboxTimeoutMs } from "./lifetime.js";
import { isExactRuntimeVersion, TERMINAL_RUNTIME_VERSION_TIMEOUT_MS } from "./runtime.js";
import {
  PRODUCT_SETUP_TIMEOUT_MS,
  TERMINAL_SANDBOX_TIMEOUT_BUFFER_MS,
  type TerminalProductStudyResult,
} from "./types.js";

/** The error a terminal lab returns before a run starts. `actor` names the registered actor. */
export interface TerminalRefusal extends RouteRefusal<
  "terminal",
  NonNullable<TerminalProductStudyResult["error"]>["code"]
> {
  readonly actor?: string;
}

export type TerminalPlanResult = RoutePlanResult<TerminalPlan, TerminalRefusal>;

/**
 * Plan a terminal-product lab. It is called for any config handed to the terminal runner, not
 * only one routeOf sends here, so a config for another route gets this route's refusal.
 */
export function planTerminalStudy(
  config: StudyConfig,
  input: {
    readonly dryRun: boolean;
    /** A test's costProbe can measure spend lines, so a positive maxUsd can trip. */
    readonly hasCostProbe?: boolean;
  },
): TerminalPlanResult {
  const refuse = (
    code: TerminalRefusal["code"],
    message: string,
    actor?: string,
  ): TerminalPlanResult => ({
    ok: false,
    refusal: { route: "terminal", code, message, ...(actor === undefined ? {} : { actor }) },
  });

  if (String(config.comms?.email?.kind) === "real")
    return refuse(
      "HUMANISH_TERMINAL_SUBJECT_INVALID",
      "Real email receiving is unsupported on the terminal route. Use a supported hosted computer-use browser lab.",
    );
  const mediaReason = desktopMediaValidationReason(config);
  if (mediaReason) return refuse("HUMANISH_TERMINAL_SUBJECT_INVALID", mediaReason);
  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  if (!analysis.ok) return refuse("HUMANISH_STUDY_ANALYSIS_INVALID", analysis.message);
  const tasksReason = taskProtocolValidationReason(config, false);
  if (tasksReason) return refuse("HUMANISH_STUDY_TASKS_UNSUPPORTED", tasksReason);

  const actorType = config.actors[0]?.type ?? "";
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isTerminalActorDescriptor(descriptor))
    return refuse(
      "HUMANISH_TERMINAL_ACTOR_UNSUPPORTED",
      `actors[0].type "${actorType}" is not a registered terminal actor.`,
    );

  const runtimeVersion = config.execution?.runtime?.version;
  const actor = config.actors[0];
  if (
    (config.execution?.runtime !== undefined && !isExactRuntimeVersion(runtimeVersion)) ||
    (actor?.model !== undefined &&
      (typeof actor.model !== "string" || actor.model.trim().length === 0)) ||
    (actor?.reasoningEffort !== undefined && !isReasoningEffort(actor.reasoningEffort))
  )
    return refuse(
      "HUMANISH_TERMINAL_FAILED",
      "Terminal runtime settings require an exact Codex version, a nonempty model when declared, and a supported reasoning-effort value.",
    );

  const product = config.subject.product;
  const surfaces = product?.publicSurfaces ?? [];
  if (!product || !product.name || !isNonEmpty(surfaces))
    return refuse(
      "HUMANISH_TERMINAL_SUBJECT_INVALID",
      "terminal-product subjects require `subject.product` with a name and at least one public surface URL.",
      descriptor.id,
    );

  const base = planBase(config, {
    dryRun: input.dryRun,
    analysis,
  });
  const egressAllow = config.execution?.egressAllow;
  const stdin = config.execution?.terminal?.stdin;
  const shared = {
    ...base,
    route: "terminal" as const,
    actor: descriptor.id,
    product: { ...product, publicSurfaces: surfaces },
    ...(actor?.persona === undefined ? {} : { personaId: actor.persona }),
    ...(actor?.mission === undefined ? {} : { mission: actor.mission }),
    runtime: {
      ...(runtimeVersion === undefined ? {} : { version: runtimeVersion }),
      // Codex's own default can change with any release and its JSON stream does not name it, so
      // the route always passes a model: the declared one, else humanish's participant default.
      ...(actor?.model === undefined
        ? { model: DEFAULT_OPENAI_CU_MODEL, modelSource: "humanish_default" as const }
        : { model: actor.model, modelSource: "declared" as const }),
      ...(actor?.reasoningEffort === undefined ? {} : { reasoningEffort: actor.reasoningEffort }),
      ...(config.execution?.runtimeAuth === undefined
        ? {}
        : { auth: config.execution.runtimeAuth }),
    },
    ...(egressAllow === undefined ? {} : { egressAllow }),
    ...(stdin === undefined ? {} : { stdin }),
  };
  const caps = config.scenario?.caps;
  if (input.dryRun)
    return { ok: true, plan: { ...shared, dryRun: true, ...(caps ? { caps } : {}) } };

  // The live route injects the runtime key into one command only, and only a registered actor
  // that declares that placement may run live.
  const keyPlacement = descriptor.capabilities.keyPlacement;
  if (keyPlacement !== "in-sandbox-command-scoped")
    return refuse(
      "HUMANISH_TERMINAL_KEYPLACEMENT_INVALID",
      `Terminal actor "${descriptor.id}" must declare keyPlacement "in-sandbox-command-scoped" for a live run (got "${String(keyPlacement)}"). The engine requires this registered default before applying the declared runtime-auth mode.`,
      descriptor.id,
    );
  // A live run grants the in-sandbox agent provider access, so a fail-closed cap must be in force.
  const maxUsd = caps?.maxUsd;
  const maxMinutes = caps?.maxMinutes;
  if (caps === undefined || maxUsd === undefined || maxMinutes === undefined || maxMinutes <= 0)
    return refuse(
      "HUMANISH_TERMINAL_CAPS_MISSING",
      "A live terminal-product run gives the agent in the sandbox access to a model provider, so it needs a cap: set scenario.caps with maxUsd (0 means no spend) and a positive maxMinutes (the time limit for the codex command). The key is used only while the cap is in force.",
      descriptor.id,
    );
  // maxUsd is checked against the cost ledger after the session, and only known lines can trip it.
  // The ledger's provider line takes only provider-reported cost, which Codex does not report (the
  // token estimate in run.json is not a measurement), and core has no product, media or payment
  // signal, so without a costProbe every line is null and a positive maxUsd could never trip. That
  // cap would promise a bound nothing enforces, so it is refused; maxMinutes bounds a live run.
  if (maxUsd > 0 && input.hasCostProbe !== true)
    return refuse(
      "HUMANISH_TERMINAL_UNPRICED_CAP",
      `scenario.caps.maxUsd=${maxUsd} cannot be enforced: Codex reports no provider cost for the participant (its token cost is only estimated after the run) and no product, media or payment spend is measured, so a positive dollar cap can never trip. Set scenario.caps.maxUsd to 0 and bound the run with scenario.caps.maxMinutes, the codex command's wall-clock kill. No sandbox was created and the runtime key was not used.`,
      descriptor.id,
    );
  // The sandbox's timeout covers the steps before the codex command, maxMinutes and the teardown
  // buffer, and E2B refuses a sandbox over an hour. Refuse here, with the arithmetic, rather than
  // after the plan prints, from a provider 400 that names neither knob.
  const productInstall = shared.product.install !== undefined;
  const sandboxTimeoutMs = terminalSandboxTimeoutMs({ maxMinutes, productInstall });
  if (sandboxTimeoutMs > MAX_SANDBOX_MS) {
    const headroomMinutes = (sandboxTimeoutMs - maxMinutes * 60_000) / 60_000;
    return refuse(
      "HUMANISH_TERMINAL_CAPS_INVALID",
      `scenario.caps.maxMinutes ${maxMinutes} derives a ${sandboxTimeoutMs / 60_000}m sandbox deadline, and a sandbox may not live longer than ${MAX_SANDBOX_MS / 60_000}m. The deadline is maxMinutes plus ${headroomMinutes}m: the Node bootstrap (${NODE_BOOTSTRAP_TIMEOUT_MS / 60_000}m), the runtime version check (${TERMINAL_RUNTIME_VERSION_TIMEOUT_MS / 60_000}m)${productInstall ? `, the product setup (${PRODUCT_SETUP_TIMEOUT_MS / 60_000}m)` : ""} and the teardown buffer (${TERMINAL_SANDBOX_TIMEOUT_BUFFER_MS / 60_000}m). Lower scenario.caps.maxMinutes to at most ${MAX_SANDBOX_MS / 60_000 - headroomMinutes}. No sandbox was created and the runtime key was not used.`,
      descriptor.id,
    );
  }
  return {
    ok: true,
    plan: {
      ...shared,
      dryRun: false,
      caps: { ...caps, maxUsd, maxMinutes },
      requirements: [
        { kind: "key", name: "E2B_API_KEY" },
        { kind: "key-one-of", names: ["CODEX_API_KEY", "OPENAI_API_KEY"] },
      ],
    },
  };
}
