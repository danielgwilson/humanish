import path from "node:path";

import type {
  RunAdapterArtifact,
  RunAdapterScore,
  RunBundle,
  RunFeedbackCandidate,
  RunScorerProvenance
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
  /**
   * Absolute path to the ignored run directory. Adapter hooks may write their
   * own product/state proof files here, then return relative references through
   * `deriveArtifacts`. This path is runtime-only and must never be persisted.
   */
  runDir: string;
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
  /**
   * Optional product/state proof artifact references. The adapter writes files
   * under `ctx.runDir` and returns local relative paths. Core stores only the
   * namespaced references and `verify` fails closed if referenced files are
   * missing or nonlocal.
   */
  deriveArtifacts?: (ctx: BrowserLabScoringContext) => RunAdapterArtifact[] | Promise<RunAdapterArtifact[]>;
}

export async function applyBrowserAdapterHooks(args: {
  hooks: BrowserLabAdapterHooks | undefined;
  context: BrowserLabScoringContext;
  bundle: RunBundle;
  sanitize: (text: string) => string;
  warnings: string[];
  hookLabel: string;
  /** Present only when the scorer was CONFIG-DECLARED (#316); core-stamped onto the bundle as
   *  evidence of which out-of-tree module was loaded. Absent for library callers. Its presence also
   *  opts a THROWING or MALFORMED scorer into the declared-gate downgrade — a declared gate that
   *  cannot render a pass is a fail, never a silent green. */
  scorerProvenance?: RunScorerProvenance;
}): Promise<{ declaredVerdictFailure?: string }> {
  const { hooks, context, bundle, sanitize, warnings, hookLabel, scorerProvenance } = args;
  if (!hooks?.score && !hooks?.deriveFeedback && !hooks?.deriveArtifacts) return {};
  const declared = scorerProvenance !== undefined;
  // Record the loaded scorer's identity regardless of hook outcome (a throwing/invalid scorer was
  // still loaded and attempted). A VALID status:"fail" flips the review below via the pre-#316 (#165)
  // path (library + declared); a DECLARED scorer that THROWS or returns MALFORMED also fails (below).
  if (scorerProvenance) bundle.scorerProvenance = scorerProvenance;

  // The scorer sees a READ-ONLY view of the bundle: it cannot mutate noSpend/cost/review in place to
  // launder a verdict (a tamper attempt throws in the scorer's strict-mode ESM and is caught below as
  // a hook failure). The seam still stamps the REAL bundle.
  const scoringContext: BrowserLabScoringContext = { ...context, bundle: frozenBundleView(context.bundle) };

  const scrubValue = <T>(value: T): T => {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? value : JSON.parse(sanitize(encoded)) as T;
  };

  let declaredVerdictFailure: string | undefined;
  if (hooks.score) {
    try {
      const score = await hooks.score(scoringContext);
      const cleaned = scrubValue(score);
      if (isAdapterScoreShape(cleaned)) {
        bundle.adapterScore = cleaned;
        const message = applyAdapterScoreFailureToReview(bundle);
        if (declared && message !== undefined) declaredVerdictFailure = message;
      } else {
        warnings.push(`${hookLabel}.score returned a value that is not a well-formed humanish.adapter-score.v1 (non-empty namespace + status + numeric score + summary); dropped so the bundle stays verifiable.`);
        if (declared) {
          declaredVerdictFailure = "Declared product scorer returned a malformed value instead of a verdict; a declared gate that cannot render a pass is recorded as a fail, never a silent pass.";
          recordDeclaredScorerVerdictFailure(bundle, declaredVerdictFailure);
        }
      }
    } catch (error) {
      const detail = sanitize(error instanceof Error ? error.message : String(error));
      warnings.push(`${hookLabel}.score threw (${detail}); dropped so the bundle stays verifiable.`);
      if (declared) {
        declaredVerdictFailure = `Declared product scorer threw before returning a verdict (${detail}); a crashed declared gate is recorded as a fail, never a silent pass.`;
        recordDeclaredScorerVerdictFailure(bundle, declaredVerdictFailure);
      }
    }
  }

  if (hooks.deriveFeedback) {
    try {
      const candidates = await hooks.deriveFeedback(scoringContext);
      const accepted: RunFeedbackCandidate[] = [];
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const cleaned = scrubValue(candidate);
        if (isAdapterFeedbackCandidateShape(cleaned)) accepted.push(cleaned);
        else warnings.push(`${hookLabel}.deriveFeedback returned a candidate that is not a well-formed humanish.feedback-candidate.v1 (or its adapter block lacked a non-empty namespace + data record); dropped so the bundle stays verifiable.`);
      }
      if (accepted.length > 0) {
        bundle.feedbackCandidates = [...bundle.feedbackCandidates, ...accepted];
      }
    } catch (error) {
      warnings.push(`${hookLabel}.deriveFeedback threw (${sanitize(error instanceof Error ? error.message : String(error))}); dropped so the bundle stays verifiable.`);
    }
  }

  if (hooks.deriveArtifacts) {
    try {
      const artifacts = await hooks.deriveArtifacts(scoringContext);
      const accepted: RunAdapterArtifact[] = [];
      for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
        const cleaned = scrubValue(artifact);
        if (isAdapterArtifactShape(cleaned)) accepted.push(cleaned);
        else warnings.push(`${hookLabel}.deriveArtifacts returned an artifact that is not a well-formed humanish.adapter-artifact.v1 (non-empty namespace + label + local path + supported kind); dropped so the bundle stays verifiable.`);
      }
      if (accepted.length > 0) {
        bundle.adapterArtifacts = [...(bundle.adapterArtifacts ?? []), ...accepted];
      }
    } catch (error) {
      warnings.push(`${hookLabel}.deriveArtifacts threw (${sanitize(error instanceof Error ? error.message : String(error))}); dropped so the bundle stays verifiable.`);
    }
  }

  return declaredVerdictFailure === undefined ? {} : { declaredVerdictFailure };
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

