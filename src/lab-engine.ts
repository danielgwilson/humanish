// The single lab engine. A lab is a config (mimetic.lab.v2); runLab routes it to an execution
// backend by COMPOSITION — subject.source x execution.target — not by a hardcoded `kind`.
//
// The four backends (synthetic dry/browser, clone smoke, clone+E2B-desktop meta, app-url
// computer-use) are genuinely distinct execution substrates and stay as proven primitives;
// runLab is the one entry that maps config -> backend options. Adding a new actor/execution
// extends routing via the registries + these selectors, never via a new `kind` in a closed
// enum. On the cua route the two axes are visibly orthogonal: subject x execution selects the
// substrate here, while actors[0].type selects WHICH registered actor runs the session inside
// it (resolved through the actor registry in cua-actor-lab.ts).

import { runCuaActorLab, type CuaActorLabHooks, type CuaActorLabResult } from "./cua-actor-lab.js";
import {
  runScriptedBrowserLab,
  type ScriptedBrowserLabHooks,
  type ScriptedBrowserLabResult
} from "./scripted-browser-lab.js";
import { DEFAULT_OSS_REPOS, runOssLab, type OssLabResult } from "./oss-lab.js";
import { runOssMetaLab, type OssMetaLabResult } from "./oss-meta-lab.js";
import type { ObserverResult } from "./observer.js";
import { runDryRun, type RunResult } from "./run.js";
import { routesToComputerUse, routesToScriptedBrowser, type LabConfig } from "./lab-config.js";

export type LabBackend = "synthetic" | "smoke" | "meta" | "cua" | "scripted";

/** Runtime overrides from CLI flags. Each wins over the config when provided. */
export interface RunLabOptions {
  cwd: string;
  runId?: string;
  dryRun?: boolean;
  open?: boolean;
  /** Lane override: synthetic sims, smoke repo limit, or meta desktop count. */
  count?: number;
  repos?: string[];
  keep?: boolean;
  redactRepos?: boolean;
  codexAppServer?: boolean;
  /** Meta watch-follow plumbing. */
  completionTimeoutMs?: number;
  onObserverReady?: (observer: ObserverResult & { ok: true }) => Promise<void> | void;
  /** Computer-use route hooks: subject provisioning (library callers) + test DI seams. */
  cuaHooks?: CuaActorLabHooks;
  /** Scripted-browser route hooks: browser injection + test DI seams (mirror of cuaHooks). */
  scriptedHooks?: ScriptedBrowserLabHooks;
}

export type LabOutcome =
  | { backend: "synthetic"; result: RunResult }
  | { backend: "smoke"; result: OssLabResult }
  | { backend: "meta"; result: OssMetaLabResult }
  | { backend: "cua"; result: CuaActorLabResult }
  | { backend: "scripted"; result: ScriptedBrowserLabResult };

/**
 * Route a lab config to its execution backend from its declared composition.
 * subject.source x execution.target are orthogonal primitives; where both axes collide
 * (clone x e2b-desktop hosts both the meta bootstrap AND the computer-use serve path) the
 * actor LANE disambiguates — via routesToComputerUse, the single shared predicate.
 */
export function selectLabBackend(config: LabConfig): LabBackend {
  if (routesToScriptedBrowser(config)) {
    // app-url subjects whose first actor resolves to a registered scripted-browser actor:
    // deterministic local replay, no model.
    return "scripted";
  }
  if (routesToComputerUse(config) || config.subject.source === "app-url") {
    // app-url subjects with a computer-use actor, and clone x e2b-desktop subjects whose first
    // actor resolves to a registered computer-use actor (the lab clones AND serves the app
    // in-sandbox). The bare app-url fallback keeps library-API configs with unknown actor
    // types routing to the cua backend's fail-closed MIMETIC_CUA_LAB_ACTOR_UNSUPPORTED.
    return "cua";
  }
  if (config.subject.source === "clone") {
    return config.execution?.target === "e2b-desktop" ? "meta" : "smoke";
  }
  // this-repo runs through the synthetic dry-run path (runDryRun).
  return "synthetic";
}

