import { actionFingerprint, isIdleTurn } from "./actions.js";
import type { CuaAction, CuaObservation } from "./types.js";

// The friction backstop. Abandonment is persona-judged first; this force-ends a session only on
// unambiguous pathology: an idle streak (turns that take no material action) or a no-progress
// streak (turns that neither change the UI state nor try something new). It is a pure fold over
// turns, never a turn budget.

const IDLE_PROGRESS_FORGIVENESS_STEPS = 2;
/** How many recent turns the repetition check looks back over (#383). */
const ACTION_REPEAT_WINDOW = 3;
/** Pixels of vertical scroll per progress bucket (#393): a real scroll step (typically >=100px)
 *  crosses a bucket and counts as progress; sub-bucket jiggle does not, so an actor nudging the
 *  same dead panel cannot stay "progressing" forever. */
const SCROLL_PROGRESS_BUCKET_PX = 200;

// Caps for stableProgressKey. The progress key is a coarse turn-over-turn comparison input, not a
// faithful serialization, so it bounds depth, breadth, string length and total output, and a huge
// or deeply nested appState cannot blow up the comparison. The values are generous (real
// route/turn/modal projections are tiny) but finite.
const STABLE_KEY_MAX_DEPTH = 6;
const STABLE_KEY_MAX_KEYS = 64;
const STABLE_KEY_MAX_ARRAY = 64;
const STABLE_KEY_MAX_STRING = 256;
const STABLE_KEY_MAX_TOTAL = 8192;

/**
 * A deterministic, bounded, sorted-key projection of an appState object, used as the friction
 * loop's progress key. Two structurally-equal states (regardless of key insertion order) map
 * to the SAME string, so key reordering can never fabricate a progress delta; two different
 * states map to different strings (within the caps).
 *
 * Correctness-load-bearing: it MUST NOT throw on a cyclic or huge input. Cycles are detected
 * with a seen-set (a back-edge degrades to the marker "[Circular]"); depth, key count, array
 * length, string length, and total output length are all capped so an adversarial or merely
 * large appState degrades to a bounded value rather than crashing the loop. Pure: it never
 * mutates the input. (See docs/architecture/state-driven-executor.md.)
 */
