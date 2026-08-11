import { formatParticipantOutcomes, formatStudyTaskFunnel } from "./run.js";
import type { RunBundle, RunCostSummary, RunEvent, RunSimulation, RunStream, RunStreamKind } from "./run.js";

export const OBSERVER_DATA_SCHEMA = "humanish.observer-data.v1";

export interface ObserverArtifactLink {
  label: string;
  href: string;
  kind: string;
}

export interface ObserverData {
  schema: typeof OBSERVER_DATA_SCHEMA;
  schemaVersion: 1;
  generatedAt: string;
  run: {
    runId: string;
    mode: RunBundle["mode"];
    status: RunBundle["review"]["verdict"];
    title: string;
    createdAt: string;
    simCount: number;
    persona: RunBundle["persona"];
    scenario: RunBundle["scenario"];
    packageName: string | null;
    redaction: RunBundle["redaction"];
    lifecycle: RunBundle["lifecycle"];
    knownGaps: string[];
    /**
     * What happened to the PARTICIPANTS, with the denominator attached. `status` above collapses the
     * run to one word for a gate; this is the study result, and it is what the person watching
     * through the glass actually wants to know. Absent on a bundle with no participants.
     *
     * A viewing room that shows only vivid moments manufactures certainty from n=1 — so the count
     * travels with the outcome here, always (docs/principles/three-roles.md).
     */
    participants?: RunBundle["review"]["participants"];
    /** The same thing as one readable line, so a renderer cannot accidentally show a number
     *  without its denominator. */
    participantsLine?: string;
    /** The study's per-task completion rates (#414), when the lab declared a protocol. */
    tasks?: RunBundle["review"]["tasks"];
    /** Pre-formatted like participantsLine, denominator on every number. */
    tasksLine?: string;
  };
  summary: {
    streams: number;
    byKind: Record<RunStreamKind, number>;
    active: number;
    blocked: number;
    warnings: number;
  };
  laneGroups: ObserverLaneGroup[];
  /**
   * OPTIONAL run-level cost ESTIMATE projected straight through from the bundle
   * (humanish.run-cost-summary.v1). Absent when the bundle carries none. The Observer LABELS every
   * figure as estimated (rates as of <asOf>) and never presents it as an authoritative charge.
   */
  cost?: RunCostSummary;
  streams: ObserverStream[];
  events: RunEvent[];
  artifactLinks: ObserverArtifactLink[];
  publicSafety: {
    publishable: false;
    note: string;
  };
  raw: {
    bundleSchema: string;
    artifactRoot: string;
  };
}

export interface ObserverStream extends RunStream {
  sim: RunSimulation;
  kindLabel: string;
  statusLabel: string;
  terminalPlain: string;
  timeline: RunEvent[];
}

export interface ObserverLaneGroup {
  roleId: string;
  simId: string;
  streamId: string;
  status: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
}

const allKinds: RunStreamKind[] = ["ui", "browser", "terminal", "tui", "codex-ui", "artifact", "summary"];

