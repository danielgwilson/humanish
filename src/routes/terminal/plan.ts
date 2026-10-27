// The terminal route's plan: every configuration refusal the route makes before a run starts, in
// its order and with its codes, then the plan the run uses. The route checks nothing here again;
// what stays in the route reads external state (keys, the runtime env, the sandbox).

import { DEFAULT_CODEX_MODEL } from "../../actors/computer-use/openai-provider.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { isReasoningEffort } from "../../actors/reasoning-effort.js";
import { actorRegistry, isTerminalActorDescriptor } from "../../actors/registry.js";
import { isNonEmpty, planBase } from "../../study/plan-base.js";
import type {
  Requirement,
  RoutePlanResult,
  RouteRefusal,
  TerminalPlan,
} from "../../study/plan-types.js";
import { studyUrlCredentialReason } from "../../study/url-credentials.js";
import type { StudyConfig } from "../../study/types.js";
import type { SandboxProviderId } from "../../run/sandbox-receipts.js";
import {
  desktopMediaValidationReason,
  networkCaptureValidationReason,
  taskProtocolValidationReason,
} from "../../study/validation.js";
import { ceilingAdvice, type SandboxCeiling } from "../../substrates/e2b/lifetime.js";
import {
  MODAL_MAX_SANDBOX_MS,
  MODAL_TOKEN_ID_ENV,
  MODAL_TOKEN_SECRET_ENV,
} from "../../substrates/modal/sdk.js";
import { NODE_BOOTSTRAP_TIMEOUT_MS } from "../../subject/node-bootstrap.js";
import { TERMINAL_RUNTIME_KEY_NAMES } from "./credentials.js";
import { terminalSandboxTimeoutMs } from "./lifetime.js";
import { isExactRuntimeVersion, TERMINAL_RUNTIME_VERSION_TIMEOUT_MS } from "./runtime.js";
import {
  PRODUCT_SETUP_TIMEOUT_MS,
  TERMINAL_SANDBOX_TIMEOUT_BUFFER_MS,
  type TerminalProductStudyResult,
} from "./types.js";

/** The error a terminal study returns before a run starts. `actor` names the registered actor. */
export interface TerminalRefusal extends RouteRefusal<
  "terminal",
  NonNullable<TerminalProductStudyResult["error"]>["code"]
> {
  readonly actor?: string;
}

export type TerminalPlanResult = RoutePlanResult<TerminalPlan, TerminalRefusal>;

/**
 * Plan a terminal-product study. It is called for any config handed to the terminal runner, not
 * only one routeOf sends here, so a config for another route gets this route's refusal.
 */