/**
 * A CONFIG-DECLARED scorer (#316) that fails to render a PASS verdict — it returned status:"fail",
 * threw, or returned a malformed value — must never leave a silent green (the declared-gate invariant:
 * a gate that cannot render a pass is a fail, never a silent pass). Adds a review gap and downgrades a
 * would-be pass/contract_proof_only to fail (this ONLY ever makes the verdict STRICTER). Callers gate
 * on `declared`, so library callers are never affected.
 */
export function recordDeclaredScorerVerdictFailure(bundle: RunBundle, reason: string): void {
  if (!bundle.review.gaps.includes(reason)) bundle.review.gaps = [...bundle.review.gaps, reason];
  if (bundle.review.verdict === "pass" || bundle.review.verdict === "contract_proof_only") {
    bundle.review.verdict = "fail";
    bundle.review.summary = reason;
  }
}

/**
 * Deep-freeze a structured clone so a loaded scorer sees a READ-ONLY bundle: it cannot mutate
 * noSpend/cost/review in place to launder a verdict (which would defeat the costProbe-not-loadable
 * guarantee). A tamper attempt throws in the scorer's strict-mode ESM and is caught as a hook failure.
 * Legitimate read-only scoring is unaffected. The seam always stamps the REAL bundle, never this view.
 */
export function frozenBundleView(bundle: RunBundle): RunBundle {
  const clone = structuredClone(bundle);
  const freeze = (obj: unknown): void => {
    if (obj !== null && typeof obj === "object" && !Object.isFrozen(obj)) {
      Object.freeze(obj);
      for (const key of Object.keys(obj as Record<string, unknown>)) {
        freeze((obj as Record<string, unknown>)[key]);
      }
    }
  };
  freeze(clone);
  return clone;
}

function isAdapterScoreShape(value: unknown): value is RunAdapterScore {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as RunAdapterScore).schema === "humanish.adapter-score.v1"
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
  if (candidate.schema !== "humanish.feedback-candidate.v1"
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

function isAdapterArtifactShape(value: unknown): value is RunAdapterArtifact {
  if (!isRecord(value)) return false;
  const artifact = value as Partial<RunAdapterArtifact>;
  return artifact.schema === "humanish.adapter-artifact.v1"
    && typeof artifact.namespace === "string"
    && artifact.namespace.trim().length > 0
    && typeof artifact.label === "string"
    && artifact.label.trim().length > 0
    && typeof artifact.path === "string"
    && isSafeRelativeArtifactPath(artifact.path)
    && isAdapterArtifactKind(artifact.kind)
    && typeof artifact.note === "string"
    && artifact.note.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativeArtifactPath(value: string): boolean {
  return value.trim().length > 0
    && !path.isAbsolute(value)
    && !value.includes("://")
    && !value.split(/[\\/]/).some((part) => part === ".." || part === "." || part.length === 0);
}

function isAdapterArtifactKind(value: unknown): value is RunAdapterArtifact["kind"] {
  return value === "state"
    || value === "review"
    || value === "log"
    || value === "trace"
    || value === "screenshot"
    || value === "filesystem"
    || value === "summary";
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
