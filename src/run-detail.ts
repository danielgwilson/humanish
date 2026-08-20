// What ONE run is doing right now (#455).
//
// The run index answers "which runs exist and are any alive" for every run in a project, cheaply
// and without opening evidence. This answers a different question about a SINGLE run — who is in
// it, what are they thinking, how far have they got — and it does open the bundle, because that is
// where the answer lives. That trade is only affordable for the one run someone is looking at,
// which is exactly when it is asked.
//
// The shape it reads from is the actor trace (`humanish.actor-trace.v1`), in two places:
//   - `stream.liveActor` while a run is in flight (the mid-run flush), and
//   - `stream.actor` once it has finished.
// Reading both means the same screen renders a run the whole way through rather than going blank
// at the moment it completes.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { estimateActorCost } from "./pricing.js";

import { resolveRunPath } from "./run.js";

export const RUN_DETAIL_SCHEMA = "humanish.run-detail.v1";

/** A participant's most recent recorded thinking. Quoted, never summarized. */
export interface RunThought {
  /** The provider's reasoning summary, verbatim. */
  text: string;
  /** Its own heading, when the provider gave one ("reasoning turn 25"). */
  title?: string;
  at?: string;
}

export interface RunParticipant {
  /** Stream id — stable within a run, and what distinguishes lanes of one study. */
  id: string;
  /** What to call them on screen: the lane's own label, else the persona id. */
  label: string;
  /** The persona id, when the trace recorded one. */
  personaId?: string;
  /**
   * The persona's declared traits (`patience:medium`, `skill:medium`, …). This is the abbreviated
   * persona a reader actually wants beside a live thought — it says who is struggling, which a
   * name alone does not.
   */
  traits: string[];
  /** `running`, `passed`, `failed`, `contract_proof_only` — the lane's own word for itself. */
  status?: string;
  /** Why the actor stopped, when it has. */
  completionReason?: string;
  thought?: RunThought;
  turns?: number;
  actions?: number;
  /**
   * Thoughts recorded so far. The mid-run flush carries the trace ITEMS but not the `counts` block,
   * so a live participant has no turn count to show — but the thoughts can be counted directly, and
   * "8 thoughts" is a true statement about progress rather than an inferred turn number.
   */
  thoughts?: number;
  /** `null` when declared absent; absent when never recorded. Never coerced to 0. */
  estimatedCostUsd?: number | null;
}

export interface RunDetail {
  schema: typeof RUN_DETAIL_SCHEMA;
  runId: string;
  participants: RunParticipant[];
  /**
   * Repo-relative path to this run's self-contained Observer artifact, when it has been written.
   * The terminal cannot show screenshots; this is where the operator goes for the pictures.
   */
  observerPath?: string;
}

/** The narrow slice of the actor trace this reads. Deliberately not the whole schema. */
interface ActorTraceFacts {
  persona?: { id?: string; traitsApplied?: string[] };
  status?: string;
  completionReason?: string;
  counts?: { turns?: number; actions?: number };
  estimatedCost?: { estimatedCostUsd?: number | null };
  /** Running usage during a live run; the finished trace carries its own `estimatedCost`. */
  tokenUsage?: Record<string, unknown>;
  ids?: { model?: string };
  items?: { kind?: string; title?: string; text?: string; at?: string; lifecycle?: string }[];
}

interface StreamFacts {
  id?: string;
  label?: string;
  status?: string;
  actor?: ActorTraceFacts;
  liveActor?: ActorTraceFacts;
}

/**
 * The latest reasoning a participant has recorded.
 *
 * Takes the LAST reasoning item rather than the newest by timestamp: the trace is append-ordered by
 * construction, and half of a live flush may not carry `at` yet. An item still in flight is skipped
 * — a partial thought read mid-write would be quoted as though the participant had finished it.
 */
function latestThought(trace: ActorTraceFacts): RunThought | undefined {
  const items = trace.items ?? [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== "reasoning") continue;
    if (item.lifecycle !== undefined && item.lifecycle !== "completed") continue;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text === "") continue;
    return {
      text,
      ...(typeof item.title === "string" && item.title !== "" ? { title: item.title } : {}),
      ...(typeof item.at === "string" ? { at: item.at } : {})
    };
  }
  return undefined;
}

