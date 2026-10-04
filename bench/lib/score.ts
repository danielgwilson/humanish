// The deterministic scorer. It reads participant reports and analysis findings, matches them
// against the answer key in bench/taskly/answer-key.ts, and never calls a model. The arm label is
// used only to look up whether a matched claim is true on the build that was served; the matching
// itself never sees it.

import {
  CLAIM_CLASSES,
  D2_MECHANISM,
  DEFECT_IDS,
  ENGAGEMENT,
  NEGATED_TRUNCATION,
  PLANTED,
  PROBLEM_LANGUAGE,
  REASSURANCE,
  type Arm,
  type ClaimClass,
  type DefectId,
  type EvidenceFacts,
  type Truth,
} from "../taskly/answer-key.js";
import { isHeading, normalize, paragraphs, quote, sentences } from "./text.js";

export type Mechanism = "data_loss" | "display" | "ambiguous" | "unspecified";

export interface ClaimMatch {
  classId: string;
  quote: string;
}

/** One participant's evidence, as the scorer needs it. */
export interface ParticipantInput {
  streamId: string;
  /** The closing report (the trace's `reason`). */
  report: string;
  /** Messages and reasoning summaries recorded during the session. */
  narration: readonly string[];
  facts: EvidenceFacts;
}

export interface ReportScore {
  streamId: string;
  detected: Record<DefectId, boolean>;
  detectedQuotes: Partial<Record<DefectId, string>>;
  /** Planted arm only: the report says a broken control worked and never reports the defect. */
  falseAssurance: ClaimMatch[];
  d2Mechanism: Mechanism | null;
  /** The report or narration shows the participant used the defect's control at all. */
  engaged: Record<DefectId, boolean>;
  /** Claims the answer key marks false on this build. */
  invented: ClaimMatch[];
  /** Claims the answer key marks true on this build, other than the planted defects. */
  supported: ClaimMatch[];
  /** Claims the retained evidence ties to the harness, persona prompt or mission. */
  harness: ClaimMatch[];
  /** Problem paragraphs that match no claim class, for a person to check. */
  unresolved: string[];
}

export interface AnalysisFindingInput {
  id: string;
  title: string;
  summary: string;
  impact: string;
  confidence: string;
  observations: readonly { claim: string }[];
}

export interface AnalysisInputForScore {
  analysisId: string;
  model: string | null;
  promptVersion: string | null;
  summaryText: string;
  findings: readonly AnalysisFindingInput[];
}

export type FindingVerdict = "planted" | "supported" | "harness" | "invented" | "unresolved";

export interface FindingScore {
  id: string;
  title: string;
  impact: string;
  confidence: string;
  verdict: FindingVerdict;
  classes: string[];
  defects: DefectId[];
}

export interface AnalysisScore {
  analysisId: string;
  listed: Record<DefectId, boolean>;
  /** The impact grade of the first finding that names each listed defect. */
  impactByDefect: Partial<Record<DefectId, string>>;
  d2Mechanism: Mechanism | null;
  falseAssurance: ClaimMatch[];
  findings: FindingScore[];
}

const emptyDefects = <T>(value: T): Record<DefectId, T> => ({
  D1: value,
  D2: value,
  D3: value,
  D4: value,
  D5: value,
});

/** Whether a truth value holds for this evidence. */
export function holds(truth: Truth, facts: EvidenceFacts): boolean {
  if (truth === "typed-over-120") return (facts.maxTypedChars ?? 0) > 120;
  return truth === "true";
}

const NEGATION = /\b(?:not|no|nothing|never)\b|n't\b/;

function claimMatches(classDef: ClaimClass, sentence: string, paragraphText: string): boolean {
  if (classDef.id === "D2") {
    const stripped = sentence.replace(NEGATED_TRUNCATION, " ");
    const subject =
      /\b(?:tasks?|text|entr(?:y|ies)|description|labels?|sentences?|title|characters?|words?|notes?|names?)\b/;
    return classDef.claim.some((pattern) => pattern.test(stripped)) && subject.test(paragraphText);
  }
  return classDef.claim.some((pattern) => pattern.test(sentence));
}

