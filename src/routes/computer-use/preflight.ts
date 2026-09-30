import { isHttpUrl, isLoopbackUrl, subjectStateInvalidReason } from "../../lab/parse-subject.js";
import type { LabCommsExternal, LabConfig, LabSubjectServe } from "../../lab/types.js";
import { DEFAULT_OPENAI_CU_MODEL } from "../../actors/computer-use/openai-provider.js";
import {
  checkHostedCodexCompatibility,
  detectLocalAgents,
  type LocalAgentId,
} from "../../actors/local-agent/cli.js";
import { describeMissingKeys } from "../../cli/key-resolution.js";
import { externalCatchHealthy } from "../../comms/sandbox-catch.js";
import { MODEL_RATES } from "../../run/pricing.js";
import {
  cuaLaneValidationReason,
  desktopMediaValidationReason,
  outputTokenLimitValidationReason,
  receivingEmailValidationReason,
} from "../../lab/validation.js";
import { defaultSessionTimeoutMs, resolvePerLaneSandboxMs } from "./lane-plan.js";
import { MAX_SANDBOX_MS, type CuaActorLabErrorCode, type CuaActorLabHooks } from "./types.js";

/** Which subject route a computer-use lab takes, derived once from its config and hooks. */
export interface CuaRoute {
  cloneRoute: boolean;
  /** A CLI studied at a desktop: nothing cloned, no browser, a terminal instead. */
  desktopCliRoute: boolean;
  localTreeRoute: boolean;
  /**
   * Clone and local-tree both provision the subject in-sandbox (clone via git, local-tree via
   * pack+upload) and share the install/build/state/start/probe pipeline, so every seam that gates
   * on "does this route provision a subject" is keyed on this union.
   */
  provisionedRoute: boolean;
  localAppSubject: boolean;
  /** A caller-supplied executor drives the subject in-process; no desktop is created. */
  inProcessRoute: boolean;
  serve: LabSubjectServe | undefined;
  appUrl: string;
  subjectRepo: string | undefined;
  subjectEnvNames: string[];
}

export function cuaRoute(config: LabConfig, hooks: CuaActorLabHooks): CuaRoute {
  const cloneRoute = config.subject.source === "clone";
  const localTreeRoute = config.subject.source === "local-tree";
  const provisionedRoute = cloneRoute || localTreeRoute;
  const serve = config.subject.serve;
  return {
    cloneRoute,
    desktopCliRoute: config.subject.source === "desktop-cli",
    localTreeRoute,
    provisionedRoute,
    localAppSubject: config.subject.source === "local-app",
    inProcessRoute: hooks.buildExecutor !== undefined,
    serve,
    appUrl: (provisionedRoute ? serve?.url : config.subject.appUrl) ?? "",
    subjectRepo: cloneRoute ? (config.subject.repos?.[0] ?? "") : undefined,
    subjectEnvNames: provisionedRoute ? (config.subject.env ?? []) : [],
  };
}

/**
 * The first reason a computer-use lab cannot start, checked before any sandbox, key or provider
 * is touched. The parser enforces most of these too; the engine repeats them for library callers
 * that hand it a config directly.
 */
