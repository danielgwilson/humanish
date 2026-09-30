// The external-public plane's host-first handoff. The host seat opens a lobby; each follower waits
// for the host's lobby code, read from the host's URL, narration or screen, and then joins with it.
// A follower fails closed without opening if the host never yields a code within the deadline.
//
// TEMPORARY SHIM (tracked by #296): this CDP URL-relay handoff — reading the host's /lobby/CODE off
// its own browser and threading it into the follower missions — is a temporary coordination shim.
// It is to be augmented/replaced by the actor message bus (fake SMS/email invite) in #297: the
// human-realistic version is the HOST SENDING the invite link and followers RECEIVING and tapping
// it, rather than the orchestrator relaying the code out-of-band.

import { commandDigestOf } from "../../subject/state.js";
import { toErrorMessage } from "../../evidence/redaction.js";
import { inboxRecipientFor, laneHasInboxRecipient } from "../computer-use/lab.js";
import { withInboxMission } from "../computer-use/lane-plan.js";
import { runCuaLane } from "../computer-use/lanes.js";
import type { DesktopParticipantRun, LaneRunOutcome } from "../computer-use/types.js";
import { extractLobbyCode, extractLobbyCodeFromNarration } from "./lobby-code.js";
import { hostOriginDigest } from "./provenance.js";
import { makeBlockedFollowerOutcome, withLobbyCodeMission, type SeatLaneDeps } from "./seats.js";
import type { ActorLaneResult, ExternalCommsWiring } from "./types.js";

// The FLOOR for the host-first handoff barrier deadline (ms). The host seat must surface a
// shared-session (/lobby/CODE) URL within the deadline or the run fails closed and no follower
// opens. The effective deadline SCALES with the per-seat run budget (execution.timeoutMs): a fixed
// 2 min is too tight for a real create-a-lobby flow on a mobile-layout seat once you subtract the
// seat's own desktop provisioning — the host reaches /lobby/CODE, but after the followers already
// gave up. So use max(FLOOR, 40% of the budget), capped at the budget. The latch resolves the
// instant the host actually reaches /lobby, so a generous ceiling only affects the fail-closed case.
const DEFAULT_HANDOFF_DEADLINE_MS = 120_000;

const HANDOFF_DEADLINE_BUDGET_FRACTION = 0.4;

// Per-seat runaway backstop for the vision-off-frame lobby-code read (used by the host to LATCH the
// handoff code, and by each follower to independently OBSERVE its own code for the convergence proof):
// at most this many single-frame reads before the seat is assumed to be somewhere without a code. Each
// reader stops the instant it has what it needs, so in practice only a handful fire (a seat reaches its
// /lobby within a few turns). NOTE: these reads are out-of-band OpenAI calls (external-public route
// only) and are NOT counted against execution.caps.maxUsd — this hard cap is what bounds their spend
// instead (each read is one cheap single-frame OCR call). If this route ever runs under a strict
// budget, fold the estimate in.
const MAX_LOBBY_CODE_VISION_READS = 30;

// Idle/no-progress backstop for the HOST lane specifically (default is 6/8). The host legitimately sits
// on an unchanging waiting-room screen while followers provision and join; it must not give up first.
const HOST_WAIT_IDLE_STEPS = 80;

const FOLLOWER_WAIT_IDLE_STEPS = 40;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  settled: () => boolean;
}

/** A minimal resolve-once latch for the host-first handoff barrier. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  let done = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value: T) => {
      if (!done) {
        done = true;
        res(value);
      }
    };
    reject = (reason: unknown) => {
      if (!done) {
        done = true;
        rej(reason);
      }
    };
  });
  return { promise, resolve, reject, settled: () => done };
}

/** Marker error the host-first barrier rejects with when the deadline elapses (fail-closed). */
class HandoffTimeoutError extends Error {
  constructor(deadlineMs: number) {
    super(`the host never produced a /lobby/CODE URL within the ${deadlineMs}ms handoff deadline`);
    this.name = "HandoffTimeoutError";
  }
}

