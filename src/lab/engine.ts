import { isLocalBrowserLab, localBrowserDefaults } from "../substrates/local/runtime-config.js";
// The single lab engine. A lab is a config (humanish.lab.v2); runLab routes it to an execution
// backend by COMPOSITION — subject.source x execution.target — not by a hardcoded `kind`.
//
// Five backends ship: synthetic, computer-use, scripted-browser, terminal-product and shared
// world. runLab is the one entry
// that maps config -> backend options. Core contributors extend the closed first-party actor union
// and these selectors rather than adding a lab `kind`. On actor-backed routes, subject x execution
// selects the substrate while actors[0].type selects a registered first-party actor.

import { resolveAutomaticAnalysis } from "../analysis/automatic-config.js";
import type { AutomaticAnalysisHooks } from "../analysis/automatic-completion.js";
import path from "node:path";
import { runCuaActorLab } from "../routes/computer-use/lab.js";
import { type CuaActorLabHooks, type CuaActorLabResult } from "../routes/computer-use/types.js";
import {
  runScriptedBrowserLab,
  type ScriptedBrowserLabHooks,
  type ScriptedBrowserLabResult,
} from "../routes/scripted-browser.js";
import { runTerminalProductLab } from "../routes/terminal/lab.js";
import {
  type TerminalProductLabHooks,
  type TerminalProductLabResult,
} from "../routes/terminal/types.js";
import { type SharedWorldLabHooks } from "../routes/shared-world/hooks.js";
import {
  runConcurrentSharedWorld,
  type ConcurrentSharedWorldLabResult,
} from "../routes/shared-world/concurrent.js";
import { withRunStatusScope, type RunLabProvenance } from "../run/status.js";
import type { ObserverResult } from "../observer/render.js";
import { runDryRun } from "../run/dry-run.js";
import { type RunResult, type RunScorerProvenance } from "../run/bundle.js";
import { automaticAnalysisRouteReason, taskProtocolValidationReason } from "./validation.js";
import { backendOf, routeOf } from "./plan.js";
import { type LabConfig } from "./types.js";

export type LabBackend = "synthetic" | "cua" | "scripted" | "terminal" | "concurrent-shared-world";

/** Runtime overrides from CLI flags. Each wins over the config when provided. */
export interface RunLabOptions {
  automaticAnalysis?: AutomaticAnalysisHooks;
  cwd: string;
  runId?: string;
  /** Which manifest this run came from (#455): threaded to the backend so the run's own
   *  status record and bundle can say which lab produced it. Absent for library callers who
   *  hand a LabConfig directly — the run is then honestly lab-less rather than guessed. */
  lab?: RunLabProvenance;
  dryRun?: boolean;
  open?: boolean;
  /** Lane override: synthetic sims or computer-use desktop count. */
  count?: number;
  /** CUA fan-out only: create a new run for failed/selected lanes from a prior run. */
  rerun?: {
    sourceRunId: string;
    laneIds?: string[];
  };
  onObserverReady?: (observer: ObserverResult & { ok: true }) => Promise<void> | void;
  /** Computer-use route hooks: subject provisioning (library callers) + test DI seams. */
  cuaHooks?: CuaActorLabHooks;
  /** Scripted-browser route hooks: browser injection + test DI seams (mirror of cuaHooks). */
  scriptedHooks?: ScriptedBrowserLabHooks;
  /** Terminal-product route hooks: sandbox/runtime-auth DI seams (mirror of cuaHooks). */
  terminalHooks?: TerminalProductLabHooks;
  /** Shared-world route hooks: sandbox / runSession / checkpoint DI seams (mirror of cuaHooks). */
  sharedWorldHooks?: SharedWorldLabHooks;
  /**
   * CONFIG-DECLARED scorer provenance (#316), forwarded alongside whichever hooks bag carries the
   * loaded scorer. Its presence is the "declared" marker the terminal route reads to flip a
   * status:"fail" verdict; the browser routes stamp it as evidence (they already flip). Core-computed
   * (path + digest), never adopter-supplied; absent for library callers.
   */
  scorerProvenance?: RunScorerProvenance;
}

