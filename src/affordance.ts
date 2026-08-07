// Affordance classification (#369): WHICH KIND of route an actor took to accomplish a step.
//
// Why this exists. A computer-use actor in a human-persona study typed a `javascript:` URL into
// the address bar to get past a step, and the run finished green: the actor routed around the
// friction the study existed to measure, and nothing in the evidence said so. Whether that is a
// defect depends on a question the bundle never recorded — who is this study's user? For a human
// population it invalidates the run; for an agent-facing product whose users ARE agents the same
// act is faithful, and the fact the agent reached for it is itself a finding about how legible
// the surface is. So the harness records the class and bakes NO verdict: the adopter's scorer
// (review.scorer.ref) decides what it means, because that judgment is product semantics.
//
// Two design facts drive the shape:
//
//  1. The computer-use action space is mouse + keyboard only — there is no `goto` action. Typing a
//     URL is a `type` action whose TEXT happens to be a URL, and typing script is a `type` action
//     whose text happens to start with `javascript:`. Classification therefore has to look at the
//     typed text, which exists only at dispatch time.
//  2. Raw typed text is never persisted (describeCuaAction deliberately renders `type [N chars]`),
//     so this module returns a CLASS and at most a scheme-shaped signal — never the text. The
//     class is public-safe by construction.
//
// Direct URL navigation is deliberately its own class and NOT lumped with script execution:
// `load(url)` appears in 99.4% of 2,337 real human web demonstrations (WebLINX), so address-bar
// use is ordinary human behavior. The anomalous classes are script execution and developer
// tooling. See docs/principles/actor-fidelity.md for the evidence and the scoping of the claim.

import type { CuaAction } from "./computer-use.js";

export const AFFORDANCE_CLASS_SCHEMA = "humanish.affordance-use.v1";

/**
 * The affordance classes, named after the surrounding literature rather than invented here:
 * "naturalistic actions" (AndroidWorld) for the human-modality subset, "nav" (BrowserGym) for
 * direct navigation, "shortcut" (MAS-Bench) for a non-UI route to the same outcome.
 */
export type AffordanceClass =
  /** Pointer or drag interaction with what is rendered on screen — the naturalistic core. */
  | "pointer"
  /** Keyboard input into the page: typed text that is not a URL and not script. */
  | "keyboard"
  /** Direct navigation by URL (the `nav` subset). A human affordance; see the note above. */
  | "url-navigation"
  /** Script execution via the address bar (a `javascript:` URL). Not a human affordance. */
  | "script-execution"
  /** Developer tooling opened by keyboard shortcut. Not a human affordance. */
  | "devtools"
  /** A browser-internal surface rather than the product: chrome://, about:, view-source:, file:. */
  | "browser-internal"
  /** The actor observing or pausing rather than acting: screenshots, waits, pointer moves. */
  | "observation";

/** Classes that a person operating this product through its own surfaces could produce. */
export const NATURALISTIC_AFFORDANCE_CLASSES: readonly AffordanceClass[] = [
  "pointer",
  "keyboard",
  "url-navigation",
  "observation"
];

/** Classes that reach past the rendered product surface. Recorded, never blocked. */
export const SHORTCUT_AFFORDANCE_CLASSES: readonly AffordanceClass[] = ["script-execution", "devtools", "browser-internal"];

export interface AffordanceObservation {
  affordance: AffordanceClass;
  /**
   * A public-safe hint about WHY this class was assigned, when one exists — a URL scheme or the
   * devtools chord. Never the typed text, never a full URL (which can carry a session token).
   */
  signal?: string;
}

/** Aggregate per-run record: how many actions fell into each class. */
export interface AffordanceUse {
  schema: typeof AFFORDANCE_CLASS_SCHEMA;
  /** Counts by class; a class with zero actions is omitted so the record stays small and honest. */
  counts: Partial<Record<AffordanceClass, number>>;
  /** Total classified actions (the denominator for any rate an adopter computes). */
  total: number;
  /** Convenience roll-up: actions in the shortcut classes. Zero is a meaningful, common value. */
  shortcutTotal: number;
}

