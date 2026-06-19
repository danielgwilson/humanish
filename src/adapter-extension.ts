import path from "node:path";

import type {
  RunAdapterScore,
  RunBundle,
  RunFeedbackCandidate
} from "./run.js";

export type BrowserAdapterBackend =
  | "cua"
  | "shared-world"
  | "concurrent-shared-world";

/**
 * Product-agnostic scoring context for browser/computer-use lanes. Product-specific
 * evidence/rubrics stay in the adopter's repo; core provides the assembled bundle
 * plus stable run identifiers and never learns product nouns.
 */
export interface BrowserLabScoringContext {
  bundle: RunBundle;
  labId: string;
  runId: string;
  actor: string;
  backend: BrowserAdapterBackend;
  dryRun: boolean;
  laneCount: number;
}

export interface BrowserLabAdapterHooks {
  /**
   * Browser-route extension seam (#165): a thin adapter may score the assembled
   * browser/shared-world evidence without forking core. The score is stored as
   * namespaced `bundle.adapterScore`; product-specific component detail belongs
   * in `data`, not in core enums or review text.
   */
  score?: (ctx: BrowserLabScoringContext) => RunAdapterScore | Promise<RunAdapterScore>;
  /**
   * Companion seam for public-safe, adapter-namespaced feedback candidates.
   * Malformed candidates are dropped before bundle persistence so core remains
   * verifiable even when an adapter misbehaves.
   */
  deriveFeedback?: (ctx: BrowserLabScoringContext) => RunFeedbackCandidate[] | Promise<RunFeedbackCandidate[]>;
}

export async function applyBrowserAdapterHooks(args: {
  hooks: BrowserLabAdapterHooks | undefined;
  context: BrowserLabScoringContext;
  bundle: RunBundle;
  sanitize: (text: string) => string;
  warnings: string[];
  hookLabel: string;
}): Promise<void> {
  const { hooks, context, bundle, sanitize, warnings, hookLabel } = args;
  if (!hooks?.score && !hooks?.deriveFeedback) return;

  const scrubValue = <T>(value: T): T => {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? value : JSON.parse(sanitize(encoded)) as T;
  };

  if (hooks.score) {
    try {
      const score = await hooks.score(context);
      const cleaned = scrubValue(score);
      if (isAdapterScoreShape(cleaned)) {
        bundle.adapterScore = cleaned;
        applyAdapterScoreFailureToReview(bundle);
      } else {
        warnings.push(`${hookLabel}.score returned a value that is not a well-formed mimetic.adapter-score.v1 (non-empty namespace + status + numeric score + summary); dropped so the bundle stays verifiable.`);
      }
    } catch (error) {
      warnings.push(`${hookLabel}.score threw (${sanitize(error instanceof Error ? error.message : String(error))}); dropped so the bundle stays verifiable.`);
    }
  }

  if (hooks.deriveFeedback) {
    try {
      const candidates = await hooks.deriveFeedback(context);
      const accepted: RunFeedbackCandidate[] = [];
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const cleaned = scrubValue(candidate);
        if (isAdapterFeedbackCandidateShape(cleaned)) accepted.push(cleaned);
        else warnings.push(`${hookLabel}.deriveFeedback returned a candidate that is not a well-formed mimetic.feedback-candidate.v1 (or its adapter block lacked a non-empty namespace + data record); dropped so the bundle stays verifiable.`);
      }
      if (accepted.length > 0) {
        bundle.feedbackCandidates = [...bundle.feedbackCandidates, ...accepted];
      }
    } catch (error) {
      warnings.push(`${hookLabel}.deriveFeedback threw (${sanitize(error instanceof Error ? error.message : String(error))}); dropped so the bundle stays verifiable.`);
    }
  }
}

export function adapterScoreFailureMessage(bundle: RunBundle): string | undefined {
  return bundle.adapterScore?.status === "fail"
    ? `Adapter scorer failed the run: ${bundle.adapterScore.summary}`
    : undefined;
}

export function applyAdapterScoreFailureToReview(bundle: RunBundle): string | undefined {
  const message = adapterScoreFailureMessage(bundle);
  if (message === undefined) return undefined;

  if (bundle.review.verdict === "pass" || bundle.review.verdict === "contract_proof_only") {
    bundle.review.verdict = "fail";
    bundle.review.summary = message;
  }
  if (!bundle.review.gaps.includes(message)) {
    bundle.review.gaps = [...bundle.review.gaps, message];
  }
  return message;
}

