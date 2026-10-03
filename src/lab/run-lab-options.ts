// The typed homes on RunLabOptions. runLab calls normalizeRunLabOptions first: it refuses an option
// the route cannot honor and otherwise passes the typed options to the route, with env copied and
// onEvent turned into the emitter. The package's runLab refuses the removed bags
// (removedOptionRefusal).

import path from "node:path";

import { isLocalBrowserLab } from "../substrates/local/runtime-config.js";
import type { InternalRunLabOptions, LabOutcome, RunLabOptions } from "../run-lab.js";
import { resolveLabDryRun, type LabRoute } from "./plan.js";
import type { LabConfig } from "./types.js";
import { knownSecretValues, labEventEmitter, type LabEvent } from "./run-lab-events.js";
import { rosterOf } from "./parse/actors.js";
import { studyResultIdentity } from "../run/study-result.js";

type Refusal = {
  ok: false;
  code: "HUMANISH_STUDY_OPTION_UNSUPPORTED";
  message: string;
};

type Normalized = {
  ok: true;
  /** The options the route reads: onEvent removed, env copied. */
  options: InternalRunLabOptions;
  /** Filled by onEvent failures while the run runs; runLab appends them to the result. */
  warnings: string[];
  /** Calls onEvent and never waits for it, or undefined without onEvent. The routes report through it. */
  emit: ((event: LabEvent) => void) | undefined;
};

const unsupported = (option: string, route: LabRoute, reason: string): Refusal => ({
  ok: false,
  code: "HUMANISH_STUDY_OPTION_UNSUPPORTED",
  message: `RunLabOptions.${option} is not supported on the ${route} route: ${reason}`,
});

// Fields RunLabOptions no longer has, and where each one's job went.
const REMOVED_OPTIONS: Readonly<Record<string, string>> = {
  cuaHooks: "Use scorer, createProvider, inProcess, prepareDesktop, env, onEvent and onStream.",
  scriptedHooks: "Use prepareDesktop and env.",
  terminalHooks: "Use scorer and env.",
  sharedWorldHooks: "Use scorer, prepareDesktop, env, onEvent and onStream.",
  automaticAnalysis: "Use onEvent (analysis-started, analysis-finished) and analysisSignal.",
  lab: "The humanish CLI sets it.",
  scorerProvenance: "The humanish CLI sets it.",
};

/** The refusal for a field a JavaScript caller passed that RunLabOptions no longer has. */
export function removedOptionRefusal(options: RunLabOptions): Refusal | undefined {
  // rerun.laneIds, the older name of rerun.participantIds, would otherwise be ignored, so the rerun
  // would select every failed participant instead of the ones the caller named.
  if (options.rerun !== undefined && Reflect.get(options.rerun, "laneIds") !== undefined)
    return {
      ok: false,
      code: "HUMANISH_STUDY_OPTION_UNSUPPORTED",
      message:
        'RunLabOptions.rerun.laneIds was removed. Use rerun.participantIds. See docs/contracts/schemas.md, "Library options".',
    };
  const field = Object.keys(REMOVED_OPTIONS).find((key) => Reflect.get(options, key) !== undefined);
  if (field === undefined) return undefined;
  return {
    ok: false,
    code: "HUMANISH_STUDY_OPTION_UNSUPPORTED",
    message: `RunLabOptions.${field} was removed. ${REMOVED_OPTIONS[field]} See docs/contracts/schemas.md, "Library options".`,
  };
}

