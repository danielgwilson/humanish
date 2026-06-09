// The single lab engine. A lab is a config (mimetic.lab.v2); runLab routes it to an execution
// backend by COMPOSITION — subject.source x execution.target — not by a hardcoded `kind`.
//
// The three backends (synthetic dry/browser, clone smoke, clone+E2B-desktop meta) are genuinely
// distinct execution substrates and stay as proven primitives; runLab is the one entry that maps
// config -> backend options. Adding a new actor/execution extends routing via the registries +
// these selectors, never via a new `kind` in a closed enum.
//
// PR #1 scope: behavior-preserving structural unification (golden-proven). Per-actor mission
// threading into the live E2B bootstrap + the computer-use actor are PR #2 (live-tested there);
// the v2 schema already carries those fields so the contract is forward-correct.

import { DEFAULT_OSS_REPOS, runOssLab, type OssLabResult } from "./oss-lab.js";
import { runOssMetaLab, type OssMetaLabResult } from "./oss-meta-lab.js";
import type { ObserverResult } from "./observer.js";
import { runDryRun, type RunResult } from "./run.js";
import type { LabConfig } from "./lab-config.js";

export type LabBackend = "synthetic" | "smoke" | "meta";

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
}

export type LabOutcome =
  | { backend: "synthetic"; result: RunResult }
  | { backend: "smoke"; result: OssLabResult }
  | { backend: "meta"; result: OssMetaLabResult };

/**
 * Route a lab config to its execution backend purely from its declared composition.
 * subject.source x execution.target are orthogonal primitives, so this is open to extension
 * (a new subject/execution pairing adds a route) rather than a closed kind enum.
 */
export function selectLabBackend(config: LabConfig): LabBackend {
  if (config.subject.source === "clone") {
    return config.execution?.target === "e2b-desktop" ? "meta" : "smoke";
  }
  // this-repo and app-url both run through the synthetic/browser-proof path (runDryRun).
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
        ...(config.subject.url === undefined ? {} : { appUrl: config.subject.url }),
        ...(options.runId === undefined ? {} : { runId: options.runId })
      });
      return { backend, result };
    }
    case "smoke": {
      const keep = options.keep ?? config.subject.clone?.keep;
      const result = await runOssLab({
        cwd: options.cwd,
        limit: options.count ?? fanout,
        repos: options.repos ?? config.subject.repos ?? [...DEFAULT_OSS_REPOS],
        ...(keep === undefined ? {} : { keep }),
        ...(options.runId === undefined ? {} : { runId: options.runId })
      });
      return { backend, result };
    }
    case "meta": {
      const dryRun = resolveLabDryRun(config, options.dryRun, undefined);
      const redactRepoNames = options.redactRepos ?? config.policies?.redactRepos;
      const codexAppServer = options.codexAppServer ?? config.execution?.desktop?.codexAppServer;
      const result = await runOssMetaLab({
        cwd: options.cwd,
        count: options.count ?? fanout,
        repos: options.repos ?? config.subject.repos ?? [...DEFAULT_OSS_REPOS],
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
  }
}
