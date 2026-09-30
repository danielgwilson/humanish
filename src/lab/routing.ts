import { actorRegistry } from "../actors/registry.js";
import { isLoopbackUrl } from "./parse-subject.js";
import type { LabConfig } from "./types.js";

// Hard cap on fan-out lanes (per the ratified design). No HUMANISH_MAX_LANES escape above this
// until a reference panel demands it — N concurrent paid desktops is real money.
export const MAX_CUA_LANES = 16;

export function actorResolvesToComputerUse(type: string | undefined): boolean {
  if (!type) return false;
  const descriptor = (
    actorRegistry as Record<string, (typeof actorRegistry)[keyof typeof actorRegistry] | undefined>
  )[type];
  return Boolean(descriptor?.capabilities.lanes.includes("computer-use"));
}

export function registeredComputerUseActors(): string[] {
  return Object.values(actorRegistry)
    .filter((entry) => entry.capabilities.lanes.includes("computer-use"))
    .map((entry) => entry.id);
}

export function actorResolvesToScriptedBrowser(type: string | undefined): boolean {
  if (!type) return false;
  const descriptor = (
    actorRegistry as Record<string, (typeof actorRegistry)[keyof typeof actorRegistry] | undefined>
  )[type];
  return Boolean(descriptor?.capabilities.lanes.includes("scripted-browser"));
}

export function registeredScriptedBrowserActors(): string[] {
  return Object.values(actorRegistry)
    .filter((entry) => entry.capabilities.lanes.includes("scripted-browser"))
    .map((entry) => entry.id);
}

/** True when `type` resolves to a registered terminal actor (the "terminal" lane). Exported so
 *  the engine + tests can resolve the dispatch the same way the parser does. */
export function actorResolvesToTerminal(type: string | undefined): boolean {
  if (!type) return false;
  const descriptor = (
    actorRegistry as Record<string, (typeof actorRegistry)[keyof typeof actorRegistry] | undefined>
  )[type];
  return Boolean(descriptor?.capabilities.lanes.includes("terminal"));
}

export function registeredTerminalActors(): string[] {
  return Object.values(actorRegistry)
    .filter((entry) => entry.capabilities.lanes.includes("terminal"))
    .map((entry) => entry.id);
}

/**
 * True when this config routes to the computer-use backend: an app-url subject whose first
 * actor resolves to a registered computer-use actor, or a clone subject on a hosted desktop
 * whose first actor does. Single source of truth — selectLabBackend and the warning logic
 * both use it. (The app-url branch used to be unconditionally true; it narrowed when the
 * scripted-browser lane arrived. Behavior-preserving for every parse-valid config —
 * selectLabBackend keeps a bare app-url fallback to the cua backend so library-API configs
 * with unknown actors still hit its fail-closed ACTOR_UNSUPPORTED.)
 */
/**
 * The declared fan-out lane count on the computer-use route: a `lanes[]` roster's length, else
 * a homogeneous `count`, else 1. The single source of truth shared by the parser, the engine,
 * and the pre-flight plan so the lane count is computed ONE way everywhere.
 */
export function cuaLaneCount(config: LabConfig): number {
  const actor = config.actors[0];
  if (actor?.lanes !== undefined) {
    return actor.lanes.length;
  }
  return actor?.count ?? 1;
}

export function declaredLaneTargets(config: LabConfig): string[] {
  return (config.actors[0]?.lanes ?? [])
    .map((lane) => lane.target)
    .filter((target): target is string => target !== undefined);
}

/**
 * The lane ids the computer-use engine will actually run: declared roster ids, else the generated
 * `lane-01..lane-NN` names. Mirrors the naming in routes/computer-use/lane-plan.ts laneSpecsAndPlan — a test
 * pins the two together — so comms recipient validation can never drift from the engine (#351).
 */
export function effectiveComputerUseLaneIds(config: LabConfig): string[] {
  const actor = config.actors[0];
  const roster = actor?.lanes;
  if (roster && roster.length > 0) {
    return roster.map((lane, index) => lane.id ?? `lane-${String(index + 1).padStart(2, "0")}`);
  }
  const count = Math.max(1, actor?.count ?? 1);
  return Array.from({ length: count }, (_, index) => `lane-${String(index + 1).padStart(2, "0")}`);
}

export function routesToComputerUse(config: LabConfig): boolean {
  // local-app drives the cua loop in-process (a custom executor + a non-vision provider), so it
  // routes to the cua backend exactly like an app-url subject with a computer-use actor.
  if (config.subject.source === "app-url" || config.subject.source === "local-app") {
    return actorResolvesToComputerUse(config.actors[0]?.type);
  }
  // desktop-cli hands the participant a terminal instead of a served page (#495), but it is the
  // same lane: same desktop, same actor, same prompt fields. Leaving it out of this predicate told
  // adopters their mission and persona were inert on the one route whose whole point is that a
  // person reads a screen.
  if (config.subject.source === "desktop-cli") {
    return (
      (config.execution?.target === undefined || config.execution.target === "e2b-desktop") &&
      actorResolvesToComputerUse(config.actors[0]?.type)
    );
  }
  // local-tree packs+uploads the working tree, then serves it exactly like a computer-use clone
  // subject: same e2b-desktop + computer-use-actor gate.
  return (
    (config.subject.source === "clone" || config.subject.source === "local-tree") &&
    config.execution?.target === "e2b-desktop" &&
    actorResolvesToComputerUse(config.actors[0]?.type)
  );
}