function isAdapterScoreShape(value: unknown): value is RunAdapterScore {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as RunAdapterScore).schema === "mimetic.adapter-score.v1"
    && typeof (value as RunAdapterScore).namespace === "string"
    && (value as RunAdapterScore).namespace.trim().length > 0
    && ["pass", "partial", "fail"].includes((value as RunAdapterScore).status)
    && typeof (value as RunAdapterScore).score === "number"
    && Number.isFinite((value as RunAdapterScore).score)
    && typeof (value as RunAdapterScore).summary === "string"
    && ((value as RunAdapterScore).data === undefined
      || (typeof (value as RunAdapterScore).data === "object"
        && (value as RunAdapterScore).data !== null
        && !Array.isArray((value as RunAdapterScore).data)));
}

function isAdapterFeedbackCandidateShape(value: unknown): value is RunFeedbackCandidate {
  if (!isRecord(value)) return false;
  const candidate = value as Partial<RunFeedbackCandidate>;
  if (candidate.schema !== "mimetic.feedback-candidate.v1"
    || typeof candidate.id !== "string"
    || typeof candidate.run_id !== "string"
    || (candidate.stream_id !== undefined && typeof candidate.stream_id !== "string")
    || typeof candidate.adapter_id !== "string"
    || typeof candidate.scenario_id !== "string"
    || typeof candidate.persona_id !== "string"
    || !isFeedbackActor(candidate.actor)
    || !isFeedbackSubstrate(candidate.substrate)
    || !isFeedbackFailureOwner(candidate.failure_owner)
    || typeof candidate.summary !== "string"
    || candidate.summary.trim().length === 0
    || typeof candidate.expected !== "string"
    || typeof candidate.actual !== "string"
    || !Array.isArray(candidate.evidence)
    || !candidate.evidence.every(isFeedbackEvidence)
    || !isRecord(candidate.redaction)
    || candidate.redaction.status !== "passed"
    || typeof candidate.redaction.notes !== "string"
    || typeof candidate.idempotency_key !== "string"
    || !isFeedbackNextState(candidate.proposed_next_state)
    || !Array.isArray(candidate.acceptance_proof)
    || !candidate.acceptance_proof.every((item) => typeof item === "string")) {
    return false;
  }
  if (candidate.adapter !== undefined) {
    const adapter = candidate.adapter;
    if (!isRecord(adapter)
      || typeof adapter.namespace !== "string" || adapter.namespace.trim().length === 0
      || !isRecord(adapter.data)) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFeedbackActor(value: unknown): value is RunFeedbackCandidate["actor"] {
  return value === "codex-tui"
    || value === "codex-exec"
    || value === "codex-app-server"
    || value === "synthetic-dry-run"
    || value === "unknown";
}

function isFeedbackSubstrate(value: unknown): value is RunFeedbackCandidate["substrate"] {
  return value === "e2b-desktop"
    || value === "e2b-terminal"
    || value === "local-filesystem"
    || value === "codex-app-server"
    || value === "unknown";
}

function isFeedbackFailureOwner(value: unknown): value is RunFeedbackCandidate["failure_owner"] {
  return value === "harness"
    || value === "target-app"
    || value === "actor"
    || value === "environment"
    || value === "unknown";
}

function isFeedbackNextState(value: unknown): value is RunFeedbackCandidate["proposed_next_state"] {
  return value === "watch"
    || value === "adapter-hardening"
    || value === "target-app-setup"
    || value === "actor-auth"
    || value === "setup-quality-review"
    || value === "study-quality-review";
}

function isFeedbackEvidence(value: unknown): value is RunFeedbackCandidate["evidence"][number] {
  if (!isRecord(value)) return false;
  return typeof value.path === "string"
    && value.path.length > 0
    && !path.isAbsolute(value.path)
    && !value.path.includes("://")
    && !value.path.includes("..")
    && (
      value.kind === "review"
      || value.kind === "state"
      || value.kind === "log"
      || value.kind === "trace"
      || value.kind === "screenshot"
      || value.kind === "filesystem"
    )
    && typeof value.note === "string";
}
