// A caller's hook bag with some members replaced, without copying the bag's values. Spreading a
// class instance keeps only its own properties, so a route that spreads a caller's bag loses the
// class's methods; this builds a plain object that keeps them.

import type { AutomaticAnalysisHooks } from "../analysis/automatic-completion.js";
import type { CuaActorLabHooks } from "../routes/computer-use/types.js";
import type { ScriptedBrowserLabHooks } from "../routes/scripted-browser/types.js";
import type { SharedWorldLabHooks } from "../routes/shared-world/hooks.js";
import type { TerminalProductLabHooks } from "../routes/terminal/types.js";

// Every member each bag type declares. The record type makes the compiler reject a missing or
// unknown name, so a member added to a bag type must be added here too.
const cuaMembers: Record<keyof CuaActorLabHooks, true> = {
  prepareDesktop: true,
  onPreflight: true,
  onPhase: true,
  onRuntimeStreamReady: true,
  onRuntimeStreamEnded: true,
  loadDesktopModule: true,
  runSession: true,
  buildExecutor: true,
  buildProvider: true,
  createDesktopLane: true,
  env: true,
  renderObserverFn: true,
  now: true,
  detachedTimers: true,
  packLocalTree: true,
  score: true,
  deriveFeedback: true,
  deriveArtifacts: true,
};
const sharedWorldMembers: Record<keyof SharedWorldLabHooks, true> = {
  loadDesktopModule: true,
  prepareDesktop: true,
  onRuntimeStreamReady: true,
  onRuntimeStreamEnded: true,
  runSession: true,
  env: true,
  renderObserverFn: true,
  detachedTimers: true,
  onPhase: true,
  now: true,
  proberCadenceMs: true,
  handoffDeadlineMs: true,
  readLobbyCodeFromFrame: true,
  packLocalTree: true,
  score: true,
  deriveFeedback: true,
  deriveArtifacts: true,
};
const terminalMembers: Record<keyof TerminalProductLabHooks, true> = {
  loadModule: true,
  env: true,
  renderObserverFn: true,
  now: true,
  costProbe: true,
  score: true,
  deriveFeedback: true,
};
const scriptedMembers: Record<keyof ScriptedBrowserLabHooks, true> = {
  runSession: true,
  launchBrowser: true,
  env: true,
  loadDesktopModule: true,
  prepareDesktop: true,
  detachedTimers: true,
  browserCommand: true,
  renderObserverFn: true,
  now: true,
};
const analysisMembers: Record<keyof AutomaticAnalysisHooks, true> = {
  deps: true,
  onStart: true,
  run: true,
};

/** The members each bag type declares, forwarded even when the bag does not enumerate them. */
export const HOOK_MEMBERS = {
  cua: Object.keys(cuaMembers),
  sharedWorld: Object.keys(sharedWorldMembers),
  terminal: Object.keys(terminalMembers),
  scripted: Object.keys(scriptedMembers),
  analysis: Object.keys(analysisMembers),
} as const;

/**
 * The bag with `overrides` in place of its own members. Every other member becomes an enumerable
 * accessor that reads the bag when it is read, so a getter runs only then and a spread of the
 * result keeps every member. The members are the bag's own and inherited keys (string or symbol)
 * plus `declared`, the members its type declares, which a proxy-backed bag may answer without
 * listing. A function is bound to the bag, so its private fields still work. The overrides are
 * ordinary data properties. Declared members always appear as own properties (undefined when
 * unset), so code reading a wrapped bag tests the value, never `in`.
 */
export function withHookOverrides<T extends object>(
  bag: T | undefined,
  declared: readonly string[],
  overrides: Partial<T>,
): T {
  const forward: Record<PropertyKey, unknown> = {};
  const replaced = new Set(Reflect.ownKeys(overrides));
  const forwardMember = (key: string | symbol): void => {
    if (key === "constructor" || replaced.has(key) || Object.hasOwn(forward, key)) return;
    Object.defineProperty(forward, key, {
      enumerable: true,
      configurable: true,
      get() {
        const value: unknown = Reflect.get(bag!, key, bag);
        return typeof value === "function" ? value.bind(bag) : value;
      },
      set(value: unknown) {
        Reflect.set(bag!, key, value, bag);
      },
    });
  };
  if (bag !== undefined) {
    for (
      let source: object | null = bag;
      source !== null && source !== Object.prototype;
      source = Object.getPrototypeOf(source) as object | null
    )
      for (const key of Reflect.ownKeys(source)) forwardMember(key);
    for (const key of declared) forwardMember(key);
  }
  for (const key of replaced) {
    Object.defineProperty(forward, key, {
      value: (overrides as Record<PropertyKey, unknown>)[key],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return forward as T;
}