/**
 * True when this config routes to the SHARED-WORLD backend (#164): a clone or local-tree subject
 * on a hosted desktop whose first actor resolves to a computer-use actor AND that declares the
 * `shared-world` topology. Mirror of routesToComputerUse; the single source of truth shared by
 * selectLabBackend (which checks it BEFORE the cua route) and the warning logic. Every
 * shared-world study runs its participants at once (`execution.concurrency` >= 2). The same
 * clone/local-tree × e2b-desktop × computer-use composition WITHOUT `topology: shared-world` stays per-lane-worlds
 * (the cua route) — the topology declaration is the override switch.
 */
export function routesToSharedWorld(config: LabConfig): boolean {
  return routesToProvisionedSharedWorld(config) || routesToExternalPublicSharedWorld(config);
}

/** The getHost provisioned-subject shared-world shape (clone/local-tree served + exposed in-sandbox). */
export function routesToProvisionedSharedWorld(config: LabConfig): boolean {
  return (
    (config.subject.source === "clone" || config.subject.source === "local-tree") &&
    config.subject.topology === "shared-world" &&
    config.execution?.target === "e2b-desktop" &&
    actorResolvesToComputerUse(config.actors[0]?.type)
  );
}

/**
 * The EXTERNAL-PUBLIC shared-world shape (#164 phase 2): a real PUBLIC deployment used DIRECTLY as
 * the shared plane — `source: app-url` + `topology: shared-world` + a computer-use actor on
 * e2b-desktop + `policies.allowPublicTargets: true`. NO getHost, NO clone, NO subject sandbox, NO
 * seed. The operator-ownership attestation `subject.publicTarget` is required (validated in
 * externalPublicSharedWorldValidationReason, not here — this predicate is the router only, so a
 * half-declared external-public config still routes here to get its precise fail-closed reason
 * rather than silently downgrading to the per-lane cua route).
 */
export function routesToExternalPublicSharedWorld(config: LabConfig): boolean {
  return (
    config.subject.source === "app-url" &&
    config.subject.topology === "shared-world" &&
    config.execution?.target === "e2b-desktop" &&
    actorResolvesToComputerUse(config.actors[0]?.type) &&
    config.policies?.allowPublicTargets === true
  );
}

/**
 * @deprecated Every shared-world study runs its participants at once since the sequential
 * shared-world route was removed. Use routesToSharedWorld; this alias goes in the next minor.
 */
export function routesToConcurrentSharedWorld(config: LabConfig): boolean {
  return routesToSharedWorld(config);
}

/**
 * Resolve a shared-world seat's entry URL from `serve.url` + a role's `entry` (relative path or
 * same-origin absolute URL). Returns null when the combination is not a same-origin loopback URL
 * (the load-bearing public-safety boundary — a seat only ever drives the in-sandbox app).
 */
export function resolveSeatUrl(serveUrl: string, entry: string | undefined): string | null {
  if (entry === undefined || entry === "") {
    return isLoopbackUrl(serveUrl) ? serveUrl : null;
  }
  let base: URL;
  let resolved: URL;
  try {
    base = new URL(serveUrl);
    resolved = new URL(entry, serveUrl);
  } catch {
    return null;
  }
  if (resolved.origin !== base.origin) {
    return null;
  }
  const value = resolved.toString();
  return isLoopbackUrl(value) ? value : null;
}

/**
 * True when this config routes to the scripted-browser backend: an app-url subject whose
 * first actor resolves to a registered scripted-browser actor (execution.target local or
 * absent — the parse layer enforces that pairing). Mirror of routesToComputerUse; the single
 * source of truth for selectLabBackend and the warning logic.
 */
export function routesToScriptedBrowser(config: LabConfig): boolean {
  return routesToLocalScriptedBrowser(config) || routesToProvisionedScriptedBrowser(config);
}

function routesToLocalScriptedBrowser(config: LabConfig): boolean {
  return (
    config.subject.source === "app-url" && actorResolvesToScriptedBrowser(config.actors[0]?.type)
  );
}

export function routesToProvisionedScriptedBrowser(config: LabConfig): boolean {
  return (
    config.subject.source === "clone" &&
    config.execution?.target === "e2b-desktop" &&
    actorResolvesToScriptedBrowser(config.actors[0]?.type)
  );
}

/**
 * True when this config routes to the terminal-product backend: a terminal-product subject whose
 * first actor resolves to a registered terminal actor (execution.target e2b-terminal or absent —
 * the parse layer enforces that pairing). Mirror of routesToComputerUse/routesToScriptedBrowser;
 * the single source of truth for selectLabBackend and the warning logic.
 */
export function routesToTerminalProduct(config: LabConfig): boolean {
  return (
    config.subject.source === "terminal-product" && actorResolvesToTerminal(config.actors[0]?.type)
  );
}