function participantFrom(stream: StreamFacts, index: number): RunParticipant {
  // A live run's flush wins over the finished trace: while both exist, the live one is the newer
  // account of what is happening.
  const trace = stream.liveActor ?? stream.actor ?? {};
  const id = stream.id ?? `stream-${index + 1}`;
  const personaId = trace.persona?.id;
  // Computed once: calling it twice to test-then-use reads as though the two could differ.
  const thought = latestThought(trace);
  const status = trace.status ?? stream.status;
  const thoughts = (trace.items ?? []).filter((item) => item?.kind === "reasoning").length;
  return {
    id,
    label: stream.label ?? personaId ?? id,
    ...(personaId === undefined ? {} : { personaId }),
    traits: Array.isArray(trace.persona?.traitsApplied) ? trace.persona.traitsApplied : [],
    ...(status === undefined ? {} : { status }),
    ...(trace.completionReason === undefined ? {} : { completionReason: trace.completionReason }),
    ...(thought === undefined ? {} : { thought }),
    ...(typeof trace.counts?.turns === "number" ? { turns: trace.counts.turns } : {}),
    ...(typeof trace.counts?.actions === "number" ? { actions: trace.counts.actions } : {}),
    ...(thoughts > 0 ? { thoughts } : {}),
    ...costOf(trace)
  };
}

/**
 * What a participant has spent, priced the same way whether the run is finished or in flight.
 *
 * A finished trace carries its own `estimatedCost`. A live one carries the RUNNING usage and the
 * model it prices at, so the same estimator gives a figure mid-run instead of the screen reporting
 * the cost as unknown until the moment the run ends — which is the half of a run where knowing what
 * it is costing actually changes what you do.
 */
function costOf(trace: ActorTraceFacts): { estimatedCostUsd?: number | null } {
  const recorded = trace.estimatedCost?.estimatedCostUsd;
  if (recorded !== undefined) return { estimatedCostUsd: recorded };
  const usage = trace.tokenUsage;
  const model = trace.ids?.model;
  if (usage === undefined || typeof model !== "string") return {};
  try {
    const estimated = estimateActorCost(usage as never, model);
    // A model `src/pricing.ts` cannot price yields no figure rather than a wrong one.
    return typeof estimated?.estimatedCostUsd === "number" ? { estimatedCostUsd: estimated.estimatedCostUsd } : {};
  } catch {
    return {};
  }
}

/**
 * Read one run's participants. Returns null when the run has no readable bundle yet — an ordinary
 * state for a run that has just started, not a failure.
 *
 * Reads the bundle NARROWLY rather than through `loadRunBundle`, which applies the strict
 * evidence-of-record guard. That guard is right for verification and wrong here: a mid-run flush is
 * a partial document by definition, so validating it as a complete bundle would make the live view
 * — the only view that needs this — the one case that never renders. Nothing read here is treated
 * as a claim about what a participant did; it is what to put on a screen.
 */
export async function readRunDetail(cwdInput: string, runId: string): Promise<RunDetail | null> {
  const runPaths = await resolveRunPath(path.resolve(cwdInput), runId).catch(() => null);
  if (runPaths === null) return null;

  let bundle: { streams?: StreamFacts[]; runId?: string };
  try {
    const raw = await readFile(path.join(runPaths.absoluteRunRoot, "run.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    bundle = parsed as { streams?: StreamFacts[]; runId?: string };
  } catch {
    // Absent or torn: the run has not written one yet, or is writing it now.
    return null;
  }

  const streams = Array.isArray(bundle.streams) ? bundle.streams : [];
  const cwd = path.resolve(cwdInput);
  const observerAbsolute = path.join(runPaths.absoluteRunRoot, "observer", "index.html");

  return {
    schema: RUN_DETAIL_SCHEMA,
    runId: bundle.runId ?? runId,
    participants: streams.map(participantFrom),
    ...(observerAbsolute.startsWith(cwd)
      ? { observerPath: path.relative(cwd, observerAbsolute) }
      : { observerPath: observerAbsolute })
  };
}
