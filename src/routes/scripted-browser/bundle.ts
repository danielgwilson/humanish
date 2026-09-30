// Assemble the scripted-browser lab's run bundle from its sessions, and the review summary and
// markdown that ship with it.

import path from "node:path";
import type { ActorPersonaRef, ActorTrace } from "../../actors/contract.js";
import type { ScriptedBrowserSessionResult } from "../../actors/scripted-browser/actor.js";
import type { BrowserPersonaJourney, BrowserSurface } from "../../actors/scripted-browser/types.js";
import { redactText } from "../../evidence/redaction.js";
import type { DesktopResourceObservation } from "../../substrates/e2b/desktop-resources.js";
import {
  buildCuaCostSummary,
  desktopSpanToMinutes,
  spendFreeCostSummary,
} from "../computer-use/costs.js";
import {
  PUBLIC_TARGET_CWD,
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  type ReviewSummary,
  type RunBundle,
  type RunEvent,
  type RunSimulation,
  type RunSubjectProvenance,
} from "../../run/bundle.js";
import { type RunStream } from "../../run/streams.js";
import type { RunLabProvenance } from "../../run/status.js";

/**
 * Project the scripted lab run into a humanish.run-bundle.v1 (no schema change — a new
 * producer only). The load-bearing line is `stream.actor = result.trace`: the provider-neutral
 * ActorTrace seam the Observer renders and verifyRun's engagement check reads. Exported for
 * the bundle-builder tests.
 */
