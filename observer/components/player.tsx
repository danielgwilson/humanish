import { IconButton } from "./ui/icon-button";
import { ReviewIcon } from "./review-icon";
import { Tabs } from "@base-ui-components/react/tabs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatDuration } from "@/lib/artifact-href";
import { liveEmbedSandbox, liveEmbedUrl } from "@/lib/live";
import type { ObserverData, ObserverStream } from "@/lib/observer-data";
import { boundedWindow, formatElapsed, frameAtElapsedMs, frameElapsedMs, frameHoldMs, groupPlayerRows, isActionRow, isFindingRow, isWaitRow, rowElapsedMs, type PlayerModel } from "@/lib/player-model";
import { openPlayback, playbackIndex, seekPlayback, type PlayerView } from "@/lib/player-state";
import { formatHash, parseHash, replaceHash } from "@/lib/route";
import { participantLabels } from "@/lib/participant-label";
import { NOTABLE_COMPLETION } from "@/lib/signal";
import { PlayerStage, type Zoom } from "./player-stage";
import "@/styles/player.css";

type Tab = "actions" | "details" | "report";
type FeedFilter = "all" | "actions" | "thoughts" | "findings";
const SPEEDS = [1, 2, 4, 8, 16] as const;
const FILMSTRIP_LIMIT = 40;
const FEED_LIMIT = 100;
const PREFS_KEY = "humanish-player-v1";
interface Preferences { speed: number; skipWaits: boolean; inspector: boolean; width: number }
function readPreferences(): Preferences {
  const fallback = { speed: 1, skipWaits: false, inspector: true, width: 340 };
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    if (!value || typeof value !== "object") return fallback;
    const prefs = value as Partial<Preferences>;
    return { speed: typeof prefs.speed === "number" && SPEEDS.includes(prefs.speed as 1) ? prefs.speed : 1,
      skipWaits: prefs.skipWaits === true, inspector: prefs.inspector !== false,
      width: typeof prefs.width === "number" && Number.isFinite(prefs.width) ? Math.max(280, Math.min(520, prefs.width)) : 340 };
  } catch { return fallback; }
}

