import { evaluateStopWhen, type StopConditionObservation } from "../../stop-conditions.js";
import { ComputerUseExecutorError, isComputerUseExecutorError } from "../executor-error.js";
import { externalHandoffNote, externalHandoffSummary } from "../external-handoff.js";
import { CUA_SPEECH_LIMITS, type HeardSpeech } from "../speech.js";
import { tracePage } from "../../../evidence/trace-page.js";
import { dwellCompleted, missingFrame, stopWhenMatched, type Stop } from "./ending.js";
import { CuaAbortError, CuaStallError, raceCallBound } from "./race.js";
import type { LoopSession } from "./session.js";
import { persistFrame } from "./frames.js";
import { notice } from "./trace.js";
import type { CuaObservation } from "./types.js";
import { plural } from "../../../run/text.js";

// Observing the desktop: bounded observe calls, speech the participant heard, persisted frames,
// the task funnel, the declared dwell window, and the checkpoint that runs before the first turn
// and after every acted turn.

/** What one look during a watch found (watch.ts). */
export interface Look {
  readonly observation: CuaObservation;
  /** The look brought speech the participant had not heard. */
  readonly speech: boolean;
  /** A stopWhen rule, a pending dwell trigger or a newly completed task matched the look. */
  readonly condition: boolean;
}

/** What a checkpoint found: a stop, or the observation the next turn reacts to. */
export type Checkpoint =
  | { readonly stop: Stop }
  | { readonly observation: CuaObservation; readonly hint: string | undefined };

interface DwellEnd {
  /** What the declared window hands the session to next. */
  readonly next: "continue" | "stop";
  readonly heldMs: number;
}

/** How long the loop waits before asking the desktop again after an observe's transport failed. */
const OBSERVE_RETRY_PAUSE_MS = 3_000;

/**
 * True when `error` says the connection to the desktop dropped, not what the desktop did: Node's
 * `fetch failed` (an HTTP provider such as E2B), a reset or refused socket, or a gRPC `UNAVAILABLE`
 * (Modal). The cause is checked too, since fetch puts the socket error there.
 */
function isTransportFailure(error: unknown): error is Error {
  if (!(error instanceof Error) || isComputerUseExecutorError(error)) return false;
  const cause = error.cause instanceof Error ? ` ${error.cause.name} ${error.cause.message}` : "";
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|UND_ERR|\bUNAVAILABLE\b/.test(
    `${error.message}${cause} ${typeof code === "string" ? code : ""}`,
  );
}

// One projection feeds both the stop guard and the task tracker, so a criterion that would stop
// the run and a criterion that completes a task can never see different evidence for one turn.
function stopObservationOf(observation: CuaObservation): StopConditionObservation {
  return {
    ...(observation.url === undefined ? {} : { url: observation.url }),
    ...(observation.text === undefined ? {} : { text: observation.text }),
    ...(observation.appState === undefined ? {} : { appState: observation.appState }),
  };
}

const pad = (value: number): string => value.toString().padStart(2, "0");

/**
 * The note after a dwell window, so the participant knows the time passed while it took no
 * action. It does not say the study held or watched the page: a participant told it is observed
 * acts as a tester (docs/principles/actor-fidelity.md).
 */
const dwellHint = (heldMs: number): string =>
  `You stayed on this page for ${plural(Math.round(heldMs / 1000), "second")} without taking any action. Carry on from what the page shows now.`;

export class DesktopObserver {
  /** New speech arrived since the provider last saw an observation. */
  heardNewSpeech = false;
  private readonly seenSpeechIds = new Set<string>();
  private pendingHeardSpeech: HeardSpeech[] = [];
  /** Notes about links handed to another app, for the next turn the participant takes. */
  private pendingHandoffNotes: string[] = [];
  private dwellDone = false;

  constructor(private readonly session: LoopSession) {}