export function buildScriptedLabBundle(args: {
  /** Lab provenance for the bundle\'s own `lab` field (#455). */
  lab?: RunLabProvenance;
  actorId: string;
  appUrl: string;
  createdAt: string;
  desktopTemplate?: string;
  dryRun: boolean;
  hostDigest?: string;
  journey: BrowserPersonaJourney;
  labId: string;
  labTitle?: string;
  persona: ActorPersonaRef;
  runId: string;
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
  surfaces: BrowserSurface[];
}): RunBundle {
  const resultBySurface = new Map(
    args.sessionResults.map((result) => [result.capture.surface.id, result]),
  );
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];

  args.surfaces.forEach((surface, index) => {
    const simId = `scripted-${surface.id}`;
    const streamId = `${simId}-stream`;
    const result = resultBySurface.get(surface.id);
    const screenshots = args.screenshotsBySurface.get(surface.id) ?? [];
    const lastScreenshot = screenshots.at(-1);
    const status = result
      ? result.status
      : args.sessionError
        ? ("failed" as const)
        : ("contract_proof_only" as const);
    const reason =
      result?.reason ??
      args.sessionError ??
      "Contract bundle only: dry-run pinned the scenario contract without launching a browser or touching the subject app.";

    simulations.push({
      id: simId,
      index: index + 1,
      personaId: args.persona.id,
      scenarioId: args.journey.scenarioId,
      status,
      streamKind: "browser",
      mode: "browser-sim",
      progress: 100,
      currentStep: reason,
      summary: result
        ? `Scripted-browser actor (${args.actorId}) replayed ${args.journey.scenarioId} on the ${surface.id} surface; ${result.completionReason}.`
        : args.sessionError
          ? `Scripted lab failed before a terminal session verdict: ${args.sessionError}`
          : `Contract lane for the scripted-browser actor (${args.actorId}) against ${args.appUrl}.`,
      streamIds: [streamId],
      startedAt: args.createdAt,
      updatedAt: result?.capture.capturedAt ?? args.createdAt,
    });

    streams.push({
      id: streamId,
      simId,
      kind: "browser",
      label: `${surface.label} — ${args.labId}`,
      status,
      transport: "snapshot",
      updatedAt: result?.capture.capturedAt ?? args.createdAt,
      embed: lastScreenshot
        ? { kind: "screenshot", url: `../${lastScreenshot}`, title: `${surface.label} (raw)` }
        : { kind: "placeholder", title: surface.label },
      // REAL emulated viewport: isMobile/deviceScaleFactor genuinely render on this route
      // (playwright emulation), unlike the e2b-desktop route's prompt-signal-only fidelity.
      viewport: surface.viewport,
      ui: {
        route: args.appUrl,
        intent: args.journey.goal,
        state: reason,
        ...(result ? { actorStatus: result.status } : {}),
        ...(lastScreenshot ? { screenshotUrl: `../${lastScreenshot}` } : {}),
      },
      // The seam this registration exists to fill: the provider-neutral actor evidence.
      ...(result ? { actor: result.trace } : {}),
      artifacts: [
        { label: "run bundle", path: "run.json", kind: "bundle" as const },
        { label: "review", path: "review.md", kind: "review" as const },
        { label: "events", path: "events.ndjson", kind: "events" as const },
        ...(result
          ? [
              {
                label: `${surface.id} browser trace`,
                path: result.capture.tracePath,
                kind: "trace" as const,
              },
              {
                label: `${surface.id} actor trace`,
                path: `actor-${surface.id}.json`,
                kind: "trace" as const,
              },
            ]
          : []),
        ...screenshots.map((screenshot, screenshotIndex) => ({
          label: `${surface.id} screenshot ${String(screenshotIndex + 1).padStart(2, "0")} (raw)`,
          path: screenshot,
          kind: "screenshot" as const,
        })),
      ],
    });
  });

  const events: RunEvent[] = [
    {
      id: "event-000-created",
      at: args.createdAt,
      level: "info",
      type: "scripted-lab.run.created",
      message: `Created scripted-browser lab run for ${args.labId} (actor ${args.actorId}, ${args.surfaces.length} surface${args.surfaces.length === 1 ? "" : "s"}).`,
    },
    {
      id: "event-001-subject",
      at: args.createdAt,
      level: "info",
      type: "scripted-lab.subject.declared",
      // Invariant 5: provenance recorded or its absence DECLARED. The lab did not provision
      // this subject on app-url routes; clone routes carry structured subject provenance below.
      message: args.subject
        ? `Provisioned synthetic subject: clone of ${args.subject.repo}${args.subject.commit ? `@${args.subject.commit}` : ""}, served + getHost-exposed in-sandbox; env names: ${args.subject.envNames?.join(", ") || "none"} (values never persisted); state provenance: ${args.subject.state.provenance}; evidence host digest: ${args.hostDigest ?? "dry-run"}.`
        : `Subject app declared at ${args.appUrl}; the lab did not provision it — subject build/commit provenance is UNPINNED; evidence binds to the scenario digest ${args.scenarioSourceDigest}.`,
    },
    {
      id: "event-002-spend",
      at: args.createdAt,
      level: "info",
      type: "scripted-lab.spend",
      message: args.subject
        ? "Scripted participant steps make no model requests; post-run analysis has a separate budget unless disabled. Live provisioned runs may spend E2B sandbox minutes to clone/serve the synthetic subject."
        : "Scripted participant steps make no model requests and use no sandbox on this route; post-run analysis has a separate budget unless disabled. scenario.mode: live gates real browser actuation against the declared app.",
    },
  ];

  if (args.sessionResults.length > 0) {
    for (const result of args.sessionResults) {
      events.push({
        id: `event-${String(events.length).padStart(3, "0")}-session-${result.capture.surface.id}`,
        at: result.capture.capturedAt,
        level: result.status === "passed" ? "info" : "warn",
        type: `scripted-lab.session.${result.completionReason}`,
        message: `${result.capture.surface.id}: ${result.status} — ${result.reason}`,
        simId: `scripted-${result.capture.surface.id}`,
        streamId: `scripted-${result.capture.surface.id}-stream`,
      });
    }
  } else if (args.sessionError) {
    events.push({
      id: "event-003-session-error",
      at: args.createdAt,
      level: "error",
      type: "scripted-lab.session.error",
      message: args.sessionError,
    });
  } else {
    events.push({
      id: "event-003-contract",
      at: args.createdAt,
      level: "info",
      type: "scripted-lab.contract.ready",
      message: `Dry-run contract bundle ready: scenario ${args.journey.scenarioId} @ ${args.scenarioSourceDigest} (${args.scenarioSource}, ${args.journey.steps.length} step${args.journey.steps.length === 1 ? "" : "s"}) parsed and digest-pinned; switch scenario.mode to live to actuate a real browser.`,
    });
  }

  const review = buildScriptedReview(args);
  const ranLive = args.sessionResults.length > 0 || args.sessionError !== undefined;

  const cost = args.dryRun ? undefined : scriptedCost(args.subjectDesktop);
  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: args.dryRun ? "dry-run" : "live",
    simCount: args.surfaces.length,
    createdAt: args.createdAt,
    cwd: PUBLIC_TARGET_CWD,
    ...(args.lab === undefined ? {} : { lab: args.lab }),
    artifactRoot: path.join(".humanish", "runs", args.runId),
    source: args.source,
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
        at: args.createdAt,
        event: "scripted-lab.run.created",
        message: `Created scripted-browser lab run with ${args.surfaces.length} surface lane${args.surfaces.length === 1 ? "" : "s"} (actor ${args.actorId}).`,
      },
    ],
    simulations,
    streams,
    events,
    redaction: {
      status: "passed",
      notes: ranLive
        ? "Scripted step URLs are sanitized to loopback origin+path (query/hash redacted) and step text passes text redaction. Screenshots are FULL-FIDELITY (raw), retained for local use in gitignored .humanish — NOT redacted for publishing; policies.redactScreenshots is not yet supported on this route."
        : "Dry-run contract bundle: no browser ran and no screenshots were captured. The scenario contract is digest-pinned; live step text passes text redaction when a session runs.",
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson",
    },
    review,
    feedbackCandidates: [],
    ...(args.subject === undefined ? {} : { subject: args.subject }),
    ...(args.desktopTemplate === undefined ? {} : { desktopTemplate: args.desktopTemplate }),
    ...(cost === undefined ? {} : { cost }),
  };
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
  return buildCuaCostSummary({
    lanes: [],
    desktops: [
      {
        laneId: "subject",
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
  surfaces: BrowserSurface[];
}): ReviewSummary {
  if (args.sessionError) {
    return {
      schema: REVIEW_SCHEMA,
      verdict: "fail",
      summary: `Scripted lab failed before a terminal session verdict: ${args.sessionError}`,
      gaps: [],
    };
  }
  if (args.sessionResults.length === 0) {
    return {
      schema: REVIEW_SCHEMA,
      verdict: "contract_proof_only",
      summary: `Dry-run contract for scenario ${args.journey.scenarioId} (${args.scenarioSource}, ${args.journey.steps.length} steps) against ${args.appUrl}: composition and scenario contract proven at $0; no browser ran.`,
      gaps: ["Live scripted session not yet run (dry-run contract only)."],
    };
  }

  // Worst-of across surfaces: harness/step failures outrank a timeout outranks a pass.
  const reasons = args.sessionResults.map((result) => result.completionReason);
  const verdict = reasons.some((reason) => reason === "harness_error" || reason === "step_failed")
    ? ("fail" as const)
    : reasons.some((reason) => reason === "timed_out")
      ? ("timed_out" as const)
      : ("pass" as const);
  const passed = args.sessionResults.filter((result) => result.status === "passed").length;
  return {
    schema: REVIEW_SCHEMA,
    verdict,
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
        `- ${stream.simId}: ${trace.provider} (${trace.lane}/${trace.protocol}) ${trace.status} (${trace.completionReason}); ${trace.counts.actions ?? 0} step action(s), ${trace.counts.screenshots ?? 0} raw screenshot(s)`,
    ),
    ...(bundle.review.gaps.length > 0
      ? ["", "## Gaps", ...bundle.review.gaps.map((gap) => `- ${gap}`)]
      : []),
    "",
  ].join("\n");
}