export function stableProgressKey(appState: Record<string, unknown>): string {
  const seen = new Set<unknown>();
  let truncated = false;
  const encode = (value: unknown, depth: number): string => {
    if (truncated) return '"…"';
    if (value === null) return "null";
    const type = typeof value;
    if (type === "number")
      return Number.isFinite(value as number) ? JSON.stringify(value) : `"${String(value)}"`;
    if (type === "boolean") return value ? "true" : "false";
    if (type === "bigint") return `"${(value as bigint).toString()}"`;
    if (type === "string") {
      const s = value as string;
      return JSON.stringify(
        s.length > STABLE_KEY_MAX_STRING ? `${s.slice(0, STABLE_KEY_MAX_STRING)}…` : s,
      );
    }
    if (type === "function" || type === "symbol" || type === "undefined") return `"[${type}]"`;
    // object or array
    if (depth >= STABLE_KEY_MAX_DEPTH) return '"[MaxDepth]"';
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const cap = Math.min(value.length, STABLE_KEY_MAX_ARRAY);
        const parts: string[] = [];
        for (let i = 0; i < cap; i += 1) {
          parts.push(encode(value[i], depth + 1));
          if (truncated) break;
        }
        if (value.length > STABLE_KEY_MAX_ARRAY) parts.push('"…"');
        return `[${parts.join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const cap = Math.min(keys.length, STABLE_KEY_MAX_KEYS);
      const parts: string[] = [];
      for (let i = 0; i < cap; i += 1) {
        const key = keys[i] as string;
        parts.push(`${JSON.stringify(key)}:${encode(record[key], depth + 1)}`);
        if (truncated) break;
      }
      if (keys.length > STABLE_KEY_MAX_KEYS) parts.push('"…":"…"');
      return `{${parts.join(",")}}`;
    } finally {
      // Leave the set so sibling subtrees that legitimately repeat a shared reference still
      // serialize once per occurrence-path without false "Circular" hits across siblings.
      seen.delete(value);
    }
  };
  let out = encode(appState, 0);
  if (out.length > STABLE_KEY_MAX_TOTAL) {
    truncated = true;
    out = `${out.slice(0, STABLE_KEY_MAX_TOTAL)}…`;
  }
  return out;
}

/**
 * The friction progress key: a stable projection of appState when present, else stateSignature.
 * A state executor with a constant signature still registers progress when its appState changes,
 * and a vision executor behaves exactly as before.
 */
function progressKeyOf(observation: CuaObservation): string {
  const base =
    observation.appState !== undefined
      ? stableProgressKey(observation.appState)
      : observation.stateSignature;
  // Scroll position is state (#393): a scroll-pinned section keeps the frame hash constant while
  // the participant genuinely advances, so the offset rides the key — bucketed, never raw.
  return observation.scrollY === undefined
    ? base
    : `${base}#s${Math.round(observation.scrollY / SCROLL_PROGRESS_BUCKET_PX)}`;
}

export interface Backstop {
  readonly progressKey: string;
  /** The last few turns' action fingerprints, in memory only, for the #383 corroboration rule. */
  readonly recentFingerprints: readonly string[];
  readonly consecutiveIdle: number;
  // One no-progress signal, idle turns included: turns that neither changed the progress key nor
  // brought new speech, and repeated a recent action (#383). The nudge, the stop threshold and the
  // reason all read this counter, so alternating idle and no-progress turns cannot slip past both
  // backstops.
  readonly consecutiveNoProgress: number;
  readonly idleProgressForgivenessUsed: number;
}

export function startBackstop(observation: CuaObservation): Backstop {
  return {
    progressKey: progressKeyOf(observation),
    recentFingerprints: [],
    consecutiveIdle: 0,
    consecutiveNoProgress: 0,
    idleProgressForgivenessUsed: 0,
  };
}

export interface BackstopLimits {
  readonly idleSteps: number;
  readonly noProgressSteps: number;
}

export interface BackstopStep {
  readonly backstop: Backstop;
  readonly idle: boolean;
  readonly progressed: boolean;
  /** Recovery nudges for the next request, before a streak trips. */
  readonly hints: readonly string[];
  /** The gave_up reason when a streak tripped. */
  readonly gaveUp: string | undefined;
}

/** Fold one acted turn and the observation after it into the backstop. */
export function advanceBackstop(
  previous: Backstop,
  turn: {
    actions: readonly CuaAction[];
    observation: CuaObservation;
    heardNewSpeech: boolean;
  },
  limits: BackstopLimits,
): BackstopStep {
  const idle = isIdleTurn(turn.actions);
  const progressKey = progressKeyOf(turn.observation);
  const frameChanged = progressKey !== previous.progressKey;

  // CORROBORATION (#383). A stale frame alone is NOT evidence of a stuck agent. The frame hash is
  // a coarse whole-screen measure, and on a light-themed web app it can miss a renamed row, a new
  // list item, or an opened panel — a measured run had 9 visibly different consecutive frames hash
  // identically while the agent was a foreign key away from finishing. Ending a lane on that
  // signal alone recorded working sessions as `gave_up`, capping every browser run at roughly
  // noProgressSteps turns and writing harness artifacts into evidence as actor behavior.
  //
  // So a no-progress turn now requires BOTH a stale frame AND the agent repeating something it
  // just tried. An agent doing varied work is never counted stuck, however blind the hash is;
  // an agent re-clicking the same dead control trips it as fast as it did before — arguably
  // faster, since that is the actual signature of being stuck.
  const fingerprint = actionFingerprint(turn.actions);
  const repeatingRecentAction =
    fingerprint.length > 0 && previous.recentFingerprints.includes(fingerprint);
  const recentFingerprints = [...previous.recentFingerprints, fingerprint].slice(
    -ACTION_REPEAT_WINDOW,
  );
  // Corroboration governs the FRAME-STALENESS backstop only. The idle backstop below is a direct
  // behavioral signal already (the agent took nothing but screenshots and waits), so it keeps
  // reading the frame on its own — a repeated screenshot is exactly what an idle streak IS, and
  // feeding repetition into it would grant an extra forgiveness step for being idle.
  const observedProgress = frameChanged || turn.heardNewSpeech;
  const progressed = observedProgress || !repeatingRecentAction;

  // A screenshot/wait turn while the UI visibly changes may be patience through loading or a
  // transition, so grant a bounded recovery window. Do not grant infinite immunity: animated
  // pixels or state-executor turn counters can otherwise keep a screenshot/wait loop alive
  // until the wall-clock timeout.
  let { consecutiveIdle, idleProgressForgivenessUsed } = previous;
  if (!idle) {
    idleProgressForgivenessUsed = 0;
    consecutiveIdle = 0;
  } else if (observedProgress && idleProgressForgivenessUsed < IDLE_PROGRESS_FORGIVENESS_STEPS) {
    idleProgressForgivenessUsed += 1;
    consecutiveIdle = 0;
  } else {
    consecutiveIdle += 1;
  }
  const consecutiveNoProgress = progressed ? 0 : previous.consecutiveNoProgress + 1;

  // An unchanged screen can be legitimate waiting (for example, a shared-world lobby).
  // Recovery may suggest another approach, but must not instruct early abandonment while
  // the task still calls for waiting. The counters, time and spend guards own hard stops.
  const noProgressRecoverySteps = Math.min(Math.max(1, limits.noProgressSteps - 1), 3);
  const idleRecoverySteps = Math.min(Math.max(1, limits.idleSteps - 1), 3);
  const hints: string[] = [];
  if (
    consecutiveNoProgress >= noProgressRecoverySteps &&
    consecutiveNoProgress < limits.noProgressSteps
  ) {
    hints.push(
      `No visible progress for ${consecutiveNoProgress} step(s). ` +
        "If your task calls for waiting for another participant or a pending transition, you may continue waiting. " +
        "Choose whether to continue or stop based on your situation and what you observe.",
    );
  }
  if (consecutiveIdle >= idleRecoverySteps && consecutiveIdle < limits.idleSteps) {
    hints.push(
      `You are only waiting or taking screenshots for ${consecutiveIdle} step(s). ` +
        "If your task calls for waiting, you may continue within the remaining session time. " +
        "When the relevant controls become actionable, continue your task; describe any blocker you actually encounter.",
    );
  }

  const gaveUp =
    consecutiveIdle >= limits.idleSteps
      ? `gave up: ${consecutiveIdle} consecutive turns with no material UI action (only screenshot/wait)`
      : consecutiveNoProgress >= limits.noProgressSteps
        ? `gave up: ${consecutiveNoProgress} consecutive turns with no change to the UI state`
        : undefined;
  return {
    backstop: {
      progressKey,
      recentFingerprints,
      consecutiveIdle,
      consecutiveNoProgress,
      idleProgressForgivenessUsed,
    },
    idle,
    progressed,
    hints,
    gaveUp,
  };
}
