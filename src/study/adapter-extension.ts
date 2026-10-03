import path from "node:path";

import type {
  RunAdapterArtifact,
  RunAdapterScore,
  RunBundle,
  RunFeedbackCandidate,
  RunScorerProvenance,
} from "../run/bundle.js";
import { isRunAdapterScore } from "../run/bundle-shape.js";
import { isRunFeedbackCandidate } from "../run/feedback-shape.js";
import { isRecord } from "../run/type-guards.js";

/** The routes that call a browser scorer. */
type BrowserScorerRoute = "computer-use" | "shared-world";

/**
 * Product-agnostic scoring context for browser/computer-use routes. Product-specific
 * evidence/rubrics stay in the adopter's repo; core provides the assembled bundle
 * plus stable run identifiers and never learns product nouns.
 */
export interface BrowserScoringContext {
  bundle: RunBundle;
  /**
   * Absolute path to the ignored run directory. Adapter hooks may write their
   * own product/state proof files here, then return relative references through
   * `deriveArtifacts`. This path is runtime-only and must never be persisted.
   */
  runDir: string;
  /** The study id. */
  studyId: string;
  runId: string;
  actor: string;
  /** The route that ran the participants. */
  route: BrowserScorerRoute;
  dryRun: boolean;
  /** How many participants the run had. */
  participantCount: number;
}

/** The scorer functions a computer-use or shared-world run calls: `RunStudyOptions.scorer`. */
export interface BrowserScorer {
  /**
   * Browser-route extension seam: a thin adapter may score the assembled
   * browser/shared-world evidence without forking core. The score is stored as
   * namespaced `bundle.adapterScore`; product-specific component detail belongs
   * in `data`, not in core enums or review text.
   */
  score?: (ctx: BrowserScoringContext) => RunAdapterScore | Promise<RunAdapterScore>;
  /**
   * Companion seam for public-safe, adapter-namespaced feedback candidates.
   * Malformed candidates are dropped before bundle persistence so core remains
   * verifiable even when an adapter misbehaves.
   */
  deriveFeedback?: (
    ctx: BrowserScoringContext,
  ) => RunFeedbackCandidate[] | Promise<RunFeedbackCandidate[]>;
  /**
   * Optional product/state proof artifact references. The adapter writes files
   * under `ctx.runDir` and returns local relative paths. Core stores only the
   * namespaced references and `verify` fails closed if referenced files are
   * missing or nonlocal.
   */
  deriveArtifacts?: (
    ctx: BrowserScoringContext,
  ) => RunAdapterArtifact[] | Promise<RunAdapterArtifact[]>;
}

/** What a scorer found against the run, for the route's final review fold (foldScorerFailures). */
export interface ScorerOutcome {
  /** Why the scorer failed the run, in order; empty when it did not. */
  failures: string[];
}

/** A declared scorer that returned a malformed value never rendered a verdict. */
export const DECLARED_SCORER_MALFORMED =
  "Declared product scorer returned a malformed value instead of a verdict; a declared gate that cannot render a pass is recorded as a fail, never a silent pass.";

/** A declared scorer that threw never rendered a verdict. `detail` is already sanitized. */
export function declaredScorerThrew(detail: string): string {
  return `Declared product scorer threw before returning a verdict (${detail}); a crashed declared gate is recorded as a fail, never a silent pass.`;
}

