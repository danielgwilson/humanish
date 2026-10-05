import type { ActorCapabilities } from "../actors/contract.js";
import { actorRegistry } from "../actors/registry.js";
import { isLoopbackUrl } from "./parse/subject.js";
import type { StudyConfig } from "./types.js";
import {
  actorOf,
  participantList,
  declaredParticipantCount,
  declaresSharedWorld,
} from "./study-fields.js";

// Hard cap on computer-use participants. No setting raises it: each participant is a paid desktop,
// and they all run at once.
export const MAX_COMPUTER_USE_PARTICIPANTS = 16;

type ActorRunKind = ActorCapabilities["lanes"][number];

// Run kinds whose evidence is the participant's screenshots. An actor that declares it produces none
// cannot run on them: a code-only actor would claim a GUI flow it only reached through a shell.
const SCREENSHOT_RUN_KINDS: ReadonlySet<ActorRunKind> = new Set([
  "computer-use",
  "scripted-browser",
]);

function runsOn(capabilities: ActorCapabilities, kind: ActorRunKind): boolean {
  return (
    capabilities.lanes.includes(kind) &&
    (!SCREENSHOT_RUN_KINDS.has(kind) || capabilities.producesScreenshots)
  );
}

function actorResolvesTo(type: string | undefined, kind: ActorRunKind): boolean {
  if (!type) return false;
  const descriptor = (
    actorRegistry as Record<string, (typeof actorRegistry)[keyof typeof actorRegistry] | undefined>
  )[type];
  return descriptor !== undefined && runsOn(descriptor.capabilities, kind);
}

function registeredActorsOn(kind: ActorRunKind): string[] {
  return Object.values(actorRegistry)
    .filter((entry) => runsOn(entry.capabilities, kind))
    .map((entry) => entry.id);
}

export function actorResolvesToComputerUse(type: string | undefined): boolean {
  return actorResolvesTo(type, "computer-use");
}

export function registeredComputerUseActors(): string[] {
  return registeredActorsOn("computer-use");
}

export function actorResolvesToScriptedBrowser(type: string | undefined): boolean {
  return actorResolvesTo(type, "scripted-browser");
}

export function registeredScriptedBrowserActors(): string[] {
  return registeredActorsOn("scripted-browser");
}

/** True when `type` resolves to a registered terminal actor (the "terminal" run kind). Exported so
 *  the engine + tests can resolve the dispatch the same way the parser does. */
export function actorResolvesToTerminal(type: string | undefined): boolean {
  return actorResolvesTo(type, "terminal");
}

export function registeredTerminalActors(): string[] {
  return registeredActorsOn("terminal");
}

/**
 * The declared fan-out participant count on the computer-use route: a `participants` list's
 * length, else a participant count, else 1. The single source of truth shared by the parser, the engine,
 * and the pre-flight plan so the participant count is computed the same way everywhere.
 */
export function computerUseParticipantCount(config: StudyConfig): number {
  return participantList(config)?.length ?? declaredParticipantCount(config) ?? 1;
}

/**
 * A participant's id: its declared roster id, else `lane-NN` (independent participants) or `role-NN`
 * (shared-world participants) from its 0-based position. The parser's filled email recipients and
 * the routes that name participants both call this, so a filled recipient names a participant that
 * runs.
 */
export function participantIdAt(
  index: number,
  declared: string | undefined,
  kind: "lane" | "seat",
): string {
  return declared ?? `${kind === "seat" ? "role" : "lane"}-${String(index + 1).padStart(2, "0")}`;
}

/**
 * True when this config routes to the computer-use backend: an app-url subject whose first actor
 * resolves to a registered computer-use actor, or a clone subject on a hosted desktop whose first
 * actor does. Single source of truth: routeOf and the warning logic both use it. (The app-url
 * branch also checks the first actor, so a scripted-browser actor routes elsewhere. routeOf keeps a
 * bare app-url fallback to the computer-use route so library-API configs with unknown actors still
 * hit its fail-closed ACTOR_UNSUPPORTED.)
 */
export function isComputerUseComposition(config: StudyConfig): boolean {
  // local-app drives the cua loop in-process (a custom executor + a non-vision provider), so it
  // routes to the computer-use route exactly like an app-url subject with a computer-use actor.
  if (config.subject.source === "app-url" || config.subject.source === "local-app") {
    return actorResolvesToComputerUse(actorOf(config)?.type);
  }
  // desktop-cli hands the participant a terminal instead of a served page, but it is the
  // same route: same desktop, same actor, same prompt fields. Leaving it out of this predicate told
  // adopters their mission and persona were inert on the one route whose whole point is that a
  // person reads a screen.
  if (config.subject.source === "desktop-cli") {
    return (
      (config.execution?.target === undefined || config.execution.target === "e2b-desktop") &&
      actorResolvesToComputerUse(actorOf(config)?.type)
    );
  }
  // local-tree packs+uploads the working tree, then serves it exactly like a computer-use clone
  // subject: same e2b-desktop + computer-use-actor gate.
  return (
    (config.subject.source === "clone" || config.subject.source === "local-tree") &&
    config.execution?.target === "e2b-desktop" &&
    actorResolvesToComputerUse(actorOf(config)?.type)
  );
}

