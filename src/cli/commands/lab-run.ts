import {
  automaticAnalysisBudget,
  formatAutomaticAnalysisBudget,
} from "../../analysis/automatic-config.js";
import { resolve } from "node:path";
import { Command } from "commander";
import { deriveStudyFacts } from "../telemetry.js";
import { resolveLabManifest } from "../../lab/discover.js";
import type { LabResolveFailure } from "../../lab/discover.js";
import { resolveLabDryRun } from "../../lab/engine.js";
import { backendOf, type LabRoute, routeOf } from "../../lab/plan.js";
import type { LabConfig } from "../../lab/types.js";
import type { RunLabProvenance } from "../../run/status.js";
import type { RunResult } from "../../run/results.js";
import { cuaBackendRun } from "./lab-backend-cua.js";
import { type BackendRun, runBackend } from "./lab-backend-run.js";
import { scriptedBackendRun } from "./lab-backend-scripted.js";
import { sharedWorldBackendRun } from "./lab-backend-shared-world.js";
import { syntheticBackendRun } from "./lab-backend-synthetic.js";
import { terminalBackendRun } from "./lab-backend-terminal.js";
import { maybeLoadAdapterScorer } from "./lab-hooks.js";
import {
  type CliIo,
  formatRunHuman,
  type LabCommandOptions,
  noteStudyFacts,
  writeResult,
} from "../io.js";
import { watchExposeRequested } from "../observer-follow.js";
import { WATCH_SAFE_NOT_APPLICABLE_MESSAGE } from "../../observer/exposure.js";