export async function applyBrowserScorer(args: {
  scorer: BrowserScorer | undefined;
  context: BrowserScoringContext;
  bundle: RunBundle;
  sanitize: (text: string) => string;
  warnings: string[];
  /** Present only when the scorer was config-declared; core-stamped onto the bundle as
   *  evidence of which out-of-tree module was loaded. Absent for library callers. Its presence also
   *  makes a throwing or malformed scorer a failure: a declared gate that cannot render a pass is
   *  a fail, never a silent green. */
  scorerProvenance?: RunScorerProvenance;
}): Promise<ScorerOutcome> {
  const { scorer, context, bundle, sanitize, warnings, scorerProvenance } = args;
  if (!scorer?.score && !scorer?.deriveFeedback && !scorer?.deriveArtifacts)
    return { failures: [] };
  const declared = scorerProvenance !== undefined;
  // Record the loaded scorer's identity regardless of hook outcome (a throwing/invalid scorer was
  // still loaded and attempted). A valid status:"fail" is a failure (library + declared, the
  // original path); a declared scorer that throws or returns a malformed value is one too (below).
  if (scorerProvenance) bundle.scorerProvenance = scorerProvenance;

  // The scorer sees a read-only view of the bundle: it cannot mutate noSpend/cost/review in place to
  // launder a verdict (a tamper attempt throws in the scorer's strict-mode ESM and is caught below as
  // a hook failure). The seam still stamps the real bundle.
  const scoringContext: BrowserScoringContext = {
    ...context,
    bundle: frozenBundleView(context.bundle),
  };

  const scrubValue = <T>(value: T): T => {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? value : (JSON.parse(sanitize(encoded)) as T);
  };

  const failures: string[] = [];
  if (scorer?.score) {
    try {
      const score = await scorer.score(scoringContext);
      const cleaned = scrubValue(score);
      if (isRunAdapterScore(cleaned)) {
        bundle.adapterScore = cleaned;
        const message = adapterScoreFailureMessage(bundle);
        if (message !== undefined) failures.push(message);
      } else {
        warnings.push(
          `scorer.score returned a value that is not a well-formed humanish.adapter-score.v1 (non-empty namespace + status + numeric score + summary); dropped so the bundle stays verifiable.`,
        );
        if (declared) failures.push(DECLARED_SCORER_MALFORMED);
      }
    } catch (error) {
      const detail = sanitize(error instanceof Error ? error.message : String(error));
      warnings.push(`scorer.score threw (${detail}); dropped so the bundle stays verifiable.`);
      if (declared) failures.push(declaredScorerThrew(detail));
    }
  }

  if (scorer?.deriveFeedback) {
    try {
      const candidates = await scorer.deriveFeedback(scoringContext);
      const accepted: RunFeedbackCandidate[] = [];
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const cleaned = scrubValue(candidate);
        if (isAdapterFeedbackCandidate(cleaned)) accepted.push(cleaned);
        else
          warnings.push(
            `scorer.deriveFeedback returned a candidate that is not a well-formed humanish.feedback-candidate.v1 (or its adapter block lacked a non-empty namespace + data record); dropped so the bundle stays verifiable.`,
          );
      }
      if (accepted.length > 0) {
        bundle.feedbackCandidates = [...bundle.feedbackCandidates, ...accepted];
      }
    } catch (error) {
      warnings.push(
        `scorer.deriveFeedback threw (${sanitize(error instanceof Error ? error.message : String(error))}); dropped so the bundle stays verifiable.`,
      );
    }
  }

  if (scorer?.deriveArtifacts) {
    try {
      const artifacts = await scorer.deriveArtifacts(scoringContext);
      const accepted: RunAdapterArtifact[] = [];
      for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
        const cleaned = scrubValue(artifact);
        if (isAdapterArtifactShape(cleaned)) accepted.push(cleaned);
        else
          warnings.push(
            `scorer.deriveArtifacts returned an artifact that is not a well-formed humanish.adapter-artifact.v1 (non-empty namespace + label + local path + supported kind); dropped so the bundle stays verifiable.`,
          );
      }
      if (accepted.length > 0) {
        bundle.adapterArtifacts = [...(bundle.adapterArtifacts ?? []), ...accepted];
      }
    } catch (error) {
      warnings.push(
        `scorer.deriveArtifacts threw (${sanitize(error instanceof Error ? error.message : String(error))}); dropped so the bundle stays verifiable.`,
      );
    }
  }

  return { failures };
}

/**
 * A feedback candidate a scorer returned, accepted at the seam: the bundle's candidate shape with a
 * non-empty summary. The browser and terminal seams both use it, so a candidate either seam drops
 * never reaches a bundle.
 */
export function isAdapterFeedbackCandidate(value: unknown): value is RunFeedbackCandidate {
  return isRunFeedbackCandidate(value) && value.summary.trim().length > 0;
}

export function adapterScoreFailureMessage(bundle: RunBundle): string | undefined {
  return bundle.adapterScore?.status === "fail"
    ? `Adapter scorer failed the run: ${bundle.adapterScore.summary}`
    : undefined;
}

/**
 * Deep-freeze a structured clone so a loaded scorer sees a read-only bundle: it cannot mutate
 * noSpend/cost/review in place to launder a verdict (which would defeat the costProbe-not-loadable
 * guarantee). A tamper attempt throws in the scorer's strict-mode ESM and is caught as a hook failure.
 * Legitimate read-only scoring is unaffected. The seam always stamps the real bundle, never this view.
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

function isAdapterArtifactShape(value: unknown): value is RunAdapterArtifact {
  if (!isRecord(value)) return false;
  const artifact = value as Partial<RunAdapterArtifact>;
  return (
    artifact.schema === "humanish.adapter-artifact.v1" &&
    typeof artifact.namespace === "string" &&
    artifact.namespace.trim().length > 0 &&
    typeof artifact.label === "string" &&
    artifact.label.trim().length > 0 &&
    typeof artifact.path === "string" &&
    isSafeRelativeArtifactPath(artifact.path) &&
    isAdapterArtifactKind(artifact.kind) &&
    typeof artifact.note === "string" &&
    artifact.note.trim().length > 0
  );
}

function isSafeRelativeArtifactPath(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("://") &&
    !value.split(/[\\/]/).some((part) => part === ".." || part === "." || part.length === 0)
  );
}

function isAdapterArtifactKind(value: unknown): value is RunAdapterArtifact["kind"] {
  return (
    value === "state" ||
    value === "review" ||
    value === "log" ||
    value === "trace" ||
    value === "screenshot" ||
    value === "filesystem" ||
    value === "summary"
  );
}