export function buildObserverData(bundle: RunBundle, generatedAt = new Date().toISOString()): ObserverData {
  const byKind = Object.fromEntries(allKinds.map((kind) => [kind, 0])) as Record<RunStreamKind, number>;
  const events = [...(bundle.events ?? [])];
  const streams = (bundle.streams ?? []).map((stream) => {
    const sim = bundle.simulations.find((candidate) => candidate.id === stream.simId) ?? fallbackSimulation(bundle, stream);
    byKind[stream.kind] += 1;

    return {
      ...stream,
      sim,
      kindLabel: kindLabel(stream.kind),
      statusLabel: statusLabel(stream.status),
      terminalPlain: stripAnsi(stream.terminal?.tail ?? ""),
      timeline: events.filter((event) => event.simId === sim.id || event.streamId === stream.id)
    };
  });

  const warnings = events.filter((event) => event.level === "warn").length;
  const blocked = streams.filter((stream) => stream.status === "blocked" || stream.status === "failed" || stream.status === "timed_out").length;
  const active = streams.filter((stream) => stream.status === "running" || stream.status === "preparing").length;

  return {
    schema: OBSERVER_DATA_SCHEMA,
    schemaVersion: 1,
    generatedAt,
    run: {
      runId: bundle.runId,
      mode: bundle.mode,
      status: bundle.review.verdict,
      title: `${bundle.scenario.title} - ${bundle.persona.name}`,
      createdAt: bundle.createdAt,
      simCount: bundle.simCount ?? bundle.simulations.length,
      persona: bundle.persona,
      scenario: bundle.scenario,
      packageName: bundle.source.packageName,
      redaction: bundle.redaction,
      lifecycle: bundle.lifecycle,
      knownGaps: bundle.review.gaps,
      ...(bundle.review.participants === undefined
        ? {}
        : {
            participants: bundle.review.participants,
            participantsLine: formatParticipantOutcomes(bundle.review.participants)
          }),
      ...(bundle.review.tasks === undefined
        ? {}
        : {
            tasks: bundle.review.tasks,
            tasksLine: formatStudyTaskFunnel(bundle.review.tasks)
          })
    },
    summary: {
      streams: streams.length,
      byKind,
      active,
      blocked,
      warnings
    },
    laneGroups: buildLaneGroups(bundle),
    ...(bundle.cost === undefined ? {} : { cost: bundle.cost }),
    streams,
    events,
    artifactLinks: [
      { label: "run bundle", href: "../run.json", kind: "bundle" },
      { label: "review JSON", href: "../review.json", kind: "review" },
      { label: "review Markdown", href: "../review.md", kind: "review" },
      { label: "event log", href: "../events.ndjson", kind: "events" },
      { label: "observer data", href: "observer-data.json", kind: "observer" },
      ...(bundle.adapterArtifacts ?? []).map((artifact) => ({
        label: artifact.label,
        href: `../${artifact.path}`,
        kind: artifact.kind
      }))
    ],
    publicSafety: {
      publishable: false,
      note: "Observer artifacts are local evidence. Before filing a public issue, use `humanish feedback issue` so redaction and public-safety checks gate the payload."
    },
    raw: {
      bundleSchema: bundle.schema,
      artifactRoot: bundle.artifactRoot
    }
  };
}

function buildLaneGroups(bundle: RunBundle): ObserverLaneGroup[] {
  const outcomes = new Map(
    (bundle.sharedWorld?.outcomes ?? []).map((outcome) => [outcome.roleId, outcome.status])
  );
  return (bundle.sharedWorld?.laneWindows ?? []).map((lane) => ({
    roleId: lane.roleId,
    simId: lane.simId,
    streamId: lane.streamId,
    status: outcomes.get(lane.roleId) ?? lane.verdict,
    ...(lane.actorType === undefined ? {} : { actorType: lane.actorType }),
    ...(lane.surface === undefined ? {} : { surface: lane.surface }),
    ...(lane.caseGroup === undefined ? {} : { caseGroup: lane.caseGroup })
  }));
}

export function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

function fallbackSimulation(bundle: RunBundle, stream: RunStream): RunSimulation {
  return {
    id: stream.simId,
    index: bundle.simulations.length + 1,
    personaId: bundle.persona.id,
    scenarioId: bundle.scenario.id,
    status: stream.status,
    streamKind: stream.kind,
    mode: "cli-sim",
    progress: 0,
    currentStep: "Unknown sim stream",
    summary: "This stream did not include matching sim metadata.",
    streamIds: [stream.id],
    startedAt: bundle.createdAt,
    updatedAt: stream.updatedAt
  };
}

function kindLabel(kind: RunStreamKind): string {
  switch (kind) {
    case "ui":
      return "UI";
    case "browser":
      return "Browser";
    case "terminal":
      return "CLI";
    case "tui":
      return "TUI";
    case "codex-ui":
      return "Codex UI";
    case "artifact":
      return "Artifact";
    case "summary":
      return "Summary";
  }
}

function statusLabel(status: RunStream["status"]): string {
  switch (status) {
    case "contract_proof_only":
      return "Contract proof";
    case "preparing":
      return "Preparing";
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "passed":
      return "Passed";
    // Participant outcomes read as what happened to a person, not as an error state.
    case "abandoned":
      return "Gave up";
    case "incomplete":
      return "Ran out of session";
    case "complete":
      return "Complete";
    case "blocked":
      return "Blocked";
    case "timed_out":
      return "Timed out";
    case "failed":
      return "Failed";
  }
}