export function cuaLabRejection(
  config: LabConfig,
  hooks: CuaActorLabHooks,
  route: CuaRoute,
): { code: CuaActorLabErrorCode; message: string } | undefined {
  const {
    cloneRoute,
    desktopCliRoute,
    localTreeRoute,
    provisionedRoute,
    localAppSubject,
    inProcessRoute,
    serve,
    appUrl,
    subjectRepo,
  } = route;
  const actor = config.actors[0];
  const mediaReason = desktopMediaValidationReason(config);
  if (mediaReason) return { code: "HUMANISH_CUA_LAB_SUBJECT_INVALID", message: mediaReason };
  const outputLimitReason = outputTokenLimitValidationReason(config);
  if (outputLimitReason)
    return { code: "HUMANISH_CUA_LAB_SUBJECT_INVALID", message: outputLimitReason };
  if (
    actor?.maxOutputTokens !== undefined &&
    (hooks.runSession || hooks.buildProvider || hooks.buildExecutor)
  ) {
    return {
      code: "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      message: "maxOutputTokens cannot be enforced by a custom runSession/provider/executor route.",
    };
  }
  const receivingReason = receivingEmailValidationReason(config);
  if (receivingReason)
    return { code: "HUMANISH_CUA_LAB_SUBJECT_INVALID", message: receivingReason };
  if (inProcessRoute && config.comms?.email?.kind === "real")
    return {
      code: "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      message: "Real email receiving requires hosted participant desktops.",
    };
  if (inProcessRoute && config.execution?.desktop?.media !== undefined) {
    return {
      code: "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      message:
        "execution.desktop.media is not provisioned by a caller-supplied executor. Remove the declaration or use a hosted computer-use browser lane.",
    };
  }
  if (inProcessRoute && config.execution?.desktop?.recording !== undefined) {
    return {
      code: "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      message: "execution.desktop.recording is not provisioned by a caller-supplied executor.",
    };
  }
  // Engine re-enforcement of the clone-route structure (library API surface).
  if (
    cloneRoute &&
    (!serve || !subjectRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(subjectRepo))
  ) {
    return {
      code: "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      message: !serve
        ? "clone subjects on the computer-use route require `subject.serve` (start + url) — the lab serves the app in-sandbox."
        : `subject.repos[0] must be an owner/repo slug (got "${subjectRepo ?? ""}").`,
    };
  }
  // Engine re-enforcement of the local-tree-route structure (library API surface): a caller
  // driving this function directly (bypassing parseLabConfig) still gets the same fail-closed
  // shape the parser enforces, naming which requirement is missing.
  if (localTreeRoute && (!serve || config.execution?.target !== "e2b-desktop")) {
    return {
      code: "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      message: !serve
        ? "local-tree subjects on the computer-use route require `subject.serve` (start + url): the lab packs and serves the working tree in-sandbox."
        : "local-tree subjects require `execution.target: e2b-desktop`: the packed working tree is provisioned and served inside a hosted desktop sandbox.",
    };
  }
  // Engine re-enforcement of the state declaration (library API surface).
  if (config.subject.state) {
    const stateReason = !provisionedRoute
      ? "`subject.state` applies only to clone subjects or local-tree subjects (the lab seeds the state it serves)."
      : subjectStateInvalidReason(config.subject.state, config.subject.env);
    if (stateReason) {
      return { code: "HUMANISH_CUA_LAB_SUBJECT_INVALID", message: stateReason };
    }
  }
  // Re-enforce the entry-target boundary (library API surface). A desktop-cli study has no entry
  // target at all — the subject is a program on the machine, not an address — so the boundary is
  // vacuous there rather than violated by an empty string.
  const allowPublicTargets = config.policies?.allowPublicTargets === true;
  const declaredTargets = [
    appUrl,
    ...(actor?.lanes ?? [])
      .map((lane) => lane.target)
      .filter((target): target is string => target !== undefined),
  ];
  const entryTargetSafe =
    desktopCliRoute ||
    declaredTargets.every((target) =>
      provisionedRoute || localAppSubject
        ? isLoopbackUrl(target)
        : allowPublicTargets
          ? isHttpUrl(target)
          : isLoopbackUrl(target),
    );
  if (!entryTargetSafe) {
    return {
      code: "HUMANISH_CUA_LAB_SUBJECT_UNSAFE",
      message:
        provisionedRoute || localAppSubject || !allowPublicTargets
          ? "subject.appUrl and any actors[0].lanes[].target entries must be loopback (127.0.0.1 or localhost) unless policies.allowPublicTargets is set for an app-url subject."
          : "subject.appUrl and actors[0].lanes[].target entries must be valid http(s) URLs.",
    };
  }
  // In-process route pairing guard (boot-time, BEFORE key-gating): a custom executor needs a
  // custom provider too (the default OpenAI provider is vision-based and would fail closed).
  if (hooks.buildExecutor !== undefined && hooks.buildProvider === undefined) {
    return {
      code: "HUMANISH_CUA_LAB_EXECUTOR_NO_PROVIDER",
      message:
        "cuaHooks.buildExecutor requires cuaHooks.buildProvider — a state-driven executor returns no screenshot, so it must be paired with a NON-vision provider (the default OpenAI computer-use provider is vision-based and would fail closed).",
    };
  }
  // local-app fail-closed (BEFORE key-gating): there is no built-in in-process driver.
  if (localAppSubject && !inProcessRoute) {
    return {
      code: "HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR",
      message:
        "subject.source: local-app requires a library caller to supply cuaHooks.buildExecutor + buildProvider; there is no built-in driver for an in-process JS contract. (Drive the app via runLab(..., { cuaHooks: { buildExecutor, buildProvider } }).)",
    };
  }
  if (
    config.subject.source === "app-url" &&
    config.execution?.target === "local" &&
    !hooks.createDesktopLane
  ) {
    return {
      code: "HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR",
      message: "Local browser studies require a configured local desktop runtime.",
    };
  }
  // Re-enforce the fan-out cross-validation (library API surface): lanes XOR count/laneFocus,
  // device XOR raw resolution, cap, unique ids, allowPublicTargets+N>1, clone.fanout.
  const fanoutReason = cuaLaneValidationReason(config);
  if (fanoutReason) {
    return { code: "HUMANISH_CUA_LAB_FANOUT_INVALID", message: fanoutReason };
  }
  // The sandbox deadline is DERIVED from the session budget, so a lab can ask for a session that
  // cannot legally be provisioned. Catch it here, before anything is created, and show the
  // arithmetic — the provider's own error names a limit but not which knob produced it.
  const derivedSandboxMs = resolvePerLaneSandboxMs(config);
  if (derivedSandboxMs > MAX_SANDBOX_MS) {
    const provisionedRoute =
      config.subject.source === "clone" || config.subject.source === "local-tree";
    const sessionMs = config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config);
    const headroomMs = derivedSandboxMs - sessionMs;
    return {
      code: "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      message: `execution.timeoutMs ${Math.round(sessionMs / 60_000)}m derives a ${Math.round(derivedSandboxMs / 60_000)}m sandbox deadline, and a sandbox may not live longer than ${MAX_SANDBOX_MS / 60_000}m. The deadline is the session budget plus ${Math.round(headroomMs / 60_000)}m of provisioning and teardown headroom${provisionedRoute ? " (this route clones, installs, builds and serves the subject before the actor starts)" : ""}. Lower execution.timeoutMs to at most ${Math.round((MAX_SANDBOX_MS - headroomMs) / 60_000)}m, or set execution.desktop.sandboxTimeoutMs explicitly.`,
    };
  }
  return undefined;
}

