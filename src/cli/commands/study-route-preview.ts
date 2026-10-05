import { Command } from "commander";
import type { StudyConfig } from "../../study/types.js";
import type { PreviewStudyResult } from "../../routes/preview.js";
import { studyResultIdentity } from "../../run/study-result.js";
import {
  type CliIo,
  formatRunHuman,
  type StudyCommandOptions,
  parseStudyCount,
  writeResult,
} from "../io.js";
import { planObserver, showObserver, staticObserverOpen } from "../observer-follow.js";
import type { RouteRun } from "./study-route-run.js";
import { declaredParticipantCount } from "../../study/study-fields.js";

interface PreviewRouteArgs {
  command: Command;
  io: CliIo;
  study: string;
  config: StudyConfig;
  mode: "run" | "watch";
  options: StudyCommandOptions;
}

/**
 * The preview route's CLI setup: the participant count and Observer plan, its runStudyWith options, and how it
 * presents the outcome. Undefined when setup has already written its own result.
 */
export function previewRouteRun(args: PreviewRouteArgs): RouteRun | undefined {
  const participantCount = parseStudyCount(
    args.options.count,
    declaredParticipantCount(args.config) ?? 4,
  );
  if (participantCount === null) {
    const result: PreviewStudyResult = {
      ...studyResultIdentity("preview", args.config.id),
      ok: false,
      cwd: args.options.cwd,
      warnings: [],
      error: {
        code: "HUMANISH_INVALID_PARTICIPANT_COUNT",
        message: "--count must be a positive integer.",
      },
    };
    writeResult(args.command, args.io, result, formatRunHuman);
    args.io.setExitCode(2);
    return undefined;
  }

  // `run` renders the Observer too, so `run` and `watch` write the same bundle and the first
  // `export` of a run bundle finds observer/index.html. A render failure is a warning on the
  // result, never a failed run. The preview renders through its finished run, so the page shown is
  // the run just written, never a directory swapped in under its id.
  const openOverride = args.options.open ?? args.config.defaults?.open;
  const plan =
    args.mode === "watch"
      ? planObserver({
          command: args.command,
          cwd: args.options.cwd,
          io: args.io,
          port: args.options.port ?? "0",
          ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
          ...(args.options.serve === undefined ? {} : { serve: args.options.serve }),
          ...(openOverride === undefined ? {} : { open: openOverride }),
        })
      : undefined;
  if (plan === null) return undefined;

  return {
    options: {
      cwd: args.options.cwd,
      count: participantCount,
      ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
      ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
      open: plan === undefined ? false : staticObserverOpen(plan),
    },
    present: async (outcome) => {
      if (outcome.route !== "preview") {
        throw new Error(`Expected the preview route, got ${outcome.route}.`);
      }
      const runResult = outcome.result;

      if (plan === undefined) {
        writeResult(args.command, args.io, runResult, formatRunHuman);
        args.io.setExitCode(runResult.ok ? 0 : 2);
        return;
      }

      if (!runResult.ok || runResult.observer === undefined) {
        writeResult(args.command, args.io, runResult, formatRunHuman);
        args.io.setExitCode(2);
        return;
      }

      await showObserver({
        command: args.command,
        io: args.io,
        plan,
        rendered: runResult.observer,
      });
    },
  };
}
