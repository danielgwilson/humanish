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
import {
  runTerminalProductLab,
  type TerminalProductLabHooks,
  type TerminalProductLabResult
} from "./e2b-terminal-lab.js";
import {
  runSharedWorldLab,
  type SharedWorldLabHooks,
  type SharedWorldLabResult
} from "./shared-world-lab.js";
import {
  runConcurrentSharedWorld,
  type ConcurrentSharedWorldLabResult
} from "./concurrent-shared-world-lab.js";
import { DEFAULT_OSS_REPOS, runOssLab, type OssLabResult } from "./oss-lab.js";
import { runOssMetaLab, type OssMetaLabResult } from "./oss-meta-lab.js";
import type { ObserverResult } from "./observer.js";
import { runDryRun, type RunResult } from "./run.js";
import { routesToComputerUse, routesToConcurrentSharedWorld, routesToScriptedBrowser, routesToSharedWorld, routesToTerminalProduct, type LabConfig } from "./lab-config.js";

export type LabBackend = "synthetic" | "smoke" | "meta" | "cua" | "scripted" | "terminal" | "shared-world" | "concurrent-shared-world";

/** Runtime overrides from CLI flags. Each wins over the config when provided. */
export interface RunLabOptions {
  cwd: string;
  runId?: string;
  dryRun?: boolean;
  open?: boolean;
  /** Lane override: synthetic sims, smoke repo limit, or meta desktop count. */
  count?: number;
  /** CUA fan-out only: create a new run for failed/selected lanes from a prior run. */
  rerun?: {
    sourceRunId: string;
    laneIds?: string[];
  };
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
  /** Terminal-product route hooks: SLICE 2 sandbox/runtime-auth DI seams (mirror of cuaHooks). */
  terminalHooks?: TerminalProductLabHooks;
  /** Shared-world route hooks: ONE-sandbox / runSession / checkpoint DI seams (mirror of cuaHooks). */
  sharedWorldHooks?: SharedWorldLabHooks;
}

export type LabOutcome =
  | { backend: "synthetic"; result: RunResult }
  | { backend: "smoke"; result: OssLabResult }
  | { backend: "meta"; result: OssMetaLabResult }
  | { backend: "cua"; result: CuaActorLabResult }
  | { backend: "scripted"; result: ScriptedBrowserLabResult }
  | { backend: "terminal"; result: TerminalProductLabResult }
  | { backend: "shared-world"; result: SharedWorldLabResult }
  | { backend: "concurrent-shared-world"; result: ConcurrentSharedWorldLabResult };

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
  if (routesToTerminalProduct(config) || config.subject.source === "terminal-product") {
    // terminal-product subjects whose first actor resolves to a registered terminal actor: a real
    // autonomous agent studying a CLI/product from public surfaces inside an E2B shell. The bare
    // terminal-product fallback keeps library-API configs with unknown actor types routing to the
    // terminal backend's fail-closed MIMETIC_TERMINAL_LAB_ACTOR_UNSUPPORTED.
    return "terminal";
  }
  if (routesToConcurrentSharedWorld(config)) {
    // shared-world + execution.concurrency > 1 (#164 phase 2): ONE getHost-exposed plane + N actor
    // sandboxes driving it AT ONCE. Checked BEFORE the sequential shared-world route (the
    // concurrency knob picks the substrate; N=1 stays sequential).
    return "concurrent-shared-world";
  }
  if (routesToSharedWorld(config)) {
    // clone × e2b-desktop × a computer-use actor that DECLARES topology: shared-world (#164): ONE
    // provisioned plane, N role seats taking sequential turns. Checked BEFORE the cua route — the
    // same composition without the topology declaration stays per-lane-worlds (cua).
    return "shared-world";
  }
  if (routesToComputerUse(config)
    || config.subject.source === "app-url"
    || config.subject.source === "local-app") {
    // app-url subjects with a computer-use actor, local-app subjects (an already-running local
    // dev server driven in-process via a custom executor), and clone x e2b-desktop subjects
    // whose first actor resolves to a registered computer-use actor (the lab clones AND serves
    // the app in-sandbox). The bare app-url/local-app fallback keeps library-API configs with
    // unknown actor types routing to the cua backend's fail-closed MIMETIC_CUA_LAB_ACTOR_UNSUPPORTED
    // (and, for local-app without hooks, MIMETIC_CUA_LAB_LOCAL_APP_NO_EXECUTOR).
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
        // CLI --count overrides the HOMOGENEOUS fan-out lane count (ignored when a lanes roster
        // is declared — the roster length is authoritative).
        ...(options.count === undefined ? {} : { countOverride: options.count }),
        ...(options.open === undefined ? {} : { open: options.open }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
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
    case "terminal": {
      // Spend-safe default: a terminal-product lab places a live key inside the sandbox on the
      // live path (SLICE 2), so it only goes live when the config (or CLI) affirmatively says so.
      // SLICE 1 implements the dry-run contract bundle only; a live call fails closed.
      const dryRun = resolveLabDryRun(config, options.dryRun, true) ?? true;
      const result = await runTerminalProductLab({
        cwd: options.cwd,
        config,
        dryRun,
        ...(options.open === undefined ? {} : { open: options.open }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(options.terminalHooks === undefined ? {} : { hooks: options.terminalHooks })
      });
      return { backend, result };
    }
    case "shared-world": {
      // Spend-safe default: a shared-world lab provisions a real sandbox + plane on the live path,
      // so it only goes live when the config (or CLI) affirmatively says so. The deterministic PoC
      // proof is fully $0 via the sharedWorldHooks DI seam.
      const dryRun = resolveLabDryRun(config, options.dryRun, true) ?? true;
      const result = await runSharedWorldLab({
        cwd: options.cwd,
        config,
        dryRun,
        ...(options.open === undefined ? {} : { open: options.open }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(options.sharedWorldHooks === undefined ? {} : { hooks: options.sharedWorldHooks })
      });
      return { backend, result };
    }
    case "concurrent-shared-world": {
      // Spend-safe default: a concurrent shared-world run provisions a real subject sandbox + N
      // actor sandboxes on the live path, so it only goes live when the config (or CLI) affirms it.
      // The deterministic PoC proof is fully $0 via the sharedWorldHooks DI seam.
      const dryRun = resolveLabDryRun(config, options.dryRun, true) ?? true;
      const result = await runConcurrentSharedWorld({
        cwd: options.cwd,
        config,
        dryRun,
        ...(options.open === undefined ? {} : { open: options.open }),
        ...(options.onObserverReady === undefined ? {} : { onObserverReady: options.onObserverReady }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(options.sharedWorldHooks === undefined ? {} : { hooks: options.sharedWorldHooks })
      });
      return { backend, result };
    }
  }
}
