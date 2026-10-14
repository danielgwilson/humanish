import type { LoopSession } from "./session.js";
import { notice } from "./trace.js";

// The record of a held participant's no-progress streaks. Past noProgressSteps a streak no longer
// ends the session of a participant held to its scheduled end (backstop.ts), so the trace says how
// many turns it had and when: analysis reads the notice as friction, and the review lists it.

/** The title of the notice that records one streak. */
export const STREAK_TITLE = "repeated an action on an unchanged screen";

interface Streak {
  readonly turns: number;
  /** When the streak's first and latest turns were seen. */
  readonly fromMs: number;
  readonly toMs: number;
}

/** The streak the participant is in, recorded when a turn ends it or the session ends. */
export class StreakRecord {
  private open: Streak | undefined;

  constructor(private readonly session: LoopSession) {}

  /**
   * Fold one turn's streak length, the backstop's consecutiveNoProgress after the turn. A held
   * participant's idle turn leaves the length as it was, and the streak's time span with it. Only
   * the streak of a participant with a scheduled end is followed: any other one ends the session
   * at noProgressSteps. The end may have passed, since the turn that reaches it is still counted.
   */
  fold(turns: number): void {
    const { open, session } = this;
    const end = session.settings.clock?.end;
    if (turns === 0) this.close();
    else if (open?.turns !== turns && end !== undefined && end.kind !== "session_cap") {
      const now = session.now();
      this.open = { turns, fromMs: open?.fromMs ?? now, toMs: now };
    }
  }

  /** Record the open streak when it reached noProgressSteps. */
  close(): void {
    const { open, session } = this;
    this.open = undefined;
    if (open === undefined || open.turns < session.noProgressSteps) return;
    const at = (ms: number) => sessionClock(ms - session.startedAtMs);
    session.trace.record("notice", () =>
      notice(
        "warn",
        STREAK_TITLE,
        `${open.turns} turns in a row repeated a recent action on an unchanged screen, from ${at(open.fromMs)} to ${at(open.toMs)} into the session. The participant is held to its scheduled end, so ${session.noProgressSteps} such turns did not end its session, and from then on the screen was watched after each one before the next request.`,
      ),
    );
  }
}

/** `40:35`, or `1:02:03` from an hour. */
function sessionClock(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1_000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const ss = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes % 60).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}
