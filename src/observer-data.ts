import type { RunBundle, RunEvent, RunSimulation, RunStream, RunStreamKind } from "./run.js";

export const OBSERVER_DATA_SCHEMA = "homun.observer-data.v1";

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
  };
  summary: {
    streams: number;
    byKind: Record<RunStreamKind, number>;
    active: number;
    blocked: number;
    warnings: number;
  };
  laneGroups: ObserverLaneGroup[];
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
      knownGaps: bundle.review.gaps
    },
    summary: {
      streams: streams.length,
      byKind,
      active,
      blocked,
      warnings
    },
    laneGroups: buildLaneGroups(bundle),
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
      note: "Observer artifacts are local evidence. Before filing a public issue, use `homun feedback issue` so redaction and public-safety checks gate the payload."
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