  /**
   * Observe, persist the frame, advance the task funnel, run a due dwell window, and check the
   * harness stop conditions. Turn 0 is the initial observation, before any model turn. `looked` is
   * the look that ended a watch: it stands in for the observation, so the frame that woke the
   * participant is the one it sees, and its URL and app state were already handed on at the look.
   */
  async checkpoint(turnNumber: number, looked?: CuaObservation): Promise<Checkpoint> {
    const { session } = this;
    const { stopWhen } = session.settings;
    const opening = turnNumber === 0;
    if (opening) session.phase = "observing initial UI state";
    else {
      if (session.signal?.aborted) throw new CuaAbortError();
      session.phase = `observing UI state after turn ${turnNumber}`;
    }
    let observation =
      looked === undefined
        ? this.handToHooks(
            this.withHeardSpeech(
              await this.observeBounded(opening ? "initial" : `after turn ${turnNumber}`),
            ),
          )
        : this.handFrameToHook(looked);
    // Fail closed before a vision provider is asked to reason over a missing frame.
    const frameless = missingFrame(session.provider, observation);
    if (frameless !== undefined) return { stop: frameless };
    await this.recordScreenshot(observation, opening ? "turn-00-start" : `turn-${pad(turnNumber)}`);
    session.settings.onCheckpoint?.(turnNumber);
    session.flush();
    this.observeTasks(observation, turnNumber);
    const dwell = await this.dwellIfDue(observation, turnNumber);
    let hint: string | undefined;
    if (dwell !== undefined) {
      observation = this.handToHooks(
        this.withHeardSpeech(await this.observeBounded("after dwell")),
      );
      await this.recordScreenshot(observation, `turn-${pad(turnNumber)}-after-dwell`);
      session.settings.onCheckpoint?.(turnNumber);
      this.observeTasks(observation, turnNumber);
      if (dwell.next === "stop") {
        const when = opening ? "at the start" : `after turn ${turnNumber}`;
        return { stop: dwellCompleted(dwell.heldMs, when, observation) };
      }
      // The window hands this observation to the provider, so it needs the same frame guard. A
      // window that ends the session sends no turn; its closing request checks the frame itself.
      const framelessAfterWindow = missingFrame(session.provider, observation);
      if (framelessAfterWindow !== undefined) return { stop: framelessAfterWindow };
      hint = dwellHint(dwell.heldMs);
    }
    const match = evaluateStopWhen(stopWhen, stopObservationOf(observation));
    if (match) {
      return { stop: stopWhenMatched(match, observation, (text) => session.redactNarration(text)) };
    }
    const notes = [...this.pendingHandoffNotes, ...(hint === undefined ? [] : [hint])];
    this.pendingHandoffNotes = [];
    return { observation, hint: notes.length === 0 ? undefined : notes.join(" ") };
  }

  /**
   * Hand an observation the next turn may react to to the runtime hooks, and note whether it
   * carried app state. Runtime-only: the participant's live location.href goes back to the
   * orchestrator and is never persisted.
   */
  private handToHooks(observation: CuaObservation): CuaObservation {
    this.handUrlOn(observation);
    return this.handFrameToHook(observation);
  }

  private handUrlOn(observation: CuaObservation): void {
    const { onObservedUrl } = this.session.settings;
    onObservedUrl?.(observation.url);
    this.noteAppState(observation);
  }

  // The frame tap reads the lobby code with a model call outside the study budget, so it gets only
  // frames a turn receives, never every look of a watch.
  private handFrameToHook(observation: CuaObservation): CuaObservation {
    const { onScreenshot } = this.session.settings;
    if (observation.screenshot !== undefined) onScreenshot?.(observation.screenshot);
    return observation;
  }

