import { formatCuaDiagnostics, formatCuaStopCause } from "../../routes/computer-use/diagnostics.js";
import type { CuaActorLabResult } from "../../routes/computer-use/types.js";
import type { ScriptedBrowserLabResult } from "../../routes/scripted/types.js";
import type { TerminalProductLabResult } from "../../routes/terminal/types.js";
import type { ConcurrentSharedWorldLabResult } from "../../routes/shared-world/types.js";

export function formatConcurrentSharedWorldLabHuman(
  result: ConcurrentSharedWorldLabResult,
): string {
  return (
    [
      `humanish lab concurrent-shared-world ${result.ok ? (result.dryRun ? "dry-run" : "live") : "failed"}`,
      ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
      `run: ${result.runId}`,
      `lab: ${result.labId}`,
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
          `persona ${participant.id} (${participant.persona}): ${participant.status}${participant.session ? ` (${participant.session.completionReason})` : ""} ${participant.ok ? "ok" : "not-ok"}`,
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
      `humanish lab terminal ${result.ok ? (result.dryRun ? "dry-run" : "live") : "failed"}`,
      ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
      `run: ${result.runId}`,
      `lab: ${result.labId}`,
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
      `humanish lab scripted ${result.ok ? (result.dryRun ? "dry-run" : "live") : "failed"}`,
      ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
      `run: ${result.runId}`,
      `lab: ${result.labId}`,
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
      `humanish lab cua ${result.ok ? (result.dryRun ? "dry-run" : "live") : "failed"}`,
      ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
      `run: ${result.runId}`,
      `lab: ${result.labId}`,
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
              `participant ${participant.id}: ${participant.status}${participant.session ? ` (${participant.session.completionReason})` : ""}${participant.diagnostics ? ` · ${formatCuaDiagnostics(participant.diagnostics)}` : ""}${participant.session ? ` · ${participant.session.reason}` : ""}`,
          )
        : []),
      ...(result.session && (result.lanes?.length ?? 0) <= 1
        ? [
            `session: ${result.session.status} (${result.session.completionReason})${result.session.stopCause ? ` · ${formatCuaStopCause(result.session.stopCause)}` : ""} · ${result.session.reason}`,
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
