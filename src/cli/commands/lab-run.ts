import {
  automaticAnalysisBudget,
  formatAutomaticAnalysisBudget,
} from "../../analysis/automatic-config.js";
import { resolve } from "node:path";
import { Command } from "commander";
import { deriveRunFacts } from "../telemetry.js";
import { resolveStudyManifest } from "../../study/discover.js";
import { warnAndQueue } from "../deprecations.js";
import type { StudyResolveFailure } from "../../study/discover.js";
import { planStudy, resolveStudyDryRun } from "../../study/plan.js";
import { keyNamesOf } from "../../study/requirements.js";
import { type StudyRoute, routeOf } from "../../study/plan.js";
import type { StudyConfig } from "../../study/types.js";
import type { RunStudyProvenance } from "../../run/study-provenance.js";
import type { RunResult } from "../../run/results.js";
import { computerUseRouteRun } from "./lab-route-computer-use.js";
import { type RouteRun, runRoute } from "./lab-route-run.js";
import { scriptedRouteRun } from "./lab-route-scripted.js";
import { sharedWorldRouteRun } from "./lab-route-shared-world.js";
import { previewRouteRun } from "./lab-route-preview.js";
import { terminalRouteRun } from "./lab-route-terminal.js";
import { maybeLoadAdapterScorer } from "./lab-scorer.js";
import {
  type CliIo,
  discoverCliKeys,
  formatRunHuman,
  type LabCommandOptions,
  noteRunFacts,
  writeResult,
  type HumanOutput,
} from "../io.js";
import { watchExposeRequested } from "../observer-follow.js";
import { beginRunSignalPhase } from "./run-signals.js";
import { WATCH_SAFE_NOT_APPLICABLE_MESSAGE } from "../../observer/exposure.js";

export async function runLabCommand(args: {
  command: Command;
  io: CliIo;
  lab: string;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const resolved = await resolveStudyManifest(args.options.cwd, args.lab);
  if (!resolved.ok) {
    writeResult(args.command, args.io, resolved, formatLabResolveFailureHuman);
    args.io.setExitCode(2);
    return;
  }

  // Surface forward-declared-field + .yml warnings on run/watch too, not only on inspect.
  // Otherwise a setting that does nothing is silently swallowed on the path users actually run.
  // Each also goes into the JSON result's warnings[], so a --json caller sees it.
  for (const warning of resolved.warnings) warnAndQueue(args.command, args.io, warning);

  const config = resolved.config;
  // The run's identity: which manifest, where it lives, and whether it is committed, a
  // local overlay, or an explicit path. Resolved once here (the only place that knows all three)
  // and carried into the run's status record and bundle so the filesystem can answer "which lab
  // produced this run" without the old `persona.source = "lab:<id>"` string convention.
  const lab: RunStudyProvenance = { id: config.id, path: resolved.path, origin: resolved.origin };
  // Named here, once, for every route: a preview or terminal result carries no labId, so the
  // starter lab `first-run` went unnamed in telemetry while the computer-use ones were named.
  noteRunFacts(args.command, deriveRunFacts({ labId: config.id }));
  const route = routeOf(config);
  if (route !== "computer-use" && labRerunFlagsRequested(args.options)) {
    writeUnsupportedRerunFlagsResult(args, route);
    return;
  }
  // Exposure serves a live desktop, which only the computer-use route produces. Refuse it on any
  // other route rather than silently ignoring it.
  if (route !== "computer-use" && watchExposeRequested(args.options)) {
    const result: RunResult = {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: resolve(args.options.cwd),
      warnings: [],
      error: {
        code: "HUMANISH_WATCH_OPTION_CONFLICT",
        message: `--expose/--tunnel/--oauth stream a live desktop and apply only to computer-use labs; this lab resolved to the ${route} route.`,
      },
    };
    writeResult(args.command, args.io, result, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }
  // A live run is never share_ready, so watch --safe admits nothing. The computer-use route
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

  // Only a live run reads provider keys, so a dry run looks none up: no `gh auth token`, no e2b
  // login, overlay or key store. A live run fills every key it finds and prints a line only for
  // the keys its plan reads. This comes after the option refusals above, which read no key, and
  // before the route's CLI setup and prepareLab, which do.
  if (resolveStudyDryRun(config, args.options.dryRun, true) === false) {
    const announced = announcedKeyNames(config, args.options);
    await discoverCliKeys({
      io: args.io,
      cwd: args.options.cwd,
      ...(announced === undefined ? {} : { announced }),
    });
  }

  // The route's CLI setup refuses bad options, runLab's plan refuses bad labs, and the route's local
  // checks (keys, runtime auth, subject env, the local agent, caps) refuse this machine, all before
  // the scorer loads, so none imports the scorer's host code. The scripted route's checks and the
  // run-id claim still come after it; the scripted route takes no scorer.
  const routeRun = routeRunFor(route, { ...args, config });
  if (routeRun === undefined) return;
  // Every route's runLab options carry the lab's provenance, from here only.
  const run = { ...routeRun, options: { ...routeRun.options, lab } };

  // From here a signal marks the run interrupted and reclaims its sandboxes (run-signals.ts).
  const signals = beginRunSignalPhase(args.io);
  try {
    // Resolve + load a config-declared/CLI-flagged adopter scorer fail-closed, before any
    // spend, and only for a plan that will run. A declared gate that cannot load (bad ref, not
    // found, load failure, no hooks, unsupported route) aborts with exit 2 rather than green-passing.
    await runRoute(
      config,
      run,
      async () => {
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
            `warning: review scorer ${scorer.provenance.ref} (${scorer.provenance.source}) is code that humanish loaded and ran in this process. Review it as you would any code you run.\n`,
          );
        }
        const analysisBudget = automaticAnalysisBudget(config.review?.analysis, route);
        if (analysisBudget && resolveStudyDryRun(config, args.options.dryRun, true) === false) {
          args.io.writeErr(`${formatAutomaticAnalysisBudget(analysisBudget)}\n`);
        }
        return scorer === undefined ? {} : { scorer };
      },
      // The run is over before presentation, which may own shutdown itself (watch's Observer).
      // A shutdown already begun keeps its handlers and finishes through its cleanups.
      signals.release,
    );
  } finally {
    signals.release();
  }
}

