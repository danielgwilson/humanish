export type StopConditionPrimitive = string | number | boolean | null;

export interface StopWhenAppStatePathEquals {
  path: string;
  equals: StopConditionPrimitive;
}

export interface StopWhenRule {
  id?: string;
  urlIncludes?: string;
  urlPathEquals?: string;
  textIncludes?: string;
  appStatePathEquals?: StopWhenAppStatePathEquals;
}

export interface StopWhen {
  any: StopWhenRule[];
}

/**
 * A declared observation window (#510): once `when` matches (or at the start, when `when` is
 * absent), the harness holds the page for `ms`, captures a frame every `everyMs`, takes no action
 * and requests no model turn, then hands control back to the participant (`then: continue`) or
 * ends the session (`then: stop`). Bounded by the session budget: a window that would outlast it
 * is cut to fit. The study is observing; the participant is not "waiting".
 */
export interface DwellWindow {
  when?: StopWhen;
  ms: number;
  everyMs: number;
  then: "continue" | "stop";
}

export interface StopConditionObservation {
  url?: string;
  text?: string;
  appState?: Record<string, unknown>;
}

export interface StopConditionMatch {
  id: string;
  ruleIndex: number;
  kinds: string[];
}

export function evaluateStopWhen(
  stopWhen: StopWhen | undefined,
  observation: StopConditionObservation
): StopConditionMatch | undefined {
  if (!stopWhen) return undefined;
  for (const [ruleIndex, rule] of stopWhen.any.entries()) {
    const kinds: string[] = [];
    if (rule.urlIncludes !== undefined) {
      if (observation.url === undefined || !observation.url.includes(rule.urlIncludes)) {
        continue;
      }
      kinds.push("urlIncludes");
    }
    if (rule.urlPathEquals !== undefined) {
      if (pathOfUrl(observation.url) !== rule.urlPathEquals) {
        continue;
      }
      kinds.push("urlPathEquals");
    }
    if (rule.textIncludes !== undefined) {
      if (observation.text === undefined || !observation.text.includes(rule.textIncludes)) {
        continue;
      }
      kinds.push("textIncludes");
    }
    if (rule.appStatePathEquals !== undefined) {
      const actual = valueAtPath(observation.appState, rule.appStatePathEquals.path);
      if (actual !== rule.appStatePathEquals.equals) {
        continue;
      }
      kinds.push("appStatePathEquals");
    }
    if (kinds.length === 0) continue;
    return {
      id: rule.id ?? `rule-${String(ruleIndex + 1).padStart(2, "0")}`,
      ruleIndex,
      kinds
    };
  }
  return undefined;
}

function pathOfUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, "http://humanish.local").pathname;
  } catch {
    return undefined;
  }
}

function valueAtPath(source: Record<string, unknown> | undefined, path: string): unknown {
  if (!source) return undefined;
  const parts = path.split(".").filter(Boolean);
  let current: unknown = source;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
