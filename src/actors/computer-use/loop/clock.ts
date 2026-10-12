import { plural } from "../../../run/text.js";
import type { Stop } from "./ending.js";
import type { LoopSession } from "./session.js";
import type { CuaObservation, ParticipantClock } from "./types.js";

// What the participant knows about the time. A hosted desktop shows a maximized browser with no
// OS clock, so a participant told "your shift ends at 11:00" cannot relate it to now unless each
// turn says so. The text rides the request's context hint, which every provider sends with the
// turn (OpenAI as a user message, Codex and the local agents as the harness note).

/**
 * The time text for the request the loop is about to send: the local time when the participant
 * has a time zone, and the end time and the minutes left from the start of its wind-down, or
 * after it tried to end its session before its end (`askedToEnd`). Undefined when there is
 * nothing to say.
 */
export function clockHint(
  clock: ParticipantClock | undefined,
  now: () => number,
  askedToEnd = false,
): string | undefined {
  if (clock === undefined) return undefined;
  const nowMs = now();
  const parts: string[] = [];
  if (clock.timeZone !== undefined)
    parts.push(`The local time is ${hourMinute(nowMs, clock.timeZone)} (${clock.timeZone}).`);
  const { end } = clock;
  if (end !== undefined && (askedToEnd || nowMs >= end.atMs - end.windDownMs)) {
    const minutesLeft = Math.max(1, Math.ceil((end.atMs - nowMs) / 60_000));
    parts.push(
      `${askedToEnd ? "Your session is not over. " : ""}Your session ends at ${endTime(clock, end.atMs)}, in ${plural(minutesLeft, "minute")}. Keep working until then. The session ends by itself at that time, and you will then be asked for your closing account.`,
    );
  }
  return parts.length === 0 ? undefined : parts.join(" ");
}

/**
 * Whether the participant has a scheduled end still to come. Its own end before then does not end
 * the session: the end is what the study declared for it.
 */
export function beforeScheduledEnd(session: LoopSession): boolean {
  const end = session.settings.clock?.end;
  return end !== undefined && session.now() < end.atMs;
}

/**
 * The stop at the participant's scheduled end, or undefined before it. The session passes as a
 * planned end and the participant is asked for its closing report on the last observation.
 */
export function scheduledEndStop(
  session: LoopSession,
  observation: CuaObservation,
): Stop | undefined {
  const end = session.settings.clock?.end;
  if (end === undefined || session.now() < end.atMs) return undefined;
  return {
    completionReason: "goal_satisfied",
    reason: `the participant's scheduled end at ${endTime(session.settings.clock!, end.atMs)} was reached`,
    stopCause: "scheduled_end",
    debriefTrigger: { kind: "scheduled_end", observation },
  };
}

// The end to the nearest minute: a run starts at no particular second, and "ends at 00:09" read
// at 00:09:06 looks past.
function endTime(clock: ParticipantClock, atMs: number): string {
  const minute = Math.round(atMs / 60_000) * 60_000;
  return clock.timeZone === undefined
    ? `${hourMinute(minute, "UTC")} UTC`
    : hourMinute(minute, clock.timeZone);
}

function hourMinute(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ms);
}
