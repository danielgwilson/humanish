import { isLocalBrowserStudy } from "../substrates/local/runtime-config.js";
import { localRuntimeStatus, type LocalRuntimeStatus } from "../substrates/local/runtime.js";
// What a study is, for the surface that has to describe it before you spend money.
//
// The run index and run detail answer questions about runs. This answers a question about the study
// itself (what it drives, who is in it, which model, and what it is allowed to spend), which is
// what a stakeholder reads on the screen where they decide whether to press Start.
//
// Resolved analysis defaults are shown independently of declared participant caps. A cap that is not
// declared is not "unlimited" and not "$0"; it is a line the screen does not draw.

import { resolveStudyDryRun } from "./plan.js";
import { routeOf } from "./plan.js";
import { localCodexParticipantCheck, planCliRun } from "./doctor.js";
import { requiredKeys, requiredSubjectEnv } from "./requirements.js";
import { automaticAnalysisBudget } from "../analysis/automatic-config.js";
import {
  DEFAULT_OPENAI_CU_MODEL,
  DEFAULT_OPENAI_CU_REASONING_EFFORT,
} from "../actors/computer-use/openai-provider.js";
import { inspectStudyManifest } from "./discover.js";
import { isComputerUseComposition } from "./routing.js";
import type { StudyConfig } from "./types.js";
import { probeKeySources, type KeyResolutionDeps } from "../keys/key-resolution.js";
import { receivingRequiredKey } from "../comms/setup.js";
import {
  actorOf,
  participantList,
  declaredParticipantCount,
  capsOf,
  surfaceCount,
} from "./study-fields.js";

export const STUDY_SUMMARY_SCHEMA = "humanish.study-summary.v1";

export interface StudyCaps {
  /** Per-participant blast-radius budget. */
  laneUsd?: number;
  /** Shared study budget across every participant. */
  studyUsd?: number;
}

export interface StudySummary {
  runtime?: Pick<LocalRuntimeStatus, "ok" | "installed" | "message">;
  participantReadiness?: { ok: boolean; message: string };
  communications?: string;
  analysis?: {
    provider?: "openai" | "codex";
    billing?: "api-estimate" | "account-unknown";
    model: string;
    maxCostUsd: number | null;
  };
  schema: typeof STUDY_SUMMARY_SCHEMA;
  /** The study's `id`. */
  studyId: string;
  title?: string;
  description?: string;
  /** "clone drawdb-io/drawdb", "app-url http://127.0.0.1:3000/", "this-repo". */
  subject?: string;
  /** How many participants and who they are: `1 × synthetic-new-user`. */
  participants?: string;
  /** The model that will actually run, override or default. */
  model?: string;
  /**
   * The reasoning effort that will actually run, override or default, and `"per-lane"` when the
   * roster declares more than one, because a single value would be a lie about half the participants.
   *
   * Shown because it was a silent constant: unreachable from a study, so every run took the provider
   * default. A study variable you cannot see is one nobody chose.
   */
  reasoningEffort?: string;
  caps: StudyCaps;
  /**
   * Whether the configured route's required keys resolve. Dry runs require none. This checks key
   * presence, not local CLI authentication or provider validity. Undefined when not checked.
   */
  keysReady?: boolean;
  missingKeys?: string[];
  /**
   * The planner's refusal message when a live key check finds the study will not plan, as
   * `humanish run` would report it. `keysReady` is then unset: a refused plan lists no keys.
   */
  planRefusal?: string;
}

/**
 * The effort every participant will run at, or `"per-lane"` when they differ. A participant that declares nothing
 * inherits the actor's, and an actor that declares nothing gets the provider default, which is
 * reported as the resolved value, exactly as `model` reports its default rather than hiding it.
 */
function reasoningEffortOf(config: StudyConfig): string {
  const fallback = actorOf(config)?.reasoningEffort ?? DEFAULT_OPENAI_CU_REASONING_EFFORT;
  const roster = participantList(config) ?? [];
  const resolved = new Set(roster.map((entry) => entry.reasoningEffort ?? fallback));
  if (resolved.size > 1) return "per-lane";
  return resolved.size === 1 ? [...resolved][0]! : fallback;
}

/** One short phrase for what the study drives. */
function subjectOf(config: Record<string, unknown>): string | undefined {
  const subject = config.subject as
    | { source?: string; repos?: string[]; appUrl?: string }
    | undefined;
  if (subject?.source === undefined) return undefined;
  const repo = subject.repos?.[0];
  if (repo !== undefined) return `${subject.source} ${repo}`;
  if (subject.appUrl !== undefined) return `${subject.source} ${subject.appUrl}`;
  return subject.source;
}

/** How many participants, and who; collapsed when they are all the same persona. */
function participantsOf(config: StudyConfig): string | undefined {
  const actor = actorOf(config);
  if (actor === undefined) return undefined;
  const rosterPersonas = (participantList(config) ?? [])
    .map((entry) => entry.persona)
    .filter((persona): persona is string => typeof persona === "string");
  const personas =
    rosterPersonas.length > 0 ? rosterPersonas : actor.persona === undefined ? [] : [actor.persona];
  // A scripted study's participants are its surfaces, one replay on each.
  const count =
    declaredParticipantCount(config) ??
    surfaceCount(config) ??
    participantList(config)?.length ??
    personas.length ??
    1;
  const unique = [...new Set(personas)];
  if (unique.length === 0) return `${count} participant${count === 1 ? "" : "s"}`;
  // Several participants of one persona reads as "3 × skeptical-power-user"; genuinely different people
  // are named, because which personas are in a study is the study's design.
  return unique.length === 1 ? `${count} × ${unique[0]}` : unique.join(" · ");
}

