import type { ActorWatch } from "../../contract.js";
import { watchFrames, type FrameRegion } from "../../../evidence/frame-change.js";
import { plural } from "../../../run/text.js";
import { planWait } from "../wait.js";
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
// A watch first lasts the turn's planned length, what planWait gave its waits before watches, so
// it never lasts longer than that wait did. Each further idle turn in a row whose watch ended at
// its limit with no change watches twice as long, up to the longer of its planned length and
// watchMaxMs. Any other ending, or a turn with another action, starts again from the planned
// length. A participant waiting on a static screen settles at one request per watchMaxMs.

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
  readonly observation?: CuaObservation;
  readonly stop?: Stop;
}

/**
 * The watches of one participant's idle turns. Between turns it keeps the run of idle turns the
 * doubling counts: a watch that ended at its limit makes the next one in the run longer, and a
 * turn with another action ends the run.
 */
export class IdleWatcher {
  /** The limit of the run's last watch, while that watch ended at its limit. */
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
    const lengths = actions.flatMap((action) =>
      action.kind === "wait" ? [planWait(session.waits, action.ms, true).ms] : [],
    );
    const plannedMs = lengths.reduce((sum, ms) => sum + ms, 0);
    if (plannedMs === 0) return undefined;
    const capMs = Math.max(plannedMs, session.waits.watchMaxMs);
    // Never shorter than the turn's own planned length, so a long named wait is not cut short.
    const limitMs =
      this.grownFromMs === undefined
        ? plannedMs
        : Math.min(capMs, Math.max(plannedMs, 2 * this.grownFromMs));
    const ending = await watchScreen(session, this.observer, turnNumber, reference, limitMs);
    this.grownFromMs = ending.wake === "limit" ? limitMs : undefined;
    return {
      wake: ending.wake,
      ...(ending.observation === undefined ? {} : { observation: ending.observation }),
      ...(ending.stop === undefined ? {} : { stop: ending.stop }),
      hint: hintFor(ending, limitMs < capMs ? capMs : undefined),
      waits: {
        ...splitWatch(lengths, limitMs, ending.ms),
        sessionEnded: ending.stop !== undefined,
        watch: {
          limitMs,
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
    const ended = (wake: ActorWatch["wake"], area?: FrameRegion): Ending => ({
      wake,
      ms,
      looks,
      observation: look.observation,
      ...(area === undefined ? {} : { area }),
    });
    // A condition comes first: the checkpoint persists the look that matched it (a task completed
    // at it is counted already), and the budget then stops the session before the next request.
    if (look.condition) return ended("condition");
    const overBudget = spendStop(session);
    if (overBudget !== undefined) return { ...ended("stopped"), stop: overBudget };
    if (look.speech) return ended("speech");
    const seen = compareLook(frames, referenceKey, look.observation, at);
    if (seen.changed) return ended("changed", seen.area);
    const windingDown = windDownAt !== undefined && at >= windDownAt;
    // A change still moving at the last look, such as a video, ended nothing: the participant
    // sees it in that look's frame, and the next watch grows as after a still screen.
    if (at >= limitAt || windingDown) return ended(windingDown ? "clock" : "limit");
    quickLooks = seen.largeMove && quickLooks < 2 ? quickLooks + 1 : 0;
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
): { readonly changed: boolean; readonly area?: FrameRegion; readonly largeMove: boolean } {
  if (frames === undefined || observation.screenshot === undefined)
    return { changed: progressKeyOf(observation) !== referenceKey, largeMove: false };
  const verdict = frames.next(observation.screenshot, atMs);
  if (verdict.verdict === "settled") return { changed: true, area: verdict.area, largeMove: false };
  return { changed: false, largeMove: verdict.verdict === "changing" && verdict.lookSoon };
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

/** The next request's note. A clock ending says nothing: the clock text that follows says it. */
function hintFor(ending: Ending, growsToMs: number | undefined): string | undefined {
  const lasted = `Your wait lasted ${duration(ending.ms)}`;
  switch (ending.wake) {
    case "changed":
      return `${lasted} and ended when the screen changed.`;
    case "speech":
      return `${lasted} and ended when you heard speech.`;
    case "condition":
      return `${lasted} and ended when the page changed.`;
    // A small change seen less than 65 s before the limit has not held still yet, so the hint
    // never says the screen stayed the same.
    case "limit":
      return growsToMs === undefined
        ? `${lasted}; no change on the screen held still long enough to end it.`
        : `${lasted}; no change on the screen held still long enough to end it. A wait right after it can last twice as long, at most ${duration(growsToMs)}.`;
    case "stalled":
      return `${lasted}; the screen could not be checked during it.`;
    case "clock":
    case "stopped":
      return undefined;
  }
}

function duration(ms: number): string {
  if (ms < 1_000) return plural(ms, "millisecond");
  if (ms < 120_000) return plural(Math.round(ms / 1_000), "second");
  return plural(Math.round(ms / 60_000), "minute");
}