export async function runLabCommand(args: {
  command: Command;
  io: CliIo;
  lab: string;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const resolved = await resolveLabManifest(args.options.cwd, args.lab);
  if (!resolved.ok) {
    writeResult(args.command, args.io, resolved, formatLabResolveFailureHuman);
    args.io.setExitCode(2);
    return;
  }

  // Surface forward-declared-field + .yml warnings on run/watch too, not only on inspect.
  // Otherwise a setting that does nothing is silently swallowed on the path users actually run.
  for (const warning of resolved.warnings) {
    args.io.writeErr(`warning: ${warning}\n`);
  }

  const config = resolved.config;
  // The run's identity (#455): which manifest, where it lives, and whether it is committed, a
  // local overlay, or an explicit path. Resolved once here — the only place that knows all three —
  // and carried into the run's status record and bundle so the filesystem can answer "which lab
  // produced this run" without the old `persona.source = "lab:<id>"` string convention.
  const lab: RunLabProvenance = { id: config.id, path: resolved.path, origin: resolved.origin };
  // Named here, once, for every backend: a synthetic or terminal result carries no labId, so the
  // starter lab `first-run` went unnamed in telemetry while the computer-use ones were named.
  noteStudyFacts(args.command, deriveStudyFacts({ labId: config.id }));
  const route = routeOf(config);
  if (route !== "computer-use" && labRerunFlagsRequested(args.options)) {
    writeUnsupportedRerunFlagsResult(args, backendOf(route));
    return;
  }
  // Exposure serves a live desktop, which only the computer-use backend produces. Refuse it on any
  // other backend rather than silently ignoring it.
  if (route !== "computer-use" && watchExposeRequested(args.options)) {
    const result: RunResult = {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: resolve(args.options.cwd),
      warnings: [],
      error: {
        code: "HUMANISH_WATCH_OPTION_CONFLICT",
        message: `--expose/--tunnel/--oauth stream a live desktop and apply only to computer-use labs; this lab resolved to ${backendOf(route)}.`,
      },
    };
    writeResult(args.command, args.io, result, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }
  // A live run is never share_ready, so watch --safe admits nothing. The computer-use backend
  // refuses it through validateExposure; refuse it here for the others.
  if (route !== "computer-use" && args.options.safe === true) {
    const result: RunResult = {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: resolve(args.options.cwd),
      warnings: [],
      error: {
        code: "HUMANISH_WATCH_SAFE_NOT_APPLICABLE",
        message: WATCH_SAFE_NOT_APPLICABLE_MESSAGE,
      },
    };
    writeResult(args.command, args.io, result, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }

  // The backend's setup refuses bad options, and runLab's plan refuses bad labs, before the scorer
  // loads, so neither imports the scorer's host code. The route's own checks of this machine (keys,
  // subject env, a browser, a free run id) still come after the scorer loads.
  const run = backendRunFor(route, { ...args, config, labProvenance: lab });
  if (run === undefined) return;

  // #316: resolve + load a config-declared/CLI-flagged adopter scorer FAIL-CLOSED, before any spend,
  // and only for a plan that will run. A declared gate that cannot load (bad ref, not found, load
  // failure, no hooks, unsupported backend) aborts with exit 2 rather than green-passing.
  await runBackend(config, run, async () => {
    const scorerLoad = await maybeLoadAdapterScorer({
      cwd: args.options.cwd,
      config,
      route,
      flag: args.options.scorer,
    });
    if (!scorerLoad.ok) {
      const result: RunResult = {
        schema: "humanish.run-result.v1",
        ok: false,
        cwd: resolve(args.options.cwd),
        warnings: [],
        error: scorerLoad.error,
      };
      writeResult(args.command, args.io, result, formatRunHuman);
      args.io.setExitCode(2);
      return undefined;
    }
    const scorer = scorerLoad.scorer;
    if (scorer) {
      // Cross-repo guardrail: `humanish lab run` now import()s host JS named in the manifest.
      // Surface it so the invoker (who may not be the manifest author) knows executable code ran.
      args.io.writeErr(
        `warning: review scorer ${scorer.provenance.ref} (${scorer.provenance.source}) is executable host code loaded and run in-process — review it as code, not config.\n`,
      );
    }
    const analysisBudget = automaticAnalysisBudget(config.review?.analysis, route);
    if (analysisBudget && resolveLabDryRun(config, args.options.dryRun, true) === false) {
      args.io.writeErr(`${formatAutomaticAnalysisBudget(analysisBudget)}\n`);
    }
    return scorer === undefined ? {} : { scorer };
  });
}

/** The route's backend setup. Undefined when the setup has already written its own result. */
function backendRunFor(
  route: LabRoute,
  args: {
    command: Command;
    io: CliIo;
    lab: string;
    config: LabConfig;
    labProvenance: RunLabProvenance;
    mode: "run" | "watch";
    options: LabCommandOptions;
  },
): BackendRun | undefined {
  switch (route) {
    case "preview":
      return syntheticBackendRun(args);
    case "computer-use":
      return cuaBackendRun(args);
    case "scripted":
      return scriptedBackendRun(args);
    case "terminal":
      return terminalBackendRun(args);
    case "shared-world":
      return sharedWorldBackendRun(args);
    default:
      // Compile-time exhaustiveness: a future route must be handled here, not silently no-op.
      throw new Error(`Unhandled lab route: ${String(route satisfies never)}`);
  }
}

function labRerunFlagsRequested(options: LabCommandOptions): boolean {
  return options.rerunFailedFrom !== undefined || options.lanes !== undefined;
}

function writeUnsupportedRerunFlagsResult(
  args: {
    command: Command;
    io: CliIo;
    options: LabCommandOptions;
  },
  backend: string,
): void {
  const result: RunResult = {
    schema: "humanish.run-result.v1",
    ok: false,
    cwd: resolve(args.options.cwd),
    warnings: [],
    error: {
      code: "HUMANISH_UNSUPPORTED_RERUN_FLAGS",
      message: `--rerun-failed-from/--lanes apply only to CUA fan-out labs; this lab resolved to ${backend}.`,
    },
  };
  writeResult(args.command, args.io, result, formatRunHuman);
  args.io.setExitCode(2);
}

function formatLabResolveFailureHuman(result: LabResolveFailure): string {
  return (
    [
      `${result.error.code}: ${result.error.message}`,
      ...result.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n") + "\n"
  );
}