function assuranceMatch(patterns: readonly RegExp[], sentence: string): boolean {
  return patterns.some((pattern) => {
    const match = pattern.exec(sentence);
    return match !== null && !NEGATION.test(match[0]);
  });
}

interface ParagraphMatches {
  paragraph: string;
  matches: ClaimMatch[];
}

/** Every claim class each paragraph of a text carries, one match per class per paragraph. */
function matchText(text: string): ParagraphMatches[] {
  return paragraphs(text).map((paragraph) => {
    const normalized = normalize(paragraph);
    const matches: ClaimMatch[] = [];
    for (const classDef of CLAIM_CLASSES) {
      const sentence = sentences(paragraph).find((candidate) =>
        claimMatches(classDef, candidate, normalized),
      );
      if (sentence !== undefined) matches.push({ classId: classDef.id, quote: quote(sentence) });
    }
    return { paragraph, matches };
  });
}

function mechanismOf(text: string): Mechanism {
  const normalized = normalize(text).replace(D2_MECHANISM.negatedLoss, " ");
  if (D2_MECHANISM.strongLoss.some((pattern) => pattern.test(normalized))) return "data_loss";
  const weak = D2_MECHANISM.weakLoss.some((pattern) => pattern.test(normalized));
  const display = D2_MECHANISM.display.some((pattern) => pattern.test(normalized));
  if (weak && display) return "ambiguous";
  if (weak) return "data_loss";
  if (display) return "display";
  return "unspecified";
}

function classById(id: string): ClaimClass {
  const found = CLAIM_CLASSES.find((classDef) => classDef.id === id);
  if (!found) throw new Error(`Unknown claim class ${id}`);
  return found;
}

type Disposition = "planted" | "supported" | "harness" | "invented" | "none";

/** What one matched class means on this arm, given the evidence. */
function dispose(classDef: ClaimClass, arm: Arm, facts: EvidenceFacts): Disposition {
  if (classDef.kind === "harness") return classDef.evidence(facts) ? "harness" : "none";
  const holdsHere = holds(classDef.truth[arm], facts);
  if (!holdsHere) return "invented";
  return classDef.kind === "planted" && arm === "planted" ? "planted" : "supported";
}

function isProblem(paragraph: string): boolean {
  if (isHeading(paragraph)) return false;
  const text = normalize(paragraph).replace(REASSURANCE, " ").replace(NEGATED_TRUNCATION, " ");
  return PROBLEM_LANGUAGE.test(text);
}

function engagedWith(defect: DefectId, text: string, facts: EvidenceFacts): boolean {
  const rule = ENGAGEMENT[defect];
  if (rule === "always") return true;
  if (rule === "typed-over-30") return (facts.maxTypedChars ?? 0) > 30;
  return rule.test(text);
}