export function planTerminalStudy(
  config: StudyConfig,
  input: {
    readonly dryRun: boolean;
    /** A test's costProbe can measure spend lines, so a positive maxUsd can trip. */
    readonly hasCostProbe?: boolean;
    /** The longest sandbox lifetime the operator's E2B plan allows (sandboxCeiling). */
    readonly sandboxCeiling: SandboxCeiling;
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
      "Real email receiving is unsupported on the terminal route. Use a supported hosted computer-use browser study.",
    );
  const mediaReason =
    desktopMediaValidationReason(config) ?? networkCaptureValidationReason(config, "terminal");
  if (mediaReason) return refuse("HUMANISH_TERMINAL_SUBJECT_INVALID", mediaReason);
  // A library caller's config skips the parser, which refuses these first.
  const credential = studyUrlCredentialReason(config);
  if (credential) return refuse("HUMANISH_TERMINAL_SUBJECT_INVALID", credential);
  const runtimeAuth: unknown = config.execution?.runtimeAuth;
  if (runtimeAuth !== undefined && runtimeAuth !== "openai-egress" && runtimeAuth !== "openai-env")
    return refuse(
      "HUMANISH_TERMINAL_CREDENTIAL_DENIED",
      "`execution.runtimeAuth` must be openai-egress or openai-env. Leave it out for openai-egress, which keeps the OpenAI key outside the sandbox.",
    );
  const sandboxProvider: SandboxProviderId =
    config.execution?.target === "modal-terminal" ? "modal" : "e2b";
  const modal = sandboxProvider === "modal" ? modalRefusal(config) : undefined;
  if (modal !== undefined) return refuse(modal.code, modal.message);
  const analysis = resolveAutomaticAnalysis(config.review?.analysis, config.actor);
  if (!analysis.ok) return refuse("HUMANISH_STUDY_ANALYSIS_INVALID", analysis.message);
  const tasksReason = taskProtocolValidationReason(config, false);
  if (tasksReason) return refuse("HUMANISH_STUDY_TASKS_UNSUPPORTED", tasksReason);

  const actorType = config.actor?.type ?? "";
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isTerminalActorDescriptor(descriptor))
    return refuse(
      "HUMANISH_TERMINAL_ACTOR_UNSUPPORTED",
      `actor.type "${actorType}" is not a registered terminal actor.`,
    );

  const runtimeVersion = config.execution?.runtime?.version;
  const actor = config.actor;
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
    sandboxProvider,
    actor: descriptor.id,
    product: { ...product, publicSurfaces: surfaces },
    ...(actor?.persona === undefined ? {} : { personaId: actor.persona }),
    ...(actor?.mission === undefined ? {} : { mission: actor.mission }),
    runtime: {
      doNotTrack: config.execution?.terminal?.doNotTrack !== false,
      ...(runtimeVersion === undefined ? {} : { version: runtimeVersion }),
      // Codex's own default can change with any release and its JSON stream does not name it, so
      // the route always passes a model: the declared one, else humanish's participant default.
      ...(actor?.model === undefined
        ? { model: DEFAULT_CODEX_MODEL, modelSource: "humanish_default" as const }
        : { model: actor.model, modelSource: "declared" as const }),
      ...(actor?.reasoningEffort === undefined ? {} : { reasoningEffort: actor.reasoningEffort }),
      ...(config.execution?.runtimeAuth === undefined
        ? {}
        : { auth: config.execution.runtimeAuth }),
    },
    ...(egressAllow === undefined ? {} : { egressAllow }),
    ...(stdin === undefined ? {} : { stdin }),
  };
  const caps = config.caps;
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
      "A live terminal-product run gives the agent in the sandbox access to a model provider, so it needs a cap: set caps with maxUsd (0 means no spend) and a positive maxMinutes (the time limit for the codex command). The key is used only while the cap is in force.",
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
      `caps.maxUsd=${maxUsd} cannot be enforced: Codex reports no provider cost for the participant (its token cost is only estimated after the run) and no product, media or payment spend is measured, so a positive dollar cap can never trip. Set caps.maxUsd to 0 and bound the run with caps.maxMinutes, the codex command's wall-clock kill. No sandbox was created and the runtime key was not used.`,
      descriptor.id,
    );
  // The sandbox's timeout covers the steps before the codex command, maxMinutes and the teardown
  // buffer, and E2B refuses a sandbox past the plan's ceiling. Refuse here, with the arithmetic,
  // rather than after the plan prints, from a provider 400 that names neither knob.
  const ceiling: SandboxCeiling =
    sandboxProvider === "modal"
      ? { ok: true, ms: MODAL_MAX_SANDBOX_MS, source: "default" }
      : input.sandboxCeiling;
  if (!ceiling.ok) return refuse("HUMANISH_TERMINAL_CAPS_INVALID", ceiling.message, descriptor.id);
  const productInstall = shared.product.install !== undefined;
  const sandboxTimeoutMs = terminalSandboxTimeoutMs({ maxMinutes, productInstall });
  if (sandboxTimeoutMs > ceiling.ms) {
    const headroomMinutes = (sandboxTimeoutMs - maxMinutes * 60_000) / 60_000;
    return refuse(
      "HUMANISH_TERMINAL_CAPS_INVALID",
      `caps.maxMinutes ${maxMinutes} derives a ${sandboxTimeoutMs / 60_000}m sandbox deadline, and a sandbox may not live longer than ${ceiling.ms / 60_000}m. The deadline is maxMinutes plus ${headroomMinutes}m: the Node bootstrap (${NODE_BOOTSTRAP_TIMEOUT_MS / 60_000}m), the runtime version check (${TERMINAL_RUNTIME_VERSION_TIMEOUT_MS / 60_000}m)${productInstall ? `, the product setup (${PRODUCT_SETUP_TIMEOUT_MS / 60_000}m)` : ""} and the teardown buffer (${TERMINAL_SANDBOX_TIMEOUT_BUFFER_MS / 60_000}m). Lower caps.maxMinutes to at most ${ceiling.ms / 60_000 - headroomMinutes}.${sandboxProvider === "modal" ? " Modal ends every sandbox after 24 hours." : ceilingAdvice(sandboxTimeoutMs)} No sandbox was created and the runtime key was not used.`,
      descriptor.id,
    );
  }
  return {
    ok: true,
    plan: {
      ...shared,
      dryRun: false,
      caps: { ...caps, maxUsd, maxMinutes },
      requirements: liveRequirements(sandboxProvider),
    },
  };
}

/** The sandbox provider's keys, then the runtime key the agent's command gets. */
function liveRequirements(provider: SandboxProviderId): Requirement[] {
  return [
    ...(provider === "modal"
      ? ([
          { kind: "key", name: MODAL_TOKEN_ID_ENV },
          { kind: "key", name: MODAL_TOKEN_SECRET_ENV },
        ] as const)
      : ([{ kind: "key", name: "E2B_API_KEY" }] as const)),
    { kind: "key-one-of", names: TERMINAL_RUNTIME_KEY_NAMES },
  ];
}

/** What a terminal study on Modal cannot have that one on E2B can. */
function modalRefusal(
  config: StudyConfig,
): { code: TerminalRefusal["code"]; message: string } | undefined {
  // E2B adds the key to requests at its egress proxy for each sandbox. Modal does that only from a
  // Secret stored in the operator's workspace, so humanish does not place the key there itself.
  if (config.execution?.runtimeAuth !== "openai-env")
    return {
      code: "HUMANISH_TERMINAL_CREDENTIAL_DENIED",
      message:
        "On Modal, humanish cannot keep the OpenAI key outside the sandbox: Modal adds a key to outbound requests only from a Secret stored in your Modal workspace. Set `execution.runtimeAuth: openai-env`, which passes the key to the codex command only, or use `execution.target: e2b-terminal`.",
    };
  const egress = modalEgressReason(config.execution?.egressAllow);
  return egress === undefined
    ? undefined
    : { code: "HUMANISH_TERMINAL_SUBJECT_INVALID", message: egress };
}

const CIDR = /^[0-9a-f:.]+\/\d{1,3}$/i;

/**
 * Why a declared egress allowlist cannot run on Modal, or undefined when it can. Modal limits
 * egress to listed domains or CIDR ranges; an entry that is neither, such as a bare IP address,
 * has no Modal form.
 */
function modalEgressReason(egressAllow: readonly string[] | undefined): string | undefined {
  const unsupported = (egressAllow ?? []).filter(
    (entry) =>
      !CIDR.test(entry) && !/^(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]*[a-z][a-z0-9-]*$/i.test(entry),
  );
  return unsupported.length === 0
    ? undefined
    : `Modal limits egress to domain names and CIDR ranges, and \`execution.egressAllow\` lists ${unsupported.map((entry) => `"${entry}"`).join(", ")}. Write a bare address as a /32 range, or use \`execution.target: e2b-terminal\`.`;
}