/** What the host and follower lanes need besides the handoff. */
export interface HandoffSeatDeps {
  laneDeps: SeatLaneDeps;
  publicAppUrl: string;
  inbox: ExternalCommsWiring | undefined;
  now: () => number;
}

/**
 * The handoff latch, its deadline and what each seat observed. The latched code and observed URLs
 * are runtime-only and land in persisted METADATA only as digests (origin + convergence). (The code
 * is a shareable game code, not a secret, and it still renders in the host's screenshots, which are
 * full-fidelity unless redactScreenshots is set — the digesting is about narration/URL metadata.)
 */
export class LobbyHandoff {
  // Per-lane runtime-only observed state (never persisted raw): the last observed URL and the last
  // observed /lobby/CODE per seat, fed by onObservedUrl. The URL is digested to ORIGIN for each seat's
  // routeHostDigest (no code leaks); the codes drive the cross-seat lobby-convergence digest.
  readonly observedFinalUrls: (string | undefined)[];
  readonly observedLobbyCodes: (string | undefined)[];
  latchedLobbyCode: string | undefined;
  /** A follower gave up because the deadline passed. */
  timedOut = false;
  /** Why the host seat ended without producing a lobby code. */
  hostFailure: string | undefined;
  readonly deadlineMs: number;
  private readonly lobbyCodeLatch = deferred<string>();
  private readonly scrubKnownValues: (text: string) => string;
  private readonly readLobbyCode: (frame: Buffer, apiKey: string) => Promise<string | undefined>;
  private readonly openaiApiKey: string;
  private deadline: Promise<never> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: {
    seatCount: number;
    timeoutMs: number;
    deadlineMs: number | undefined;
    scrubKnownValues: (text: string) => string;
    readLobbyCode: (frame: Buffer, apiKey: string) => Promise<string | undefined>;
    openaiApiKey: string;
  }) {
    this.observedFinalUrls = new Array(options.seatCount);
    this.observedLobbyCodes = new Array(options.seatCount);
    this.deadlineMs =
      options.deadlineMs ??
      Math.min(
        options.timeoutMs,
        Math.max(
          DEFAULT_HANDOFF_DEADLINE_MS,
          Math.floor(options.timeoutMs * HANDOFF_DEADLINE_BUDGET_FRACTION),
        ),
      );
    this.scrubKnownValues = options.scrubKnownValues;
    this.readLobbyCode = options.readLobbyCode;
    this.openaiApiKey = options.openaiApiKey;
  }

  /**
   * Scrubs the latched lobby CODE from ANY persisted narration once the host resolves it (the
   * 6-char code has no detectable secret shape, so shape-only redaction cannot catch it).
   */
  readonly scrub = (text: string): string => {
    const base = this.scrubKnownValues(text);
    return this.latchedLobbyCode && this.latchedLobbyCode.length > 0
      ? base.split(this.latchedLobbyCode).join("[REDACTED_LOBBY_CODE]")
      : base;
  };

  /** Starts the deadline the followers wait against. */
  startDeadline(): void {
    this.deadline = new Promise<never>((_resolve, reject) => {
      this.deadlineTimer = setTimeout(
        () => reject(new HandoffTimeoutError(this.deadlineMs)),
        this.deadlineMs,
      );
    });
    this.deadline.catch(() => undefined); // never an unhandled rejection
  }

  stopDeadline(): void {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
    }
  }

  // Resolve the host->follower handoff latch from WHICHEVER path sees the code first (CDP url-read,
  // host narration, or vision-off-frame). Idempotent: only the first code wins, and it is also stashed
  // as latchedLobbyCode so it gets scrubbed from any later narration.
  latchLobbyCode(code: string, laneIndex: number): void {
    if (this.latchedLobbyCode !== undefined) return;
    this.observedLobbyCodes[laneIndex] = code;
    this.latchedLobbyCode = code;
    this.stopDeadline();
    this.lobbyCodeLatch.resolve(code);
  }

  // Build an onScreenshot handler that vision-reads the lobby code off THIS seat's own frame (the
  // CDP-independent observation). `done()` short-circuits once this seat has what it needs (the host
  // once latched; a follower once it has recorded its own observed code), `onCode` records/latches the
  // result. One read in flight at a time, bounded by MAX_LOBBY_CODE_VISION_READS so a seat that never
  // reaches a lobby can't rack up unbounded calls (fire-and-forget; the loop never awaits it).
  makeLobbyCodeVisionReader(
    done: () => boolean,
    onCode: (code: string) => void,
  ): (frame: Buffer) => void {
    let inFlight = false;
    let reads = 0;
    return (frame: Buffer): void => {
      if (done() || inFlight || reads >= MAX_LOBBY_CODE_VISION_READS) return;
      inFlight = true;
      reads += 1;
      void this.readLobbyCode(frame, this.openaiApiKey)
        .then((code) => {
          if (code !== undefined && !done()) onCode(code);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
  }

  makeLaneObservedUrl(laneIndex: number, isHost: boolean): (url: string | undefined) => void {
    return (url: string | undefined): void => {
      if (typeof url !== "string" || url.length === 0) return;
      this.observedFinalUrls[laneIndex] = url; // runtime-only; digested to origin, never persisted raw
      const code = extractLobbyCode(url);
      if (code !== undefined) {
        this.observedLobbyCodes[laneIndex] = code;
        if (isHost) this.latchLobbyCode(code, laneIndex);
      }
    };
  }

  /** Resolves with the host's code, or rejects when the host ends without one or the deadline passes. */
  waitForHostCode(): Promise<string> {
    return Promise.race([this.lobbyCodeLatch.promise, this.deadline!]);
  }

  /** Releases waiting followers to fail closed when the host ended without a code. */
  releaseFollowersIfUnlatched(outcome: LaneRunOutcome | undefined): void {
    if (!this.lobbyCodeLatch.settled()) {
      const reason =
        outcome?.sessionError ??
        outcome?.session?.reason ??
        "no terminal host outcome was recorded";
      this.hostFailure = this.scrub(`Host seat ended before producing a lobby URL: ${reason}`);
      this.lobbyCodeLatch.reject(new Error(this.hostFailure));
    }
  }

  /** The digest-only convergence proofs over what the seats observed. */
  convergence(declaredOriginDigest: string | undefined): {
    publicOriginDigest: string | undefined;
    lobbyConvergenceDigest: string | undefined;
  } {
    // Observed-origin convergence proof (blocker 2): the convergence claim is about what the seats
    // OBSERVED, not what was DECLARED. Digest each observing seat's origin and require they AGREE on
    // ONE — that agreement IS the convergence proof and becomes plane.publicOriginDigest. A normal
    // cross-origin redirect (declared apex -> observed www) is therefore tolerated: the seats still
    // converge on ONE observed origin. Leave it undefined (verify fails closed) only if the seats did
    // not converge on a single observed origin (or none observed one).
    const observedOriginDigests = this.observedFinalUrls
      .filter((url): url is string => typeof url === "string" && url.length > 0)
      .map((url) => hostOriginDigest(url));
    const distinctObservedOrigins = new Set(observedOriginDigests);
    const publicOriginDigest =
      distinctObservedOrigins.size === 1
        ? [...distinctObservedOrigins][0]
        : // NOTHING observed (e.g. a handoff-timeout run where no seat ever navigated): fall back to the
          // DECLARED origin so a FAILED run's bundle stays structurally valid (every seat's route then
          // digests to the declared origin too). The run still fails closed for its own reason (HANDOFF_
          // TIMEOUT / no lobby convergence / no overlap-on-pass). GENUINE divergence (≥2 distinct observed
          // origins) leaves it undefined so verify fails closed on the non-convergence.
          distinctObservedOrigins.size === 0
          ? declaredOriginDigest
          : undefined;

    // Lobby-convergence proof: a digest of the shared /lobby/CODE path iff EVERY seat converged on the
    // SAME code (a follower stuck on "/" yields no code → no false convergence). Digest-only. NOTE:
    // observedLobbyCodes may be a SPARSE array (a seat that never observed a code leaves a hole), and
    // Array.prototype.every SKIPS holes — so count the DEFINED codes explicitly, never rely on every().
    const definedCodes = this.observedLobbyCodes.filter(
      (code): code is string => code !== undefined,
    );
    const distinctCodes = new Set(definedCodes);
    const lobbyConvergenceDigest =
      distinctCodes.size === 1 && definedCodes.length === this.observedLobbyCodes.length
        ? commandDigestOf(`/lobby/${[...distinctCodes][0]}`)
        : undefined;
    return { publicOriginDigest, lobbyConvergenceDigest };
  }
}

// Adopter-hosted inbox (#387): the persona is told its address and inbox URL on THIS plane.
function withSeatInbox(
  spec: DesktopParticipantRun,
  inbox: ExternalCommsWiring | undefined,
): DesktopParticipantRun {
  return inbox && laneHasInboxRecipient(inbox.email, spec.planned.id)
    ? withInboxMission(
        spec,
        inbox.inboxUrl,
        inboxRecipientFor(inbox.email, spec.planned.id)?.address,
      )
    : spec;
}

// The HOST lane (which yields the /lobby/CODE the followers wait on) runs on its OWN dedicated
// slot, and the FOLLOWERS run through a bounded pool of size concurrency-1 (blockers 1 & 4):
// followers block on the host's code while holding a worker slot, so if the host lane were
// scheduled INSIDE the same bounded pool it could be starved (never scheduled among the first
// `concurrency` workers) and the run would die with a spurious HANDOFF_TIMEOUT (e.g. lanes
// [p2,p3,host] with concurrency 2). Giving the host its own slot, started IMMEDIATELY and OUTSIDE
// the follower pool, guarantees it is ALWAYS schedulable regardless of its roster position or of
// concurrency vs lane count — while total in-flight paid desktops stay ≤ the declared concurrency
// (host + up to concurrency-1 followers), preserving the spend cap.
export async function runHostLane(
  handoff: LobbyHandoff,
  deps: HandoffSeatDeps,
  spec: DesktopParticipantRun,
  laneIndex: number,
): Promise<ActorLaneResult> {
  const onObservedUrl = handoff.makeLaneObservedUrl(laneIndex, true);
  // CDP-INDEPENDENT handoff paths (the E2B-desktop CDP url-read the onObservedUrl path relies on is
  // unreliable in practice). Two backups, both resolving the SAME latch; whichever sees the code first
  // wins, all digest-only:
  //   (1) onMessage — scan the host's own narration IF it happens to state the lobby URL; and
  //   (2) onScreenshot — vision-read the code straight off the host's waiting-room frame. This is the
  //       robust one: the code is rendered on screen even when CDP fails AND when the host never
  //       narrates it, and — crucially — the host is NOT asked to announce anything, so it keeps
  //       running (create -> wait for players -> Start -> play) instead of ending on a stray message.
  const onMessage = (text: string): void => {
    if (handoff.latchedLobbyCode !== undefined) return;
    const code = extractLobbyCodeFromNarration(text);
    if (code !== undefined) handoff.latchLobbyCode(code, laneIndex);
  };
  // Vision-read the host's waiting-room frame and LATCH the code for the followers (stops once latched).
  const onScreenshot = handoff.makeLobbyCodeVisionReader(
    () => handoff.latchedLobbyCode !== undefined,
    (code) => handoff.latchLobbyCode(code, laneIndex),
  );
  // The host's job includes a long LEGITIMATE idle wait — sitting in the waiting room while the
  // followers provision their own desktops and walk the Join flow (easily 15-30 turns of an
  // unchanging "waiting for players" screen). At the default idle backstop (6) the host would give up
  // before anyone arrives, orphaning the lobby (exactly the earlier failure). Raise the host's idle /
  // no-progress tolerance so it waits patiently; the per-seat timeout still bounds a truly stuck host.
  const hostSpec: DesktopParticipantRun = {
    ...withSeatInbox(spec, deps.inbox),
    backstop: {
      idleSteps: spec.backstop?.idleSteps ?? HOST_WAIT_IDLE_STEPS,
      noProgressSteps: spec.backstop?.noProgressSteps ?? HOST_WAIT_IDLE_STEPS,
    },
  };
  const startedAt = deps.now();
  let outcome: LaneRunOutcome | undefined;
  try {
    outcome = await runCuaLane(hostSpec, {
      ...deps.laneDeps,
      appUrl: deps.publicAppUrl,
      onObservedUrl,
      onMessage,
      onScreenshot,
    });
  } finally {
    // If the host finished without ever surfacing a code, release followers to fail closed
    // immediately rather than wait the full deadline (a no-op if it already resolved).
    handoff.releaseFollowersIfUnlatched(outcome);
  }
  const endedAt = deps.now();
  return {
    spec,
    outcome,
    startedAt,
    endedAt,
    route: handoff.observedFinalUrls[laneIndex] ?? deps.publicAppUrl,
  };
}

export async function runFollowerLane(
  handoff: LobbyHandoff,
  deps: HandoffSeatDeps,
  spec: DesktopParticipantRun,
  laneIndex: number,
): Promise<ActorLaneResult> {
  const onObservedUrl = handoff.makeLaneObservedUrl(laneIndex, false);
  // FOLLOWER: do NOT compose a mission or open the target until the host yields a lobby code.
  let code: string;
  try {
    code = await handoff.waitForHostCode();
  } catch (error) {
    // An ended host is not a deadline expiry. Preserve its actual failure.
    const timedOut = error instanceof HandoffTimeoutError;
    handoff.timedOut ||= timedOut;
    const reason = handoff.scrub(toErrorMessage(error));
    const at = deps.now();
    return {
      spec,
      outcome: makeBlockedFollowerOutcome(spec, reason, timedOut),
      startedAt: at,
      endedAt: at,
      route: deps.publicAppUrl,
    };
  }
  // Followers also idle-wait — in the waiting room until the host starts, and between rounds. Raise
  // their idle backstop too (less than the host's: they wait less), so a follower that joins ahead of
  // the other does not give up before the game begins. Per-seat timeout still bounds a stuck follower.
  const followerSpec: DesktopParticipantRun = {
    ...withLobbyCodeMission(withSeatInbox(spec, deps.inbox), code),
    backstop: {
      idleSteps: spec.backstop?.idleSteps ?? FOLLOWER_WAIT_IDLE_STEPS,
      noProgressSteps: spec.backstop?.noProgressSteps ?? FOLLOWER_WAIT_IDLE_STEPS,
    },
  };
  // Independently OBSERVE this follower's own lobby code by vision-reading its waiting-room frame,
  // and record it for the cross-seat convergence proof. This does NOT latch anything (followers gate
  // on the HOST's code, not their own) — it just fills this seat's observedLobbyCodes slot from a
  // reliable signal instead of the flaky CDP url-read, so lobbyConvergenceDigest can prove all seats
  // reached the SAME /lobby/CODE. If a follower somehow joined a DIFFERENT lobby, it reads a different
  // code and convergence correctly fails (no false proof); if it never reads one, the seat stays a
  // hole and convergence is honestly "not observed" for that seat.
  const onScreenshot = handoff.makeLobbyCodeVisionReader(
    () => handoff.observedLobbyCodes[laneIndex] !== undefined,
    (observed) => {
      handoff.observedLobbyCodes[laneIndex] = observed;
    },
  );
  const startedAt = deps.now();
  const outcome = await runCuaLane(followerSpec, {
    ...deps.laneDeps,
    appUrl: deps.publicAppUrl,
    onObservedUrl,
    onScreenshot,
  });
  const endedAt = deps.now();
  return {
    spec,
    outcome,
    startedAt,
    endedAt,
    route: handoff.observedFinalUrls[laneIndex] ?? deps.publicAppUrl,
  };
}