/**
 * The first reason a live computer-use run cannot start on this machine: missing keys, a missing
 * or signed-out local agent, missing subject env, a spend cap with no price, or an unreachable
 * external comms catch. Checked before any sandbox exists, because each one found later has
 * already paid for a desktop.
 */
export async function liveCuaRejection(args: {
  config: LabConfig;
  hooks: CuaActorLabHooks;
  env: Record<string, string | undefined>;
  openaiApiKey: string;
  e2bApiKey: string;
  localAgentRoute: boolean;
  preferredLocalAgent: LocalAgentId;
  subjectEnvNames: string[];
  externalCommsConfig: LabCommsExternal | undefined;
}): Promise<{ code: CuaActorLabErrorCode; message: string } | undefined> {
  const {
    config,
    hooks,
    env,
    openaiApiKey,
    e2bApiKey,
    localAgentRoute,
    preferredLocalAgent,
    subjectEnvNames,
    externalCommsConfig,
  } = args;
  const missingKeys = [
    ...(openaiApiKey || localAgentRoute || hooks.buildProvider ? [] : ["OPENAI_API_KEY"]),
    ...(e2bApiKey || hooks.createDesktopLane ? [] : ["E2B_API_KEY"]),
  ];
  if (missingKeys.length > 0) {
    // The moment someone new actually hits the wall. If a signed-in coding agent is sitting
    // right there, say so HERE rather than making them go and find an API key — that detour is
    // where most people trying humanish stop.
    const suggestion = missingKeys.includes("OPENAI_API_KEY")
      ? await (async () => {
          const ready = (await detectLocalAgents({ env })).filter(
            (agent) => agent.authStatus === "authenticated",
          );
          return ready.length === 0
            ? ""
            : ` ${ready.map((agent) => agent.label).join(" and ")} reports authenticated on this machine` +
                ` — set actors[0].type: local-agent to use ${ready.length === 1 ? "it" : "one"} instead of a key.`;
        })()
      : "";
    return {
      code: "HUMANISH_CUA_LAB_KEYS_MISSING",
      message: `Live computer-use labs need ${missingKeys.join(" and ")} in the environment (values are never persisted). ${describeMissingKeys(missingKeys, env)}${suggestion}`,
    };
  }
  if (localAgentRoute && !hooks.buildProvider) {
    // Refuse HERE, before a sandbox exists. "codex is not installed" discovered after the
    // machine is paid for is the same information delivered at the worst possible moment.
    const available = await detectLocalAgents({ env });
    const chosen = available.find((agent) => agent.id === preferredLocalAgent);
    if (chosen === undefined) {
      return {
        code: "HUMANISH_CUA_LAB_KEYS_MISSING",
        message:
          `actors[0].type: local-agent needs the ${preferredLocalAgent} CLI on PATH and signed in. ` +
          `Install it, or set OPENAI_API_KEY and use actors[0].type: openai-computer-use instead.`,
      };
    }
    if (chosen.authStatus !== "authenticated") {
      return {
        code: "HUMANISH_CUA_LAB_KEYS_MISSING",
        message:
          chosen.authStatus === "unauthenticated"
            ? `${chosen.label} reports not signed in — run \`${chosen.id === "codex" ? "codex login" : "claude auth login"}\`, then retry.`
            : `${chosen.label} authentication status could not be checked. Run \`${chosen.id === "codex" ? "codex login status" : "claude auth status"}\` and update the CLI if needed. No desktop was launched.`,
      };
    }
    if (chosen.id === "codex") {
      const compatibility = await checkHostedCodexCompatibility(chosen.binPath, { env });
      if (compatibility !== "supported") {
        return {
          code: "HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED",
          message:
            compatibility === "unsupported_platform"
              ? `Hosted Codex participants require Linux or macOS on x64 or arm64. This host is ${process.platform}/${process.arch}; no desktop was launched.`
              : `Hosted Codex participants require Codex CLI 0.154.0. Run \`codex --version\` and install the supported version before retrying; no desktop was launched.`,
        };
      }
      if (
        chosen.billing === "account-unknown" &&
        (config.execution?.caps?.maxUsd !== undefined ||
          config.execution?.caps?.maxTotalUsd !== undefined)
      ) {
        return {
          code: "HUMANISH_CUA_LAB_UNPRICED_CAP",
          message:
            "A ChatGPT-account Codex participant has no API-dollar price, so execution.caps.maxUsd/maxTotalUsd cannot be enforced. Remove the dollar cap and use finite execution timeout/step limits, or use an API-backed participant; no desktop was launched.",
        };
      }
    }
  }
  const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
  if (missingSubjectEnv.length > 0) {
    return {
      code: "HUMANISH_CUA_LAB_SUBJECT_ENV_MISSING",
      message: `subject.env declares ${missingSubjectEnv.join(", ")} but the environment does not provide ${missingSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`,
    };
  }
  // FAIL-CLOSED CAP TENSION (discipline #3): a maxUsd cap needs a MEASURABLE per-turn estimate.
  // If the operator set execution.caps.maxUsd but src/run/pricing.ts has no rate for the resolved
  // model, the loop could not enforce the cap — and silently running uncapped would break the
  // runaway-retry protection. Refuse at PREFLIGHT (before any sandbox/spend) rather than run
  // uncapped: an unenforceable cap is more dangerous than none. The operator adds a rate to
  // src/run/pricing.ts (the honest place) or removes the cap.
  if (
    config.execution?.caps?.maxUsd !== undefined ||
    config.execution?.caps?.maxTotalUsd !== undefined
  ) {
    const capModelId = (config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL).trim().toLowerCase();
    if (!MODEL_RATES[capModelId]) {
      return {
        code: "HUMANISH_CUA_LAB_UNPRICED_CAP",
        message: `execution.caps declares a spend cap (maxUsd/maxTotalUsd) but src/run/pricing.ts has no rate for model "${config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL}"; add a rate or remove the cap — an unenforceable cap is refused rather than run uncapped.`,
      };
    }
  }
  // Adopter-hosted comms catch (#380): fail closed BEFORE any sandbox is created — a comms lab
  // whose catch is unreachable collects nothing while every lane still spends. The probe asserts
  // OUR service marker in /health, so an adopter's proxy answering 200 for everything cannot
  // pass for a catch.
  if (externalCommsConfig && !(await externalCatchHealthy(externalCommsConfig))) {
    return {
      code: "HUMANISH_CUA_LAB_COMMS_CATCH_UNREACHABLE",
      message:
        "The external comms catch or inbox is unreachable or incompatible (GET /health must identify humanish-comms-catch and advertise recipient-inbox-v1). Update Humanish on the catch host and restart it with `humanish comms catch` on that host, or drop comms.email to run without the inbox funnel.",
    };
  }
  return undefined;
}