export type LabOutcome =
  | { backend: "synthetic"; result: RunResult }
  | { backend: "cua"; result: CuaActorLabResult }
  | { backend: "scripted"; result: ScriptedBrowserLabResult }
  | { backend: "terminal"; result: TerminalProductLabResult }
  | { backend: "concurrent-shared-world"; result: ConcurrentSharedWorldLabResult };

/** The backend a config runs on: `routeOf` in plan.ts, under its older name. */
export function selectLabBackend(config: LabConfig): LabBackend {
  return backendOf(routeOf(config));
}

/** First actor's declared lane count, if any. */
function actorLaneCount(config: LabConfig): number | undefined {
  return config.actors[0]?.count;
}

/** Resolve dry-run: explicit override wins, else the scenario mode, else the given fallback. */
export function resolveLabDryRun(
  config: LabConfig,
  override: boolean | undefined,
  fallback: boolean | undefined,
): boolean | undefined {
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

/**
 * The one seam every lab backend is dispatched through. The body runs inside a status scope so a
 * backend that fails closed and RETURNS an error result — 18 such exits across the backends — can
 * never leave its liveness record ticking as though the run were still going. See
 * `withRunStatusScope`.
 */
export async function runLab(config: LabConfig, options: RunLabOptions): Promise<LabOutcome> {
  return withRunStatusScope(() => runLabInScope(config, options));
}

async function runLabInScope(config: LabConfig, options: RunLabOptions): Promise<LabOutcome> {
  config = localBrowserDefaults(config);
  const backend = selectLabBackend(config);
  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  const analysisReason = analysis.ok ? automaticAnalysisRouteReason(config) : analysis.message;
  const receivingReason =
    String(config.comms?.email?.kind) === "real"
      ? "Real email receiving is unsupported on this backend. Use a supported hosted computer-use study."
      : undefined;
  const tasksReason = analysisReason ?? taskProtocolValidationReason(config);
  const admissionReason = receivingReason ?? tasksReason;
  if (admissionReason && backend === "synthetic") {
    const cwd = path.resolve(options.cwd);
    const code = receivingReason
      ? "HUMANISH_LAB_COMMS_UNSUPPORTED"
      : analysisReason
        ? analysis.ok
          ? "HUMANISH_LAB_ANALYSIS_UNSUPPORTED"
          : "HUMANISH_LAB_ANALYSIS_INVALID"
        : "HUMANISH_LAB_TASKS_UNSUPPORTED";
    const error = { code, message: admissionReason } as const;
    return {
      backend,
      result: {
        schema: "humanish.run-result.v1",
        ok: false,
        cwd,
        warnings: [],
        error,
      },
    };
  }

  switch (backend) {
    case "synthetic": {
      const result = await runDryRun({
        ...(options.lab === undefined ? {} : { lab: options.lab }),
        cwd: options.cwd,
        dryRun: resolveLabDryRun(config, options.dryRun, true) ?? true,
        simCount: options.count ?? actorLaneCount(config) ?? 4,
        ...(options.runId === undefined ? {} : { runId: options.runId }),
      });
      return { backend, result };
    }
    case "cua": {
      // The config selects the local browser study. Two hooks keep a run out of it: with
      // createDesktopLane the caller (or the study re-entering here) provides the desktop, and
      // with buildExecutor the caller drives the app in process and needs no desktop. Every other
      // hook, such as a scorer, travels with the study.
      const hooks = options.cuaHooks;
      if (
        isLocalBrowserLab(config) &&
        hooks?.createDesktopLane === undefined &&
        hooks?.buildExecutor === undefined
      ) {
        const { runLocalFirecrackerStudy } =
          await import("../substrates/local/firecracker-study.js");
        return runLocalFirecrackerStudy({ ...options, config });
      }
      // Spend-safe default: a computer-use lab only goes live when the config (or CLI) says so.
      const dryRun = resolveLabDryRun(config, options.dryRun, true) ?? true;
      const result = await runCuaActorLab({
        ...(options.automaticAnalysis === undefined
          ? {}
          : { automaticAnalysis: options.automaticAnalysis }),
        ...(options.lab === undefined ? {} : { lab: options.lab }),
        cwd: options.cwd,
        config,
        dryRun,
        // CLI --count overrides the HOMOGENEOUS fan-out lane count (ignored when a lanes roster
        // is declared — the roster length is authoritative).
        ...(options.count === undefined ? {} : { countOverride: options.count }),
        ...(options.open === undefined ? {} : { open: options.open }),
        ...(options.onObserverReady === undefined
          ? {}
          : { onObserverReady: options.onObserverReady }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
        ...(options.cuaHooks === undefined ? {} : { hooks: options.cuaHooks }),
        ...(options.scorerProvenance === undefined
          ? {}
          : { scorerProvenance: options.scorerProvenance }),
      });
      return { backend, result };
    }
    case "scripted": {
      // Same dry-run default. Provider spend is $0 on this route BY MECHANISM (no model in
      // the loop), but `scenario.mode: live` is still the gate: a live scripted run actuates a
      // real browser against a real running app (fills forms, clicks buttons — state-mutating
      // effects on the operator's app), which deserves the same affirmative declaration as
      // spend.
      const dryRun = resolveLabDryRun(config, options.dryRun, true) ?? true;
      const result = await runScriptedBrowserLab({
        ...(options.automaticAnalysis === undefined
          ? {}
          : { automaticAnalysis: options.automaticAnalysis }),
        ...(options.lab === undefined ? {} : { lab: options.lab }),
        cwd: options.cwd,
        config,
        dryRun,
        ...(options.open === undefined ? {} : { open: options.open }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(options.scriptedHooks === undefined ? {} : { hooks: options.scriptedHooks }),
      });
      return { backend, result };
    }
    case "terminal": {
      // Spend-safe default: the shipped live route passes a runtime key only to the in-sandbox
      // agent command, so it goes live only when the config or CLI affirmatively says so. Dry-run
      // emits contract evidence without creating a sandbox, reading a key, or spending.
      const dryRun = resolveLabDryRun(config, options.dryRun, true) ?? true;
      const result = await runTerminalProductLab({
        ...(options.automaticAnalysis === undefined
          ? {}
          : { automaticAnalysis: options.automaticAnalysis }),
        ...(options.lab === undefined ? {} : { lab: options.lab }),
        cwd: options.cwd,
        config,
        dryRun,
        ...(options.open === undefined ? {} : { open: options.open }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(options.terminalHooks === undefined ? {} : { hooks: options.terminalHooks }),
        ...(options.scorerProvenance === undefined
          ? {}
          : { scorerProvenance: options.scorerProvenance }),
      });
      return { backend, result };
    }
    case "concurrent-shared-world": {
      // Spend-safe default: a concurrent shared-world run provisions a real subject sandbox + N
      // actor sandboxes on the live path, so it only goes live when the config (or CLI) affirms it.
      // The deterministic PoC proof is fully $0 via the sharedWorldHooks DI seam.
      const dryRun = resolveLabDryRun(config, options.dryRun, true) ?? true;
      const result = await runConcurrentSharedWorld({
        ...(options.automaticAnalysis === undefined
          ? {}
          : { automaticAnalysis: options.automaticAnalysis }),
        ...(options.lab === undefined ? {} : { lab: options.lab }),
        cwd: options.cwd,
        config,
        dryRun,
        ...(options.open === undefined ? {} : { open: options.open }),
        ...(options.onObserverReady === undefined
          ? {}
          : { onObserverReady: options.onObserverReady }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(options.sharedWorldHooks === undefined ? {} : { hooks: options.sharedWorldHooks }),
        ...(options.scorerProvenance === undefined
          ? {}
          : { scorerProvenance: options.scorerProvenance }),
      });
      return { backend, result };
    }
  }
}
