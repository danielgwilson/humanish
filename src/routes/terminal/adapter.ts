import type { ActorTrace } from "../../actors/contract.js";
import {
  type RunBundle,
  type RunFeedbackCandidate,
  type RunScorerProvenance,
} from "../../run/bundle.js";
import { isRunAdapterScore } from "../../run/bundle-shape.js";
import {
  adapterScoreFailureMessage,
  declaredScorerThrew,
  DECLARED_SCORER_MALFORMED,
  frozenBundleView,
  isAdapterFeedbackCandidate,
  type ScorerOutcome,
} from "../../study/adapter-extension.js";
import type { TerminalLedgers, TerminalScorer, TerminalProductScoringContext } from "./types.js";

/**
 * Run the product-adapter extension seam over the assembled
 * evidence and attach its results to the bundle in place, without core knowing any product noun.
 * The review is not touched here: the returned failures are folded into it by the caller.
 *
 *  - `score`: when present, the returned namespaced `RunAdapterScore` lands on `bundle.adapterScore`.
 *    For a library caller (no `scorerProvenance`), the adapter score is additive and never a
 *    failure. For a config-declared scorer (`scorerProvenance` present), a status:"fail" is a
 *    failure (the keystone route is the product's own definition of pass/fail), and so is a scorer
 *    that throws or returns a malformed value, so a crashed declared gate is never a silent green.
 *  - `deriveFeedback`: when present, the returned candidates are appended to
 *    `bundle.feedbackCandidates`; each carries its own namespaced `adapter` product-noun block.
 *
 * Defense in depth: the adapter's namespaced payloads are re-serialized through the run's scrub +
 * redact, and any candidate / score that does not satisfy core's exported shape is dropped with a
 * warning (a malformed adapter output never poisons a verifiable bundle). The bundle verifier
 * re-checks the surviving shapes downstream, so the seam stays fail-closed end to end.
 */
export async function applyAdapterExtensionSeam(args: {
  scorer: TerminalScorer | undefined;
  bundle: RunBundle;
  trace: ActorTrace;
  ledgers: TerminalLedgers;
  transcript: string;
  product: string;
  studyId: string;
  runId: string;
  sanitize: (text: string) => string;
  warnings: string[];
  /** Present only when the scorer was config-declared. It is the "declared" marker that opts the
   *  terminal route into flip-on-fail. Absent for library callers (additive, back-compat). */
  scorerProvenance?: RunScorerProvenance;
}): Promise<ScorerOutcome> {
  const {
    scorer,
    bundle,
    trace,
    ledgers,
    transcript,
    product,
    studyId,
    runId,
    sanitize,
    warnings,
    scorerProvenance,
  } = args;
  if (!scorer?.score && !scorer?.deriveFeedback) return { failures: [] };
  const declared = scorerProvenance !== undefined;
  // Record the loaded scorer's identity regardless of hook outcome (a throwing/invalid scorer was
  // still loaded and attempted).
  if (scorerProvenance) bundle.scorerProvenance = scorerProvenance;

  // The scorer sees a read-only view of the bundle so it cannot mutate noSpend/cost/review in place to
  // launder a verdict (a tamper attempt throws and is caught as a hook failure below). The seam stamps
  // the real bundle. The transcript is the same normalized, source-scrubbed text the run persists as
  // terminal-transcript.txt, so the scorer sees nothing beyond what disk already holds.
  const ctx: TerminalProductScoringContext = {
    bundle: frozenBundleView(bundle),
    trace,
    ledgers,
    transcript,
    product,
    studyId,
    runId,
  };
  // Best-effort re-scrub of the adapter payload: round-trip the whole JSON through the run's denylist
  // sanitizer. It is a scrub with no containment: it catches recognizable secret shapes and known
  // local paths, and misses encoded/split/custom secrets, DB passwords, PII, or abs paths outside
  // the denylist. A
  // payload from config-declared code is acceptable only because the trust boundary (the party who
  // declares the scorer runs the study) already permits direct exfiltration; the re-scrub is
  // defense-in-depth, not a wall.
  const scrubValue = <T>(value: T): T => JSON.parse(sanitize(JSON.stringify(value))) as T;

  // Set for a declared scorer that fails to render a pass verdict (status:"fail", malformed, or throw).
  // The caller folds it into the review and fails the run result on it: a declared gate that cannot
  // pass is a fail, never a silent green. Empty for a library caller and for a passing scorer.
  const failures: string[] = [];

  if (scorer?.score) {
    try {
      const score = await scorer.score(ctx);
      const cleaned = scrubValue(score);
      if (isRunAdapterScore(cleaned)) {
        bundle.adapterScore = cleaned;
        // A config-declared terminal scorer owns the product verdict: a status:"fail" fails the
        // review and the run result. A library caller keeps the additive no-fail behavior.
        const message = declared ? adapterScoreFailureMessage(bundle) : undefined;
        if (message !== undefined) failures.push(message);
      } else {
        warnings.push(
          "scorer.score returned a value that is not a well-formed humanish.adapter-score.v1 (non-empty namespace + status + numeric score + summary); dropped so the bundle stays verifiable.",
        );
        // A declared gate that returned a malformed value never rendered a verdict, so it fails closed.
        if (declared) failures.push(DECLARED_SCORER_MALFORMED);
      }
    } catch (error) {
      const detail = sanitize(error instanceof Error ? error.message : String(error));
      warnings.push(`scorer.score threw (${detail}); dropped so the bundle stays verifiable.`);
      // A crashed declared gate must be visible, never a silent pass: it fails the review and the
      // run result.
      if (declared) failures.push(declaredScorerThrew(detail));
    }
  }

  if (scorer?.deriveFeedback) {
    try {
      const candidates = await scorer.deriveFeedback(ctx);
      const accepted: RunFeedbackCandidate[] = [];
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const cleaned = scrubValue(candidate);
        if (isAdapterFeedbackCandidate(cleaned)) accepted.push(cleaned);
        else
          warnings.push(
            "scorer.deriveFeedback returned a candidate that is not a well-formed humanish.feedback-candidate.v1 (or its adapter block lacked a non-empty namespace + data record); dropped so the bundle stays verifiable.",
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

  return { failures };
}