// Text-only rendering of the participant's reported narration, never HTML/markdown links.
export function renderThoughtText(text: string): (string | { bold: string })[] {
  const parts: (string | { bold: string })[] = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ bold: match[1] ?? "" });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function Player({ data, stream, model, initialFrame = null, initialMode = null, updating = true, onViewChange }: {
  data: ObserverData; stream: ObserverStream; model: PlayerModel; initialFrame?: number | null; initialMode?: "live" | "replay" | null;
  /** Source capability, not the most recent poll result; transient failures stay updating. */
  updating?: boolean;
  onViewChange?: (view: PlayerView) => void;
}) {
  const preparing = stream.status === "queued" || stream.status === "preparing";
  const active = updating && (stream.status === "running" || preparing);
  const lifecycle = preparing ? "Preparing" : "Running";
  const sourcePlayback = useCallback((addressed: number | null, mode: "live" | "replay" | null) => openPlayback(
    model, active, !updating && mode === "live" && addressed === null ? Math.max(0, model.frames.length - 1) : addressed,
    updating ? mode : "replay"
  ), [model, active, updating]);
  const [state, setState] = useState(() => sourcePlayback(initialFrame, initialMode));
  const [previousUpdating, setPreviousUpdating] = useState(updating);
  if (previousUpdating !== updating) {
    setPreviousUpdating(updating);
    if (!updating && state.mode === "live") setState(seekPlayback(model, playbackIndex(state, model)));
  }
  // A URL navigation is a new instruction even in the same participant. Adjust before
  // commit so a stale frame cannot overwrite the incoming address in a later effect.
  const address = `${stream.id}:${initialMode ?? "auto"}:${initialFrame ?? "none"}`;
  const [previousAddress, setPreviousAddress] = useState(address);
  if (address !== previousAddress) {
    setPreviousAddress(address);
    setState(sourcePlayback(initialFrame, initialMode));
  }
  const [preferences, setPreferences] = useState(readPreferences);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [tab, setTab] = useState<Tab>("actions");
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [groupWaits, setGroupWaits] = useState(true);
  const [showThoughts, setShowThoughts] = useState(true);
  const [feedPage, setFeedPage] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manualLink, setManualLink] = useState<string | null>(null);
  const [scrubPreview, setScrubPreview] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const [streamRevision, setStreamRevision] = useState(0);
  const viewerRef = useRef<HTMLDivElement>(null);
  const filmRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ x: number; width: number } | null>(null);
  const frames = model.frames;
  const frame = playbackIndex(state, model);
  const current = frame >= 0 ? frames[frame] : undefined;
  const following = state.mode === "live";
  const live = following && active ? liveEmbedUrl(stream) : null;
  const playing = state.playing;
  const viewMode: PlayerView["mode"] = following && active ? "live" : "replay";
  const selectedFrame = current?.index ?? null;
  const onViewChangeRef = useRef(onViewChange);
  useEffect(() => { onViewChangeRef.current = onViewChange; }, [onViewChange]);
  useEffect(() => {
    onViewChangeRef.current?.({ frame: selectedFrame, mode: viewMode, playing });
  }, [selectedFrame, viewMode, playing]);
  const actor = stream.actor;
  const viewport = stream.viewport;
  // Computer-use actions use desktop pixels, not the browser CSS layout viewport.
  // Older browser recordings lack desktopGeometry and retain their viewport mapping.
  const coordinateSpace = stream.desktopGeometry?.screen.verified ?? stream.desktopGeometry?.screen.requested ?? viewport;
  const raw = current?.redaction === "none" || actor?.redaction.screenshots === "raw";
  const notableEnd = actor !== undefined && Object.hasOwn(NOTABLE_COMPLETION, actor.completionReason);
  const elapsed = frameElapsedMs(model, Math.max(0, frame));
  const duration = frameElapsedMs(model, Math.max(0, frames.length - 1));
  const timing = model.paced === "recorded" ? "recorded pace" : "avg-paced";
  const hold = frameHoldMs(model, Math.max(0, frame));
  const rowIndex = useMemo(() => {
    const pins = new Map<number, typeof model.rows>();
    const actions = new Set<number>();
    const findings = new Set<number>();
    const waits = new Set<number>();
    let thoughtCount = 0;
    let actionCount = 0;
    for (const row of model.rows) {
      if (row.coord) pins.set(row.frameIndex, [...(pins.get(row.frameIndex) ?? []), row]);
      if (isActionRow(row)) actions.add(row.frameIndex);
      if (isFindingRow(row)) findings.add(row.frameIndex);
      if (isWaitRow(row)) waits.add(row.frameIndex);
      if (row.kind === "reasoning") thoughtCount += 1;
      else if (isActionRow(row) || isWaitRow(row)) actionCount += 1;
    }
    if (notableEnd && frames.length > 0) findings.add(frames.length - 1);
    return { pins, actions: [...actions], findings: [...findings], waits, thoughtCount, actionCount };
  }, [model, notableEnd, frames.length]);
  const currentPins = rowIndex.pins.get(frame) ?? [];
  const skipDuration = preferences.skipWaits && rowIndex.waits.has(frame) && !rowIndex.actions.includes(frame) ? Math.max(0, hold - 1000) : 0;
  const seek = useCallback((index: number) => {
    setState(seekPlayback(model, index));
    setFeedPage(null);
    setNotice(null);
  }, [model]);
  const togglePlay = useCallback(() => {
    if (frames.length === 0) return;
    if (playing) setState(seekPlayback(model, Math.max(0, frame)));
    else setState(seekPlayback(model, frame >= frames.length - 1 || frame < 0 ? 0 : frame, true));
  }, [model, frames.length, frame, playing]);
  const jumpToLive = () => { setState(openPlayback(model, active, null, "live")); setFeedPage(null); };

  useEffect(() => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(preferences)); } catch { /* storage can be disabled in an offline artifact */ } }, [preferences]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => {
    const navigate = () => {
      const route = parseHash(window.location.hash);
      if (route.laneId !== stream.id) return;
      setState(sourcePlayback(route.frame, route.mode ?? null));
      setFeedPage(null);
    };
    window.addEventListener("hashchange", navigate);
    window.addEventListener("popstate", navigate);
    return () => { window.removeEventListener("hashchange", navigate); window.removeEventListener("popstate", navigate); };
  }, [sourcePlayback, stream.id]);
  useEffect(() => {
    // Keep following intent in the address, including before the first capture.
    if (following && active) replaceHash(formatHash(stream.id, null, "live"));
    else if (current) replaceHash(formatHash(stream.id, current.index));
  }, [following, active, playing, current, stream.id]);
  const nextFrameId = frames[frame + 1]?.itemId ?? null;
  useEffect(() => {
    if (!playing || frame < 0) return;
    if (nextFrameId === null) { setState((value) => ({ ...value, playing: false })); return; }
    // An unchanged evidence poll must not reset a seven-second capture interval every
    // five seconds. Depend on the actual transition, never the snapshot object identity.
    const timer = setTimeout(() => setState({ mode: "replay", frameId: nextFrameId, requestedFrame: frame + 1, playing: true }), Math.max(120, (hold - skipDuration) / preferences.speed));
    return () => clearTimeout(timer);
  }, [playing, frame, nextFrameId, hold, skipDuration, preferences.speed]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, button, a, summary, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"], [role="slider"], [role="tab"]')) return;
      if (event.key === " ") { event.preventDefault(); togglePlay(); }
      if (event.key === "ArrowLeft") { event.preventDefault(); seek(Math.max(0, frame - 1)); }
      if (event.key === "ArrowRight") { event.preventDefault(); seek(frame + 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frame, seek, togglePlay]);
  useEffect(() => {
    // Neighbor-only preload/decode: no eager decoding of a long screenshot recording.
    const neighbors = [frames[frame - 1], frames[frame + 1]];
    for (const neighbor of neighbors) {
      if (!neighbor) continue;
      const image = new Image();
      image.src = neighbor.href;
      void image.decode?.().catch(() => undefined);
    }
  }, [frames, frame]);

  const filteredRows = useMemo(() => model.rows.filter((row) => {
    if (!showThoughts && row.kind === "reasoning") return false;
    return filter === "all" || (filter === "thoughts" && row.kind === "reasoning")
      || (filter === "actions" && isActionRow(row)) || (filter === "findings" && isFindingRow(row));
  }), [model.rows, filter, showThoughts]);
  const groups = useMemo(() => groupPlayerRows(filteredRows, groupWaits), [filteredRows, groupWaits]);
  const activeGroup = Math.max(0, groups.findIndex((group) => group.first.frameIndex <= frame && group.last.frameIndex >= frame));
  const feedWindow = boundedWindow(groups.length, feedPage ?? activeGroup, FEED_LIMIT);
  const filmWindow = boundedWindow(frames.length, Math.max(0, frame), FILMSTRIP_LIMIT);
  useEffect(() => {
    const revealWithin = (pane: HTMLDivElement | null, selector: string, horizontal: boolean) => {
      const row = pane?.querySelector(selector);
      if (!pane || !(row instanceof HTMLElement)) return;
      const p = pane.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (horizontal) {
        if (r.left < p.left) pane.scrollLeft += r.left - p.left;
        else if (r.right > p.right) pane.scrollLeft += r.right - p.right;
      } else if (feedPage === null) {
        if (r.top < p.top) pane.scrollTop += r.top - p.top;
        else if (r.bottom > p.bottom) pane.scrollTop += r.bottom - p.bottom;
      }
    };
    revealWithin(filmRef.current, '[data-on]', true);
    revealWithin(feedRef.current, '[data-on]', false);
  }, [frame, feedPage, tab]);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (viewerRef.current?.requestFullscreen) await viewerRef.current.requestFullscreen();
      else throw new Error("unavailable");
      setNotice(null);
    } catch { setNotice("Fullscreen is unavailable in this browser or was declined. The player remains usable here."); }
  };
  const copyMoment = async () => {
    if (!current) return;
    // Deliberately copies a replay address, even while following the live desktop.
    const link = `${window.location.href.split("#")[0] ?? ""}${formatHash(stream.id, current.index)}`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("unavailable");
      await navigator.clipboard.writeText(link);
      setManualLink(null); setNotice("Link copied to this recorded moment.");
    } catch { setManualLink(link); setNotice("Copy this moment link below. Clipboard access is unavailable."); }
  };
  const nextAction = rowIndex.actions.find((index) => index > frame);
  const nextFinding = rowIndex.findings.find((index) => index > frame);
  const markerLeft = (index: number) => `${duration > 0 ? 100 * frameElapsedMs(model, index) / duration : 0}%`;
  const captureAge = current?.atMs !== undefined ? Math.max(0, now - current.atMs) : null;
  const modeLabel = !updating ? "Offline recording" : active
    ? live ? `${lifecycle} · Live desktop` : following ? `${lifecycle} · Latest capture` : `${lifecycle} · Replay at ${formatElapsed(elapsed)}`
    : `${stream.status === "failed" || stream.status === "blocked" || stream.status === "timed_out" ? "Stopped" : "Finished"} · Recording`;

  return <div className="player evidence-player" data-inspector={preferences.inspector ? "open" : "closed"}>
    <div className="viewer" ref={viewerRef}>
      <div className="player-heading">
        <div className="player-mode"><strong>{modeLabel}</strong>
          <span>{!updating ? `Saved snapshot · participant status at capture: ${stream.statusLabel || stream.status}${current?.atMs !== undefined ? ` · ${new Date(current.atMs).toISOString()}` : ""}` : live ? "Read-only desktop; connection health is managed by the provider." : following && active && current
            ? captureAge === null ? "Capture time unavailable" : `Captured ${formatDuration(captureAge)} ago`
            : current?.atMs !== undefined ? `Captured ${new Date(current.atMs).toISOString()}` : "Capture timestamps unavailable"}</span>
        </div>
        {live ? <button type="button" className="tbtn" onClick={() => {
          setStreamRevision((value) => value + 1);
          setNotice("Reloading the read-only desktop connection. This does not restart the participant; connection health is managed by the provider.");
        }}>Reload stream</button> : null}
        {active && !following ? <button type="button" className="tbtn live-jump" aria-label="Jump to live" onClick={jumpToLive}>Go live</button> : null}
        <button type="button" className="tbtn" aria-label={preferences.inspector ? "Hide inspector" : "Show inspector"} aria-expanded={preferences.inspector}
          onClick={() => setPreferences((value) => ({ ...value, inspector: !value.inspector }))}>Inspector {preferences.inspector ? "−" : "+"}</button>
      </div>
      <PlayerStage sandbox={liveEmbedSandbox(stream)} frame={current} count={frames.length} viewport={coordinateSpace} pins={currentPins} zoom={zoom} live={live} streamRevision={streamRevision} label={stream.label}
        emptyText={frames.length > 0 ? "This addressed frame is unavailable in the current recording. Choose another moment below."
          : !updating ? "This saved snapshot contains no recorded screenshots. It cannot show current participant activity." : active ? preparing ? "The participant is preparing. Waiting for its first recorded frame." : "Waiting for the first recorded frame. The participant is still running." : "This participant ended without a recorded screenshot."} />
      <div className="transport">
        <IconButton className="tbtn" label={playing ? "Pause" : "Play"} hint={playing ? "Pause playback" : "Play recording"} onClick={togglePlay} disabled={frames.length === 0}><ReviewIcon name={playing ? "pause" : "play"} /></IconButton>
        <IconButton className="tbtn" label="Previous frame" onClick={() => seek(frame - 1)} disabled={frame <= 0}><ReviewIcon name="previous-frame" /></IconButton>
        <IconButton className="tbtn" label="Next frame" onClick={() => seek(frame + 1)} disabled={frame >= frames.length - 1}><ReviewIcon name="next-frame" /></IconButton>
        <span className="elapsed">{formatElapsed(elapsed)} <span>/ {formatElapsed(duration)}</span></span>
        <div className="scrubwrap" onPointerLeave={() => setScrubPreview(null)}>
          {scrubPreview !== null && frames[scrubPreview] ? <div className="scrub-preview" aria-hidden="true">
            <img src={frames[scrubPreview]?.href} alt="" /><span>{formatElapsed(frameElapsedMs(model, scrubPreview))} · frame {scrubPreview + 1}</span>
          </div> : null}
          <div className="scrub-track" aria-hidden="true"><div className="scrub-played" style={{ width: markerLeft(Math.max(0, frame)) }} />
            {[...rowIndex.pins.keys()].slice(0, 200).map((index) => <span key={index} className="scrub-tick" style={{ left: markerLeft(index) }} />)}
            {notableEnd && frames.length > 0 ? <span className="scrub-flag">⚑</span> : null}
          </div>
          <input className="scrub" type="range" min={0} max={Math.max(1, duration)} step={1} value={elapsed} disabled={frames.length < 2}
            aria-label="Seek recording time" aria-valuetext={`${formatElapsed(elapsed)} of ${formatElapsed(duration)}, frame ${Math.max(0, frame + 1)} of ${frames.length}`}
            onKeyDown={(event) => {
              if (event.altKey || event.ctrlKey || event.metaKey) return;
              const next = event.key === "ArrowRight" || event.key === "ArrowUp" ? frame + 1
                : event.key === "ArrowLeft" || event.key === "ArrowDown" ? frame - 1
                : event.key === "Home" ? 0 : event.key === "End" ? frames.length - 1
                : event.key === "PageUp" ? frame + Math.max(1, Math.ceil(frames.length / 10))
                : event.key === "PageDown" ? frame - Math.max(1, Math.ceil(frames.length / 10)) : null;
              if (next === null) return;
              // Native millisecond steps snap back to the same sparse capture. Move
              // between recorded boundaries so both arrow directions remain usable.
              event.preventDefault();
              seek(next);
            }}
            onPointerMove={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              if (bounds.width > 0) setScrubPreview(frameAtElapsedMs(model, Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * duration));
            }}
            onChange={(event) => seek(frameAtElapsedMs(model, Number(event.target.value)))} />
        </div>
        <span className="counter">{Math.max(0, frame + 1)} / {frames.length}</span>
        <button type="button" className="tbtn speed" aria-label="Playback speed" onClick={() => setPreferences((value) => ({ ...value, speed: SPEEDS[(SPEEDS.indexOf(value.speed as 1) + 1) % SPEEDS.length] ?? 1 }))}>{preferences.speed}×</button>
        <IconButton className="tbtn" label="Fullscreen" onClick={() => { void toggleFullscreen(); }}><ReviewIcon name="fullscreen" /></IconButton>
      </div>
      <div className="player-review-tools">
        <label><input type="checkbox" checked={preferences.skipWaits} onChange={(event) => setPreferences((value) => ({ ...value, skipWaits: event.target.checked }))} /> Skip waits</label>
        <button type="button" className="tbtn" disabled={nextAction === undefined} onClick={() => { if (nextAction !== undefined) seek(nextAction); }}>Next action</button>
        <button type="button" className="tbtn" disabled={nextFinding === undefined} onClick={() => { if (nextFinding !== undefined) seek(nextFinding); }} title="Recorded warnings, findings, or notable completion; not inferred from narration">Next finding</button>
        <label className="zoom-control">View <select aria-label="Image zoom" value={String(zoom)} disabled={live !== null} onChange={(event) => setZoom(event.target.value === "fit" || event.target.value === "actual" ? event.target.value : Number(event.target.value))}>
          <option value="fit">Fit</option><option value="actual">Actual size</option><option value="0.5">50%</option><option value="1.5">150%</option><option value="2">200%</option><option value="3">300%</option>
        </select></label>
        <button type="button" className="tbtn" disabled={!current} onClick={() => { void copyMoment(); }}>Copy moment link</button>
        {current ? <a className="tbtn" href={current.href} target="_blank" rel="noopener noreferrer" download>Original frame</a> : null}
        <details className="player-shortcuts"><summary>Shortcuts</summary><span>Space: play or pause · ← / →: previous or next frame. Zoomed image: drag or scroll to pan. Use Tab to reach controls; shortcuts leave editable fields alone.</span></details>
        {raw ? <span className="rawchip" title="Raw local screenshots. Redact before publishing.">RAW</span> : current?.redaction ? <span className="frame-redaction">{current.redaction}</span> : null}
      </div>
      <div className="player-evidence-note">{frames.length === 0 ? <span>{active ? `${lifecycle} · awaiting the first recorded frame` : "No recorded frames"}</span> : null}<span className="t-meta">{rowIndex.actionCount} actions{rowIndex.thoughtCount > 0 ? ` · ${rowIndex.thoughtCount} thoughts` : ""} · {timing}</span>
        {frame >= 0 && frame < frames.length - 1 && hold >= 5000 && model.paced === "recorded"
          ? <span>Next capture +{formatDuration(hold)}. Changes between captures are not recorded.{skipDuration > 0 ? ` Playback skips ${formatDuration(skipDuration)} of this capture interval containing recorded waits.` : ""}</span> : null}
        {stream.liveEnded === true ? <span>Desktop stream ended · recorded evidence</span> : null}
      </div>
      {notice ? <p className="player-notice" role="status">{notice}</p> : null}
      {manualLink ? <label className="moment-fallback">Moment link<input readOnly value={manualLink} aria-label="Moment link" onFocus={(event) => event.target.select()} /></label> : null}
      <div className="filmstrip" ref={filmRef} aria-label="Recorded frames">
        {filmWindow.start > 0 ? <button type="button" className="tbtn film-page" onClick={() => seek(Math.max(0, filmWindow.start - 1))}>Earlier frames</button> : null}
        {frames.slice(filmWindow.start, filmWindow.end).map((f) => <button key={f.itemId} type="button" className="fs" {...(f.index === frame ? { "data-on": "" } : {})}
          aria-label={`Frame ${f.index + 1}, ${formatElapsed(frameElapsedMs(model, f.index))}, ${f.title}`} onClick={() => seek(f.index)}>
          <span className="im"><img src={f.href} alt="" loading="lazy" decoding="async" /></span>
          <span className="lab">{formatElapsed(frameElapsedMs(model, f.index))} · {f.index + 1}</span>
        </button>)}
        {filmWindow.end < frames.length ? <button type="button" className="tbtn film-page" onClick={() => seek(filmWindow.end)}>Later frames</button> : null}
      </div>
    </div>
    {preferences.inspector ? <>
      <div className="inspector-resize" role="separator" aria-label="Inspector width" aria-orientation="vertical" tabIndex={0}
        aria-valuemin={280} aria-valuemax={520} aria-valuenow={preferences.width}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault(); event.stopPropagation();
          setPreferences((value) => ({ ...value, width: Math.max(280, Math.min(520, value.width + (event.key === "ArrowLeft" ? 20 : -20))) }));
        }}
        onPointerDown={(event) => { resizeRef.current = { x: event.clientX, width: preferences.width }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => { const start = resizeRef.current; if (start) setPreferences((value) => ({ ...value, width: Math.max(280, Math.min(520, start.width + start.x - event.clientX)) })); }}
        onPointerUp={() => { resizeRef.current = null; }} onLostPointerCapture={() => { resizeRef.current = null; }} />
      <Tabs.Root className="inspector" style={{ width: preferences.width }} value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <Tabs.List className="itabs" aria-label="Participant inspector">{(["actions", "details", "report"] as const).map((name) => <Tabs.Tab key={name} value={name}>{name}</Tabs.Tab>)}</Tabs.List>
        <Tabs.Panel value="actions" className="action-panel">
          <div className="feed-controls"><label>Show <select aria-label="Filter activity" value={filter} onChange={(event) => { setFilter(event.target.value as FeedFilter); setFeedPage(null); }}>
            <option value="all">All evidence</option><option value="actions">Actions</option><option value="thoughts">Reported thinking</option><option value="findings">Warnings & findings</option>
          </select></label><label><input type="checkbox" checked={groupWaits} onChange={(event) => setGroupWaits(event.target.checked)} /> Group waits</label>
            <label><input type="checkbox" checked={showThoughts} onChange={(event) => setShowThoughts(event.target.checked)} /> Thinking</label></div>
          <div className="ipanel acts" ref={feedRef}>
            {groups.length === 0 ? <p className="feed-empty">No recorded entries match this filter.</p> : null}
            {feedWindow.start > 0 ? <button type="button" className="tbtn feed-page" onClick={() => setFeedPage(Math.max(0, feedWindow.start - Math.floor(FEED_LIMIT / 2)))}>Earlier entries</button> : null}
            {groups.slice(feedWindow.start, feedWindow.end).map(({ first: row, last, count }) => {
              const stamp = formatElapsed(rowElapsedMs(model, row));
              const text = row.text || row.title;
              const attrs = { ...(row.isFrame ? { "data-frame-row": row.frameIndex } : {}), ...(row.frameIndex <= frame && last.frameIndex >= frame ? { "data-on": "" } : {}) };
              return row.kind === "reasoning" ? <details className="thought-detail" key={row.id}>
                <summary className="arow thought" {...attrs} title="Reported thinking — the participant's own narration, not ground truth" onClick={() => seek(row.frameIndex)}>
                  <span className="tc">{stamp}</span><span className="atext">{renderThoughtText(text).map((part, index) => typeof part === "string" ? part : <strong key={index}>{part.bold}</strong>)}</span>
                </summary><p className="thought-full">{text}</p>
              </details> : <button key={row.id} type="button" className={row.isFrame ? "arow shot" : "arow"} {...attrs} onClick={() => seek(row.frameIndex)}>
                <span className="tc">{stamp}</span><span className="atext">{count > 1 ? `${count} recorded waits · ${stamp}–${formatElapsed(rowElapsedMs(model, last))}` : `${row.title}${row.text ? ` — ${row.text}` : ""}`}</span>
              </button>;
            })}
            {feedWindow.end < groups.length ? <button type="button" className="tbtn feed-page" onClick={() => setFeedPage(feedWindow.end + Math.floor(FEED_LIMIT / 2))}>Later entries</button> : null}
            {groups.length > FEED_LIMIT ? <p className="feed-window">Entries {feedWindow.start + 1}–{feedWindow.end} of {groups.length} · original events retained</p> : null}
          </div>
        </Tabs.Panel>
        <Tabs.Panel value="details" className="ipanel">
            <div className="kv">
              <span className="k">Persona</span>
              <span className="v">{participantLabels(data.streams).get(stream.id) ?? stream.label}</span>
              <span className="k">Scenario</span>
              <span className="v">{data.run.scenario.title}</span>
              <span className="k">Lane</span>
              <span className="v">{stream.label}</span>
              {actor ? (
                <>
                  <span className="k">Actor</span>
                  <span className="v">
                    {actor.provider}
                    {actor.ids.model !== undefined ? ` · ${actor.ids.model}` : ""}
                  </span>
                  <span className="k">Duration</span>
                  <span className="v">{formatDuration(actor.durationMs)}</span>
                </>
              ) : null}
              {viewport ? (
                <>
                  <span className="k">Viewport</span>
                  <span className="v">{viewport.width}×{viewport.height}</span>
                </>
              ) : null}
              {actor?.affordanceUse ? (
                <>
                  <span className="k">Affordances</span>
                  <span className="v">
                    {Object.entries(actor.affordanceUse.counts)
                      .map(([kind, count]) => `${kind} ${count}`)
                      .join(" · ")}
                    {` · shortcuts ${actor.affordanceUse.shortcutTotal}`}
                  </span>
                </>
              ) : null}
              {actor ? (
                <>
                  <span className="k">Redaction</span>
                  <span className="v">screenshots {actor.redaction.screenshots}</span>
                </>
              ) : null}
              <span className="k">Artifacts</span>
              <span className="v">{(stream.artifacts ?? []).length + data.artifactLinks.length} linked files</span>
            </div>
          </Tabs.Panel>
        <Tabs.Panel value="report" className="ipanel">
            <div className="blk">
              <span className="o-label">Outcome</span>
              <p className="verbatim">
                {stream.statusLabel}
                {actor && Object.hasOwn(NOTABLE_COMPLETION, actor.completionReason)
                  ? ` · ⚑ ${NOTABLE_COMPLETION[actor.completionReason]}`
                  : ""}
              </p>
            </div>
            {actor ? (
              <div className="blk">
                <span className="o-label">Recorded reason, verbatim</span>
                <p className="verbatim">“{actor.reason}”</p>
              </div>
            ) : null}
            {data.run.knownGaps.length > 0 ? (
              <div className="blk">
                <span className="o-label">Known gaps</span>
                {data.run.knownGaps.map((gap) => (
                  <p key={gap} className="verbatim dim">{gap}</p>
                ))}
              </div>
            ) : null}
            {actor?.estimatedCost && typeof actor.estimatedCost.estimatedCostUsd === "number" ? (
              <div className="blk">
                <span className="o-label">Est. lane cost</span>
                <p className="verbatim">
                  ~${actor.estimatedCost.estimatedCostUsd.toFixed(2)} (rates as of {actor.estimatedCost.ratesAsOf})
                </p>
              </div>
            ) : null}
          </Tabs.Panel>
      </Tabs.Root>
    </> : null}
  </div>;
}
