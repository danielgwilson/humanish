import { actorEnding, type ActorEnding } from "../actors/stop-cause.js";
import { isCommsReceivingEvidence, receivingAnalysisContext } from "../comms/receiving-evidence.js";
import {
  formatParticipantOutcomes,
  formatRunTaskFunnel,
  participantOutcomeDetails,
  withCuaReviewProvenance,
} from "../run/outcomes.js";
import { cuaGoalSource, CUA_COMPLETION_NOTE, type CuaGoalSource } from "../actors/goal-source.js";
import type { RunBundle, RunCostSummary, RunEvent, RunSimulation } from "../run/bundle.js";
import { bundleDisplayFacts, runDisplay, type RunDisplay } from "../run/display.js";
import { withoutRequestLists } from "../run/stream-trace.js";
import type { RunStream, RunStreamKind, StoredRunStream } from "../run/streams.js";
import { isRecord } from "../run/type-guards.js";
import { joinObserverData, shellNeedsItems, type ObserverShell } from "./participant-items.js";

/**
 * The Observer's data. From v2 observer-data.json leaves out each participant's items, and from v3
 * each participant's per-request lists (REQUEST_LISTS in src/run/stream-trace.ts), which no part
 * of the page shows.
 */
export const OBSERVER_DATA_SCHEMA = "humanish.observer-data.v3";

interface ObserverArtifactLink {
  label: string;
  href: string;
  kind: string;
}

