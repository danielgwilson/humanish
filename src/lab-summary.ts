// What a lab IS, for the surface that has to describe it before you spend money (#455).
//
// The run index and run detail answer questions about runs. This answers a question about the LAB
// itself — what it drives, who is in it, which model, and what it is allowed to spend — which is
// what a stakeholder reads on the screen where they decide whether to press Start.
//
// Every field is optional and omitted when the manifest does not declare it. A cap that is not
// declared is not "unlimited" and not "$0"; it is a line the screen does not draw.

import { DEFAULT_OPENAI_CU_MODEL, DEFAULT_OPENAI_CU_REASONING_EFFORT } from "./openai-responses-cu.js";
import { inspectLabManifest } from "./labs.js";
import { probeKeySources } from "./key-resolution.js";

export const LAB_SUMMARY_SCHEMA = "humanish.lab-summary.v1";

export interface LabCaps {
  /** Per-lane blast-radius budget. */
  laneUsd?: number;
  /** Shared study budget across every lane. */
  studyUsd?: number;
}

export interface LabSummary {
  schema: typeof LAB_SUMMARY_SCHEMA;
  labId: string;
  title?: string;
  description?: string;
  /** "clone drawdb-io/drawdb", "app-url http://127.0.0.1:3000/", "this-repo". */
  subject?: string;
  /** How many participants and who they are: `1 × synthetic-new-user`. */
  participants?: string;
  /** The model that will actually run, override or default. */
  model?: string;
  /**
   * The reasoning effort that will actually run, override or default — and "per-lane" when the
   * roster declares more than one, because a single value would be a lie about half the lanes.
   *
   * Shown because it was a silent constant: unreachable from a lab, so every run took the provider
   * default. A study variable you cannot see is one nobody chose (#497).
   */
  reasoningEffort?: string;
  caps: LabCaps;
  /**
   * Whether every key a LIVE run of this lab needs is resolvable right now. `undefined` when not
   * checked. Names only — a value never leaves the key layer.
   */
  keysReady?: boolean;
  missingKeys?: string[];
}

/**
 * The effort every lane will run at, or "per-lane" when they differ. A lane that declares nothing
 * inherits the actor's, and an actor that declares nothing gets the provider default — which is
 * reported as the resolved value, exactly as `model` reports its default rather than hiding it.
 */
function reasoningEffortOf(config: Record<string, unknown>): string {
  const actors = config.actors as
    | { reasoningEffort?: string; lanes?: { reasoningEffort?: string }[] }[]
    | undefined;
  const actor = actors?.[0];
  const fallback = actor?.reasoningEffort ?? DEFAULT_OPENAI_CU_REASONING_EFFORT;
  const lanes = actor?.lanes ?? [];
  const resolved = new Set(lanes.map((lane) => lane.reasoningEffort ?? fallback));
  if (resolved.size > 1) return "per-lane";
  return resolved.size === 1 ? [...resolved][0]! : fallback;
}

/** One short phrase for what the lab drives. */
function subjectOf(config: Record<string, unknown>): string | undefined {
  const subject = config.subject as { source?: string; repos?: string[]; appUrl?: string } | undefined;
  if (subject?.source === undefined) return undefined;
  const repo = subject.repos?.[0];
  if (repo !== undefined) return `${subject.source} ${repo}`;
  if (subject.appUrl !== undefined) return `${subject.source} ${subject.appUrl}`;
  return subject.source;
}

/** How many participants, and who — collapsed when they are all the same persona. */
function participantsOf(config: Record<string, unknown>): string | undefined {
  const actors = config.actors as
    | { count?: number; persona?: string; lanes?: { persona?: string }[] }[]
    | undefined;
  const actor = actors?.[0];
  if (actor === undefined) return undefined;
  const lanePersonas = (actor.lanes ?? []).map((lane) => lane.persona).filter((persona): persona is string => typeof persona === "string");
  const personas = lanePersonas.length > 0 ? lanePersonas : actor.persona === undefined ? [] : [actor.persona];
  const count = actor.count ?? actor.lanes?.length ?? personas.length ?? 1;
  const unique = [...new Set(personas)];
  if (unique.length === 0) return `${count} participant${count === 1 ? "" : "s"}`;
  // Several lanes of ONE persona reads as "3 × skeptical-power-user"; genuinely different people
  // are named, because which personas are in a study is the study's design.
  return unique.length === 1 ? `${count} × ${unique[0]}` : unique.join(" · ");
}

function capsOf(config: Record<string, unknown>): LabCaps {
  const caps = (config.policies as { caps?: { maxUsd?: number; maxTotalUsd?: number } } | undefined)?.caps
    ?? (config.caps as { maxUsd?: number; maxTotalUsd?: number } | undefined);
  return {
    ...(typeof caps?.maxUsd === "number" ? { laneUsd: caps.maxUsd } : {}),
    ...(typeof caps?.maxTotalUsd === "number" ? { studyUsd: caps.maxTotalUsd } : {})
  };
}

export interface ReadLabSummaryOptions {
  /** Skip the key probe (it touches vendor stores); the screen then shows no keys line. */
  checkKeys?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Describe one lab. Returns null when the manifest cannot be resolved — the caller already knows
 * the lab exists from the listing, so this failing means the file changed underneath them.
 */
export async function readLabSummary(
  cwd: string,
  lab: string,
  options: ReadLabSummaryOptions = {}
): Promise<LabSummary | null> {
  const inspected = await inspectLabManifest(cwd, lab).catch(() => null);
  if (inspected === null || !inspected.ok || inspected.config === undefined) return null;
  const config = inspected.config as unknown as Record<string, unknown>;
  const actors = config.actors as { model?: string }[] | undefined;

  let keysReady: boolean | undefined;
  let missingKeys: string[] | undefined;
  if (options.checkKeys === true) {
    // Only the keys a live run of THIS lab would need. Names only; no value is read or returned.
    const needed = ["OPENAI_API_KEY", "E2B_API_KEY"];
    const probes = await probeKeySources(needed, { cwd, env: options.env ?? process.env }).catch(() => []);
    const missing = probes.filter((probe) => probe.source === null).map((probe) => probe.name);
    keysReady = probes.length > 0 && missing.length === 0;
    if (missing.length > 0) missingKeys = missing;
  }

  // Computed once: a test-then-use pair reads as though the two calls could differ.
  const subject = subjectOf(config);
  const participants = participantsOf(config);

  return {
    schema: LAB_SUMMARY_SCHEMA,
    labId: String(config.id ?? lab),
    ...(typeof config.title === "string" ? { title: config.title } : {}),
    ...(typeof config.description === "string" ? { description: config.description.trim() } : {}),
    ...(subject === undefined ? {} : { subject }),
    ...(participants === undefined ? {} : { participants }),
    model: actors?.[0]?.model ?? DEFAULT_OPENAI_CU_MODEL,
    reasoningEffort: reasoningEffortOf(config),
    caps: capsOf(config),
    ...(keysReady === undefined ? {} : { keysReady }),
    ...(missingKeys === undefined ? {} : { missingKeys })
  };
}