/** First actor's declared lane count, if any. */
function actorLaneCount(config: LabConfig): number | undefined {
  return config.actors[0]?.count;
}

/** Resolve dry-run: explicit override wins, else the scenario mode, else the given fallback. */
export function resolveLabDryRun(config: LabConfig, override: boolean | undefined, fallback: boolean | undefined): boolean | undefined {
  if (override !== undefined) {
    return override;
  }
  if (config.scenario?.mode === "live") {
    return false;
  }
  if (config.scenario?.mode === "dry-run") {
    return true;
  }
  return fallback;
}

export async function runLab(config: LabConfig, options: RunLabOptions): Promise<LabOutcome> {
  const backend = selectLabBackend(config);
  const fanout = config.subject.clone?.fanout ?? config.subject.repos?.length ?? DEFAULT_OSS_REPOS.length;

  switch (backend) {
    case "synthetic": {
      const result = await runDryRun({
        cwd: options.cwd,
        dryRun: resolveLabDryRun(config, options.dryRun, true) ?? true,
        simCount: options.count ?? actorLaneCount(config) ?? 4,
        ...(options.runId === undefined ? {} : { runId: options.runId })
      });
      return { backend, result };
    }
    case "smoke": {
      const keep = options.keep ?? config.subject.clone?.keep;
      const repos = options.repos ?? config.subject.repos;
      const result = await runOssLab({
        cwd: options.cwd,
        limit: options.count ?? fanout,
        ...(repos === undefined ? {} : { repos }),
        ...(keep === undefined ? {} : { keep }),
        ...(options.runId === undefined ? {} : { runId: options.runId })
      });
      return { backend, result };
    }
    case "meta": {
      const dryRun = resolveLabDryRun(config, options.dryRun, undefined);
      const redactRepoNames = options.redactRepos ?? config.policies?.redactRepos;
      const codexAppServer = options.codexAppServer ?? config.execution?.desktop?.codexAppServer;
      const metaRepos = options.repos ?? config.subject.repos;
      const result = await runOssMetaLab({
        cwd: options.cwd,
        count: options.count ?? fanout,
        ...(metaRepos === undefined ? {} : { repos: metaRepos }),
        ...(dryRun === undefined ? {} : { dryRun }),
        ...(redactRepoNames === undefined ? {} : { redactRepoNames }),
        ...(codexAppServer === undefined ? {} : { codexAppServer }),
        ...(options.open === undefined ? {} : { open: options.open }),
        ...(options.completionTimeoutMs === undefined ? {} : { completionTimeoutMs: options.completionTimeoutMs }),
        ...(options.onObserverReady === undefined ? {} : { onObserverReady: options.onObserverReady }),
        ...(options.runId === undefined ? {} : { runId: options.runId })
      });
      return { backend, result };
    }
    case "cua": {
      // Spend-safe default: a computer-use lab only goes live when the config (or CLI) says so.
      const dryRun = resolveLabDryRun(config, options.dryRun, true) ?? true;
      const result = await runCuaActorLab({
        cwd: options.cwd,
        config,
        dryRun,
        ...(options.open === undefined ? {} : { open: options.open }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(options.cuaHooks === undefined ? {} : { hooks: options.cuaHooks })
      });
      return { backend, result };
    }
    case "scripted": {
      // Same dry-run default. Provider spend is $0 on this route BY MECHANISM (no model in
      // the loop), but `scenario.mode: live` is still the gate: a live scripted run actuates a
      // real browser against a real running app (fills forms, clicks buttons — state-mutating
      // effects on the operator's app), which deserves the same affirmative declaration as
      // spend. This differs deliberately from `run --app-url`, which actuates on invocation.
      const dryRun = resolveLabDryRun(config, options.dryRun, true) ?? true;
      const result = await runScriptedBrowserLab({
        cwd: options.cwd,
        config,
        dryRun,
        ...(options.open === undefined ? {} : { open: options.open }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(options.scriptedHooks === undefined ? {} : { hooks: options.scriptedHooks })
      });
      return { backend, result };
    }
  }
}
