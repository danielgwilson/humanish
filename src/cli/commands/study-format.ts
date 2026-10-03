import type { CliError, HumanOutput } from "../io.js";
import { formatCuaDiagnostics, formatCuaStopCause } from "../../routes/computer-use/diagnostics.js";
import type { CuaActorStudyResult } from "../../routes/computer-use/types.js";
import type { ScriptedBrowserStudyResult } from "../../routes/scripted/types.js";
import type { TerminalProductStudyResult } from "../../routes/terminal/types.js";
import type { ConcurrentSharedWorldStudyResult } from "../../routes/shared-world/types.js";

/** A lab run's first lines: the command that ran, whether it was a dry run, how it ended, and its route. */
function runHeader(
  result: { ok: boolean; dryRun?: boolean; studyId: string },
  route: "computer-use" | "terminal" | "scripted" | "shared-world",
): string[] {
  const kind = result.dryRun === true ? "dry run" : result.dryRun === false ? "live run" : "run";
  return [
    `humanish run ${result.studyId}: ${kind} ${result.ok ? "finished" : "failed"}`,
    `route: ${route}`,
  ];
}

/**
 * A run's human output: its lines on stdout and, when it failed with an error, that error on
 * stderr through formatCliError.
 */
function withError(error: CliError | undefined, lines: string[]): HumanOutput {
  const stdout = `${lines.join("\n")}\n`;
  return error === undefined ? stdout : { stdout, error };
}

/** A participant's status in words: a dry run's placeholder status says that nothing ran live. */
function participantStatus(status: string): string {
  return status === "contract_proof_only" ? "dry run, nothing ran live" : status;
}

export function formatConcurrentSharedWorldStudyHuman(
  result: ConcurrentSharedWorldStudyResult,
): HumanOutput {
  return withError(result.error, [
    ...runHeader(result, "shared-world"),
    `run: ${result.runId}`,
    `actor: ${result.actor}`,
    `topology: ${result.topology}/${result.topologyMode} (${result.roleCount} persona${result.roleCount === 1 ? "" : "s"}, concurrency ${result.concurrency})`,
    ...(result.host ? [`host: ${result.host}`] : []),
    ...(result.subject?.commit
      ? [`plane: ${result.subject.repo}@${result.subject.commit.slice(0, 12)}`]
      : []),
    ...(result.overlapProven === undefined
      ? []
      : [
          `overlap: ${result.overlapProven ? "proven" : "not observed"} (this run only; no scale or adoption claim)`,
        ]),
    ...result.roles.map(
      (participant) =>
        `persona ${participant.id} (${participant.persona}): ${participantStatus(participant.status)}${participant.session ? ` (${participant.session.completionReason})` : ""}${participant.ok ? "" : ", not ok"}`,
    ),
    ...(result.subjectSandbox
      ? [
          `subject sandbox: ${result.subjectSandbox.sandboxId} killed=${result.subjectSandbox.killed ? "yes" : "no"}`,
        ]
      : []),
    ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
    ...(result.observer?.opened === undefined
      ? []
      : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
    ...result.warnings.map((warning) => `warning: ${warning}`),
  ]);
}

export function formatTerminalStudyHuman(result: TerminalProductStudyResult): HumanOutput {
  return withError(result.error, [
    ...runHeader(result, "terminal"),
    `run: ${result.runId}`,
    `actor: ${result.actor}`,
    `product: ${result.product}`,
    ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
    ...(result.observer?.opened === undefined
      ? []
      : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
    ...result.warnings.map((warning) => `warning: ${warning}`),
  ]);
}

export function formatScriptedStudyHuman(result: ScriptedBrowserStudyResult): HumanOutput {
  return withError(result.error, [
    ...runHeader(result, "scripted"),
    `run: ${result.runId}`,
    `actor: ${result.actor}`,
    `subject: ${result.appUrl}`,
    ...(result.scenario
      ? [
          `scenario: ${result.scenario.id} @ ${result.scenario.sourceDigest.slice(0, 12)} (${result.scenario.source}, ${result.scenario.steps} step${result.scenario.steps === 1 ? "" : "s"})`,
        ]
      : []),
    ...result.sessions.map(
      (session) =>
        `session ${session.surface}: ${session.status} (${session.completionReason}) · ${session.reason} [${session.screenshots} screenshot${session.screenshots === 1 ? "" : "s"}]`,
    ),
    ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
    ...(result.observer?.opened === undefined
      ? []
      : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
    ...result.warnings.map((warning) => `warning: ${warning}`),
  ]);
}

export function formatCuaStudyHuman(result: CuaActorStudyResult): HumanOutput {
  return withError(result.error, [
    ...runHeader(result, "computer-use"),
    `run: ${result.runId}`,
    `actor: ${result.actor}`,
    `subject: ${result.appUrl}`,
    ...(result.subject?.source === "clone"
      ? [
          `repo: ${result.subject.repo}${result.subject.commit ? `@${result.subject.commit.slice(0, 12)}` : ""}${result.subject.envNames && result.subject.envNames.length > 0 ? ` env=[${result.subject.envNames.join(", ")}]` : ""}`,
        ]
      : []),
    ...(result.rerun
      ? [`rerun: ${result.rerun.selectedLaneIds.join(", ")} from ${result.rerun.sourceRunId}`]
      : []),
    ...(result.diagnostics ? [`diagnostic: ${formatCuaDiagnostics(result.diagnostics)}`] : []),
    ...((result.lanes?.length ?? 0) > 1
      ? result.lanes!.map(
          (participant) =>
            `participant ${participant.id}: ${participantStatus(participant.status)}${participant.session ? ` (${participant.session.completionReason})` : ""}${participant.diagnostics ? ` · ${formatCuaDiagnostics(participant.diagnostics)}` : ""}${participant.session ? ` · ${participant.session.reason}` : ""}`,
        )
      : []),
    ...(result.session && (result.lanes?.length ?? 0) <= 1
      ? [
          `session: ${participantStatus(result.session.status)} (${result.session.completionReason})${result.session.stopCause ? ` · ${formatCuaStopCause(result.session.stopCause)}` : ""} · ${result.session.reason}`,
          `screenshots: ${result.session.screenshots}`,
        ]
      : []),
    ...(result.sandbox
      ? [
          `sandbox: ${result.sandbox.sandboxId} stream=${result.sandbox.streamUrlPresent ? "connected" : "missing"} killed=${result.sandbox.killed ? "yes" : "no"}`,
        ]
      : []),
    ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
    ...(result.observer?.opened === undefined
      ? []
      : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
    ...result.warnings.map((warning) => `warning: ${warning}`),
  ]);
}
