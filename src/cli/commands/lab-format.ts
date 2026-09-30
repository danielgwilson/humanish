import { formatCuaDiagnostics, formatCuaStopCause } from "../../routes/computer-use/diagnostics.js";
import type { CuaActorLabResult } from "../../routes/computer-use/lab.js";
import type { ScriptedBrowserLabResult } from "../../routes/scripted-browser.js";
import type { TerminalProductLabResult } from "../../routes/terminal/lab.js";
import type { SharedWorldLabResult } from "../../routes/shared-world/sequential.js";
import type { ConcurrentSharedWorldLabResult } from "../../routes/shared-world/concurrent.js";

export function formatSharedWorldLabHuman(result: SharedWorldLabResult): string {
  return (
    [
      `humanish lab shared-world ${result.ok ? (result.dryRun ? "dry-run" : "live") : "failed"}`,
      ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
      `run: ${result.runId}`,
      `lab: ${result.labId}`,
      `actor: ${result.actor}`,
      `topology: ${result.topology} (${result.roleCount} role${result.roleCount === 1 ? "" : "s"})`,
      `sequence: ${result.sequence.join(" -> ") || "(none)"}`,
      ...(result.subject?.commit
        ? [`plane: ${result.subject.repo}@${result.subject.commit.slice(0, 12)}`]
        : []),
      ...result.roles.map(
        (role) =>
          `role ${role.id} (${role.persona}): ${role.status}${role.session ? ` (${role.session.completionReason})` : ""}${role.skippedReason ? ` · ${role.skippedReason}` : ""}`,
      ),
      ...(result.sandbox
        ? [`sandbox: ${result.sandbox.sandboxId} killed=${result.sandbox.killed ? "yes" : "no"}`]
        : []),
      ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
      ...(result.observer?.opened === undefined
        ? []
        : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
      ...result.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n") + "\n"
  );
}

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
        (role) =>
          `persona ${role.id} (${role.persona}): ${role.status}${role.session ? ` (${role.session.completionReason})` : ""} ${role.ok ? "ok" : "not-ok"}`,
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
            (lane) =>
              `lane ${lane.id}: ${lane.status}${lane.session ? ` (${lane.session.completionReason})` : ""}${lane.diagnostics ? ` · ${formatCuaDiagnostics(lane.diagnostics)}` : ""}${lane.session ? ` · ${lane.session.reason}` : ""}`,
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