/** The computer-use caps. Other routes draw none. */
function summaryCapsOf(config: StudyConfig): StudyCaps {
  if (!isComputerUseComposition(config)) return {};
  const caps = capsOf(config);
  return {
    ...(typeof caps?.maxUsd === "number" ? { laneUsd: caps.maxUsd } : {}),
    ...(typeof caps?.maxTotalUsd === "number" ? { studyUsd: caps.maxTotalUsd } : {}),
  };
}

export interface ReadStudySummaryOptions {
  /** Skip the key probe (it touches vendor stores); the screen then shows no keys line. */
  checkKeys?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Where the key probe looks for vendor stores; tests point it at a temp home. */
  keyDeps?: KeyResolutionDeps;
}

/**
 * Describe one study. Returns null when the manifest cannot be resolved: the caller already knows
 * the study exists from the listing, so this failing means the file changed underneath them.
 */
export async function readStudySummary(
  cwd: string,
  study: string,
  options: ReadStudySummaryOptions = {},
): Promise<StudySummary | null> {
  const inspected = await inspectStudyManifest(cwd, study).catch(() => null);
  if (inspected === null || !inspected.ok || inspected.config === undefined) return null;
  const config = inspected.config as unknown as Record<string, unknown>;
  const route = routeOf(inspected.config);

  let keysReady: boolean | undefined;
  let missingKeys: string[] | undefined;
  const dryRun = resolveStudyDryRun(inspected.config, undefined, true) === true;
  // A live key check reads the plan's requirements. A study the planner refuses has none to check,
  // so the summary reports the refusal in place of its keys.
  const planned =
    options.checkKeys === true && !dryRun ? await planCliRun(inspected.config, cwd) : undefined;
  const planRefusal = planned?.ok === false ? planned.refusal.message : undefined;
  if (options.checkKeys === true && planned?.ok !== false) {
    const requirements = planned?.planned.plan.requirements ?? [];
    const subjectKeys = requiredSubjectEnv(requirements);
    const email = inspected.config.comms?.email;
    const receivingKey =
      !dryRun && email?.kind === "real"
        ? await receivingRequiredKey(cwd, email.connection)
        : undefined;
    const candidates = [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "E2B_API_KEY",
      ...subjectKeys,
      ...(receivingKey ? [receivingKey] : []),
    ];
    const probes = dryRun
      ? []
      : await probeKeySources(candidates, {
          cwd,
          env: options.env ?? process.env,
          ...(options.keyDeps === undefined ? {} : { deps: options.keyDeps }),
        }).catch(() => []);
    const present = new Set(
      probes.filter((probe) => probe.source !== null).map((probe) => probe.name),
    );
    const required = requiredKeys(requirements, (name) => present.has(name));
    const missing = [
      ...new Set([...required, ...subjectKeys, ...(receivingKey ? [receivingKey] : [])]),
    ].filter((name) => !present.has(name));
    if (receivingKey === null) missing.push("email connection");
    keysReady = missing.length === 0;
    if (missing.length > 0) missingKeys = missing;
  }

  // Computed once: a test-then-use pair reads as though the two calls could differ.
  const analysis = automaticAnalysisBudget(inspected.config.review?.analysis, route);
  const subject = subjectOf(config);
  const participants = participantsOf(inspected.config);
  const runtime =
    options.checkKeys === true && isLocalBrowserStudy(inspected.config)
      ? await localRuntimeStatus({
          ...(options.env ? { env: options.env } : {}),
          media:
            inspected.config.execution?.desktop?.media !== undefined ||
            inspected.config.execution?.desktop?.recording !== undefined,
        })
      : undefined;
  const participantReadiness =
    options.checkKeys === true &&
    isLocalBrowserStudy(inspected.config) &&
    actorOf(inspected.config)?.type === "local-agent"
      ? await localCodexParticipantCheck({ env: options.env ?? process.env })
      : undefined;

  return {
    ...(analysis ? { analysis } : {}),
    ...(runtime
      ? { runtime: { ok: runtime.ok, installed: runtime.installed, message: runtime.message } }
      : {}),
    ...(participantReadiness
      ? {
          participantReadiness: {
            ok: participantReadiness.ok,
            message: participantReadiness.message,
          },
        }
      : {}),
    schema: STUDY_SUMMARY_SCHEMA,
    ...(inspected.config.comms?.email?.kind === "real"
      ? {
          communications: `Real email · ${inspected.config.comms.email.connection} · fresh inbox per participant · hosted processing · local review only`,
        }
      : {}),
    studyId: String(config.id ?? study),
    ...(typeof config.title === "string" ? { title: config.title } : {}),
    ...(typeof config.description === "string" ? { description: config.description.trim() } : {}),
    ...(subject === undefined ? {} : { subject }),
    ...(participants === undefined ? {} : { participants }),
    model: actorOf(inspected.config)?.model ?? DEFAULT_OPENAI_CU_MODEL,
    reasoningEffort: reasoningEffortOf(inspected.config),
    caps: summaryCapsOf(inspected.config),
    ...(keysReady === undefined ? {} : { keysReady }),
    ...(missingKeys === undefined ? {} : { missingKeys }),
    ...(planRefusal === undefined ? {} : { planRefusal }),
  };
}