/** Score one participant's closing report against the answer key. */
export function scoreReport(input: ParticipantInput, arm: Arm): ReportScore {
  const matched = matchText(input.report);
  const detected = emptyDefects(false);
  const detectedQuotes: Partial<Record<DefectId, string>> = {};
  const invented: ClaimMatch[] = [];
  const supported: ClaimMatch[] = [];
  const harness: ClaimMatch[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const d2Paragraphs: string[] = [];

  for (const { paragraph, matches } of matched) {
    let explained = false;
    for (const match of matches) {
      const classDef = classById(match.classId);
      const disposition = dispose(classDef, arm, input.facts);
      if (disposition !== "none") explained = true;
      if (classDef.kind === "planted" && classDef.id === "D2") d2Paragraphs.push(paragraph);
      if (seen.has(match.classId) || disposition === "none") continue;
      seen.add(match.classId);
      if (disposition === "planted") {
        const id = classDef.id as DefectId;
        detected[id] = true;
        detectedQuotes[id] = match.quote;
      } else if (disposition === "supported") supported.push(match);
      else if (disposition === "invented") invented.push(match);
      else harness.push(match);
    }
    if (!explained && isProblem(paragraph)) unresolved.push(quote(normalize(paragraph)));
  }

  const falseAssurance: ClaimMatch[] = [];
  if (arm === "planted") {
    for (const defect of PLANTED) {
      if (detected[defect.id]) continue;
      for (const paragraph of paragraphs(input.report)) {
        const sentence = sentences(paragraph).find((candidate) =>
          assuranceMatch(defect.assurance, candidate),
        );
        if (sentence !== undefined) {
          falseAssurance.push({ classId: defect.id, quote: quote(sentence) });
          break;
        }
      }
    }
  }

  const everything = normalize([input.report, ...input.narration].join("\n"));
  const engaged = emptyDefects(false);
  for (const defect of DEFECT_IDS) engaged[defect] = engagedWith(defect, everything, input.facts);

  return {
    streamId: input.streamId,
    detected,
    detectedQuotes,
    falseAssurance,
    d2Mechanism: detected.D2 ? mechanismOf(d2Paragraphs.join("\n\n")) : null,
    engaged,
    invented,
    supported,
    harness,
    unresolved,
  };
}

function classesIn(text: string): ClaimClass[] {
  const normalized = normalize(text);
  return CLAIM_CLASSES.filter((classDef) =>
    sentences(text).some((sentence) => claimMatches(classDef, sentence, normalized)),
  );
}

function findingText(finding: AnalysisFindingInput): string {
  const observations = finding.observations.map((observation) => observation.claim).join(" ");
  return `${finding.title}. ${finding.summary} ${observations}`;
}

/**
 * Score one analysis artifact. `facts` combine every participant of the analyzed run: the analysis
 * sees all of them, so a finding is true when any participant's evidence makes it true.
 */
export function scoreAnalysis(
  input: AnalysisInputForScore,
  arm: Arm,
  facts: EvidenceFacts,
): AnalysisScore {
  const listed = emptyDefects(false);
  const impactByDefect: Partial<Record<DefectId, string>> = {};
  const findings: FindingScore[] = [];
  let d2Mechanism: Mechanism | null = null;

  for (const finding of input.findings) {
    const text = findingText(finding);
    // The title names what the finding is about; its evidence can mention other defects in passing.
    const titleClasses = classesIn(finding.title);
    const classes = titleClasses.length > 0 ? titleClasses : classesIn(text);
    const dispositions = classes.map((classDef) => ({
      classDef,
      disposition: dispose(classDef, arm, facts),
    }));
    const defects = dispositions
      .filter(({ classDef, disposition }) => classDef.kind === "planted" && disposition === "planted")
      .map(({ classDef }) => classDef.id as DefectId);
    let verdict: FindingVerdict = "unresolved";
    if (defects.length > 0) verdict = "planted";
    else if (dispositions.some(({ disposition }) => disposition === "supported")) verdict = "supported";
    else if (dispositions.some(({ disposition }) => disposition === "harness")) verdict = "harness";
    else if (dispositions.some(({ disposition }) => disposition === "invented")) verdict = "invented";

    for (const defect of defects) {
      if (!listed[defect]) impactByDefect[defect] = finding.impact;
      listed[defect] = true;
    }
    if (defects.includes("D2") && d2Mechanism === null) d2Mechanism = mechanismOf(text);
    findings.push({
      id: finding.id,
      title: finding.title,
      impact: finding.impact,
      confidence: finding.confidence,
      verdict,
      classes: classes.map((classDef) => classDef.id),
      defects,
    });
  }

  const falseAssurance: ClaimMatch[] = [];
  if (arm === "planted") {
    for (const defect of PLANTED) {
      if (listed[defect.id]) continue;
      const sentence = sentences(input.summaryText).find((candidate) =>
        assuranceMatch(defect.assurance, candidate),
      );
      if (sentence !== undefined) falseAssurance.push({ classId: defect.id, quote: quote(sentence) });
    }
  }

  return {
    analysisId: input.analysisId,
    listed,
    impactByDefect,
    d2Mechanism,
    falseAssurance,
    findings,
  };
}

/** Facts for an analysis: the union over the run's participants. */
export function combineFacts(all: readonly EvidenceFacts[], mission: string): EvidenceFacts {
  const typed = all.map((facts) => facts.maxTypedChars).filter((value): value is number => value !== null);
  return {
    maxTypedChars: typed.length === 0 ? null : Math.max(...typed),
    providerStall: all.some((facts) => facts.providerStall),
    failedAction: all.some((facts) => facts.failedAction),
    personaTraits: [...new Set(all.flatMap((facts) => facts.personaTraits))],
    mission,
  };
}
