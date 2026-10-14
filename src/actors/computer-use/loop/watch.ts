import type { ActorWatch } from "../../contract.js";
import {
  watchFrames,
  type FrameRegion,
  type FrameVerdict,
} from "../../../evidence/frame-change.js";
import { plural } from "../../../run/text.js";
import { isIdleTurn, type WatchedWaits } from "./actions.js";
import { progressKeyOf } from "./backstop.js";
import { clockEndStop } from "./clock.js";
import { timeLimit, type Stop } from "./ending.js";
import type { DesktopObserver, Look } from "./observation.js";
import { CuaAbortError, CuaStallError, raceSessionDeadline } from "./race.js";
import type { LoopSession } from "./session.js";
import { spendStop } from "./spend.js";
import type { CuaAction, CuaObservation } from "./types.js";

// A turn that only waits or takes screenshots and asks for some wait time is watched: no wait goes
// to the desktop, the loop looks at the screen every lookEveryMs, and the next model request comes
// when a change holds still (evidence/frame-change.ts), speech arrives, a study condition matches,
// the participant's wind-down or end arrives, or the watch's time passes.
//
// A watch first lasts the turn's planned length: its waits' named lengths, together up to
// watchMaxMs, and idleWaitMs for each wait that names none, and at least idleWaitMs. Each further
// idle turn in a row whose watch ended at its limit, or was woken by a small change (at most 24
// tiles) that held still, watches twice as long, up to the longer of its planned length and
// watchMaxMs. Any other ending, or a turn with another action, starts again from its first
// length. A participant waiting on a static screen settles at one request per watchMaxMs: at the
// default 10 minutes, one naming 1 minute each turn waits 60, 120, 240 and 480 s, then 10 minutes
// at a time.

/** A watch that ran for one idle turn: how it ended, and what the loop does next. */
export interface Watched {
  readonly wake: ActorWatch["wake"];
  /**
   * The look that ended the watch, which the checkpoint takes in place of a fresh observe. Absent
   * when no look ended it: a stalled look, or the participant's end.
   */
  readonly observation?: CuaObservation;
  /** The next request's note: how long the participant waited and why it woke. */
  readonly hint: string | undefined;
  /**
   * Set when the session ends here: the study budget or the session's time ran out, or the
   * participant's end came.
   */
  readonly stop?: Stop;
  /** Each wait's part of the watch, for the trace. */
  readonly waits: WatchedWaits;
}

/** How a watch ended, before the turn's hint and waits are worked out from it. */
interface Ending {
  readonly wake: ActorWatch["wake"];
  /** How long the watch lasted. */
  readonly ms: number;
  readonly looks: number;
  readonly area?: FrameRegion;
  /** What the look that ended the watch found, for the hint. */
  readonly seen?: FrameVerdict;
  readonly observation?: CuaObservation;
  readonly stop?: Stop;
}

/**
 * The watches of one participant's idle turns. Between turns it keeps the run of idle turns the
 * doubling counts: a watch that ended at its limit or on a small change makes the next one in the
 * run longer, and a turn with another action ends the run.
 */
export class IdleWatcher {
  /** The limit of the run's last watch, while that watch ended at its limit or on a small change. */
  private grownFromMs: number | undefined;

  constructor(
    private readonly session: LoopSession,
    private readonly observer: DesktopObserver,
  ) {}

  /**
   * Watch the screen in place of this turn's waits. Undefined, with nothing run, for a turn with
   * another action, which ends the run, or with no wait time (screenshots only, or waits of 0 ms),
   * which leaves the run as it is. `reference` is the observation the participant chose to wait on.
   */
  async watch(
    turnNumber: number,
    reference: CuaObservation,
    actions: readonly CuaAction[],
  ): Promise<Watched | undefined> {
    const { session } = this;
    if (!isIdleTurn(actions)) {
      this.grownFromMs = undefined;
      return undefined;
    }
    // A named wait past maxWaitMs, the longest one wait sent to the desktop lasts, is watched for
    // its length: a participant told to wait 10 minutes waits 10 minutes. A turn's named waits
    // together last at most watchMaxMs, in order, so a Codex call of 4 long waits stays open no
    // longer than one. A wait that names no length lasts idleWaitMs.
    const asked = actions.flatMap((action) =>
      action.kind === "wait" ? [Math.max(0, action.ms ?? session.waits.idleWaitMs)] : [],
    );
    let namedMs = 0;
    const lengths = actions.flatMap((action) => {
      if (action.kind !== "wait") return [];
      if (action.ms === undefined) return [session.waits.idleWaitMs];
      const ms = Math.min(Math.max(0, action.ms), session.waits.watchMaxMs - namedMs);
      namedMs += ms;
      return [ms];
    });
    const plannedMs = lengths.reduce((sum, ms) => sum + ms, 0);
    if (plannedMs === 0) return undefined;
    const capMs = Math.max(plannedMs, session.waits.watchMaxMs);
    // Never shorter than idleWaitMs, so a participant naming a few milliseconds on a static screen
    // does not send requests back to back, and never shorter than the turn's own planned length, so
    // a long named wait is not cut short.
    const shortestMs = Math.max(plannedMs, session.waits.idleWaitMs);
    const limitMs =
      this.grownFromMs === undefined
        ? shortestMs
        : Math.min(capMs, Math.max(shortestMs, 2 * this.grownFromMs));
    const ending = await watchScreen(session, this.observer, turnNumber, reference, limitMs);
    // A small change that held still (a status label, or a counter the rule did not hold back)
    // wakes the participant and keeps the doubling, so a repeating small change cannot keep every
    // watch short.
    const grows =
      ending.wake === "limit" || (ending.seen?.verdict === "settled" && ending.seen.small);
    this.grownFromMs = grows ? limitMs : undefined;
    return {
      wake: ending.wake,
      ...(ending.observation === undefined ? {} : { observation: ending.observation }),
      ...(ending.stop === undefined ? {} : { stop: ending.stop }),
      hint: hintFor(ending),
      waits: {
        ...splitWatch(lengths, limitMs, ending.ms),
        sessionEnded: ending.stop !== undefined,
        watch: {
          limitMs,
          askedMs: asked.reduce((sum, ms) => sum + ms, 0),
          wake: ending.wake,
          looks: ending.looks,
          ...(ending.area === undefined ? {} : { area: { ...ending.area } }),
        },
      },
    };
  }
}

