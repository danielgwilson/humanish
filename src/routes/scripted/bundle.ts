// Assemble the scripted-browser lab's run bundle from its sessions, and the review summary and
// markdown that ship with it.

import type { ActorPersonaRef, ActorTrace } from "../../actors/contract.js";
import type { ScriptedBrowserSessionResult } from "../../actors/scripted-browser/actor.js";
import type { BrowserPersonaJourney, BrowserSurface } from "../../actors/scripted-browser/types.js";
import { redactText } from "../../evidence/redaction.js";
import type { DesktopResourceObservation } from "../../substrates/e2b/desktop-resources.js";
import {
  buildRunCostSummary,
  desktopSpanToMinutes,
  spendFreeCostSummary,
} from "../../run/cost-summary.js";
import {
  REVIEW_SCHEMA,
  type ReviewSummary,
  type RunBundle,
  type RunEvent,
  type RunSubjectProvenance,
  bundleArtifacts,
  bundleHead,
  type BundleRun,
} from "../../run/bundle.js";
import { type RunStream } from "../../run/streams.js";
import { participantEvent, recordIdOf } from "../../run/participant-records.js";
import { scriptedSurfaceIds, scriptedSurfaceRecords } from "./surface-records.js";

/** What the scripted lab's bundle is built from. */
interface ScriptedBundleArgs {
  /** The run this bundle belongs to; the bundle head reads its id, mode, start and lab. */
  run: BundleRun;
  actorId: string;
  appUrl: string;
  desktopTemplate?: string;
  dryRun: boolean;
  hostDigest?: string;
  journey: BrowserPersonaJourney;
  labId: string;
  labTitle?: string;
  persona: ActorPersonaRef;
  scenarioSource: string;
  scenarioSourceDigest: string;
  screenshotsBySurface: Map<string, string[]>;
  sessionResults: ScriptedBrowserSessionResult[];
  sessionError?: string;
  source: RunBundle["source"];
  subject?: RunSubjectProvenance;
  /** The provisioned clone's desktop; absent when no sandbox was created. */
  subjectDesktop?: {
    durationMs: number | undefined;
    observation: DesktopResourceObservation | undefined;
    killed: boolean;
  };
  surfaces: readonly BrowserSurface[];
  /** The run's verdict (judgeScripted). */
  verdict: ReviewSummary["verdict"];
}

/**
 * Project the scripted lab run into a humanish.run-bundle.v1 (no schema change: a new
 * producer only). The key line is `stream.actor = result.trace`: the provider-neutral
 * ActorTrace seam the Observer renders and verifyRun's engagement check reads. Exported for
 * the bundle-builder tests.
 */
export function buildScriptedLabBundle(args: ScriptedBundleArgs): RunBundle {
  const resultBySurface = new Map(
    args.sessionResults.map((result) => [result.capture.surface.id, result]),
  );
  // Each surface's records are stamped with the run's start.
  const context = { ...args, createdAt: args.run.createdAt };
  const records = args.surfaces.map((surface, index) =>
    scriptedSurfaceRecords(
      context,
      surface,
      index,
      resultBySurface.get(surface.id),
      args.screenshotsBySurface.get(surface.id) ?? [],
    ),
  );

  const events = scriptedEvents(args);
  const review = buildScriptedReview(args);
  const ranLive = args.sessionResults.length > 0 || args.sessionError !== undefined;

  const cost = args.dryRun ? undefined : scriptedCost(args.subjectDesktop);
  return {
    ...bundleHead(args.run, { participants: args.surfaces.length, source: args.source }),
    persona: {
      id: args.persona.id,
      name: `Scripted journey persona (${args.persona.id})`,
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest,
    },
    scenario: {
      id: args.journey.scenarioId,
      title: args.journey.scenarioTitle,
      goal: redactText(args.journey.goal),
      source: args.scenarioSource,
      sourceDigest: args.scenarioSourceDigest,
    },
    lifecycle: [
      {
        at: args.run.createdAt,
        event: "scripted-lab.run.created",
        message: `Created scripted-browser lab run with ${args.surfaces.length} surface${args.surfaces.length === 1 ? "" : "s"} (actor ${args.actorId}).`,
      },
    ],
    simulations: records.map((record) => record.simulation),
    streams: records.map((record) => record.stream),
    events,
    redaction: {
      status: "passed",
      notes: ranLive
        ? "Scripted step URLs are sanitized to loopback origin+path (query/hash redacted) and step text passes text redaction. Screenshots are FULL-FIDELITY (raw), retained for local use in gitignored .humanish — NOT redacted for publishing; policies.redactScreenshots is not yet supported on this route."
        : "Dry-run contract bundle: no browser ran and no screenshots were captured. The scenario contract is digest-pinned; live step text passes text redaction when a session runs.",
    },
    artifacts: bundleArtifacts(),
    review,
    feedbackCandidates: [],
    ...(args.subject === undefined ? {} : { subject: args.subject }),
    ...(args.desktopTemplate === undefined ? {} : { desktopTemplate: args.desktopTemplate }),
    ...(cost === undefined ? {} : { cost }),
  };
}

