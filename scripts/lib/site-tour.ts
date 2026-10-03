// Builds the site's tour data (site/lib/tour/<slug>.json) from one kept run bundle: the frames
// the replay player steps through, with the actions and reasoning that came before each, plus the
// facts the study band prints. Pure, so tests feed it a fixture bundle; scripts/site-tour.ts does
// the reading, the verify call and the publishing.

import { runCost, runCostLabel, type RunAnalysisCost } from "../../src/run/run-cost.js";
import type { RunCostSummary } from "../../src/run/bundle.js";
import type { TourData, TourFacts, TourLane } from "../../site/lib/tour-types.js";

/** One item of an actor trace, as run.json's `streams[].actor.items` records it. */
interface TraceItem {
  id: string;
  kind: string;
  title?: string;
  text?: string;
  at?: string;
  coord?: { x: number; y: number };
  screenshotRef?: { path: string };
}

/** The parts of a run bundle the tour reads. */
export interface TourBundle {
  runId: string;
  createdAt: string;
  /** A clone subject carries `repo` and `commit`; other subjects are read as unknown. */
  subject?: unknown;
  review?: { participants?: { total: number; reachedGoal: number } };
  cost?: Pick<RunCostSummary, "estimatedTotalUsd" | "fullyEstimated" | "ratesAsOf" | "placeholder">;
  streams: Array<{
    actor?: {
      lane?: string;
      persona?: { id?: string };
      provider?: string;
      status?: string;
      completionReason?: string;
      reason?: string;
      durationMs?: number;
      counts?: Record<string, number>;
      items?: TraceItem[];
    };
  }>;
}

/** The parts of the Observer's companion analysis record the tour reads. */
export interface TourAnalysis {
  analysis: {
    completedAt?: string;
    result: {
      summary?: string;
      findings?: Array<{ title: string; summary: string; impact: string }>;
    } | null;
  } | null;
  spend?: RunAnalysisCost;
}

/** `humanish verify --json` output, the fields the tour reads. */
export interface TourVerifyInput {
  checks: Array<{ name: string; ok: boolean; message?: string }>;
  shareSafety: { status: string; reasons: Array<{ code: string; message: string }> };
}

export interface TourInput {
  bundle: TourBundle;
  analysis: TourAnalysis;
  verify: TourVerifyInput;
  /** The size of the run's captures, read from the first screenshot. */
  frameSize: { w: number; h: number };
}

/** A capture's published path: the site serves JPEG copies of the bundle's PNG screenshots. */
export function publishedCapturePath(path: string): string {
  return path.replace(/\.png$/i, ".jpg");
}

function lane(actor: NonNullable<TourBundle["streams"][number]["actor"]>): TourLane {
  const frames: TourLane["frames"] = [];
  let actions: TourLane["trailingActions"] = [];
  let reasoning: TourLane["trailingReasoning"] = [];
  for (const item of actor.items ?? []) {
    if (item.kind === "screenshot" && item.screenshotRef) {
      frames.push({
        id: item.id,
        title: item.title ?? item.id,
        at: item.at ?? null,
        file: publishedCapturePath(item.screenshotRef.path),
        actionsBefore: actions,
        reasoningBefore: reasoning,
      });
      actions = [];
      reasoning = [];
    } else if (item.kind === "ui_action") {
      actions.push({
        id: item.id,
        title: item.title ?? item.id,
        coord: item.coord ?? null,
        at: item.at ?? null,
        text: item.text ?? null,
      });
    } else if ((item.kind === "reasoning" || item.kind === "message") && item.text) {
      reasoning.push({
        id: item.id,
        text: item.text,
        at: item.at ?? null,
        ...(item.kind === "message" ? { message: true } : {}),
      });
    }
  }
  return {
    lane: actor.lane ?? null,
    laneId: null,
    provider: actor.provider ?? null,
    persona: actor.persona?.id ?? null,
    status: actor.status ?? null,
    completionReason: actor.completionReason ?? null,
    reason: actor.reason ?? null,
    durationMs: actor.durationMs ?? null,
    counts: actor.counts ?? null,
    frames,
    trailingActions: actions,
    trailingReasoning: reasoning,
  };
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function facts(input: TourInput): TourFacts {
  const { bundle, analysis, verify } = input;
  const subject = (bundle.subject ?? {}) as { repo?: string; commit?: string };
  const participants = bundle.review?.participants;
  const started = Date.parse(bundle.createdAt);
  const analyzed = Date.parse(analysis.analysis?.completedAt ?? "");
  return {
    date: bundle.createdAt.slice(0, 10),
    subject: subject.repo
      ? `${subject.repo}${subject.commit ? " · commit-pinned" : ""}`
      : "app under study",
    participants: participants
      ? `${participants.reachedGoal}/${participants.total} reached the goal`
      : "outcome not recorded",
    verifyChecks: `${verify.checks.filter((check) => check.ok).length}/${verify.checks.length} checks`,
    status: verify.shareSafety.status,
    wallClock: Number.isFinite(analyzed)
      ? `${duration(analyzed - started)} incl. analysis`
      : "not recorded",
    cost: runCostLabel(runCost(bundle.cost, analysis.spend)) ?? "not estimated",
    frameSize: input.frameSize,
  };
}

/** The tour data for the bundle's first participant. */
export function buildTour(input: TourInput): TourData {
  const actor = input.bundle.streams[0]?.actor;
  if (!actor) throw new Error("the bundle's first stream has no actor trace");
  const result = input.analysis.analysis?.result ?? null;
  return {
    runId: input.bundle.runId,
    lanes: [lane(actor)],
    findings: (result?.findings ?? []).map((finding) => ({
      title: finding.title,
      summary: finding.summary,
      impact: finding.impact,
      evidence: [],
    })),
    ...(result?.summary ? { analysisSummary: result.summary } : {}),
    verify: {
      status: input.verify.shareSafety.status,
      reasons: input.verify.shareSafety.reasons.map(({ code, message }) => ({ code, message })),
      checks: input.verify.checks.map((check) => ({
        name: check.name,
        ok: check.ok,
        detail: check.ok ? "" : (check.message ?? ""),
      })),
    },
    facts: facts(input),
  };
}
