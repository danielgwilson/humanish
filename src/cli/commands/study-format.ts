import { participantCaption } from "../../run/participant-caption.js";
import type { CliError, HumanOutput } from "../io.js";
import { formatCuaDiagnostics, formatCuaStopCause } from "../../routes/computer-use/diagnostics.js";
import type { CuaActorStudyResult } from "../../routes/computer-use/types.js";
import type { ScriptedBrowserStudyResult } from "../../routes/scripted/types.js";
import type { TerminalProductStudyResult } from "../../routes/terminal/types.js";
import type { ConcurrentSharedWorldStudyResult } from "../../routes/shared-world/types.js";
import type { StudySubject } from "../../study/types.js";
import { subjectName } from "../../run/subject-name.js";

/**
 * A run's first lines: the command that ran, whether it was a dry run, how it ended, and its route.
 * `runOk` is the run's own ok, which automaticAnalysisEnvelope keeps when an analysis that did not
 * complete turns `ok` false. That run finished, and the line says so.
 */
function runHeader(
  result: { ok: boolean; runOk?: boolean; dryRun?: boolean; studyId: string },
  route: "computer-use" | "terminal" | "scripted" | "shared-world",
): string[] {
  const kind = result.dryRun === true ? "dry run" : result.dryRun === false ? "live run" : "run";
  const ending = result.ok
    ? "finished"
    : result.runOk === true
      ? "finished; the analysis did not complete"
      : "failed";
  return [`humanish run ${result.studyId}: ${kind} ${ending}`, `route: ${route}`];
}

/**
 * A run's human output: its lines on stdout and, when it failed with an error, that error on
 * stderr through formatCliError.
 */
function withError(error: CliError | undefined, lines: string[]): HumanOutput {
  const stdout = `${lines.join("\n")}\n`;
  return error === undefined ? stdout : { stdout, error };
}

/** How a summary names a sandbox: by digest. The raw id is only in the run's receipts. */
function sandboxName(sandbox: { sandboxId: string; sandboxIdDigest?: string }): string {
  return sandbox.sandboxIdDigest !== undefined
    ? `[redacted-sandbox-id ${sandbox.sandboxIdDigest}]`
    : sandbox.sandboxId;
}

/**
 * One line per run naming the file that holds its raw sandbox ids, for the operator, when the
 * result names a sandbox at all (each one carries a digest).
 */
function sandboxIdsLine(result: { runId?: string }): string[] {
  return result.runId && JSON.stringify(result).includes('"sandboxIdDigest"')
    ? [`sandbox ids: .humanish/runs/${result.runId}/sandbox-receipts.ndjson`]
    : [];
}

/**
 * The `subject:` line's name for the study's declared subject. A refusal made before the route
 * resolved a URL has none, so it names the URL the study declares.
 */
function subjectLine(appUrl: string, subject: StudySubject): string {
  const named = subjectName(appUrl, { source: subject.source, product: subject.product?.name });
  return named !== "" ? named : (subject.appUrl ?? subject.serve?.url ?? subject.source);
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
    `participants: ${result.roleCount}, up to ${result.concurrency} at once`,
    ...(result.host ? [`host: ${result.host}`] : []),
    ...(result.subject?.commit
      ? [`app: ${result.subject.repo}@${result.subject.commit.slice(0, 12)}`]
      : []),
    ...(result.overlapProven === undefined
      ? []
      : [
          result.overlapProven
            ? "Participants used the app at the same time (observed in this run only)."
            : "Participants were not observed using the app at the same time.",
        ]),
    ...result.roles.map(
      (participant) =>
        `${participantCaption({ id: participant.id, personaId: participant.persona })}: ${participantStatus(participant.status)}${participant.ok ? "" : ", not ok"}`,
    ),
    ...(result.subjectSandbox
      ? [
          `subject sandbox: ${sandboxName(result.subjectSandbox)} killed=${result.subjectSandbox.killed ? "yes" : "no"}`,
        ]
      : []),
    ...sandboxIdsLine(result),
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
    ...(result.sandbox
      ? [`sandbox: ${sandboxName(result.sandbox)} killed=${result.sandbox.killed ? "yes" : "no"}`]
      : []),
    ...sandboxIdsLine(result),
    ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
    ...(result.observer?.opened === undefined
      ? []
      : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
    ...result.warnings.map((warning) => `warning: ${warning}`),
  ]);
}

/** `subject` is the study's declared subject, which names it when the result has no URL. */
export function formatScriptedStudyHuman(
  result: ScriptedBrowserStudyResult,
  subject: StudySubject,
): HumanOutput {
  return withError(result.error, [
    ...runHeader(result, "scripted"),
    `run: ${result.runId}`,
    `actor: ${result.actor}`,
    `subject: ${subjectLine(result.appUrl, subject)}`,
    ...(result.scenario
      ? [
          `scenario: ${result.scenario.id} @ ${result.scenario.sourceDigest.slice(0, 12)} (${result.scenario.source}, ${result.scenario.steps} step${result.scenario.steps === 1 ? "" : "s"})`,
        ]
      : []),
    ...result.sessions.map(
      (session) =>
        `session ${session.surface}: ${session.status} (${session.completionReason}) · ${session.reason} [${session.screenshots} screenshot${session.screenshots === 1 ? "" : "s"}]`,
    ),
    ...(result.subjectSandbox
      ? [
          `subject sandbox: ${sandboxName(result.subjectSandbox)} killed=${result.subjectSandbox.killed ? "yes" : "no"}`,
        ]
      : []),
    ...sandboxIdsLine(result),
    ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
    ...(result.observer?.opened === undefined
      ? []
      : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
    ...result.warnings.map((warning) => `warning: ${warning}`),
  ]);
}

/** `subject` is the study's declared subject, which names it when the result has no URL. */
export function formatCuaStudyHuman(
  result: CuaActorStudyResult,
  subject: StudySubject,
): HumanOutput {
  return withError(result.error, [
    ...runHeader(result, "computer-use"),
    `run: ${result.runId}`,
    `actor: ${result.actor}`,
    `subject: ${subjectLine(result.appUrl, subject)}`,
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
          `sandbox: ${sandboxName(result.sandbox)} stream=${result.sandbox.streamUrlPresent ? "connected" : "missing"} killed=${result.sandbox.killed ? "yes" : "no"}`,
        ]
      : []),
    ...sandboxIdsLine(result),
    ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
    ...(result.observer?.opened === undefined
      ? []
      : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
    ...result.warnings.map((warning) => `warning: ${warning}`),
  ]);
}
