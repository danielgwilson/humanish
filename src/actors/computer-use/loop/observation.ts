import { evaluateStopWhen, type StopConditionObservation } from "../../stop-conditions.js";
import { CuaExecutorError, isCuaExecutorError } from "../executor-error.js";
import { CUA_SPEECH_LIMITS, type HeardSpeech } from "../speech.js";
import { dwellCompleted, missingFrame, stopWhenMatched, type Stop } from "./ending.js";
import { CuaAbortError, CuaStallError, raceBounded } from "./race.js";
import type { LoopSession } from "./session.js";
import { notice } from "./trace.js";
import type { CuaObservation } from "./types.js";

// Observing the desktop: bounded observe calls, speech the participant heard, persisted frames,
// the task funnel, the declared dwell window, and the checkpoint that runs before the first turn
// and after every acted turn.

/** What a checkpoint found: a stop, or the observation the next turn reacts to. */
export type Checkpoint =
  | { readonly stop: Stop }
  | { readonly observation: CuaObservation; readonly hint: string | undefined };

interface DwellEnd {
  /** What the declared window hands the session to next. */
  readonly next: "continue" | "stop";
  readonly heldMs: number;
}

// One projection feeds BOTH the stop guard and the task tracker, so a criterion that would stop
// the run and a criterion that completes a task can never see different evidence for one turn.
function stopObservationOf(observation: CuaObservation): StopConditionObservation {
  return {
    ...(observation.url === undefined ? {} : { url: observation.url }),
    ...(observation.text === undefined ? {} : { text: observation.text }),
    ...(observation.appState === undefined ? {} : { appState: observation.appState }),
  };
}

const pad = (value: number): string => value.toString().padStart(2, "0");

export class DesktopObserver {
  /** New speech arrived since the provider last saw an observation. */
  heardNewSpeech = false;
  private readonly seenSpeechIds = new Set<string>();
  private pendingHeardSpeech: HeardSpeech[] = [];
  private dwellDone = false;

  constructor(private readonly session: LoopSession) {}

  /**
   * Observe, persist the frame, advance the task funnel, run a due dwell window, and check the
   * harness stop conditions. Turn 0 is the initial observation, before any model turn.
   */
  async checkpoint(turnNumber: number): Promise<Checkpoint> {
    const { session } = this;
    const { stopWhen } = session.settings;
    const opening = turnNumber === 0;
    if (opening) session.phase = "observing initial UI state";
    else {
      if (session.signal?.aborted) throw new CuaAbortError();
      session.phase = `observing UI state after turn ${turnNumber}`;
    }
    let observation = this.admit(
      this.collectHeardSpeech(
        await this.observeBounded(opening ? "initial" : `after turn ${turnNumber}`),
      ),
    );
    // Fail closed before a vision provider is asked to reason over a missing frame.
    const frameless = missingFrame(session.provider, observation);
    if (frameless !== undefined) return { stop: frameless };
    await this.recordScreenshot(observation, opening ? "turn-00-start" : `turn-${pad(turnNumber)}`);
    session.flush();
    this.observeTasks(observation, turnNumber);
    const dwell = await this.dwellIfDue(observation, turnNumber);
    let hint: string | undefined;
    if (dwell !== undefined) {
      observation = this.admit(this.collectHeardSpeech(await this.observeBounded("after dwell")));
      await this.recordScreenshot(observation, `turn-${pad(turnNumber)}-after-dwell`);
      this.observeTasks(observation, turnNumber);
      if (dwell.next === "stop") {
        const when = opening ? "at the start" : `after turn ${turnNumber}`;
        return { stop: dwellCompleted(dwell.heldMs, when, observation) };
      }
      // The window hands this observation to the provider, so it needs the same frame guard. A
      // window that ends the session sends no turn; its closing request checks the frame itself.
      const framelessAfterWindow = missingFrame(session.provider, observation);
      if (framelessAfterWindow !== undefined) return { stop: framelessAfterWindow };
      hint = `The study held this page under observation for ${Math.round(dwell.heldMs / 1000)} seconds (a declared dwell window; you took no actions in that time). Continue the mission from the current state of the page.`;
    }
    const match = evaluateStopWhen(stopWhen, stopObservationOf(observation));
    if (match) {
      return { stop: stopWhenMatched(match, observation, (text) => session.redactNarration(text)) };
    }
    return { observation, hint };
  }

