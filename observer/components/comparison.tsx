import { Select } from "./ui/select";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { historyRunHref } from "@/lib/artifact-href";
import { frameTimes } from "@/lib/comparison";
import { fetchObserverData, type HistoryIndex } from "@/lib/live";
import type { ObserverData, ObserverStream } from "@/lib/observer-data";
import { buildPlayerModel } from "@/lib/player-model";
import { participantLabels } from "@/lib/participant-label";
import { replaceHash } from "@/lib/route";
import { ComparisonPanel, elapsed, type ComparisonEntry } from "./comparison-panel";

type Clock = "shared" | "elapsed";

type ComparisonRoute = ReturnType<typeof comparisonRoute>;

function comparisonRoute() {
  const query = new URLSearchParams(window.location.hash.split("?")[1]);
  const value = Number(query.get("at"));
  return {
    clock: query.get("clock") === "elapsed" ? ("elapsed" as const) : ("shared" as const),
    at: query.has("at") && Number.isFinite(value) ? value : null,
    run: query.get("run") ?? "",
    lane: query.get("otherLane") ?? "",
  };
}

/**
 * Another run's recorded evidence, from its page in the library, and a line saying how loading
 * it went. Nothing loads for a run outside the library or while this study already has three
 * participants in the comparison. A newer choice abandons the request for the older one.
 */
