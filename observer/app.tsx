import { Tooltip } from "@base-ui-components/react/tooltip";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Comparison } from "./components/comparison";
import { EmptyState } from "./components/empty-state";
import { IconRail } from "./components/icon-rail";
import { ParticipantStub } from "./components/participant-stub";
import { Player } from "./components/player";
import { RunStatus } from "./components/run-status";
import { SavedMoments } from "./components/saved-moments";
import { Sidebar } from "./components/sidebar";
import { Drawer } from "./components/ui/drawer";
import { StudyGrid } from "./components/study-grid";
import { Topbar, type GridFilters } from "./components/topbar";
import { observerArtifactHref } from "./lib/artifact-href";
import { isActiveStream, isServedOrigin, liveEmbedUrl } from "./lib/live";
import type { ObserverData } from "./lib/observer-data";
import type { PlayerView } from "./lib/player-state";
import { buildPlayerModel } from "./lib/player-model";
import { participantLabels } from "./lib/participant-label";
import { isDensity, isMoments, isStringList, usePreference, type SavedMoment } from "./lib/preferences";
import { formatHash, parseHash, pushHash } from "./lib/route";
import { useObserverFeed } from "./lib/use-observer-feed";

const NO_FILTERS: GridFilters = { status: "", kind: "", query: "" };
const isFilters = (v: unknown): v is GridFilters => !!v && typeof v === "object" && ["status", "kind", "query"].every((k) => typeof (v as Record<string, unknown>)[k] === "string" && ((v as Record<string, string>)[k]?.length ?? 0) < 256);
const compareRoute = () => window.location.hash.startsWith("#/compare");
const routeCompareIds = () => new URLSearchParams(window.location.hash.split("?")[1]).getAll("lane").slice(0, 3);