  /**
   * Hand an observation the next turn may react to to the runtime hooks, and note whether it
   * carried app state. Runtime-only: the seat's live location.href goes back to the orchestrator
   * and is never persisted.
   */
  private admit(observation: CuaObservation): CuaObservation {
    const { onObservedUrl, onScreenshot } = this.session.settings;
    onObservedUrl?.(observation.url);
    if (observation.screenshot !== undefined) onScreenshot?.(observation.screenshot);
    this.noteAppState(observation);
    return observation;
  }

  /**
   * Every observation that carried app state counts, including dwell frames and the closing
   * observation, which no turn receives: they feed the task funnel, and the trace notes must say
   * app state was observed.
   */
  private noteAppState(observation: CuaObservation): void {
    if (observation.appState !== undefined) this.session.observedAppState = true;
  }

  /** The provider received the pending speech; collect afresh for the next observation. */
  speechDelivered(): void {
    this.pendingHeardSpeech = [];
    this.heardNewSpeech = false;
  }

  /**
   * A done turn takes no actions, so no checkpoint observes the participant's final state, and a
   * task completed by that state would read as incomplete. One guarded observation feeds the
   * tracker. An ordinary observe failure changes nothing (the funnel reports what it saw); an
   * executor failure still fails the harness. No screenshot or stop check rides it, because the
   * session is already over.
   */
  async observeClosingTasks(turnNumber: number): Promise<void> {
    if (this.session.taskTracker === undefined) return;
    try {
      this.session.phase = "observing closing task state";
      const closing = this.collectHeardSpeech(await this.observeBounded("closing"));
      this.noteAppState(closing);
      this.observeTasks(closing, turnNumber);
    } catch (error) {
      if (isCuaExecutorError(error)) throw error;
    }
  }

  // An executor without stallRecovery "fail_closed" gets one retry of a stalled observe (#480).
  // One that cannot safely replay a pending request opts out, so even a shorter outer bound stops
  // without retrying.
  private async observeBounded(label: string): Promise<CuaObservation> {
    const { session } = this;
    const { executor } = session;
    try {
      return await raceBounded(
        `observe (${label})`,
        executor.observe(),
        session.remaining(),
        session.observationTimeoutMs,
        session.signal,
      );
    } catch (error) {
      if (!(error instanceof CuaStallError)) throw error;
      if (executor.stallRecovery === "fail_closed") {
        // The outer bound says nothing about whether the still-pending request completed.
        // The owning session will close it; this loop must not send a replacement request.
        throw new CuaExecutorError("deadline_exceeded", "outcome_uncertain");
      }
      session.trace.record("notice", () =>
        notice(
          "warn",
          "observation stalled; retrying once",
          `${error.what} produced nothing within ${error.afterMs}ms; asking the desktop again`,
        ),
      );
      return await raceBounded(
        `observe (${label}, retry)`,
        executor.observe(),
        session.remaining(),
        session.observationTimeoutMs,
        session.signal,
      );
    }
  }

  private collectHeardSpeech(value: CuaObservation): CuaObservation {
    for (const utterance of value.heardSpeech ?? []) {
      if (this.seenSpeechIds.has(utterance.id)) continue;
      this.seenSpeechIds.add(utterance.id);
      this.pendingHeardSpeech.push(utterance);
      this.heardNewSpeech = true;
      this.session.trace.record("notice", () =>
        notice("ok", "speech heard", this.session.redactNarration(utterance.text)),
      );
    }
    if (this.pendingHeardSpeech.length > CUA_SPEECH_LIMITS.utterances) {
      throw new CuaExecutorError("invalid_response", "outcome_uncertain");
    }
    return this.pendingHeardSpeech.length === 0
      ? value
      : { ...value, heardSpeech: this.pendingHeardSpeech.slice() };
  }

