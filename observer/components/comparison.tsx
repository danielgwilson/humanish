import { useEffect, useMemo, useRef, useState } from "react";
import { historyRunHref } from "@/lib/artifact-href";
import { comparisonFrame, frameTimes } from "@/lib/comparison";
import { fetchObserverData, type HistoryIndex } from "@/lib/live";
import type { ObserverData, ObserverStream } from "@/lib/observer-data";
import { buildPlayerModel } from "@/lib/player-model";
import { participantLabels } from "@/lib/participant-label";
import { formatHash, replaceHash } from "@/lib/route";

const elapsed = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
function comparisonRoute() {
  const query = new URLSearchParams(window.location.hash.split("?")[1]);
  const value = Number(query.get("at"));
  return { clock: query.get("clock") === "elapsed" ? "elapsed" as const : "shared" as const, at: query.has("at") && Number.isFinite(value) ? value : null, run: query.get("run") ?? "", lane: query.get("otherLane") ?? "" };
}

export function Comparison({ data, streams, history, onBack, onOpen, onLocationChange }: {
  data: ObserverData; streams: ObserverStream[]; history: HistoryIndex | null; onBack: () => void;
  onOpen: (id: string, frame: number) => void; onLocationChange: (hash: string) => void;
}) {
  const lastRoute = useRef(window.location.hash);
  const [clock, setClock] = useState<"shared" | "elapsed">(() => comparisonRoute().clock);
  const [time, setTime] = useState<number | null>(() => comparisonRoute().at);
  const [playing, setPlaying] = useState(false);
  const [otherId, setOtherId] = useState(() => comparisonRoute().run);
  const [other, setOther] = useState<ObserverData | null>(null);
  const [otherLane, setOtherLane] = useState(() => comparisonRoute().lane);
  const [loadState, setLoadState] = useState("");
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const availableOther = !!history?.runs.some((run) => run.runId === otherId);
  const otherAllowed = streams.length < 3;
  useEffect(() => {
    if (!otherId) { setOther(null); setLoadState(""); return; }
    if (!otherAllowed) { setOther(null); setLoadState("Keep at most two participants from this study to compare another run. Return to participants to change your selection."); return; }
    const href = availableOther ? historyRunHref(otherId) : null;
    if (!href) { setOther(null); setLoadState("That run is not in the available library."); return; }
    const controller = new AbortController(); let disposed = false;
    setOther(null); setLoadState("Loading recorded evidence…");
    void fetchObserverData((input, init) => window.fetch(input, init), href.replace(/index\.html$/, "observer-data.json"), controller.signal).then((next) => {
      if (disposed) return;
      if (next?.run.runId === otherId) { setOther(next); setLoadState("Other run loaded as recorded evidence."); }
      else setLoadState("Could not load that run. Check that its viewer is still available.");
    });
    return () => { disposed = true; controller.abort(); };
  }, [otherId, availableOther, otherAllowed]);
  const participants = useMemo(() => {
    const labels = participantLabels(data.streams);
    const entries = streams.slice(0, 3).map((stream) => ({ stream, name: labels.get(stream.id) ?? stream.label, run: data.run.runId, base: "", model: buildPlayerModel(stream) }));
    const selected = other?.streams.find((s) => s.id === otherLane) ?? other?.streams[0];
    if (other && selected && otherAllowed) entries.push({ stream: selected, name: participantLabels(other.streams).get(selected.id) ?? selected.label, run: other.run.runId, base: historyRunHref(other.run.runId) ?? "", model: buildPlayerModel(selected) });
    return entries.map((entry) => ({ ...entry, times: entry.model ? frameTimes(entry.model, clock) : null }));
  }, [streams, other, otherLane, clock, data.run.runId, data.streams, otherAllowed]);
  const valid = participants.filter((p) => p.times?.length);
  const start = Math.min(...valid.map((p) => p.times?.[0] ?? Infinity));
  const end = Math.max(...valid.map((p) => p.times?.at(-1) ?? -Infinity));
  const usable = Number.isFinite(start) && Number.isFinite(end);
  const at = usable ? Math.max(start, Math.min(end, time ?? start)) : 0;
  useEffect(() => {
    if (!playing || !usable || at >= end) { if (playing) setPlaying(false); return; }
    const timer = setTimeout(() => setTime(Math.min(end, at + 250)), 250);
    return () => clearTimeout(timer);
  }, [playing, at, end, usable]);
  useEffect(() => {
    if (window.location.hash !== lastRoute.current) return;
    const query = new URLSearchParams(); streams.forEach((s) => query.append("lane", s.id));
    query.set("clock", clock); if (usable) query.set("at", String(Math.round(at))); if (otherId) query.set("run", otherId); if (otherLane) query.set("otherLane", otherLane);
    replaceHash(`#/compare?${query}`);
    lastRoute.current = window.location.hash;
    onLocationChange(lastRoute.current);
  }, [at, clock, streams, otherId, otherLane, usable, onLocationChange]);
  useEffect(() => {
    const navigate = () => { if (!window.location.hash.startsWith("#/compare")) return; lastRoute.current = window.location.hash; const r = comparisonRoute(); setTime(r.at); setClock(r.clock); setOtherId(r.run); setOtherLane(r.lane); setPlaying(false); };
    window.addEventListener("hashchange", navigate); window.addEventListener("popstate", navigate);
    return () => { window.removeEventListener("hashchange", navigate); window.removeEventListener("popstate", navigate); };
  }, []);
  const overlaps = valid.length > 1 && Math.max(...valid.map((p) => p.times?.[0] ?? Infinity)) <= Math.min(...valid.map((p) => p.times?.at(-1) ?? -Infinity));
  return <section className="comparison" aria-label="Compare participants">
    <div className="compare-toolbar"><button type="button" className="review-tool" onClick={onBack}>Back to participants</button>
      <label>Align by <select aria-label="Comparison clock" value={clock} onChange={(e) => { setClock(e.target.value as typeof clock); setTime(null); setPlaying(false); }}><option value="shared">Capture time</option><option value="elapsed">Elapsed time</option></select></label>
      {history && history.runs.length > 1 ? <label>Compare another run <select aria-label="Comparison run" disabled={!otherAllowed && !otherId} aria-describedby={!otherAllowed ? "compare-limit" : undefined} value={otherId} onChange={(e) => { setOtherId(e.target.value); setOtherLane(""); setClock("elapsed"); setTime(null); }}><option value="">This study only</option>{history.runs.filter((r) => r.runId !== data.run.runId).map((r) => <option key={r.runId} value={r.runId}>{r.runId}</option>)}</select></label> : null}
      {other ? <label>Participant <select aria-label="Other run participant" value={otherLane || other.streams[0]?.id || ""} onChange={(e) => setOtherLane(e.target.value)}>{other.streams.map((s) => <option key={s.id} value={s.id}>{participantLabels(other.streams).get(s.id) ?? s.label}</option>)}</select></label> : null}
    </div>
    {!otherAllowed && history && history.runs.length > 1 ? <p id="compare-limit">Comparison holds up to three participants. Return to participants and remove one to add another run.</p> : null}
    <p className="compare-note">{clock === "shared" ? "Aligned to recorded capture timestamps. Clocks may differ; each screen shows its capture age." : "Aligned from each participant’s first capture. This compares progress, not simultaneous events."}</p>
    {clock === "shared" && valid.length > 1 && !overlaps ? <p role="status">These recordings do not overlap in time. Choose elapsed time to compare their progress.</p> : null}
    {loadState ? <p role="status">{loadState}</p> : null}
    {usable ? <div className="compare-transport"><button type="button" className="review-tool" aria-label={playing ? "Pause comparison" : "Play comparison"} onClick={() => { if (at >= end) setTime(start); setPlaying(!playing); }}>{playing ? "Pause" : "Play"}</button>
      <input type="range" aria-label="Seek comparison" min={start} max={end} step={100} value={at} onChange={(e) => { setPlaying(false); setTime(Number(e.target.value)); }} />
      <span>{clock === "shared" ? new Date(at).toLocaleTimeString() : elapsed(at)} · {elapsed(end - start)} range</span></div> : <p>No timestamped frames to align. Choose elapsed time for older recordings.</p>}
    <div className="compare-grid">{participants.map((p) => {
      const selection = p.times ? comparisonFrame(p.times, at) : null;
      const frame = selection && selection.index >= 0 ? p.model?.frames[selection.index] : null;
      const href = frame ? p.base && !frame.href.startsWith("data:") ? new URL(frame.href, new URL(p.base, window.location.href)).href : frame.href : null;
      const failed = href !== null && failedImages.includes(href);
      return <article key={`${p.run}/${p.stream.id}`} className="compare-participant"><h2>{p.name}</h2><p className="compare-run">{p.run}</p>
        <div className="compare-stage">{href && !failed ? <img src={href} alt={`Recorded frame from ${p.name}`} onError={() => setFailedImages((old) => [...old.slice(-30), href])} /> : <p>{failed ? "Frame unavailable" : !p.times ? "No capture timestamps" : "No capture yet at this time"}</p>}</div>
        <p className="compare-caption">{selection && selection.index >= 0 ? `${selection.coverage === "after" ? "Past recording end · last capture" : "Recorded capture"} · ${elapsed(selection.ageMs)} before cursor · frame ${selection.index + 1}${p.model?.paced === "avg" ? " · estimated timing" : ""}` : "Outside recorded coverage"}</p>
        {frame ? <a className="review-tool compare-open" href={`${p.base}${formatHash(p.stream.id, frame.index)}`} aria-label={`Open frame ${frame.index + 1} from ${p.name}`} onClick={(event) => {
          if (p.base || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); onOpen(p.stream.id, frame.index);
        }}>Open frame {frame.index + 1}</a> : null}
        {failed ? <button type="button" className="review-tool" onClick={() => setFailedImages((old) => old.filter((v) => v !== href))}>Retry image</button> : null}
      </article>;
    })}</div>
  </section>;
}