/**
 * The filled keys a live run prints a line for: the ones its plan reads. Count and rerun options
 * change who runs, not which keys. Undefined, so every fill is printed, when a scorer is declared,
 * since its host code may read any key, and when the lab does not plan.
 */
function announcedKeyNames(
  config: StudyConfig,
  options: LabCommandOptions,
): ReadonlySet<string> | undefined {
  if (options.scorer !== undefined || config.review?.scorer !== undefined) return undefined;
  const planned = planStudy(config, { cwd: options.cwd, dryRun: false });
  return planned.ok ? keyNamesOf(planned.planned.plan) : undefined;
}

/** The route's CLI setup. Undefined when the setup has already written its own result. */
function routeRunFor(
  route: StudyRoute,
  args: {
    command: Command;
    io: CliIo;
    lab: string;
    config: StudyConfig;
    mode: "run" | "watch";
    options: LabCommandOptions;
  },
): RouteRun | undefined {
  switch (route) {
    case "preview":
      return previewRouteRun(args);
    case "computer-use":
      return computerUseRouteRun(args);
    case "scripted":
      return scriptedRouteRun(args);
    case "terminal":
      return terminalRouteRun(args);
    case "shared-world":
      return sharedWorldRouteRun(args);
    default:
      // Compile-time exhaustiveness: a future route must be handled here, not silently no-op.
      throw new Error(`Unhandled lab route: ${String(route satisfies never)}`);
  }
}

function labRerunFlagsRequested(options: LabCommandOptions): boolean {
  return options.rerunFailedFrom !== undefined || options.participants !== undefined;
}

function writeUnsupportedRerunFlagsResult(
  args: {
    command: Command;
    io: CliIo;
    options: LabCommandOptions;
  },
  route: StudyRoute,
): void {
  const result: RunResult = {
    schema: "humanish.run-result.v1",
    ok: false,
    cwd: resolve(args.options.cwd),
    warnings: [],
    error: {
      code: "HUMANISH_UNSUPPORTED_RERUN_FLAGS",
      message: `--rerun-failed-from/--participants apply only to computer-use fan-out labs; this lab resolved to the ${route} route.`,
    },
  };
  writeResult(args.command, args.io, result, formatRunHuman);
  args.io.setExitCode(2);
}

function formatLabResolveFailureHuman(result: StudyResolveFailure): HumanOutput {
  const warnings = result.warnings.map((warning) => `warning: ${warning}\n`).join("");
  return { ...(warnings ? { stdout: warnings } : {}), error: result.error };
}