  // No frame, nothing persisted: a state-driven executor returns observations without a
  // screenshot, counts.screenshots stays 0 and redaction.screenshots reads "n/a". No empty buffer
  // reaches disk.
  private async recordScreenshot(observation: CuaObservation, label: string): Promise<void> {
    const { session } = this;
    const frame = observation.screenshot;
    if (frame === undefined) return;
    session.phase = `writing screenshot ${label}`;
    // Default: persist the raw frame (full fidelity, local-only). redactScreenshots flips to the
    // publish-safe blurred thumbnail. Either way the bytes the model already saw were raw.
    const { bytes, method } = session.redactScreenshots
      ? await session.settings.redaction
          .redactScreenshot(frame, { label })
          .then((r) => ({ bytes: r.buffer, method: r.method }))
      : { bytes: frame, method: "none" as const };
    const path = await session.writeScreenshot(`${label}.png`, bytes);
    const screenshotRef = { path, redaction: method };
    session.lastScreenshotRef = screenshotRef;
    session.trace.record("screenshot", () => ({
      lifecycle: "completed",
      title: label,
      screenshotRef,
    }));
    session.trace.bump("screenshots");
  }

  // Evaluated BEFORE the stopWhen check each turn so a final task whose criterion coincides with
  // the stop condition still lands in the funnel of the very turn that ends the session.
  private observeTasks(observation: CuaObservation, turn: number): void {
    const { taskTracker } = this.session;
    if (taskTracker === undefined) return;
    for (const completion of taskTracker.observe(stopObservationOf(observation), turn)) {
      // The id is researcher-authored config and the kinds are rule-type names; the matched VALUES
      // (a URL, page text) never appear here — the same discipline as the stopWhen notice.
      this.session.trace.record("notice", () =>
        notice(
          "matched",
          `task completed: ${this.session.redactNarration(completion.id)}`,
          this.session.redactNarration(
            `turn ${turn}; matched rule ${completion.matchedRuleIndex} (${completion.matchedKinds.join("+")})`,
          ),
        ),
      );
    }
  }

  // The declared observation window (#510). The harness holds, looks, and takes nothing back to
  // the model: no action, no turn, no tokens. It runs once, cut to whatever session budget is
  // left, and says in the trace that the time was deliberate.
  private async dwellIfDue(
    observation: CuaObservation,
    turnNumber: number,
  ): Promise<DwellEnd | undefined> {
    const { session } = this;
    const { dwell, onScreenshot } = session.settings;
    if (dwell === undefined || this.dwellDone) return undefined;
    if (
      dwell.when !== undefined &&
      evaluateStopWhen(dwell.when, stopObservationOf(observation)) === undefined
    )
      return undefined;
    this.dwellDone = true;
    const trigger = dwell.when === undefined ? "at the start" : "its condition matched";
    const budget = Math.min(dwell.ms, Math.max(0, session.remaining() - dwell.everyMs));
    if (budget < dwell.everyMs) {
      session.trace.record("notice", () =>
        notice(
          "warn",
          "dwell window skipped",
          `${trigger} at turn ${turnNumber}, but only ${Math.max(0, session.remaining())}ms of session budget remained for a ${dwell.ms}ms window`,
        ),
      );
      return undefined;
    }
    const dwellStartedAtMs = session.now();
    session.trace.record("notice", () => ({
      lifecycle: "started",
      title: "dwell window started",
      text: `${trigger} at turn ${turnNumber}: holding ${budget}ms, a frame every ${dwell.everyMs}ms, no actions, no model turns`,
    }));
    let frames = 0;
    while (session.now() - dwellStartedAtMs < budget) {
      if (session.signal?.aborted) throw new CuaAbortError();
      await session.sleep(Math.min(dwell.everyMs, budget - (session.now() - dwellStartedAtMs)));
      session.phase = `dwell frame ${frames + 1}`;
      const frameObservation = this.collectHeardSpeech(
        await this.observeBounded(`dwell frame ${frames + 1}`),
      );
      frames += 1;
      if (frameObservation.screenshot !== undefined) onScreenshot?.(frameObservation.screenshot);
      this.noteAppState(frameObservation);
      await this.recordScreenshot(frameObservation, `dwell-${pad(frames)}`);
      session.flush();
      this.observeTasks(frameObservation, turnNumber);
    }
    const heldMs = session.now() - dwellStartedAtMs;
    session.trace.record("notice", () =>
      notice(
        // A window that ENDS the session is structured, harness-owned completion evidence, the
        // same class as a matched stopWhen, and the verdict resolver reads it that way.
        dwell.then === "stop" ? "matched" : "ok",
        "dwell window complete",
        `${frames} frame(s) over ${heldMs}ms; no model turn was requested during the window`,
      ),
    );
    return { next: dwell.then, heldMs };
  }
}