async function watchScreen(
  session: LoopSession,
  observer: DesktopObserver,
  turnNumber: number,
  reference: CuaObservation,
  limitMs: number,
): Promise<Ending> {
  const { lookEveryMs, settleWaitMs } = session.waits;
  const startedAt = session.now();
  const limitAt = startedAt + limitMs;
  const deadlineAt = session.startedAtMs + session.timeoutMs;
  const end = session.settings.clock?.end;
  const endAt = end?.atMs;
  // A wind-down already under way bounds no watch: the participant was told when it started.
  const windDownAt =
    end !== undefined && end.atMs - end.windDownMs > startedAt
      ? end.atMs - end.windDownMs
      : undefined;
  // A reply that came back past the end or the deadline starts no watch.
  if (session.signal?.aborted) throw new CuaAbortError();
  if (endAt !== undefined && startedAt >= endAt)
    return {
      wake: "clock",
      ms: 0,
      looks: 0,
      ...stopAt(clockEndStop(session, reference, startedAt)),
    };
  if (startedAt >= deadlineAt)
    return { wake: "stopped", ms: 0, looks: 0, stop: timeLimit(session) };
  session.trace.record("notice", () => ({
    lifecycle: "started",
    title: "watching the screen",
    text: `until the screen changes or ${limitMs}ms pass, looking every ${lookEveryMs}ms and at the end; no model request until then`,
  }));
  session.flush();
  const frames = reference.screenshot === undefined ? undefined : watchFrames(reference.screenshot);
  const referenceKey = progressKeyOf(reference);
  let looks = 0;
  let quickLooks = 0;
  let lastLook: CuaObservation | undefined;
  let nextLookAt = startedAt + lookEveryMs;
  for (;;) {
    if (session.signal?.aborted) throw new CuaAbortError();
    session.phase = `watching the screen during turn ${turnNumber}`;
    const target = Math.min(
      nextLookAt,
      limitAt,
      windDownAt ?? limitAt,
      endAt ?? limitAt,
      deadlineAt,
    );
    const sleptFrom = session.now();
    await raceSessionDeadline(
      session.sleep(Math.max(0, target - sleptFrom)),
      deadlineAt - sleptFrom,
      session.signal,
    );
    // An injected clock need not move with the injected sleep; the watch's schedule still does.
    const at = Math.max(session.now(), target);
    // The wait lasts until the watch returns, so it includes the look that ended it, and a stalled
    // look's observe and retry.
    const lasted = (): number => Math.max(session.now(), at) - startedAt;
    // No observe after the end or the deadline: one started with no time left would fail, and at
    // the end the session would end as timed out. The stop is read at `at`: a host timer can fire
    // a millisecond before the clock reaches the end.
    if (endAt !== undefined && at >= endAt)
      return {
        wake: "clock",
        ms: lasted(),
        looks,
        ...stopAt(clockEndStop(session, lastLook ?? reference, at)),
      };
    if (at >= deadlineAt) return { wake: "stopped", ms: lasted(), looks, stop: timeLimit(session) };
    let look: Look;
    try {
      look = await observer.look(turnNumber);
    } catch (error) {
      if (error instanceof CuaStallError) return { wake: "stalled", ms: lasted(), looks };
      throw error;
    }
    looks += 1;
    lastLook = look.observation;
    const ms = lasted();
    const ended = (wake: ActorWatch["wake"], seen?: FrameVerdict): Ending => ({
      wake,
      ms,
      looks,
      observation: look.observation,
      ...(seen === undefined ? {} : { seen }),
      ...(seen?.verdict === "settled" ? { area: seen.area } : {}),
    });
    // A condition comes first: the checkpoint persists the look that matched it (a task completed
    // at it is counted already), and the budget then stops the session before the next request.
    if (look.condition) return ended("condition");
    const overBudget = spendStop(session);
    if (overBudget !== undefined) return { ...ended("stopped"), stop: overBudget };
    if (look.speech) return ended("speech");
    const seen = compareLook(frames, referenceKey, look.observation, at);
    if (seen.verdict === "settled") return ended("changed", seen);
    const windingDown = windDownAt !== undefined && at >= windDownAt;
    // A change still moving at the last look, such as a video, ended nothing: the participant
    // sees it in that look's frame, the hint says a large part was changing, and the next watch
    // grows as after a still screen.
    if (at >= limitAt || windingDown) return ended(windingDown ? "clock" : "limit", seen);
    const largeMove = seen.verdict === "changing" && seen.lookSoon;
    quickLooks = largeMove && quickLooks < 2 ? quickLooks + 1 : 0;
    nextLookAt = at + (quickLooks > 0 ? settleWaitMs : lookEveryMs);
  }
}