/**
 * True when this config routes to the shared-world route: a clone or local-tree subject
 * on a hosted desktop whose first actor resolves to a computer-use actor and that declares the
 * `shared-world` topology. Mirror of isComputerUseComposition; the single source of truth shared by
 * routeOf (which checks it before the computer-use route) and the warning logic. Every
 * shared-world study runs its participants at once (`execution.concurrency` >= 2). The same
 * clone/local-tree × e2b-desktop × computer-use composition without `route: shared-world` stays per-lane-worlds
 * (the computer-use route); the route declaration is the override switch.
 */
export function isSharedWorldComposition(config: StudyConfig): boolean {
  return (
    isProvisionedSharedWorldComposition(config) || isExternalPublicSharedWorldComposition(config)
  );
}

/** The getHost provisioned-subject shared-world shape (clone/local-tree served + exposed in-sandbox). */
export function isProvisionedSharedWorldComposition(config: StudyConfig): boolean {
  return (
    (config.subject.source === "clone" || config.subject.source === "local-tree") &&
    declaresSharedWorld(config) &&
    config.execution?.target === "e2b-desktop" &&
    actorResolvesToComputerUse(actorOf(config)?.type)
  );
}

/**
 * The external-public shared-world shape: a real public deployment used directly as
 * the shared plane: `source: app-url` + `route: shared-world` + a computer-use actor on
 * e2b-desktop + `policies.allowPublicTargets: true`. No getHost, no clone, no subject sandbox, no
 * seed. The operator-ownership attestation `subject.publicTarget` is required (validated in
 * externalPublicSharedWorldValidationReason, not here; this predicate is the router only, so a
 * half-declared external-public config still routes here to get its precise fail-closed reason
 * rather than silently downgrading to the per-participant computer-use route).
 */
export function isExternalPublicSharedWorldComposition(config: StudyConfig): boolean {
  return (
    config.subject.source === "app-url" &&
    declaresSharedWorld(config) &&
    config.execution?.target === "e2b-desktop" &&
    actorResolvesToComputerUse(actorOf(config)?.type) &&
    config.policies?.allowPublicTargets === true
  );
}

/**
 * Resolve a shared-world participant's entry URL from `serve.url` and its roster entry's `entry`
 * (a relative path or a same-origin absolute URL). Returns null when the result is not a
 * same-origin loopback URL, so a participant only ever drives the in-sandbox app.
 */
export function resolveEntryUrl(serveUrl: string, entry: string | undefined): string | null {
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
 * absent; the parse layer enforces that pairing). Mirror of isComputerUseComposition; the single
 * source of truth for routeOf and the warning logic.
 */
export function isScriptedBrowserComposition(config: StudyConfig): boolean {
  return (
    isLocalScriptedBrowserComposition(config) || isProvisionedScriptedBrowserComposition(config)
  );
}

function isLocalScriptedBrowserComposition(config: StudyConfig): boolean {
  return (
    config.subject.source === "app-url" && actorResolvesToScriptedBrowser(actorOf(config)?.type)
  );
}

export function isProvisionedScriptedBrowserComposition(config: StudyConfig): boolean {
  return (
    config.subject.source === "clone" &&
    config.execution?.target === "e2b-desktop" &&
    actorResolvesToScriptedBrowser(actorOf(config)?.type)
  );
}

/**
 * True when this config routes to the terminal-product backend: a terminal-product subject whose
 * first actor resolves to a registered terminal actor (execution.target e2b-terminal or absent;
 * the parse layer enforces that pairing). Mirror of isComputerUseComposition/isScriptedBrowserComposition;
 * the single source of truth for routeOf and the warning logic.
 */
export function isTerminalProductComposition(config: StudyConfig): boolean {
  return (
    config.subject.source === "terminal-product" && actorResolvesToTerminal(actorOf(config)?.type)
  );
}

/** The five execution paths a study can take. */
export type StudyRoute = "preview" | "computer-use" | "shared-world" | "terminal" | "scripted";

/**
 * The route a config takes. It never refuses: a config no route can run still gets the route
 * whose own checks refuse it with the most precise reason.
 */
export function routeOf(config: StudyConfig): StudyRoute {
  const source = config.subject.source;
  // A scripted-browser actor on a loopback app or a provisioned clone replays committed steps.
  if (isScriptedBrowserComposition(config)) return "scripted";
  // A terminal-product subject goes to the terminal route even with an unregistered actor, so that
  // route refuses the actor instead of another route running something else.
  if (isTerminalProductComposition(config) || source === "terminal-product") return "terminal";
  // Checked before computer use: the same composition without the topology declaration runs
  // independent participants.
  if (isSharedWorldComposition(config)) return "shared-world";
  // A CLI studied at a desktop is a computer-use study whose subject is a terminal window.
  if (source === "desktop-cli") return "computer-use";
  // Every other app-url, clone, local-app or local-tree config goes to computer use, including
  // ones with an unknown actor: that route refuses the actor, where the preview route would run
  // no participant at all.
  if (
    isComputerUseComposition(config) ||
    source === "app-url" ||
    source === "clone" ||
    source === "local-app" ||
    source === "local-tree"
  )
    return "computer-use";
  // this-repo runs the synthetic preview.
  return "preview";
}
