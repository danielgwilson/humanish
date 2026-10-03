import type { ActorTokenUsage, ActorTraceItem } from "../../actors/contract.js";
import type { CuaLiveMetadata } from "../../actors/computer-use/loop.js";
import { attachObserverRuntimeStreamUrls, type ObserverResult } from "../../observer/render.js";
import { type ObserverRuntimeStreamUrl } from "../../observer/run-routes.js";
import type { RunBundle } from "../../run/bundle.js";
import type { RunStudyHomes } from "../../study/run-study-homes.js";
import type { DesktopParticipantRun } from "./types.js";

export interface LiveTraceFlush {
  /** Record a participant's recorded-so-far items; the bundle rewrite follows on the flush
   *  schedule. */
  flush: (
    participantId: string,
    items: readonly ActorTraceItem[],
    usage?: ActorTokenUsage,
    metadata?: CuaLiveMetadata,
  ) => void;
  /** Stop flushing, clear the timer and wait for an in-flight write. Call it on every exit. */
  stop: () => Promise<void>;
}

/**
 * Incremental live flush: as each participant's loop reports its recorded-so-far items,
 * rewrite the in-progress bundle with per-stream `liveActor` partials so the attached
 * Observer's 5s poll sees the timeline grow. Throttled (one write per interval, trailing
 * write guaranteed). `write` is the run's `writeSnapshot`, which serializes writes and refuses
 * any snapshot once the final write began, so a late flush cannot resurrect the in-progress
 * bundle. A flush failure is swallowed: mid-run observability must never break the run itself.
 */
export function startLiveTraceFlush(args: {
  bundle: RunBundle;
  participantRuns: readonly DesktopParticipantRun[];
  /** The model the running usage prices at. Usage without its model is not a cost. */
  model: string;
  /** Publishes one in-progress bundle: the run's `writeSnapshot`. */
  write: (bundle: RunBundle) => Promise<void>;
}): LiveTraceFlush {
  const { bundle, participantRuns, model, write } = args;
  const streamIdByParticipant = new Map(
    participantRuns.map((spec) => [spec.planned.id, spec.streamId]),
  );
  // The persona each participant is running, so the live flush can say who is in it.
  const personaByStream = new Map(
    participantRuns
      .map((spec) => [spec.streamId, spec.persona?.id] as const)
      .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string"),
  );
  const liveItemsByStream = new Map<string, ActorTraceItem[]>();
  // Running token usage per participant, so a run in flight can price itself instead of reporting the
  // cost as unknown until the moment it ends.
  const liveUsageByStream = new Map<string, ActorTokenUsage>();
  const liveMetadataByStream = new Map<string, CuaLiveMetadata>();
  let flushWriting: Promise<void> | undefined;
  let flushDirty = false;
  let flushClosed = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let lastFlushAtMs = 0;
  const FLUSH_MIN_INTERVAL_MS = 2_000;
  const flushNow = async (): Promise<void> => {
    while (flushDirty && !flushClosed) {
      flushDirty = false;
      lastFlushAtMs = Date.now();
      const updatedAt = new Date(lastFlushAtMs).toISOString();
      const patched: RunBundle = {
        ...bundle,
        streams: bundle.streams.map((stream) => {
          const liveItems = liveItemsByStream.get(stream.id);
          return liveItems === undefined
            ? stream
            : {
                ...stream,
                liveActor: {
                  schema: "humanish.live-actor.v1" as const,
                  updatedAt,
                  // Who this participant is, carried while the run is live. Without it a
                  // surface watching a live run can only name the participant id and the stream
                  // label (`<participant id> · browser`), which describe the harness, not the participant.
                  ...(personaByStream.get(stream.id) === undefined
                    ? {}
                    : { persona: { id: personaByStream.get(stream.id)! } }),
                  ...(liveUsageByStream.get(stream.id) === undefined
                    ? {}
                    : {
                        tokenUsage: liveUsageByStream.get(stream.id)!,

                        // The model too: usage without the rate it prices at is not a cost.
                        ids: { model },
                      }),
                  ...liveMetadataByStream.get(stream.id),
                  items: [...liveItems],
                },
              };
        }),
      };
      try {
        await write(patched);
      } catch {
        // Swallowed by design; the final write is the evidence of record.
      }
    }
    flushWriting = undefined;
  };
  const scheduleFlush = (): void => {
    if (flushClosed || flushWriting !== undefined) return;
    const sinceMs = Date.now() - lastFlushAtMs;
    if (sinceMs >= FLUSH_MIN_INTERVAL_MS) {
      flushWriting = flushNow();
      return;
    }
    if (flushTimer === undefined) {
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        scheduleFlush();
      }, FLUSH_MIN_INTERVAL_MS - sinceMs);
      flushTimer.unref?.();
    }
  };
  const flush: LiveTraceFlush["flush"] = (participantId, items, usage, metadata) => {
    // An empty snapshot (the initial observation on a frameless route) carries no
    // evidence worth a disk write; the first real item triggers the first flush.
    if (items.length === 0) return;
    const streamId = streamIdByParticipant.get(participantId);
    if (streamId === undefined) return;
    liveItemsByStream.set(streamId, items.slice());
    if (metadata !== undefined) liveMetadataByStream.set(streamId, metadata);
    if (usage !== undefined) liveUsageByStream.set(streamId, usage);
    flushDirty = true;
    scheduleFlush();
  };
  const stop = async (): Promise<void> => {
    flushClosed = true;
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    await flushWriting;
  };
  return { flush, stop };
}

/**
 * The live desktop views (runtime stream URLs) participants report, attached to whichever Observer shows
 * the run. The URLs carry auth, so they live in memory and on the Observer result, never in run
 * artifacts.
 */
export function trackRuntimeStreams(onStream: RunStudyHomes["onStream"] | undefined): {
  /** Records each stream for the Observer, after the caller's onStream. */
  onStream: NonNullable<RunStudyHomes["onStream"]>;
  /** From now on, keep this live Observer's stream list current. */
  showIn: (observer: ObserverResult & { ok: true }) => void;
  /** Give the final Observer every stream the run reported. */
  attachFinal: (observer: ObserverResult) => void;
} {
  let liveObserver: (ObserverResult & { ok: true }) | undefined;
  const urls: ObserverRuntimeStreamUrl[] = [];
  return {
    onStream: async (event) => {
      await onStream?.(event);
      if (event.type === "ready") urls.push({ streamId: event.streamId, url: event.url });
      // Mark, never remove: the tile needs to know the live view ended (and say so) rather than
      // have the stream silently vanish from the overlay.
      else for (const entry of urls) if (entry.streamId === event.streamId) entry.ended = true;
      if (liveObserver) attachObserverRuntimeStreamUrls(liveObserver, urls);
    },
    showIn: (observer) => {
      liveObserver = observer;
    },
    attachFinal: (observer) => {
      if (observer.ok && urls.length > 0) {
        attachObserverRuntimeStreamUrls(observer as ObserverResult & { ok: true }, urls);
      }
    },
  };
}