const stopAt = (stop: Stop | undefined): { stop?: Stop } => (stop === undefined ? {} : { stop });

/**
 * Whether a look shows a change that wakes the participant. A frame is compared with the reference
 * frame tile by tile; an observation without one (a state executor) by its progress key.
 */
function compareLook(
  frames: ReturnType<typeof watchFrames> | undefined,
  referenceKey: string,
  observation: CuaObservation,
  atMs: number,
): FrameVerdict {
  if (frames === undefined || observation.screenshot === undefined)
    return progressKeyOf(observation) === referenceKey
      ? { verdict: "unchanged" }
      : { verdict: "settled", area: { x: 0, y: 0, width: 0, height: 0 }, small: false };
  return frames.next(observation.screenshot, atMs);
}

/**
 * Each wait's part of a watch that lasted `ms`: the limit is shared among the waits in proportion
 * to their planned lengths, and the watch covers them in order. Later waits get 0.
 */
function splitWatch(
  lengths: readonly number[],
  limitMs: number,
  ms: number,
): { ms: number[]; endedOn: number } {
  const plannedMs = lengths.reduce((sum, length) => sum + length, 0);
  const starts: number[] = [];
  const ends: number[] = [];
  let planned = 0;
  for (const length of lengths) {
    starts.push(Math.floor((limitMs * planned) / plannedMs));
    planned += length;
    ends.push(Math.floor((limitMs * planned) / plannedMs));
  }
  const found = ends.findIndex((shareEnd, index) => shareEnd > starts[index]! && ms <= shareEnd);
  const endedOn = found === -1 ? lengths.length - 1 : found;
  return {
    ms: lengths.map((_, index) =>
      index < endedOn ? ends[index]! - starts[index]! : index === endedOn ? ms - starts[index]! : 0,
    ),
    endedOn,
  };
}

/**
 * The next request's note. A clock ending says nothing: the clock text that follows says it. A
 * small change is named by its place, so a participant is not told the screen changed when what
 * changed was a counter or a timestamp. The note says nothing of the next wait's length: a
 * participant told it names that length and keeps waiting.
 */
function hintFor(ending: Ending): string | undefined {
  const lasted = `Your wait lasted ${duration(ending.ms)}`;
  const { seen } = ending;
  switch (ending.wake) {
    case "changed":
      return seen?.verdict === "settled" && seen.small
        ? `${lasted} and ended when a small part of the screen changed and then stayed the same for over a minute, ${place(seen.area)}.`
        : `${lasted} and ended when the screen changed.`;
    case "speech":
      return `${lasted} and ended when you heard speech.`;
    case "condition":
      return `${lasted} and ended when the page changed.`;
    // A small change seen less than 65 s before the limit has not held still yet, so the hint
    // never says the screen stayed the same.
    case "limit":
      if (seen?.verdict === "changing" && seen.lookSoon)
        return `${lasted}; a large part of the screen was changing at its last check.`;
      if (seen?.verdict !== "settled" && seen?.held !== undefined)
        return `${lasted}; a small part of the screen changed and stayed the same, ${place(seen.held)}. A small change does not end a wait.`;
      return `${lasted}; no change on the screen held still long enough to end it.`;
    case "stalled":
      return `${lasted}; the screen could not be checked during it.`;
    case "clock":
    case "stopped":
      return undefined;
  }
}

const place = (area: FrameRegion): string =>
  `at x ${area.x}, y ${area.y} (${area.width} x ${area.height} pixels)`;

function duration(ms: number): string {
  if (ms < 1_000) return plural(ms, "millisecond");
  if (ms < 120_000) return plural(Math.round(ms / 1_000), "second");
  return plural(Math.round(ms / 60_000), "minute");
}