  /**
   * One look at the screen while the participant waits. Speech it brings is kept for the next
   * request, its URL goes to the URL tap (the shared-world lobby latch) and a task it completes is
   * recorded. Detects, without acting on, the conditions the checkpoint acts on; the watch that
   * asked hands a look that ends it to the checkpoint. Nothing is persisted.
   */
  async look(turnNumber: number): Promise<Look> {
    const { session } = this;
    if (session.signal?.aborted) throw new CuaAbortError();
    session.phase = `looking at the screen during turn ${turnNumber}`;
    const heardBefore = this.pendingHeardSpeech.length;
    const observation = this.withHeardSpeech(
      await this.observeBounded(`look during turn ${turnNumber}`),
    );
    this.handUrlOn(observation);
    const evidence = stopObservationOf(observation);
    const { stopWhen, dwell } = session.settings;
    const completedTask = this.observeTasks(observation, turnNumber);
    const dwellDue =
      dwell?.when !== undefined &&
      !this.dwellDone &&
      evaluateStopWhen(dwell.when, evidence) !== undefined;
    return {
      observation,
      speech: this.pendingHeardSpeech.length > heardBefore,
      condition: completedTask || dwellDue || evaluateStopWhen(stopWhen, evidence) !== undefined,
    };
  }

  /**
   * Every observation that carried app state counts, including dwell frames and the final task
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
  async observeFinalTasks(turnNumber: number): Promise<void> {
    if (this.session.taskTracker === undefined) return;
    try {
      this.session.phase = "observing closing task state";
      const final = this.withHeardSpeech(await this.observeBounded("closing"));
      this.noteAppState(final);
      this.observeTasks(final, turnNumber);
    } catch (error) {
      if (isComputerUseExecutorError(error)) throw error;
    }
  }

  /**
   * Observe the desktop and note the observation's page as the session's final page. Every
   * observation passes through here, so the page recordScreenshot puts on an item is the page of
   * the observation it records.
   */
  private async observeBounded(label: string): Promise<CuaObservation> {
    const observation = await this.observeOrRetry(label);
    const { session } = this;
    this.noteHandoffs(observation);
    session.finalPage =
      session.settings.recordPages === false
        ? undefined
        : tracePage(observation.url, (text) => session.redactNarration(text));
    return observation;
  }

  /**
   * Record each link the browser handed to another app, and keep its note for the next turn. The
   * desktop showed nothing for it, so without the note the participant reads a dead link.
   */
  private noteHandoffs(observation: CuaObservation): void {
    for (const handoff of observation.externalHandoffs ?? []) {
      this.session.trace.record("notice", () =>
        notice(
          "ok",
          "link opened another app",
          this.session.redactNarration(externalHandoffSummary(handoff)),
        ),
      );
      this.pendingHandoffNotes.push(externalHandoffNote(handoff));
    }
  }

  // An executor without stallRecovery "fail_closed" gets one retry of a stalled observe, and one
  // retry, after a pause, of an observe whose transport failed: observe only reads the desktop, so
  // asking again is safe, and a dropped connection to a hosted desktop usually clears in seconds.
  // One that cannot safely replay a pending request opts out, so even a shorter outer bound stops
  // without retrying.
  private async observeOrRetry(label: string): Promise<CuaObservation> {
    const { session } = this;
    const { executor } = session;
    try {
      return await raceCallBound(
        `observe (${label})`,
        executor.observe(),
        session.remaining(),
        session.observationTimeoutMs,
        session.signal,
      );
    } catch (error) {
      if (isTransportFailure(error) && executor.stallRecovery !== "fail_closed") {
        return await this.observeAfterFailure(label, error);
      }
      if (!(error instanceof CuaStallError)) throw error;
      if (executor.stallRecovery === "fail_closed") {
        // The outer bound says nothing about whether the still-pending request completed.
        // The owning session will close it; this loop must not send a replacement request.
        throw new ComputerUseExecutorError("deadline_exceeded", "outcome_uncertain");
      }
      session.trace.record("notice", () =>
        notice(
          "warn",
          "observation stalled; retrying once",
          `${error.what} produced nothing within ${error.afterMs}ms; asking the desktop again`,
        ),
      );
      return await raceCallBound(
        `observe (${label}, retry)`,
        executor.observe(),
        session.remaining(),
        session.observationTimeoutMs,
        session.signal,
      );
    }
  }

