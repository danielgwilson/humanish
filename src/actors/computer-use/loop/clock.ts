import { plural } from "../../../run/text.js";
import type { Stop } from "./ending.js";
import type { LoopSession } from "./session.js";
import type { CuaObservation, ParticipantClock } from "./types.js";

// What the participant knows about the time. A hosted desktop's panel clock shows the time in the
// participant's zone, or in UTC without one, and a local browser shows no clock. Neither shows
// when the session ends, so a participant told "your shift ends at 11:00" relates it to now
// through each turn's text. The text rides the request's context hint, which every provider sends
// with the turn (OpenAI as a user message, Codex and the local agents as the harness note).

/**
 * The time text for the request the loop is about to send: the local time when the participant
 * has a time zone, and the end time and the minutes left from the start of its wind-down, or
 * after it tried to end its session before its scheduled end (`askedToEnd`). Undefined when
 * there is nothing to say.
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
    const at = `${endTime(clock, end.atMs)}${end.kind === "session_cap" ? " at the latest" : ""}`;
    const close =
      end.kind === "session_cap"
        ? "You may end it sooner when you are done. If you are still working then, it ends by itself, and you will then be asked for your closing account."
        : "Keep working until then. The session ends by itself at that time, and you will then be asked for your closing account.";
    parts.push(
      `${askedToEnd ? "Your session is not over. " : ""}Your session ends at ${at}, in ${plural(minutesLeft, "minute")}. ${close}`,
    );
  }
  return parts.length === 0 ? undefined : parts.join(" ");
}

/**
 * Whether the participant is held to a scheduled end still to come. Its own end before then does
 * not end the session: the end is what the study declared for it. A session cap holds no one.
 */
export function heldToScheduledEnd(session: LoopSession): boolean {
  const end = session.settings.clock?.end;
  return end !== undefined && end.kind !== "session_cap" && session.now() < end.atMs;
}

/**
 * The stop at the participant's end, or undefined before it: its scheduled end or its session cap,
 * which is the stop cause. The session passes as a planned end and the participant is asked for
 * its closing report on the last observation.
 */
export function clockEndStop(session: LoopSession, observation: CuaObservation): Stop | undefined {
  const end = session.settings.clock?.end;
  if (end === undefined || session.now() < end.atMs) return undefined;
  const at = endTime(session.settings.clock!, end.atMs);
  const kind = end.kind ?? "scheduled_end";
  return {
    completionReason: "goal_satisfied",
    reason:
      kind === "session_cap"
        ? `the participant's session reached its cap at ${at}`
        : `the participant's scheduled end at ${at} was reached`,
    stopCause: kind,
    debriefTrigger: { kind, observation },
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