function useOtherRun(
  otherId: string,
  available: boolean,
  allowed: boolean,
): { other: ObserverData | null; loadState: string } {
  const [other, setOther] = useState<ObserverData | null>(null);
  const [loadState, setLoadState] = useState("");
  useEffect(() => {
    if (!otherId) {
      setOther(null);
      setLoadState("");
      return;
    }
    if (!allowed) {
      setOther(null);
      setLoadState(
        "Keep at most two participants from this study to compare another run. Return to participants to change your selection.",
      );
      return;
    }
    const href = available ? historyRunHref(otherId) : null;
    if (!href) {
      setOther(null);
      setLoadState("That run is not in the available library.");
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    setOther(null);
    setLoadState("Loading recorded evidence…");
    void fetchObserverData(
      (input, init) => window.fetch(input, init),
      href.replace(/index\.html$/, "observer-feed.json"),
      controller.signal,
    ).then((next) => {
      if (disposed) return;
      if (next?.run.runId === otherId) {
        setOther(next);
        setLoadState("Other run loaded as recorded evidence.");
      } else setLoadState("Could not load that run. Check that its viewer is still available.");
    });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [otherId, available, allowed]);
  return { other, loadState };
}

/** This study's participants, at most three, then the chosen participant of another run. */
function comparisonParticipants({
  runId,
  runStreams,
  streams,
  other,
  otherLane,
  clock,
  otherAllowed,
}: {
  runId: string;
  runStreams: ObserverStream[];
  streams: ObserverStream[];
  other: ObserverData | null;
  otherLane: string;
  clock: Clock;
  otherAllowed: boolean;
}): ComparisonEntry[] {
  const labels = participantLabels(runStreams);
  const entries = streams.slice(0, 3).map((stream) => ({
    stream,
    name: labels.get(stream.id) ?? stream.label,
    run: runId,
    base: "",
    model: buildPlayerModel(stream),
  }));
  const selected = other?.streams.find((s) => s.id === otherLane) ?? other?.streams[0];
  if (other && selected && otherAllowed)
    entries.push({
      stream: selected,
      name: participantLabels(other.streams).get(selected.id) ?? selected.label,
      run: other.run.runId,
      base: historyRunHref(other.run.runId) ?? "",
      model: buildPlayerModel(selected),
    });
  return entries.map((entry) => ({
    ...entry,
    times: entry.model ? frameTimes(entry.model, clock) : null,
  }));
}

/** Frames whose image failed to load, the last 31. A stopped server's failures are forgotten
 * when it answers again, so those frames are asked for once more. */
function useFailedImages(serverStopped: boolean) {
  const [failed, setFailed] = useState<string[]>([]);
  const [previousStopped, setPreviousStopped] = useState(serverStopped);
  if (previousStopped !== serverStopped) {
    setPreviousStopped(serverStopped);
    // Requests failed while no server answered; ask again once one does.
    if (!serverStopped) setFailed([]);
  }
  return {
    failed,
    fail: (href: string) => setFailed((old) => [...old.slice(-30), href]),
    retry: (href: string | null) => setFailed((old) => old.filter((v) => v !== href)),
  };
}

/**
 * Keeps the comparison's address in the hash: the participants, the clock, the cursor, and
 * another run and its participant. Each change replaces the address and reports it, unless the
 * hash has moved to an address this comparison did not write. A history move to another
 * comparison address is handed to `onNavigate`.
 */
function useComparisonAddress(
  {
    streams,
    clock,
    at,
    usable,
    otherId,
    otherLane,
  }: {
    streams: ObserverStream[];
    clock: Clock;
    at: number;
    /** Some participant has frame times, so the cursor is part of the address. */
    usable: boolean;
    otherId: string;
    otherLane: string;
  },
  onLocationChange: (hash: string) => void,
  onNavigate: (route: ComparisonRoute) => void,
): void {
  const lastRoute = useRef(window.location.hash);
  useEffect(() => {
    if (window.location.hash !== lastRoute.current) return;
    const query = new URLSearchParams();
    streams.forEach((s) => query.append("lane", s.id));
    query.set("clock", clock);
    if (usable) query.set("at", String(Math.round(at)));
    if (otherId) query.set("run", otherId);
    if (otherLane) query.set("otherLane", otherLane);
    replaceHash(`#/compare?${query}`);
    lastRoute.current = window.location.hash;
    onLocationChange(lastRoute.current);
  }, [at, clock, streams, otherId, otherLane, usable, onLocationChange]);
  const applyRoute = useEffectEvent(onNavigate);
  useEffect(() => {
    const navigate = () => {
      if (!window.location.hash.startsWith("#/compare")) return;
      lastRoute.current = window.location.hash;
      applyRoute(comparisonRoute());
    };
    window.addEventListener("hashchange", navigate);
    window.addEventListener("popstate", navigate);
    return () => {
      window.removeEventListener("hashchange", navigate);
      window.removeEventListener("popstate", navigate);
    };
  }, []);
}

export function Comparison({
  data,
  streams,
  history,
  onBack,
  onOpen,
  onLocationChange,
  serverStopped = false,
}: {
  /** The serving process is gone; one page notice says so in place of a message per frame. */
  serverStopped?: boolean;
  data: ObserverData;
  streams: ObserverStream[];
  history: HistoryIndex | null;
  onBack: () => void;
  onOpen: (id: string, frame: number) => void;
  onLocationChange: (hash: string) => void;
}) {
  const [clock, setClock] = useState<Clock>(() => comparisonRoute().clock);
  const [time, setTime] = useState<number | null>(() => comparisonRoute().at);
  const [playing, setPlaying] = useState(false);
  const [otherId, setOtherId] = useState(() => comparisonRoute().run);
  const [otherLane, setOtherLane] = useState(() => comparisonRoute().lane);
  const images = useFailedImages(serverStopped);
  const availableOther = !!history?.runs.some((run) => run.runId === otherId);
  const otherAllowed = streams.length < 3;
  const { other, loadState } = useOtherRun(otherId, availableOther, otherAllowed);
  const participants = useMemo(
    () =>
      comparisonParticipants({
        runId: data.run.runId,
        runStreams: data.streams,
        streams,
        other,
        otherLane,
        clock,
        otherAllowed,
      }),
    [streams, other, otherLane, clock, data.run.runId, data.streams, otherAllowed],
  );
  const valid = participants.filter((p) => p.times?.length);
  const start = Math.min(...valid.map((p) => p.times?.[0] ?? Infinity));
  const end = Math.max(...valid.map((p) => p.times?.at(-1) ?? -Infinity));
  const usable = Number.isFinite(start) && Number.isFinite(end);
  const at = usable ? Math.max(start, Math.min(end, time ?? start)) : 0;
  useEffect(() => {
    if (!playing || !usable || at >= end) {
      if (playing) setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setTime(Math.min(end, at + 250)), 250);
    return () => clearTimeout(timer);
  }, [playing, at, end, usable]);
  useComparisonAddress(
    { streams, clock, at, usable, otherId, otherLane },
    onLocationChange,
    (r) => {
      setTime(r.at);
      setClock(r.clock);
      setOtherId(r.run);
      setOtherLane(r.lane);
      setPlaying(false);
    },
  );
  const overlaps =
    valid.length > 1 &&
    Math.max(...valid.map((p) => p.times?.[0] ?? Infinity)) <=
      Math.min(...valid.map((p) => p.times?.at(-1) ?? -Infinity));
  return (
    <section className="comparison" aria-label="Compare participants">
      <ComparisonToolbar
        clock={clock}
        onClock={(value) => {
          setClock(value);
          setTime(null);
          setPlaying(false);
        }}
        history={history}
        runId={data.run.runId}
        otherId={otherId}
        otherAllowed={otherAllowed}
        onOtherRun={(value) => {
          setOtherId(value);
          setOtherLane("");
          setClock("elapsed");
          setTime(null);
        }}
        other={other}
        otherLane={otherLane}
        onOtherLane={setOtherLane}
        onBack={onBack}
      />
      {!otherAllowed && history && history.runs.length > 1 ? (
        <p id="compare-limit">
          Comparison holds up to three participants. Return to participants and remove one to add
          another run.
        </p>
      ) : null}
      <p className="compare-note">
        {clock === "shared"
          ? "Aligned to recorded capture timestamps. Clocks may differ; each screen shows its capture age."
          : "Aligned from each participant’s first capture. This compares progress, not simultaneous events."}
      </p>
      {clock === "shared" && valid.length > 1 && !overlaps ? (
        <p role="status">
          These recordings do not overlap in time. Choose elapsed time to compare their progress.
        </p>
      ) : null}
      {loadState ? <p role="status">{loadState}</p> : null}
      {usable ? (
        <ComparisonTransport
          clock={clock}
          playing={playing}
          at={at}
          start={start}
          end={end}
          onToggle={() => {
            if (at >= end) setTime(start);
            setPlaying(!playing);
          }}
          onSeek={(value) => {
            setPlaying(false);
            setTime(value);
          }}
        />
      ) : (
        <p>No timestamped frames to align. Choose elapsed time for older recordings.</p>
      )}
      <div className="compare-grid">
        {participants.map((p) => (
          <ComparisonPanel
            key={`${p.run}/${p.stream.id}`}
            participant={p}
            at={at}
            serverStopped={serverStopped}
            failedImages={images.failed}
            onFail={images.fail}
            onRetry={images.retry}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
}

/** Back to the grid, the clock the comparison aligns by, and another run and its participant. */
function ComparisonToolbar({
  clock,
  onClock,
  history,
  runId,
  otherId,
  otherAllowed,
  onOtherRun,
  other,
  otherLane,
  onOtherLane,
  onBack,
}: {
  clock: Clock;
  onClock: (clock: Clock) => void;
  history: HistoryIndex | null;
  runId: string;
  otherId: string;
  /** This study has fewer than three participants in the comparison. */
  otherAllowed: boolean;
  onOtherRun: (runId: string) => void;
  other: ObserverData | null;
  otherLane: string;
  onOtherLane: (streamId: string) => void;
  onBack: () => void;
}) {
  return (
    <div className="compare-toolbar">
      <button type="button" className="review-tool" onClick={onBack}>
        Back to participants
      </button>
      <label>
        Align by{" "}
        <Select
          label="Comparison clock"
          value={clock}
          onValueChange={(value) => onClock(value as Clock)}
          options={[
            { value: "shared", label: "Capture time" },
            { value: "elapsed", label: "Elapsed time" },
          ]}
        />
      </label>
      {history && history.runs.length > 1 ? (
        <label>
          Compare another run{" "}
          <Select
            label="Comparison run"
            disabled={!otherAllowed && !otherId}
            describedBy={!otherAllowed ? "compare-limit" : undefined}
            value={otherId}
            onValueChange={onOtherRun}
            options={[
              { value: "", label: "This study only" },
              ...history.runs
                .filter((r) => r.runId !== runId)
                .map((r) => ({ value: r.runId, label: r.runId })),
            ]}
          />
        </label>
      ) : null}
      {other ? (
        <label>
          Participant{" "}
          <Select
            label="Other run participant"
            value={otherLane || other.streams[0]?.id || ""}
            onValueChange={onOtherLane}
            options={other.streams.map((stream) => ({
              value: stream.id,
              label: participantLabels(other.streams).get(stream.id) ?? stream.label,
            }))}
          />
        </label>
      ) : null}
    </div>
  );
}

/** Play or pause the comparison clock, seek it, and read the cursor and the range. */
function ComparisonTransport({
  clock,
  playing,
  at,
  start,
  end,
  onToggle,
  onSeek,
}: {
  clock: Clock;
  playing: boolean;
  at: number;
  start: number;
  end: number;
  onToggle: () => void;
  onSeek: (at: number) => void;
}) {
  return (
    <div className="compare-transport">
      <button
        type="button"
        className="review-tool"
        aria-label={playing ? "Pause comparison" : "Play comparison"}
        onClick={onToggle}
      >
        {playing ? "Pause" : "Play"}
      </button>
      <input
        type="range"
        aria-label="Seek comparison"
        min={start}
        max={end}
        step={100}
        value={at}
        onChange={(e) => onSeek(Number(e.target.value))}
      />
      <span>
        {clock === "shared" ? new Date(at).toLocaleTimeString() : elapsed(at)} ·{" "}
        {elapsed(end - start)} range
      </span>
    </div>
  );
}