// A `javascript:` URL typed into the address bar. Tolerates leading whitespace and mixed case;
// the scheme is what matters, not the payload (which is never recorded).
const SCRIPT_URL = /^\s*(?:javascript|data):/i;
// Browser-internal surfaces: not the product under study, and not something a study of the
// product's UX can attribute to the product.
const BROWSER_INTERNAL_URL = /^\s*(?:chrome|about|view-source|devtools|file|edge|brave):/i;
// An http(s) URL, or a bare host-looking string a browser resolves as navigation.
const HTTP_URL = /^\s*https?:\/\//i;
const BARE_HOST = /^\s*(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:?#]\S*)?\s*$/i;
// The common devtools chords across platforms.
const DEVTOOLS_CHORDS = new Set([
  "f12",
  "ctrl+shift+i",
  "ctrl+shift+j",
  "ctrl+shift+c",
  "cmd+alt+i",
  "cmd+alt+j",
  "cmd+alt+c",
  "meta+alt+i",
  "meta+alt+j",
  "meta+alt+c"
]);

/**
 * Classify one computer-use action. PURE: same action in, same class out, no I/O, no clock. The
 * returned signal is public-safe (a scheme or a chord), never the action's text.
 */
export function classifyCuaAction(action: CuaAction): AffordanceObservation {
  switch (action.kind) {
    case "click":
    case "double_click":
    case "drag":
    case "scroll":
      return { affordance: "pointer" };
    case "wait":
    case "screenshot":
    // A bare pointer move actuates nothing on its own; it is the actor looking around.
    case "move":
      return { affordance: "observation" };
    case "keypress": {
      const chord = normalizeChord(action.keys);
      if (DEVTOOLS_CHORDS.has(chord)) {
        return { affordance: "devtools", signal: chord };
      }
      return { affordance: "keyboard" };
    }
    case "type": {
      const text = action.text;
      if (SCRIPT_URL.test(text)) {
        // The payload after the scheme is deliberately dropped: it is arbitrary author text and
        // could carry anything. The scheme alone is the finding. `data:` rides here with
        // `javascript:` because a data URL can carry executable HTML.
        return { affordance: "script-execution", signal: schemeOf(text) };
      }
      if (BROWSER_INTERNAL_URL.test(text)) {
        return { affordance: "browser-internal", signal: schemeOf(text) };
      }
      if (HTTP_URL.test(text)) {
        // Scheme only — a full URL can carry a session token or an identifying path.
        return { affordance: "url-navigation", signal: schemeOf(text) };
      }
      if (BARE_HOST.test(text)) {
        return { affordance: "url-navigation", signal: "bare-host" };
      }
      return { affordance: "keyboard" };
    }
    default:
      // The wire->CuaAction mapper drops unrecognized action types before they reach here, so
      // this is unreachable today; classify defensively rather than throwing inside a run.
      return { affordance: "observation" };
  }
}

/**
 * Normalize a key chord so the same physical shortcut matches however a provider spells it:
 * `Control`/`ctrl`, `Meta`/`Command`/`cmd`, `Option`/`alt` all collapse, and modifier ORDER is
 * normalized so ["Shift","Control","J"] and ["Control","Shift","J"] are one chord.
 */
function normalizeChord(keys: readonly string[]): string {
  const alias: Record<string, string> = {
    control: "ctrl", ctl: "ctrl",
    meta: "cmd", command: "cmd", super: "cmd", os: "cmd",
    option: "alt", opt: "alt"
  };
  const parts = keys.map((key) => {
    const lowered = key.trim().toLowerCase();
    return alias[lowered] ?? lowered;
  });
  const order = ["ctrl", "cmd", "alt", "shift"];
  const modifiers = parts.filter((part) => order.includes(part)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const rest = parts.filter((part) => !order.includes(part));
  return [...modifiers, ...rest].join("+");
}

/** The scheme alone, lowercased — never the rest of a URL, which can carry a session token. */
function schemeOf(text: string): string {
  const trimmed = text.trim();
  const colon = trimmed.indexOf(":");
  return colon === -1 ? "" : `${trimmed.slice(0, colon).toLowerCase()}:`;
}

/** Fold a sequence of observations into the per-run aggregate. */
export function summarizeAffordanceUse(observations: readonly AffordanceObservation[]): AffordanceUse {
  const counts: Partial<Record<AffordanceClass, number>> = {};
  for (const observation of observations) {
    counts[observation.affordance] = (counts[observation.affordance] ?? 0) + 1;
  }
  const shortcutTotal = SHORTCUT_AFFORDANCE_CLASSES.reduce((sum, klass) => sum + (counts[klass] ?? 0), 0);
  return { schema: AFFORDANCE_CLASS_SCHEMA, counts, total: observations.length, shortcutTotal };
}
