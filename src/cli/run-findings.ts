// The end of a live run's output: what its automatic analysis left, read from the run once and
// written both ways. The human output gets the analysis line, then the top findings or the command
// that gets them; `--json` gets the same message and command on `automaticAnalysis`, and a bounded
// `findings` summary when the analysis left findings.

import { rename, writeFile } from "node:fs/promises";

import type { Command } from "commander";
import type { AutomaticAnalysisOutcome } from "../analysis/job.js";
import { cwdFlag, readRunFindings, type AnalysisFindings, type FindingsDeps } from "./findings.js";
import { formatFindingsSummary } from "./findings-text.js";
import { cli } from "./invocation.js";
import { analysisOutcomeText, type CliIo, type HumanOutput, wantsJson, writeResult } from "./io.js";

/** At most this many findings go in `run --json`; `review --json` has every one. */
const TOP_FINDINGS = 5;

/** The findings a live run's analysis left, as `run --json` carries them. */
interface RunFindingsSummary {
  analysisId: string | null;
  status: AnalysisFindings["status"];
  count: number;
  /** Null for an analysis written before design findings. */
  designFindingCount: number | null;
  /** The highest-priority findings, at most five, in the analysis's order. */
  top: {
    id: string;
    title: string;
    headline: string | null;
    impact: AnalysisFindings["findings"][number]["impact"];
    confidence: AnalysisFindings["findings"][number]["confidence"];
    /** The ids of the participants the finding affected. */
    participants: string[];
  }[];
  /** The command that prints every finding with its evidence. */
  review: string;
  /** The Observer page that opens on the findings, or null when the run rendered no Observer. */
  observer: string | null;
  /** analysis.json relative to the project directory. */
  path: string | null;
}

interface RunResultShape {
  runId?: string;
  automaticAnalysis?: AutomaticAnalysisOutcome;
  observer?: { observerPath?: string };
}

function findingsSummary(
  view: AnalysisFindings,
  review: string,
  observerPath: string | undefined,
): RunFindingsSummary {
  return {
    analysisId: view.analysisId,
    status: view.status,
    count: view.findings.length,
    designFindingCount: view.designFindings === null ? null : view.designFindings.length,
    top: view.findings.slice(0, TOP_FINDINGS).map((finding) => ({
      id: finding.id,
      title: finding.title,
      headline: finding.headline,
      impact: finding.impact,
      confidence: finding.confidence,
      participants: finding.affected.map((participant) => participant.streamId),
    })),
    review,
    observer: observerPath === undefined ? null : `${observerPath}#/report`,
    path: view.path,
  };
}

/** What the run's analysis left: the message, the command, the human lines and any findings. */
async function readRunReport(
  cwd: string,
  result: RunResultShape,
  deps: FindingsDeps,
): Promise<
  | {
      message: string;
      nextCommand: string | null;
      lines: string[];
      findings?: RunFindingsSummary;
    }
  | undefined
> {
  const outcome = result.automaticAnalysis;
  if (outcome === undefined || result.runId === undefined || result.runId === "not-created")
    return undefined;
  const outcomeLine = `analysis: ${analysisOutcomeText(outcome)}`;
  // What the attempt warned about, such as a request sent again after it ran out of output.
  const warningLines = (outcome.result?.warnings ?? []).map((warning) => `analysis: ${warning}`);
  const plain = {
    message: `The automatic analysis was ${analysisOutcomeText(outcome)}.`,
    nextCommand: null,
    lines: [outcomeLine, ...warningLines],
  };
  // A dry run left no evidence, and its own output names the live run.
  if (outcome.reason === "AUTOMATIC_ANALYSIS_DRY_RUN") return plain;
  const analysisId = outcome.result?.analysisId;
  const finished = outcome.state === "complete" || outcome.state === "partial";
  let view: AnalysisFindings;
  try {
    view = await readRunFindings(cwd, result.runId, finished ? analysisId : undefined, deps);
  } catch {
    return plain;
  }
  const rejected = outcome.result?.rejectedOutputPath;
  const rejectedLine = rejected
    ? [
        `analysis: ${outcome.result?.error?.code ?? "rejected"}; the rejected output is kept locally at ${rejected}`,
      ]
    : [];
  const review = cli(`review --run ${view.runId}${cwdFlag(cwd)}`);
  if (finished && (view.state === "ready" || view.state === "stale"))
    return {
      message: view.message,
      nextCommand: review,
      lines: [
        outcomeLine,
        ...warningLines,
        ...rejectedLine,
        ...formatFindingsSummary(view, review),
      ],
      findings: findingsSummary(view, review, result.observer?.observerPath),
    };
  // The line reads "analysis: skipped because ...", as it does without the view.
  const said = view.message.replace(/^The automatic analysis (?:was )?/, "");
  return {
    message: view.message,
    nextCommand: view.next,
    lines: [
      `analysis: ${said}`,
      ...warningLines,
      ...rejectedLine,
      ...(view.next === null ? [] : [`next: ${view.next}`]),
    ],
  };
}

/**
 * Writes a finished run's result. After the route's own output it says what the automatic
 * analysis did and the command a person runs next; when the analysis left findings, the top ones.
 * `--json` carries the same message and command on `automaticAnalysis` and the findings summary
 * as `findings`. A run with no analysis record is written as writeResult writes it.
 */
export async function writeRunResult<T extends RunResultShape>(
  command: Command,
  io: CliIo,
  cwd: string,
  result: T,
  formatHuman: (result: T) => HumanOutput,
  deps: FindingsDeps = {},
): Promise<void> {
  const report = await readRunReport(cwd, result, deps);
  if (report === undefined || result.automaticAnalysis === undefined) {
    writeResult(command, io, result, formatHuman);
    return;
  }
  if (!wantsJson(command)) {
    writeResult(command, io, result, formatHuman, report.lines);
    return;
  }
  writeResult(
    command,
    io,
    {
      ...result,
      automaticAnalysis: {
        ...result.automaticAnalysis,
        message: report.message,
        nextCommand: report.nextCommand,
      },
      ...(report.findings === undefined ? {} : { findings: report.findings }),
    },
    // JSON output never calls the human formatter.
    () => "",
  );
}

/**
 * Write `value` to `file` as JSON in one rename, so a reader polling for it never sees it half
 * written. A remote run's launcher reads it while this process keeps serving the Observer.
 */
export async function writeResultFile(file: string, value: unknown): Promise<void> {
  const partial = `${file}.partial`;
  await writeFile(partial, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(partial, file);
}
