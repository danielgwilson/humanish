// The route decision. A lab's route follows from its composition (subject.source,
// execution.target, the first actor's registered lane, subject.topology), never from a declared
// kind. This is the only function that decides it; selectLabBackend maps its answer to the older
// backend names.

import type { LabBackend } from "./engine.js";
import {
  routesToComputerUse,
  routesToScriptedBrowser,
  routesToSharedWorld,
  routesToTerminalProduct,
} from "./routing.js";
import type { LabConfig } from "./types.js";

/** The five execution paths a lab can take. */
export type LabRoute = "preview" | "computer-use" | "shared-world" | "terminal" | "scripted";

const BACKENDS: Record<LabRoute, LabBackend> = {
  preview: "synthetic",
  "computer-use": "cua",
  "shared-world": "concurrent-shared-world",
  terminal: "terminal",
  scripted: "scripted",
};

/** The backend name older callers and wire fields use for a route. */
export function backendOf(route: LabRoute): LabBackend {
  return BACKENDS[route];
}

/**
 * The route a config takes. It never refuses: a config no route can run still gets the route
 * whose own checks refuse it with the most precise reason.
 */
export function routeOf(config: LabConfig): LabRoute {
  const source = config.subject.source;
  // A scripted-browser actor on a loopback app or a provisioned clone replays committed steps.
  if (routesToScriptedBrowser(config)) return "scripted";
  // A terminal-product subject goes to the terminal route even with an unregistered actor, so that
  // route refuses the actor instead of another route running something else.
  if (routesToTerminalProduct(config) || source === "terminal-product") return "terminal";
  // Checked before computer use: the same composition without the topology declaration runs as
  // independent lanes.
  if (routesToSharedWorld(config)) return "shared-world";
  // A CLI studied at a desktop is a computer-use study whose subject is a terminal window.
  if (source === "desktop-cli") return "computer-use";
  // Every other app-url, clone, local-app or local-tree config goes to computer use, including
  // ones with an unknown actor: that route refuses the actor, where the preview route would run
  // no participant at all.
  if (
    routesToComputerUse(config) ||
    source === "app-url" ||
    source === "clone" ||
    source === "local-app" ||
    source === "local-tree"
  )
    return "computer-use";
  // this-repo runs the synthetic preview.
  return "preview";
}
