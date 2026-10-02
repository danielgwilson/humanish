import { formatCuaDiagnostics, formatCuaStopCause } from "../../routes/computer-use/diagnostics.js";
import type { CuaActorLabResult } from "../../routes/computer-use/types.js";
import type { ScriptedBrowserLabResult } from "../../routes/scripted/types.js";
import type { TerminalProductLabResult } from "../../routes/terminal/types.js";
import type { ConcurrentSharedWorldLabResult } from "../../routes/shared-world/types.js";

/** A lab run's first lines: the command that ran, whether it was a dry run, how it ended, and its route. */
function runHeader(
  result: { ok: boolean; dryRun?: boolean; labId: string },
  route: "computer-use" | "terminal" | "scripted" | "shared-world",
): string[] {
  const kind = result.dryRun === true ? "dry run" : result.dryRun === false ? "live run" : "run";
  return [
    `humanish run ${result.labId}: ${kind} ${result.ok ? "finished" : "failed"}`,
    `route: ${route}`,
  ];
}

/** A participant's status in words: a dry run's placeholder status says that nothing ran live. */
function participantStatus(status: string): string {
  return status === "contract_proof_only" ? "dry run, nothing ran live" : status;
}

export function formatConcurrentSharedWorldLabHuman(
  result: ConcurrentSharedWorldLabResult,
): string {
  return (
    [
      ...runHeader(result, "shared-world"),
      ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
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
    ].join("\n") + "\n"
  );
}

export function formatTerminalLabHuman(result: TerminalProductLabResult): string {
  return (
    [
      ...runHeader(result, "terminal"),
      ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
      `run: ${result.runId}`,
      `actor: ${result.actor}`,
      `product: ${result.product}`,
      ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
      ...(result.observer?.opened === undefined
        ? []
        : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
      ...result.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n") + "\n"
  );
}

export function formatScriptedLabHuman(result: ScriptedBrowserLabResult): string {
  return (
    [
      ...runHeader(result, "scripted"),
      ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
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
    ].join("\n") + "\n"
  );
}

export function formatCuaLabHuman(result: CuaActorLabResult): string {
  return (
    [
      ...runHeader(result, "computer-use"),
      ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
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
    ].join("\n") + "\n"
  );
}