  private async observeAfterFailure(label: string, error: Error): Promise<CuaObservation> {
    const { session } = this;
    session.trace.record("notice", () =>
      notice(
        "warn",
        "observation failed; retrying once",
        `observe (${label}) failed with ${error.name}: ${session.redactNarration(error.message)}; asking the desktop again in ${OBSERVE_RETRY_PAUSE_MS}ms`,
      ),
    );
    await session.sleep(Math.min(OBSERVE_RETRY_PAUSE_MS, Math.max(0, session.remaining())));
    if (session.signal?.aborted) throw new CuaAbortError();
    return await raceCallBound(
      `observe (${label}, retry)`,
      session.executor.observe(),
      session.remaining(),
      session.observationTimeoutMs,
      session.signal,
    );
  }

  /**
   * The observation with every utterance heard since the provider last saw one. New utterances are
   * recorded as notices; too many pending utterances fail the executor as invalid_response.
   */
  private withHeardSpeech(observation: CuaObservation): CuaObservation {
    for (const utterance of observation.heardSpeech ?? []) {
      if (this.seenSpeechIds.has(utterance.id)) continue;
      this.seenSpeechIds.add(utterance.id);
      this.pendingHeardSpeech.push(utterance);
      this.heardNewSpeech = true;
      this.session.trace.record("notice", () =>
        notice("ok", "speech heard", this.session.redactNarration(utterance.text)),
      );
    }
    if (this.pendingHeardSpeech.length > CUA_SPEECH_LIMITS.utterances) {
      throw new ComputerUseExecutorError("invalid_response", "outcome_uncertain");
    }
    return this.pendingHeardSpeech.length === 0
      ? observation
      : { ...observation, heardSpeech: this.pendingHeardSpeech.slice() };
  }

  // No frame, nothing persisted: a state-driven executor returns observations without a
  // screenshot, counts.screenshots stays 0 and redaction.screenshots reads "n/a". No empty buffer
  // reaches disk.
  private async recordScreenshot(observation: CuaObservation, label: string): Promise<void> {
    const { session } = this;
    const frame = observation.screenshot;
    if (frame === undefined) return;
    // Persisted raw by default (full fidelity, local-only); redactScreenshots keeps the
    // publish-safe blurred thumbnail instead.
    const screenshotRef = await persistFrame(session, frame, label);
    session.lastScreenshotRef = screenshotRef;
    const page = session.finalPage;
    session.trace.record("screenshot", () => ({
      lifecycle: "completed",
      title: label,
      screenshotRef,
      // A copy: the live flush freezes a recorded item, and finalPage stays the session's own.
      ...(page === undefined ? {} : { page: { ...page } }),
    }));
    session.trace.bump("screenshots");
  }

  // Evaluated before the stopWhen check each turn so a final task whose criterion coincides with
  // the stop condition still lands in the funnel of the very turn that ends the session. Returns
  // whether a task completed.
  private observeTasks(observation: CuaObservation, turnNumber: number): boolean {
    const { taskTracker } = this.session;
    if (taskTracker === undefined) return false;
    const completions = taskTracker.observe(stopObservationOf(observation), turnNumber);
    for (const completion of completions) {
      // The id is researcher-authored config and the kinds are rule-type names; the matched values
      // (a URL, page text) never appear here: the same discipline as the stopWhen notice.
      this.session.trace.record("notice", () =>
        notice(
          "matched",
          `task completed: ${this.session.redactNarration(completion.id)}`,
          this.session.redactNarration(
            `turn ${turnNumber}; matched rule ${completion.matchedRuleIndex} (${completion.matchedKinds.join("+")})`,
          ),
        ),
      );
    }
    return completions.length > 0;
  }

  // The declared observation window. The harness holds, looks, and takes nothing back to
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
      const frameObservation = this.withHeardSpeech(
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
        // A window that ends the session is structured, harness-owned completion evidence, the
        // same class as a matched stopWhen, and the verdict resolver reads it that way.
        dwell.then === "stop" ? "matched" : "ok",
        "dwell window complete",
        `${plural(frames, "frame")} over ${heldMs}ms; no model turn was requested during the window`,
      ),
    );
    return { next: dwell.then, heldMs };
  }
}
