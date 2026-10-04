// Reads the parts of a run bundle (`run.json`) and an analysis artifact the scorer uses. Only the
// fields named here are read; docs/contracts/run-bundle.md and src/analysis/types.ts own the shapes.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { EvidenceFacts } from "../taskly/answer-key.js";
import type { AnalysisInputForScore, ParticipantInput } from "./score.js";

interface TraceItem {
  kind: string;
  lifecycle?: string;
  title?: string;
  text?: string;
}

export interface BundleStream {
  id: string;
  laneId?: string;
  assignment?: { mission?: string };
  actor?: {
    provider?: string;
    status?: string;
    completionReason?: string;
    stopCause?: string;
    reason?: string | null;
    ids?: { model?: string | null };
    persona?: { id?: string; traitsApplied?: string[] };
    items?: TraceItem[];
  };
}

export interface CostLine {
  kind: string;
  laneId?: string;
  modelId?: string | null;
  estimatedCostUsd: number | null;
}

export interface RunBundle {
  runId: string;
  mode?: string;
  study?: { id?: string };
  cost?: { estimatedTotalUsd?: number | null; breakdown?: CostLine[] };
  streams: BundleStream[];
}

export interface AnalysisArtifact {
  id: string;
  runId: string;
  status: string;
  provider?: string;
  promptVersion?: string;
  config?: { model?: string; maxCostUsd?: number | null; maxOutputTokens?: number | null };
  usage?: { estimatedCostUsd?: number | null; inputTokens?: number | null; outputTokens?: number | null };
  result: {
    summary: string;
    participants?: { streamId: string; summary?: string; outcomeReason?: string }[];
    findings: {
      id: string;
      title: string;
      summary: string;
      impact: string;
      confidence: string;
      observations?: { claim: string }[];
    }[];
  } | null;
}

const TYPED = /^type \[(\d+) chars?\]/;
const STALL = /stall|retr(?:y|ied)|timed? ?out/i;

export function factsOf(stream: BundleStream, mission: string): EvidenceFacts {
  const items = stream.actor?.items ?? [];
  const typed = items
    .filter((item) => item.kind === "ui_action")
    .map((item) => TYPED.exec(item.title ?? "")?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  return {
    maxTypedChars: typed.length === 0 ? null : Math.max(...typed),
    providerStall: items.some((item) => item.kind === "notice" && STALL.test(item.title ?? "")),
    failedAction: items.some(
      (item) => item.kind === "ui_action" && item.lifecycle !== undefined && item.lifecycle !== "completed",
    ),
    personaTraits: stream.actor?.persona?.traitsApplied ?? [],
    mission: stream.assignment?.mission ?? mission,
  };
}

/** Each participant of a run, with the evidence facts the answer key can check. */
export function participantsOf(bundle: RunBundle, mission: string): ParticipantInput[] {
  return bundle.streams
    .filter((stream) => stream.actor !== undefined)
    .map((stream) => ({
      streamId: stream.id,
      report: stream.actor?.reason ?? "",
      narration: (stream.actor?.items ?? [])
        .filter((item) => item.kind === "message" || item.kind === "reasoning")
        .map((item) => item.text ?? ""),
      facts: factsOf(stream, mission),
    }));
}

export function analysisInputOf(artifact: AnalysisArtifact): AnalysisInputForScore | null {
  if (artifact.result === null) return null;
  const participantText = (artifact.result.participants ?? []).flatMap((participant) => [
    participant.summary ?? "",
    participant.outcomeReason ?? "",
  ]);
  return {
    analysisId: artifact.id,
    model: artifact.config?.model ?? null,
    promptVersion: artifact.promptVersion ?? null,
    summaryText: [artifact.result.summary, ...participantText].join("\n\n"),
    findings: artifact.result.findings.map((finding) => ({
      id: finding.id,
      title: finding.title,
      summary: finding.summary,
      impact: finding.impact,
      confidence: finding.confidence,
      observations: finding.observations ?? [],
    })),
  };
}

/** The costs one run recorded, by kind. Unpriced lines stay null. */
export function runCosts(bundle: RunBundle): {
  participantUsd: number | null;
  desktopUsd: number | null;
  participantModels: string[];
} {
  const lines = bundle.cost?.breakdown ?? [];
  const sum = (kind: string): number | null => {
    const matching = lines.filter((line) => line.kind === kind);
    if (matching.length === 0 || matching.some((line) => line.estimatedCostUsd === null)) return null;
    return matching.reduce((total, line) => total + (line.estimatedCostUsd ?? 0), 0);
  };
  const models = bundle.streams
    .map((stream) => stream.actor?.ids?.model)
    .filter((model): model is string => typeof model === "string");
  return {
    participantUsd: sum("model-tokens"),
    desktopUsd: sum("desktop-minutes"),
    participantModels: [...new Set(models)],
  };
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function readRunBundle(projectDir: string, runId: string): RunBundle {
  return readJson<RunBundle>(path.join(projectDir, ".humanish", "runs", runId, "run.json"));
}

/** The named analysis version of a run, or its newest complete one when no id is given. */
export function readAnalysis(
  projectDir: string,
  runId: string,
  analysisId?: string,
): AnalysisArtifact | null {
  const root = path.join(projectDir, ".humanish", "runs", runId, "analysis");
  if (!existsSync(root)) return null;
  const ids = analysisId === undefined ? readdirSync(root) : [analysisId];
  const artifacts = ids
    .map((id) => path.join(root, id, "analysis.json"))
    .filter((file) => existsSync(file))
    .map((file) => readJson<AnalysisArtifact & { completedAt?: string }>(file))
    .filter((artifact) => artifact.status === "complete")
    .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));
  return artifacts.at(-1) ?? null;
}