export function App({ data: initialData }: { data: ObserverData | null }) {
  const { data, history, connection, retry } = useObserverFeed(initialData);
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  const [comparison, setComparison] = useState(compareRoute);
  const [compareIds, setCompareIds] = useState<string[]>(routeCompareIds);
  const comparisonLocation = useRef(compareRoute() ? window.location.hash : "");
  const rememberComparison = useCallback((hash: string) => { comparisonLocation.current = hash; }, []);
  const [density, setDensity] = usePreference("density", "comfortable", isDensity);
  const [filters, setFilters] = usePreference("filters", NO_FILTERS, isFilters);
  const [pinnedByRun, setPinnedByRun] = usePreference(`pins-${initialData?.run.runId ?? "empty"}`, [] as string[], isStringList);
  const [savedMoments, setSavedMoments, momentsStored] = usePreference("moments", [] as SavedMoment[], isMoments);
  const [savedMessage, setSavedMessage] = useState("");
  const [playerView, setPlayerView] = useState<(PlayerView & { streamId: string }) | null>(null);
  const [monitoring, setMonitoring] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [sideOpen, setSideOpen] = useState(() => { try { return window.localStorage.getItem("humanish-sidebar") !== "closed"; } catch { return true; } });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [phone, setPhone] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 880px)").matches);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const media = window.matchMedia?.("(max-width: 880px)");
    const resize = () => setPhone(media?.matches ?? false);
    media?.addEventListener("change", resize);
    return () => { clearInterval(timer); media?.removeEventListener("change", resize); };
  }, []);
  useEffect(() => {
    const navigate = () => { setRoute(parseHash(window.location.hash)); setComparison(compareRoute()); if (compareRoute()) setCompareIds(routeCompareIds()); };
    window.addEventListener("hashchange", navigate); window.addEventListener("popstate", navigate);
    return () => { window.removeEventListener("hashchange", navigate); window.removeEventListener("popstate", navigate); };
  }, []);
  const streams = data?.streams ?? [];
  const selected = streams.find((s) => s.id === route.laneId) ?? null;
  const libraryAsDrawer = phone || !!selected || comparison;
  const openParticipant = (id: string | null, frame: number | null = null) => {
    pushHash(formatHash(id, frame)); setRoute(parseHash(window.location.hash)); setComparison(false); setSavedMessage("");
  };
  const toGrid = () => openParticipant(null);
  const toggleLibrary = () => {
    if (libraryAsDrawer) { setDrawerOpen((v) => !v); return; }
    setSideOpen((v) => { try { window.localStorage.setItem("humanish-sidebar", v ? "closed" : "open"); } catch { /* session preference still works */ } return !v; });
  };
  const stepParticipant = (delta: number) => {
    if (!streams.length) return;
    const index = selected ? streams.findIndex((s) => s.id === selected.id) : 0;
    const next = streams[(index + delta + streams.length) % streams.length];
    if (next) openParticipant(next.id);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input,select,textarea,[contenteditable=true],[role=dialog],[role=menu]")) return;
      if (event.key === "Escape" && !document.fullscreenElement) {
        if (monitoring) setMonitoring(false);
        else if (selected || comparison) { pushHash(""); setRoute(parseHash("")); setComparison(false); }
      }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [selected, comparison, monitoring]);
  const model = useMemo(() => selected ? buildPlayerModel(selected) ?? ((isActiveStream(selected) && ["browser", "ui", "codex-ui"].includes(selected.kind)) || (isServedOrigin(window.location.protocol) && liveEmbedUrl(selected) !== null) ? { frames: [], rows: [], avgFrameMs: 1500, paced: "avg" as const } : null) : null, [selected]);
  const viewChanged = useCallback((view: PlayerView) => { if (selected) setPlayerView({ ...view, streamId: selected.id }); }, [selected?.id]);
  if (!data) return <EmptyState />;
  const labels = participantLabels(streams);
  const visible = streams.filter((s) => {
    if (filters.status === "__active" ? !isActiveStream(s) : filters.status && s.statusLabel !== filters.status) return false;
    if (filters.kind && s.kindLabel !== filters.kind) return false;
    return `${labels.get(s.id)} ${s.label} ${s.id} ${s.laneId ?? ""} ${s.sim.personaId}`.toLowerCase().replace(/[-_]+/g, " ").includes(filters.query.toLowerCase().replace(/[-_]+/g, " "));
  });
  const togglePin = (id: string) => setPinnedByRun(pinnedByRun.includes(id) ? pinnedByRun.filter((v) => v !== id) : [...pinnedByRun.slice(-49), id]);
  const toggleCompare = (id: string) => setCompareIds((old) => old.includes(id) ? old.filter((v) => v !== id) : old.length < 3 ? [...old, id] : old);
  const openComparison = () => {
    const ids = compareIds.filter((id) => streams.some((s) => s.id === id));
    if (!ids.length) return;
    const previousIds = new URLSearchParams(comparisonLocation.current.split("?")[1]).getAll("lane");
    const unchanged = previousIds.length === ids.length && ids.every((id) => previousIds.includes(id));
    const q = new URLSearchParams(); ids.forEach((id) => q.append("lane", id));
    pushHash(unchanged ? comparisonLocation.current : `#/compare?${q}`);
    setComparison(true); setRoute(parseHash(""));
  };
  const saveMoment = () => {
    const current = playerView;
    if (!selected || !model || !current || current.streamId !== selected.id || current.frame === null || current.mode === "live") { setSavedMessage("Pause on a recorded frame before saving a moment."); return; }
    const frame = model.frames[current.frame];
    if (!frame) { setSavedMessage("That frame is no longer available."); return; }
    const moment: SavedMoment = { runId: data.run.runId, streamId: selected.id, itemId: frame.itemId, frame: frame.index, savedAt: new Date().toISOString() };
    setSavedMoments([...savedMoments.filter((m) => !(m.runId === moment.runId && m.streamId === moment.streamId && m.itemId === moment.itemId)).slice(-49), moment]); setSavedMessage("Moment saved.");
  };
  const openMoment = (moment: SavedMoment) => {
    const stream = streams.find((s) => s.id === moment.streamId);
    const frame = stream ? buildPlayerModel(stream)?.frames.find((f) => f.itemId === moment.itemId) : null;
    if (!frame) { setSavedMessage("This saved frame is no longer in the available recording."); return false; }
    openParticipant(moment.streamId, frame.index);
    return true;
  };
  const currentMoments = savedMoments.filter((m) => m.runId === data.run.runId);
  const savedControl = <SavedMoments labels={labels} moments={currentMoments} canSave={!!selected && playerView?.streamId === selected.id && playerView.mode === "replay" && playerView.frame !== null} stored={momentsStored} message={savedMessage} onSave={saveMoment} onOpen={openMoment}
          onRemove={(moment) => setSavedMoments(savedMoments.filter((m) => !(m.runId === moment.runId && m.streamId === moment.streamId && m.itemId === moment.itemId)))} />;
  return <Tooltip.Provider delay={350}><div className={`frame${monitoring ? " monitoring" : ""}`}>
    <a className="skip-observer" href="#observer-content" onClick={(event) => { event.preventDefault(); document.getElementById("observer-content")?.focus(); }}>Skip to evidence</a>
    <IconRail runsActive={!selected && !comparison && filters.status !== "__active"} liveActive={!selected && !comparison && filters.status === "__active"} onRuns={() => { setFilters(NO_FILTERS); toGrid(); }} onLive={() => { setFilters({ ...NO_FILTERS, status: "__active" }); toGrid(); }} />
    {!selected && !comparison && sideOpen && !monitoring ? <Sidebar data={data} history={history} onRuns={toGrid} /> : null}
    <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} label="Run library"><Sidebar data={data} history={history} onRuns={() => { toGrid(); setDrawerOpen(false); }} /></Drawer>
    <div className="main">
      <Topbar data={data} selected={selected} comparison={comparison} filters={filters} onFilters={setFilters} onRuns={toGrid} onStep={stepParticipant} onLibrary={toggleLibrary} sideOpen={libraryAsDrawer ? drawerOpen : sideOpen} reviewControl={savedControl}
        gridControl={!selected && !comparison ? <label className="tool"><span className="o-label">Preview size</span><select aria-label="Preview size" value={density} onChange={(e) => { if (isDensity(e.target.value)) setDensity(e.target.value); }}><option value="compact">Compact</option><option value="comfortable">Comfortable</option><option value="large">Large</option></select></label> : null}
        {...(!selected && !comparison ? { onMonitor: () => setMonitoring(true) } : {})} />
      <RunStatus data={data} connection={connection} now={now} onRetry={retry} actions={<>
        {monitoring ? <button type="button" className="review-tool" onClick={() => setMonitoring(false)}>Exit monitor</button> : null}
        {selected && comparisonLocation.current ? <button type="button" className="review-tool" onClick={openComparison}>Back to comparison</button> : null}
        {!selected && !comparison && compareIds.length ? <span className="compare-selection"><button type="button" className="review-tool" onClick={openComparison}>Compare selected ({compareIds.length}/3)</button>{compareIds.length === 3 ? <span role="status">Comparison limit: 3 participants. Remove one to choose another.</span> : null}</span> : null}
      </>} />
      <main id="observer-content" tabIndex={-1} className={selected && model ? "content player-host" : "content"}>
        {comparison ? <Comparison data={data} streams={streams.filter((s) => compareIds.includes(s.id))} history={history} onBack={toGrid} onOpen={openParticipant} onLocationChange={rememberComparison} />
          : selected ? model ? <Player key={selected.id} data={data} stream={selected} model={model} initialFrame={route.frame} initialMode={route.mode ?? null} updating={connection.state !== "offline"} onViewChange={viewChanged} /> : <ParticipantStub key={selected.id} data={data} stream={selected} />
            : <StudyGrid data={data} streams={visible} onOpen={openParticipant} density={density} pinnedIds={pinnedByRun} compareIds={compareIds} onPin={togglePin} onCompare={toggleCompare} now={now} />}
      </main>
      <div className="statusbar"><span title={data.run.runId}>Study <b>{data.run.runId}</b></span><span className="links">{data.artifactLinks.map((link) => { const href = observerArtifactHref(link.href); return href ? <a key={link.href} href={href}>{link.label}</a> : null; })}</span></div>
    </div>
  </div></Tooltip.Provider>;
}