/** Why the route cannot honor an option it was given, or undefined when it can. */
function unsupportedOption(
  config: LabConfig,
  route: LabRoute,
  options: InternalRunLabOptions,
): Refusal | undefined {
  const { scorer, createProvider, inProcess, prepareDesktop } = options;
  if (inProcess !== undefined && createProvider === undefined)
    return unsupported(
      "inProcess",
      route,
      "an in-process executor returns no frame, so it needs createProvider.",
    );
  const participantRoute = route === "computer-use" || route === "shared-world";
  if (scorer !== undefined && route !== "terminal" && !participantRoute)
    return unsupported("scorer", route, "only computer use, shared world and terminal score runs.");
  if (createProvider !== undefined && route !== "computer-use")
    return unsupported(
      "createProvider",
      route,
      route === "shared-world"
        ? "shared-world participants run the lab's own brain."
        : "only computer use takes a caller brain.",
    );
  if (route === "computer-use") {
    const source = config.subject.source;
    if (inProcess !== undefined) {
      if (source !== "app-url" && source !== "local-app")
        return unsupported("inProcess", route, "it drives an app-url or local-app subject.");
    }
    if (prepareDesktop !== undefined) {
      if (isLocalBrowserLab(config))
        return unsupported("prepareDesktop", route, "a local VM study has no E2B desktop.");
      // An in-process run has no desktop to prepare.
      if (inProcess !== undefined || source === "local-app")
        return unsupported("prepareDesktop", route, "an in-process run has no desktop.");
    }
    return undefined;
  }
  if (inProcess !== undefined)
    return unsupported("inProcess", route, "only computer use drives an app in process.");
  if (prepareDesktop === undefined || route === "shared-world") return undefined;
  if (route === "scripted" && config.subject.source === "clone") return undefined;
  return unsupported(
    "prepareDesktop",
    route,
    route === "scripted"
      ? "only a clone subject runs on an E2B desktop."
      : "this route has no E2B desktop to prepare.",
  );
}

/**
 * Refuse what the route cannot honor, copy env, and build the emitter onEvent receives through.
 * Nothing here touches the filesystem, so a refusal leaves no run directory, receipt or sandbox.
 */
export function normalizeRunLabOptions(
  config: LabConfig,
  route: LabRoute,
  options: InternalRunLabOptions,
): Normalized | Refusal {
  const refused = unsupportedOption(config, route, options);
  if (refused) return refused;

  const warnings: string[] = [];
  const { env, onEvent, ...forwarded } = options;
  // The route gets this copy, so it is the env a warning is scrubbed against, whatever the caller
  // does to its own object afterwards.
  const forwardedEnv = env === undefined ? undefined : { ...env };
  const emit = labEventEmitter(onEvent, warnings, () =>
    knownSecretValues(config, options, forwardedEnv),
  );

  // Every route reads its typed options directly, and onEvent reaches it as `emit`. unsupportedOption
  // already refused an option no route reads; the preview route reads no env.
  const normalized: InternalRunLabOptions = { ...forwarded };
  if (route !== "preview" && forwardedEnv !== undefined) normalized.env = forwardedEnv;
  return { ok: true, options: normalized, warnings, emit };
}

/** A refusal in the route's own result envelope, before any run exists. */
export function optionRefusalOutcome(
  config: LabConfig,
  route: LabRoute,
  options: RunLabOptions,
  refusal: Refusal,
): LabOutcome {
  const cwd = path.resolve(options.cwd);
  const error = { code: refusal.code, message: refusal.message };
  const actor = config.actors[0]?.type ?? "";
  const dryRun = resolveLabDryRun(config, options.dryRun, true) ?? true;
  const runId = options.runId ?? "not-created";
  const common = { ok: false, cwd, actor, dryRun, runId, warnings: [], error };
  switch (route) {
    case "preview":
      return {
        route: "preview",
        result: {
          ...studyResultIdentity("preview", config.id),
          ok: false,
          cwd,
          warnings: [],
          error,
        },
      };
    case "computer-use":
      return {
        route: "computer-use",
        result: {
          ...studyResultIdentity("computer-use", config.id),
          ...common,
          ok: false,
          appUrl: config.subject.appUrl ?? config.subject.serve?.url ?? "",
          lanes: [],
        },
      };
    case "scripted":
      return {
        route: "scripted",
        result: {
          ...studyResultIdentity("scripted", config.id),
          ...common,
          ok: false,
          appUrl: config.subject.appUrl ?? "",
          sessions: [],
        },
      };
    case "terminal":
      return {
        route: "terminal",
        result: {
          ...studyResultIdentity("terminal", config.id),
          ...common,
          ok: false,
          product: config.subject.product?.name ?? "",
        },
      };
    case "shared-world": {
      const participantCount = rosterOf(config.actors[0])?.length ?? 0;
      return {
        route: "shared-world",
        result: {
          ...studyResultIdentity("shared-world", config.id),
          ...common,
          ok: false,
          topology: "shared-world",
          topologyMode: "concurrent",
          roleCount: participantCount,
          concurrency: config.execution?.concurrency ?? Math.max(1, participantCount),
          roles: [],
        },
      };
    }
  }
}