export interface ObserverData {
  schema: typeof OBSERVER_DATA_SCHEMA;
  schemaVersion: 3;
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
    /** The participants' verdict. `display` says whether the run passed. */
    status: RunBundle["review"]["verdict"];
    /**
     * How the run reads (runDisplay in src/run/display.ts): `passed` only when the verdict is pass
     * and run.json's outcome does not say the run failed. Absent in observer-data.json written
     * before it existed.
     */
    display?: RunDisplay;
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
     * What happened to the participants, with the denominator attached. `status` above collapses the
     * run to one word for a gate; this is the study result, and it is what the person watching
     * through the glass actually wants to know. Absent on a bundle with no participants.
     *
     * A viewing room that shows only vivid moments manufactures certainty from n=1, so the count
     * travels with the outcome here, always (docs/principles/three-roles.md).
     */
    participants?: RunBundle["review"]["participants"];
    /** The same thing as one readable line, so a renderer cannot accidentally show a number
     *  without its denominator. */
    participantsLine?: string;
    /** The study's per-task completion rates, when the study declared a protocol. */
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
   * Optional run-level cost estimate projected straight through from the bundle
   * (humanish.run-cost-summary.v1). Absent when the bundle carries none. The Observer labels every
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
     * Additive + optional: the result of verification at static render or
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

export interface ObserverStream extends StoredRunStream {
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
export function recordedStreamEmbed(
  embed: NonNullable<RunStream["embed"]>,
): NonNullable<RunStream["embed"]> {
  if (!embed) return embed;
  const { runtimeDesktop: _runtimeGrant, ...recorded } = embed as NonNullable<
    RunStream["embed"]
  > & { runtimeDesktop?: unknown };
  return recorded;
}

interface ObserverLaneGroup {
  roleId: string;
  simId: string;
  streamId: string;
  status: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
}

const allKinds: RunStreamKind[] = [
  "ui",
  "browser",
  "terminal",
  "tui",
  "codex-ui",
  "artifact",
  "summary",
];

/**
 * The Observer's projection of a bundle. `statusRecord` is the run's status.json, read for a
 * bundle with no outcome in run.json: a run in progress, interrupted, or recorded before run.json
 * carried its outcome.
 */
export function buildObserverData(
  bundle: RunBundle,
  generatedAt = new Date().toISOString(),
  statusRecord?: unknown,
): ObserverData {
  const byKind = Object.fromEntries(allKinds.map((kind) => [kind, 0])) as Record<
    RunStreamKind,
    number
  >;
  const events = [...(bundle.events ?? [])];
  // Analysis cites this source-backed aggregate as context, not a participant
  // action. Retain its identity for evidence navigation without inventing a
  // timestamp, capture, or actor-trace entry. Raw provider/message data is never
  // part of this projection, including on the best-effort live polling path.
  const receiving = isCommsReceivingEvidence(bundle.commsReceiving)
    ? bundle.commsReceiving
    : undefined;
  const streams = (bundle.streams ?? []).map((stream) => {
    const sim =
      bundle.simulations.find((candidate) => candidate.id === stream.simId) ??
      fallbackSimulation(bundle, stream);
    // The judge's status for the participant wins where the run recorded one, so a participant
    // the verdict counted as blocked or as never engaging shows that way here. A bundle written
    // before the judge's status was recorded keeps the typed-outcome reading: a natural session
    // that finished while declaring a blocker. Never turn an active or failed harness into a
    // participant outcome.
    const status =
      stream.judgedStatus ??
      ((stream.status === "passed" || stream.status === "complete") &&
      stream.actor?.completionReason === "goal_satisfied" &&
      stream.actor.declaredOutcome === "blocked"
        ? "blocked"
        : stream.status);
    byKind[stream.kind] += 1;

    return {
      ...withoutStreamLists(stream),
      ...(stream.embed === undefined ? {} : { embed: recordedStreamEmbed(stream.embed) }),
      status,
      sim,
      kindLabel: kindLabel(stream.kind),
      statusLabel: statusLabel(status, bundle.mode),
      terminalPlain: stripAnsi(stream.terminal?.tail ?? ""),
      timeline: [
        ...events.filter((event) => event.simId === sim.id || event.streamId === stream.id),
        ...(receiving
          ? [
              {
                id: `comms-receiving-${stream.id}`,
                at: "",
                level: "info" as const,
                type: "Harness email receiving (count-only context)",
                message: receivingAnalysisContext(receiving, stream.laneId),
                streamId: stream.id,
              },
            ]
          : []),
      ],
    };
  });

  const warnings = events.filter((event) => event.level === "warn").length;
  const blocked = streams.filter(
    (stream) =>
      stream.status === "blocked" || stream.status === "failed" || stream.status === "timed_out",
  ).length;
  const active = streams.filter(
    (stream) => stream.status === "running" || stream.status === "preparing",
  ).length;

  return withObserverEndings({
    schema: OBSERVER_DATA_SCHEMA,
    schemaVersion: 3,
    generatedAt,
    run: {
      runId: bundle.runId,
      mode: bundle.mode,
      status: bundle.review.verdict,
      display: runDisplay(bundleDisplayFacts(bundle, statusRecord)),
      title: `${bundle.scenario.title} - ${bundle.persona.name}`,
      createdAt: bundle.createdAt,
      simCount: bundle.simCount ?? bundle.simulations.length,
      persona: bundle.persona,
      scenario: bundle.scenario,
      packageName: bundle.source.packageName,
      redaction: bundle.redaction,
      lifecycle: bundle.lifecycle,
      knownGaps: withCuaReviewProvenance(bundle.review, bundle.streams).gaps,
      ...(bundle.review.participants === undefined
        ? {}
        : {
            participants: bundle.review.participants,
          }),
      ...(bundle.review.tasks === undefined
        ? {}
        : {
            tasks: bundle.review.tasks,
            tasksLine: formatRunTaskFunnel(bundle.review.tasks),
          }),
    },
    summary: {
      streams: streams.length,
      byKind,
      active,
      blocked,
      warnings,
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
        kind: artifact.kind,
      })),
    ],
    publicSafety: {
      publishable: false,
      note: "Observer artifacts are local evidence. Before filing a public issue, use `humanish feedback issue` so redaction and public-safety checks gate the payload.",
    },
    raw: {
      bundleSchema: bundle.schema,
      artifactRoot: bundle.artifactRoot,
    },
  });
}

/** The stream without its participant's per-request lists; a saved stream that is not an object as it is. */
function withoutStreamLists<T extends StoredRunStream>(
  stream: T,
): Omit<T, "actor" | "liveActor"> & Pick<StoredRunStream, "actor" | "liveActor"> {
  if (!isRecord(stream)) return stream;
  return {
    ...stream,
    ...(isRecord(stream.actor) ? { actor: withoutRequestLists(stream.actor) } : {}),
    ...(isRecord(stream.liveActor) ? { liveActor: withoutRequestLists(stream.liveActor) } : {}),
  };
}

