import { actorEnding, type ActorEnding } from "./actor-stop-cause.js";
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
  /** Served-only liveness observation. Never a replacement for the recorded evidence verdict. */
  runtime?: {
    state: "running" | "finished" | "interrupted" | "unknown";
    observedAt: string;
    source: "local-run-status";
  };
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
    /**
     * ADDITIVE + OPTIONAL (#584): the result of verification at static render or
     * export time. Unverified projections omit this field. The timestamp records
     * that check; it is not an assertion about subsequent file changes.
     */
    share?: {
      status: "share_ready" | "local_only" | "blocked";
      verifiedAt: string;
      reasons: string[];
    };
  };
  raw: {
    bundleSchema: string;
    artifactRoot: string;
  };
}

export interface ObserverStream extends RunStream {
  /** Only the attached server may grant provider-origin access for a live desktop iframe. */
  embed?: NonNullable<RunStream["embed"]> & { runtimeDesktop?: true };
  /** Participant-facing status. The actor and simulation retain their original protocol status. */
  status: RunStream["status"];
  /** Precise recorded interruption; absent when the source carries no cause. */
  ending?: ActorEnding;
  sim: RunSimulation;
  kindLabel: string;
  statusLabel: string;
  terminalPlain: string;
  timeline: RunEvent[];
}

/** Discard a forged or stale runtime grant before projecting persisted evidence. */
export function recordedStreamEmbed(embed: NonNullable<RunStream["embed"]>): NonNullable<RunStream["embed"]> {
  if (!embed) return embed;
  const { runtimeDesktop: _runtimeGrant, ...recorded } = embed as NonNullable<RunStream["embed"]> & { runtimeDesktop?: unknown };
  return recorded;
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
    // A natural session can finish its protocol while the participant explicitly reports a
    // blocker (#690). Match the review's typed-outcome rule without rewriting the raw trace or
    // guessing from prose. Never turn an active or failed harness into a participant outcome.
    const status = (stream.status === "passed" || stream.status === "complete")
      && stream.actor?.completionReason === "goal_satisfied"
      && stream.actor.declaredOutcome === "blocked"
      ? "blocked"
      : stream.status;
    byKind[stream.kind] += 1;

    return {
      ...stream,
      ...(stream.embed === undefined ? {} : { embed: recordedStreamEmbed(stream.embed) }),
      status,
      sim,
      kindLabel: kindLabel(stream.kind),
      statusLabel: statusLabel(status),
      terminalPlain: stripAnsi(stream.terminal?.tail ?? ""),
      timeline: events.filter((event) => event.simId === sim.id || event.streamId === stream.id)
    };
  });

  const warnings = events.filter((event) => event.level === "warn").length;
  const blocked = streams.filter((stream) => stream.status === "blocked" || stream.status === "failed" || stream.status === "timed_out").length;
  const active = streams.filter((stream) => stream.status === "running" || stream.status === "preparing").length;

  return withObserverEndings({
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
            participants: bundle.review.participants
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
  });
}

/** Refresh presentation from recorded actor evidence, including older exported snapshots. */
export function withObserverEndings(data: ObserverData): ObserverData {
  const streams = (data.streams ?? []).map(({ ending: _previousEnding, ...stream }) => {
    const ending = actorEnding(stream.actor);
    return {
      ...stream,
      ...(ending === undefined ? {} : { ending }),
      ...(stream.status === "incomplete" || (ending !== undefined && stream.status === "abandoned")
        ? { statusLabel: "Interrupted" } : {})
    };
  });
  return {
    ...data,
    streams,
    run: {
      ...data.run,
      ...(data.run.participants === undefined ? {} : {
        participantsLine: formatParticipantOutcomes(data.run.participants, streams.flatMap((stream) => stream.actor === undefined ? []
          : [{ status: stream.actor.status, ...(stream.ending === undefined ? {} : { label: stream.ending.label }) }]))
      })
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
      return "Interrupted";
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
