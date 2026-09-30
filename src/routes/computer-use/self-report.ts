import type { CuaLoopResult } from "../../actors/computer-use/loop.js";
import { selfReportedBlocker, type BlockerFacts, type SessionEnding } from "../../run/judge.js";

// "can't" followed by a PERCEPTION verb describes what the screen showed, not an inability to
// proceed: "the canvas truncates it so you can't even read the whole thing", "I can't tell from
// the screen whether the rename is persisted", "so I could not read its full description". Five
// of five completed live runs on 2026-09-01 (two on drawDB, three on the planted benchmark app)
// were refused as "not a credible pass" on exactly these sentences, every one a defect report
// written AFTER the participant reached the goal. The more precisely a participant describes a
// display defect, the more likely the scan was to refuse the run — the incentive inversion #453
// fixed for resolved arcs, back in a new shape. "could not complete", "could not connect",
// "unable to get focus" still count: those name an inability to act.
const PERCEPTION_AFTER_MODAL =
  /\b(can'?t|cannot|could ?not|couldn'?t|unable to|wasn'?t able to)\s+(even\s+|quite\s+|really\s+|fully\s+)?(read|see|tell|view|make out|verify|confirm|be sure|be certain|judge|know)\b/g;

function hasBlockerLanguage(text: string): boolean {
  return (
    /\b(can'?t|cannot|could not|unable|blocked|blocker|failed|invalid|not set)\b/.test(text) ||
    /\b(shows|showing|hit|encountered|returned|got)\b.{0,80}\berror\b/.test(text) ||
    /\berror[:.]/.test(text) ||
    /what would you like me to do|please tell me|need (the )?(task|credentials|instructions)/.test(
      text,
    )
  );
}

/** The friction scan (inclusive): does the narrative report ANY blocker-shaped language,
 *  resolved or not? Feeds the participants `reportedFriction` tally and feedback candidates. */
// Report-shaped language: what a participant writes when it finished AND has something to say.
// Every one of the day's eleven drawDB reports (2026-09-01) opened a section "What confused me"
// or "Accessibility defects:"; none contained a blocker word, so none became a feedback candidate
// and a lane that had just replicated a keyboard-accessibility defect three times drafted "Live
// study completed without a participant-reported finding". Friction is the INCLUSIVE scan; a
// false positive here adds a candidate a person then reads, which is the cheap direction.
const REPORTED_DEFECT_LANGUAGE =
  /\b(defects?|bugs?|accessibilit(y|ies)|inaccessible|not (keyboard|screen.?reader)[- ]?accessible|confus(ed|ing)|hesitat(ed|ion)|unexpected(ly)?|unclear|hard to (find|tell|see|read|reach)|no (visible )?focus|overlap(ped|ping|s)?|truncat(ed|es|ion)|cut off|did nothing|nothing happened|no effect)\b/;

// The friction scan's own negations (#614). "Nothing was confusing", "no defects", "not unclear"
// are what a participant writes when it has NOTHING to report, and until 2026-09-03 each of them
// counted as reported friction and became a feedback candidate whose "actual" was a sentence
// reporting no problem. Only the report-shaped adjectives are negatable here: "no visible focus",
// "not keyboard-accessible" and "did nothing" are defects and stay.
const NEGATED_REPORT_ITEM = String.raw`(?:confus(?:ed|ing|ion)|unclear(?:\s+error\s+output)?|unexpected(?:ly)?|hesitat(?:ed|ion|ions)|surpris(?:ed|ing|es)|defects?|bugs?|overlap(?:ped|ping|s)?|truncat(?:ed|es|ion)|hard to (?:find|tell|see|read|reach)|blockers?|blocking issues?|errors?(?:\s+output)?|failures?|problems?|issues?)`;

const NEGATED_REPORT_QUALIFIERS = String.raw`(?:(?:really|particularly|especially|major|minor|real|actual|remaining|functional|obvious|noticeable|significant|any|a|an)\s+)*`;

const NEGATED_REPORT_MODIFIERS = String.raw`(?:(?:was|were|felt|seemed|really|particularly|especially|major|minor|real|actual|remaining|functional|obvious|noticeable|significant|any|a|an|encounter(?:ed)?|experience(?:d)?|notice(?:d)?|observe(?:d)?|feel|find|found|have|had)\s+)*`;

const NEGATED_REPORT_LANGUAGE = new RegExp(
  String.raw`\b(?:nothing|no|not|never|without|none|(?:did|do|does|was|were|has|have|had)n['’]t)\s+${NEGATED_REPORT_MODIFIERS}${NEGATED_REPORT_ITEM}\b` +
    // Negation scopes over a coordinated report list, not the rest of the sentence. In
    // particular, leave "but the label was confusing" and "and Save did nothing" intact.
    String.raw`(?:\s*,?\s+(?:or|nor|and)\s+${NEGATED_REPORT_QUALIFIERS}${NEGATED_REPORT_ITEM}\b)*` +
    // Keep the predicate inside its negation: "No errors blocked me" reports no blocker.
    String.raw`(?:\s+(?:blocked|stopped|prevented)\s+(?:me|us|it)\b)?`,
  "g",
);

function stripNegatedReportLanguage(text: string): string {
  // "Not without hesitation" reports hesitation; do not let the inner "without" erase it.
  return text.replace(/\b(?:not|never)\s+without\b/g, "with").replace(NEGATED_REPORT_LANGUAGE, " ");
}

function completionReasonContradictsGoal(reason: string): boolean {
  // Preserve the full negated list before the older blocker-specific rules remove its first
  // noun ("no issues or hesitation"). Matching reports first also avoids their broad encounter
  // clause rule swallowing a genuine subsequent observation.
  const text = stripQuotedSpans(
    stripNegatedNonBlockerPhrases(
      stripNegatedReportLanguage(stripCodeExamples(reason).toLowerCase()),
    ),
  );
  return hasBlockerLanguage(text) || REPORTED_DEFECT_LANGUAGE.test(text);
}

/** Code/documentation excerpts are quoted material, not participant observations. */
function stripCodeExamples(text: string): string {
  return (
    text
      // Include an unterminated fence: copied text is not promoted just because its closing fence
      // was omitted. Match the same marker so backticks inside a tilde fence cannot end it early.
      .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, " ")
      .replace(/(`+)[^`\n]*\1/g, " ")
  );
}

/** Interim messages also contain plans and hypotheses. Admit observed-report clauses only;
 * the established closing-report scan remains separate. This is a conservative text heuristic,
 * not an assertion that every mention of a defect is evidence that one happened. */
function interimMessageReportsFriction(message: string): boolean {
  const prose = stripQuotedSpans(stripCodeExamples(message).toLowerCase());
  const clauses = prose.split(
    /(?<=[.!?])\s+|[;\n]+|,\s*(?:but|so|however|yet)\s+|\s+so\s+(?=i\b|we\b)/,
  );
  return clauses.some((clause) => {
    // A condition, question, intention, or conjecture does not assert an observed result.
    // Clause splitting above keeps "Save did nothing, so I will try Enter" observable.
    if (
      /\?|\b(?:if|unless|whether|maybe|perhaps|suppose|hypothetically|might|may|would|should)\b|\bcould\b(?!\s+not\b)/.test(
        clause,
      ) ||
      /\b(?:i|we)(?:['’]ll|\s+(?:will|plan|intend|want|hope|suspect|wonder))\b|\bgoing to\b|\blet['’]s\b/.test(
        clause,
      ) ||
      /\b(?:task|goal|mission|objective|plan)\s+(?:(?:is|was)\s+)?to\b|^\s*(?:check|test|look|checking|testing)\b/.test(
        clause,
      )
    )
      return false;

    // A topic is not a defect ("the accessibility guide is open", "shows error-handling docs").
    // Actual friction in those surfaces still qualifies: "the error guide was confusing".
    const observation = clause
      .replace(/\baccessibilit(?:y|ies)\b/g, " ")
      .replace(
        /\berror[- ]handling\b|\berror\s+(?:documentation|docs?|guides?|reference|examples?)\b/g,
        " ",
      );
    const assertsObservation =
      /\b(?:is|are|was|were|has|had|did|does|shows?|showed|seems?|seemed|looks?|looked|found|noticed|saw|hit|encountered|felt|got|failed|returned|cannot|can['’]?t|unable|could not)\b|\b(?:overlap(?:ped|ping|s)?|truncat(?:ed|es)|cut off|nothing happened|no (?:visible )?focus)\b/.test(
        observation,
      );
    return assertsObservation && completionReasonContradictsGoal(observation);
  });
}

/** The verdict scan (strict): like the friction scan, but resolved-arc segments are stripped
 *  first — failure narration the participant itself reports as overcome is friction on the
 *  road, not a blocker at the destination (#453). */
function completionReasonBlocksVerdict(reason: string): boolean {
  // Perception phrases are stripped for the VERDICT only: "I could not read the full description"
  // is friction worth a tally count and a feedback candidate (the friction scan above keeps it),
  // and it is not a reason to refuse the pass.
  return hasBlockerLanguage(
    stripResolvedArcSegments(
      stripQuotedSpans(stripNegatedNonBlockerPhrases(reason.toLowerCase())),
    ).replace(PERCEPTION_AFTER_MODAL, ""),
  );
}

// A failure segment counts as a resolved arc when the recovery is self-reported either in the
// SAME segment ("the import failed but then went through") or — the common report shape — in the
// immediately FOLLOWING segment as a retry/alternative that succeeded ("my first import failed
// with a parser error. A simpler SQL import succeeded."). The lookahead demands the retry flavor
// on purpose: unrelated praise ("Separately, the search box worked") must never launder an
// unresolved failure. "Login failed so I gave up" has no recovery anywhere and stays a blocker.
// (#453 — the run-1 false negative: a defect report after demonstrated success failed the lane,
// an incentive inversion against exactly the participant behavior a study wants most.)
const RESOLUTION_TERMS =
  /\b(succeed(?:ed|s)?|success(?:ful|fully)?|worked|works around|then worked|now works?|resolved|fixed|recovered|got it working|went through)\b/;

const RETRY_RESOLUTION =
  /\b(simpler|simplified|retry(?:ing)?|retried|second (?:attempt|try)|another (?:attempt|try|approach)|different (?:approach|way|route)|instead|then|eventually|after that)\b[^.!?\n]{0,80}\b(succeed(?:ed|s)?|success(?:ful|fully)?|worked|went through|completed|passed)\b/;

/** Drop sentence/bullet segments whose failure language is part of a self-reported RESOLVED arc. */
function stripResolvedArcSegments(text: string): string {
  const segments = text.split(/(?<=[.!?])\s+|\n+/);
  return segments
    .filter((segment, index) => {
      if (!hasBlockerLanguage(segment)) return true;
      if (RESOLUTION_TERMS.test(segment)) return false;
      const next = segments[index + 1];
      return !(next !== undefined && RETRY_RESOLUTION.test(next));
    })
    .join(" ");
}

// Negations that DESCRIBE a defect rather than deny one. Kept out of every clause drop below.
const DEFECT_SHAPED_NEGATION =
  /\bno\s+(?:visible\s+)?focus\b|\bno\s+(?:keyboard|screen.?reader)[- ]?(?:access|path|route|way|alternative|equivalent)|\bnot\s+(?:keyboard|screen.?reader)[- ]?accessible\b|\bno\s+(?:effect|feedback|response)\b|\b(?:did|does)\s+nothing\b|\bnothing\s+happened\b/;

function stripNegatedNonBlockerPhrases(text: string): string {
  return (
    text
      // FIRST, before the narrower rules eat the "no blockers" and leave "encountered ... error"
      // behind: "I encountered no blockers or unclear error output." refused a clean passing run on
      // 2026-09-01. A verb of encounter followed by "no" negates the whole clause, so drop the clause.
      // ... unless the clause names a DEFECT: "the delete control had no visible focus" is a
      // finding, and the verb it happens to use must not decide whether it counts (#622).
      .replace(
        /\b(?:encountered|hit|saw|found|met|had|got|ran into)\s+no\s+[^.!?\n]*/g,
        (clause) => (DEFECT_SHAPED_NEGATION.test(clause) ? clause : " "),
      )
      .replace(
        /\bno\s+(?:real\s+|remaining\s+|actual\s+)?(?:blocker|blockers|blocking issue|blocking issues|error|errors|failure|failures)\s+(?:was\s+|were\s+)?(?:encountered|observed|found|hit|seen|reported|detected)\b/g,
        "",
      )
      .replace(
        /\bwithout\s+(?:a\s+|any\s+)?(?:real\s+|remaining\s+|actual\s+)?(?:blocker|blockers|blocking issue|blocking issues|error|errors|failure|failures)\b/g,
        "",
      )
      .replace(/\bnot\s+(?:blocked|a blocker|an error|failed)\b/g, "")
      // "No functional failures blocked me" downgraded a clean passing run to a lab failure on
      // 2026-09-01. The adjective list above is closed (real|remaining|actual), so an ordinary
      // qualifier like "functional" slipped through and the trailing verb "blocked" tripped the
      // scan. Allow up to two intervening words, and cover the verb form directly.
      .replace(
        /\bno\s+(?:\w+\s+){0,2}(?:blocker|blockers|blocking issues?|errors?|failures?|problems?|issues?)\b(?:\s+(?:blocked|stopped|prevented)\s+(?:me|us|it))?/g,
        " ",
      )
      .replace(/\bnothing\s+(?:\w+\s+){0,2}(?:blocked|stopped|prevented)\s+(?:me|us|it)\b/g, " ")
  );
}

/**
 * Remove double-quoted spans and markdown blockquote lines before the blocker scan, so a persona
 * that faithfully QUOTES the subject app's own copy (e.g. a banner reading "cannot be undone") is
 * not misread as the actor reporting its OWN blocker. Only double quotes (straight and smart) and
 * `>` blockquotes are stripped — never single quotes, which would mangle contractions like `can't`.
 */
function stripQuotedSpans(text: string): string {
  return text
    .replace(/"[^"]*"/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/^\s*>.*$/gm, " ");
}

function traceHasStopWhenMatch(session: CuaLoopResult): boolean {
  return session.trace.items.some(
    (item) =>
      item.kind === "notice" &&
      item.status === "matched" &&
      // A dwell window that ended the session (then: stop) is the same class of harness-owned,
      // structured completion as a matched stopWhen (#510).
      (item.title.startsWith("stopWhen matched") || item.title === "dwell window complete"),
  );
}

/**
 * A goal_satisfied lane counts as a self-reported blocker ONLY when its final narrative contradicts
 * the goal AND the run's own stop predicate did NOT fire. A matched stopWhen is independent,
 * structured completion evidence, so it overrides a text scan of the free-form narrative — which can
 * otherwise trip on the subject app's OWN quoted copy (e.g. a relayed "cannot be undone" banner).
 * Resolved-arc segments never block the verdict (#453). Returns the offending reason, or undefined
 * when the lane is a clean pass. Exported for testing.
 */
export function resolveSelfReportedBlocker(session: CuaLoopResult | undefined): string | undefined {
  return session !== undefined && selfReportedBlocker(blockerFacts(session))
    ? session.reason
    : undefined;
}

/**
 * A session's ending, reduced to what the judge's blocker rule reads. The closing report is read
 * here, where the participant's language is understood; the rule stays in judge.
 */
function blockerFacts(session: CuaLoopResult): BlockerFacts {
  return {
    completionReason: session.completionReason,
    stopConditionMatched: traceHasStopWhenMatch(session),
    ...(session.trace.declaredOutcome === undefined
      ? {}
      : { declaredOutcome: session.trace.declaredOutcome }),
    closingReportReadsBlocked: completionReasonBlocksVerdict(session.reason),
  };
}

/** A session's ending, reduced to what the judge's engagement and blocker rules read. */
export function sessionEnding(session: CuaLoopResult): SessionEnding {
  return {
    ...blockerFacts(session),
    actions: session.trace.counts.actions ?? 0,
    messages: session.trace.counts.messages ?? 0,
  };
}

/**
 * Friction is independent of how a completed session ended (#657). Read the participant's
 * redacted messages, including earlier reports, rather than the harness-owned reason that
 * stopWhen/dwell writes. Reasoning, observations, and notices are not participant reports.
 * Resolved arcs still count (#453); quoted copy and negated reports still do not. This read
 * never changes the verdict. Exported for testing.
 */
export function resolveSelfReportedFriction(
  session: CuaLoopResult | undefined,
): string | undefined {
  if (session?.completionReason !== "goal_satisfied") return undefined;
  // Friction stays a read of the narrative even when the outcome was declared: a participant who
  // reached the goal and described what was hard on the way has reported friction.
  if (session.trace.declaredOutcome === "blocked") return session.reason;
  const messages = session.trace.items
    .filter((item) => item.kind === "message" && item.id !== session.trace.debrief?.messageId)
    .map((item) => item.text?.trim() ?? "")
    .filter((text) => text.length > 0);
  // A custom session may keep its closing report only in reason even when earlier messages exist.
  // Structured stop/dwell reasons are controller text and never enter this closing-report path.
  const closingReport = traceHasStopWhenMatch(session) ? undefined : session.reason.trim();
  // One candidate per participant, with exact repeats removed (the closing report often repeats
  // a prior turn). Earlier turns require observed-report clauses, not arbitrary defect mentions.
  const typedReports =
    session.trace.debrief?.status === "completed"
      ? (session.trace.debrief.report?.frictionReports ?? [])
      : [];
  const reports = [
    ...new Set([
      ...typedReports,
      ...messages.filter((message) =>
        message === closingReport
          ? completionReasonContradictsGoal(message)
          : interimMessageReportsFriction(message),
      ),
    ]),
  ];
  if (
    closingReport &&
    completionReasonContradictsGoal(closingReport) &&
    !reports.includes(closingReport)
  ) {
    reports.push(closingReport);
  }
  if (reports.length > 0) return reports.join("\n\n");
  return undefined;
}