/**
 * A saved Observer projection as this version reads it, as v3 and unchecked as before. An
 * observer-data.json written before v2 holds every participant's items, and its per-request lists,
 * which are left out. A v2 or v3 one holds no items, so it is read only when no participant has
 * any: showing participants with no steps would say they did nothing, and the items are in the
 * run's traces. Null for a projection that leaves items out, and for a schema other than v1, v2
 * and v3.
 */
export function observerDataFromSaved(value: unknown): ObserverData | null {
  const saved = value as ObserverData | ObserverShell;
  const schema = (saved as { schema?: unknown }).schema;
  if (schema === "humanish.observer-data.v1") {
    const streams = Array.isArray(saved.streams)
      ? (saved as ObserverData).streams.map(withoutStreamLists)
      : saved.streams;
    return { ...(saved as ObserverData), streams, schema: OBSERVER_DATA_SCHEMA, schemaVersion: 3 };
  }
  if (schema !== "humanish.observer-data.v2" && schema !== OBSERVER_DATA_SCHEMA) return null;
  return shellNeedsItems(saved as ObserverShell)
    ? null
    : {
        ...joinObserverData(saved as ObserverShell, null),
        schema: OBSERVER_DATA_SCHEMA,
        schemaVersion: 3,
      };
}

const GOAL_SOURCE_LABELS: Record<CuaGoalSource, string> = {
  participant_report: "Reported complete",
  condition_matched: "Condition matched",
  scheduled_end: "Ran until scheduled end",
  session_cap: "Ran until session cap",
  unavailable: "Completion source unavailable",
};

/** Refresh presentation from recorded actor evidence, including older exported snapshots. */
export function withObserverEndings(data: ObserverData): ObserverData {
  const streams = (data.streams ?? []).map(({ ending: _previousEnding, ...stream }) => {
    const ending = actorEnding(stream.actor);
    const source = cuaGoalSource(stream.actor, stream.status);
    return {
      ...stream,
      ...(ending === undefined ? {} : { ending }),
      ...((stream.status === "passed" || stream.status === "complete") && source !== undefined
        ? {
            statusLabel: GOAL_SOURCE_LABELS[source],
          }
        : {}),
      ...(stream.status === "incomplete" || (ending !== undefined && stream.status === "abandoned")
        ? { statusLabel: "Interrupted" }
        : {}),
    };
  });
  const details = participantOutcomeDetails(streams);
  return {
    ...data,
    streams,
    run: {
      ...data.run,
      ...(data.run.participants !== undefined &&
      data.run.participants.reachedGoal > 0 &&
      details.some((entry) => entry.goalSource !== undefined)
        ? {
            knownGaps: [
              ...data.run.knownGaps.filter((gap) => gap !== CUA_COMPLETION_NOTE),
              CUA_COMPLETION_NOTE,
            ],
          }
        : {}),
      ...(data.run.participants === undefined
        ? {}
        : {
            participantsLine: formatParticipantOutcomes(data.run.participants, details),
          }),
    },
  };
}

function buildLaneGroups(bundle: RunBundle): ObserverLaneGroup[] {
  const outcomes = new Map(
    (bundle.sharedWorld?.outcomes ?? []).map((outcome) => [outcome.roleId, outcome.status]),
  );
  return (bundle.sharedWorld?.laneWindows ?? []).map((lane) => ({
    roleId: lane.roleId,
    simId: lane.simId,
    streamId: lane.streamId,
    status: outcomes.get(lane.roleId) ?? lane.verdict,
    ...(lane.actorType === undefined ? {} : { actorType: lane.actorType }),
    ...(lane.surface === undefined ? {} : { surface: lane.surface }),
    ...(lane.caseGroup === undefined ? {} : { caseGroup: lane.caseGroup }),
  }));
}

function stripAnsi(value: string): string {
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
    currentStep: "Unknown participant stream",
    summary: "This stream did not include matching participant metadata.",
    streamIds: [stream.id],
    startedAt: bundle.createdAt,
    updatedAt: stream.updatedAt,
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

/** `contract_proof_only` reads "Dry run" on a dry run; a live participant with it has no result. */
function statusLabel(status: RunStream["status"], mode: RunBundle["mode"]): string {
  switch (status) {
    case "contract_proof_only":
      return mode === "dry-run" ? "Dry run" : "No verdict";
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