/** The created, subject and spend events, then one event per session or the run's outcome. */
function scriptedEvents(args: ScriptedBundleArgs): RunEvent[] {
  const events: RunEvent[] = [
    {
      id: "event-000-created",
      at: args.run.createdAt,
      level: "info",
      type: "scripted-lab.run.created",
      message: `Created scripted-browser lab run for ${args.labId} (actor ${args.actorId}, ${args.surfaces.length} surface${args.surfaces.length === 1 ? "" : "s"}).`,
    },
    {
      id: "event-001-subject",
      at: args.run.createdAt,
      level: "info",
      type: "scripted-lab.subject.declared",
      // Provenance is recorded or its absence declared. The lab did not provision
      // this subject on app-url routes; clone routes carry structured subject provenance below.
      message: args.subject
        ? `Provisioned synthetic subject: clone of ${args.subject.repo}${args.subject.commit ? `@${args.subject.commit}` : ""}, served + getHost-exposed in-sandbox; env names: ${args.subject.envNames?.join(", ") || "none"} (values never persisted); state provenance: ${args.subject.state.provenance}; evidence host digest: ${args.hostDigest ?? "dry-run"}.`
        : `Subject app declared at ${args.appUrl}; the lab did not provision it — subject build/commit provenance is UNPINNED; evidence binds to the scenario digest ${args.scenarioSourceDigest}.`,
    },
    {
      id: "event-002-spend",
      at: args.run.createdAt,
      level: "info",
      type: "scripted-lab.spend",
      message: args.subject
        ? "Scripted participant steps make no model requests; post-run analysis has a separate budget unless disabled. Live provisioned runs may spend E2B sandbox minutes to clone/serve the synthetic subject."
        : "Scripted participant steps make no model requests and use no sandbox on this route; post-run analysis has a separate budget unless disabled. scenario.mode: live gates real browser actuation against the declared app.",
    },
  ];

  if (args.sessionResults.length > 0) {
    for (const result of args.sessionResults) {
      events.push(
        participantEvent(scriptedSurfaceIds(result.capture.surface.id), {
          id: `event-${String(events.length).padStart(3, "0")}-session-${result.capture.surface.id}`,
          at: result.capture.capturedAt,
          level: result.status === "passed" ? "info" : "warn",
          type: `scripted-lab.session.${result.completionReason}`,
          message: `${result.capture.surface.id}: ${result.status} — ${result.reason}`,
        }),
      );
    }
  } else if (args.sessionError !== undefined) {
    events.push({
      id: "event-003-session-error",
      at: args.run.createdAt,
      level: "error",
      type: "scripted-lab.session.error",
      message: args.sessionError,
    });
  } else {
    events.push({
      id: "event-003-contract",
      at: args.run.createdAt,
      level: "info",
      type: "scripted-lab.contract.ready",
      message: `Dry-run contract bundle ready: scenario ${args.journey.scenarioId} @ ${args.scenarioSourceDigest} (${args.scenarioSource}, ${args.journey.steps.length} step${args.journey.steps.length === 1 ? "" : "s"}) parsed and digest-pinned; switch scenario.mode to live to actuate a real browser.`,
    });
  }
  return events;
}

/** No model runs on this route; the only spend is a provisioned clone's desktop. */
function scriptedCost(
  subjectDesktop:
    | {
        durationMs: number | undefined;
        observation: DesktopResourceObservation | undefined;
        killed: boolean;
      }
    | undefined,
) {
  if (subjectDesktop === undefined) return spendFreeCostSummary();
  return buildRunCostSummary({
    participants: [],
    desktops: [
      {
        participantId: "subject",
        minutes: desktopSpanToMinutes(subjectDesktop.durationMs),
        observation: subjectDesktop.observation,
        lifetimeComplete: subjectDesktop.killed,
      },
    ],
  });
}

function buildScriptedReview(args: {
  appUrl: string;
  journey: BrowserPersonaJourney;
  scenarioSource: string;
  sessionResults: ScriptedBrowserSessionResult[];
  sessionError?: string;
  surfaces: readonly BrowserSurface[];
  verdict: ReviewSummary["verdict"];
}): ReviewSummary {
  if (args.sessionError !== undefined) {
    return {
      schema: REVIEW_SCHEMA,
      verdict: args.verdict,
      summary: `Scripted lab failed before a terminal session verdict: ${args.sessionError}`,
      gaps: [],
    };
  }
  if (args.sessionResults.length === 0) {
    return {
      schema: REVIEW_SCHEMA,
      verdict: args.verdict,
      summary: `Dry-run contract for scenario ${args.journey.scenarioId} (${args.scenarioSource}, ${args.journey.steps.length} steps) against ${args.appUrl}: composition and scenario contract proven at $0; no browser ran.`,
      gaps: ["Live scripted session not yet run (dry-run contract only)."],
    };
  }

  const passed = args.sessionResults.filter((result) => result.status === "passed").length;
  return {
    schema: REVIEW_SCHEMA,
    verdict: args.verdict,
    summary: `Scripted-browser actor replayed ${args.journey.scenarioId} on ${args.sessionResults.length} surface${args.sessionResults.length === 1 ? "" : "s"} against ${args.appUrl}: ${passed}/${args.sessionResults.length} satisfied the scenario predicate.`,
    gaps: args.sessionResults
      .filter((result) => result.status !== "passed")
      .map((result) => `${result.capture.surface.id}: ${result.reason}`),
  };
}

export function renderScriptedReviewMarkdown(bundle: RunBundle): string {
  const subject = bundle.events.find((event) => event.type === "scripted-lab.subject.declared");
  const spend = bundle.events.find((event) => event.type === "scripted-lab.spend");
  const traces = bundle.streams
    .map((stream) => ({ stream, trace: stream.actor as ActorTrace | undefined }))
    .filter(
      (entry): entry is { stream: RunStream; trace: ActorTrace } => entry.trace !== undefined,
    );
  return [
    `# ${bundle.scenario.title}`,
    "",
    `- run: ${bundle.runId}`,
    `- mode: ${bundle.mode}`,
    `- verdict: ${bundle.review.verdict}`,
    `- summary: ${bundle.review.summary}`,
    `- scenario: ${bundle.scenario.id} @ ${bundle.scenario.sourceDigest} (${bundle.scenario.source})`,
    ...(subject ? [`- subject: ${subject.message}`] : []),
    ...(spend ? [`- spend: ${spend.message}`] : []),
    ...traces.map(
      ({ stream, trace }) =>
        `- ${recordIdOf(stream)}: ${trace.provider} (${trace.lane}/${trace.protocol}) ${trace.status} (${trace.completionReason}); ${trace.counts.actions ?? 0} step action(s), ${trace.counts.screenshots ?? 0} raw screenshot(s)`,
    ),
    ...(bundle.review.gaps.length > 0
      ? ["", "## Gaps", ...bundle.review.gaps.map((gap) => `- ${gap}`)]
      : []),
    "",
  ].join("\n");
}
