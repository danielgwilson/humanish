import { Tooltip } from "@base-ui-components/react/tooltip";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Comparison } from "./components/comparison";
import { EmptyState } from "./components/empty-state";
import { ParticipantStub } from "./components/participant-stub";
import { Player } from "./components/player";
import { RunStatus } from "./components/run-status";
import { SavedMoments } from "./components/saved-moments";
import { Sidebar, type StudyLibrary } from "./components/sidebar";
import { Drawer } from "./components/ui/drawer";
import { StudyReport } from "./components/study-report";
import { reportFindingId, reportHash, resolveReportMoment, type StudyReport as ReportData } from "./lib/study-report";
import "./styles/study-report.css";
import { StudyGrid } from "./components/study-grid";
import { StudyPlayback } from "./components/study-playback";
import "./styles/study-playback.css";
import { ParticipantPager, Topbar } from "./components/topbar";
import { GridOptions, type GridFilters } from "./components/grid-options";
import { ShareStatus } from "./components/study-details";
import { recordingSource, recordingState, type RecordingSource } from "./lib/recording-source";
import { isActiveStream, isServedOrigin, liveEmbedUrl } from "./lib/live";
import type { ObserverData } from "./lib/observer-data";
import type { PlayerView } from "./lib/player-state";
import { buildPlayerModel } from "./lib/player-model";
import { participantLabels } from "./lib/participant-label";
import { isDensity, isMoments, isStringList, usePreference, type SavedMoment } from "./lib/preferences";
import { formatHash, parseHash, pushHash } from "./lib/route";
import { savedEntryLabels } from "./lib/saved-entry-labels";
import { projectStudyAnalysis, type LoadedStudyAnalysis } from "./lib/study-analysis";
import { useObserverFeed } from "./lib/use-observer-feed";
import { automaticAnalysisNotice } from "./lib/automatic-analysis";
import { useStudyPlayback } from "./lib/use-study-playback";

const NO_FILTERS: GridFilters = { status: "", kind: "", query: "" };
const isFilters = (v: unknown): v is GridFilters => !!v && typeof v === "object" && ["status", "kind", "query"].every((k) => typeof (v as Record<string, unknown>)[k] === "string" && ((v as Record<string, string>)[k]?.length ?? 0) < 256);
const compareRoute = () => window.location.hash.startsWith("#/compare");
const routeCompareIds = () => new URLSearchParams(window.location.hash.split("?")[1]).getAll("lane").slice(0, 3);

export function App({ data: initialData, snapshot = false, report: suppliedReport, library, analysis: initialAnalysis }: { data: ObserverData | null; snapshot?: boolean; report?: ReportData; library?: StudyLibrary; analysis?: LoadedStudyAnalysis }) {
  const { data, history, connection, retry, analysis } = useObserverFeed(initialData, snapshot, initialAnalysis);
  const currentRunId = useRef(data?.run.runId ?? ""); currentRunId.current = data?.run.runId ?? "";
  const report = useMemo(() => suppliedReport ?? (data ? projectStudyAnalysis(analysis, data) : undefined), [suppliedReport, analysis, data]);
  const hasFindingsView = !!report || !!analysis.automatic;
  const [reportRoute, setReportRoute] = useState(() => reportFindingId(window.location.hash));
  const [concernsOpen, setConcernsOpen] = useState(false);
  const reportIds = useRef<string[]>([]); reportIds.current = report?.findings.map((finding) => finding.id) ?? [];
  const hasConcerns = useRef(false); hasConcerns.current = report?.concernReviews !== undefined;
  const readSource = () => recordingSource(window.history.state, currentRunId.current, reportIds.current, hasConcerns.current);
  const [source, setSource] = useState<RecordingSource>(readSource);
  const reportActive = hasFindingsView && reportRoute !== null;
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  const [navigationRevision, setNavigationRevision] = useState(0);
  const [preservePlayback, setPreservePlayback] = useState(false);
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
  const [gridPage, setGridPage] = useState({ runId: data?.run.runId ?? "", page: 0 });
  const [monitoring, setMonitoring] = useState(false);
  const [now, setNow] = useState(Date.now);
  const automaticNotice = analysis.automatic ? automaticAnalysisNotice(analysis.automatic, snapshot, now) : undefined;
  const [sideOpen, setSideOpen] = useState(() => { try { const saved = window.localStorage.getItem("humanish-sidebar"); return saved === "open" || (saved !== "closed" && (!snapshot || (library?.entries.length ?? 0) > 1)); } catch { return true; } });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [phone, setPhone] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 880px)").matches);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const media = window.matchMedia?.("(max-width: 880px)");
    const resize = () => { setPhone(media?.matches ?? false); if (!media?.matches) setDrawerOpen(false); };
    media?.addEventListener("change", resize);
    resize(); // Reconcile a resize between the initial render and subscription.
    return () => { clearInterval(timer); media?.removeEventListener("change", resize); };
  }, []);
  useEffect(() => {
    const navigate = () => {
      const finding = reportFindingId(window.location.hash);
      setReportRoute(finding); setSource(readSource()); setRoute(parseHash(window.location.hash)); setComparison(compareRoute());
      if (compareRoute()) setCompareIds(routeCompareIds());
      // Internal participant history changes the view of the running clock. A
      // copied/reloaded or externally changed evidence address is a fresh seek.
      setPreservePlayback(window.history.state?.humanishStudyNavigation === currentRunId.current);
      setNavigationRevision((value) => value + 1);
    };
    window.addEventListener("hashchange", navigate); window.addEventListener("popstate", navigate);
    return () => { window.removeEventListener("hashchange", navigate); window.removeEventListener("popstate", navigate); };
  }, []);
  const streams = data?.streams ?? [];
  const studyPlayback = useStudyPlayback(data?.run.runId ?? "", streams);
  const entryLabels = useMemo(() => savedEntryLabels(streams), [streams]);
  const selected = streams.find((s) => s.id === route.laneId) ?? null;
  // The viewport and explicit preference own the shell, never the selected view.
  const libraryAsDrawer = phone;
  const findingsView = reportActive || (!!selected && !!report && (source.kind === "finding" || source.kind === "concerns"));
  const contentRef = useRef<HTMLElement>(null);

  const scrollPositions = useRef(new Map<string, number>());
  const contentView = reportActive ? "findings" : comparison ? "comparison" : selected?.id ?? "grid";
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = scrollPositions.current.get(contentView) ?? 0;
  }, [contentView]);
  const focus = (find: () => HTMLElement | null | undefined) => {
    const afterPaint = window.requestAnimationFrame ?? ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
    afterPaint(() => find()?.focus({ preventScroll: true }));
  };
  const openParticipant = (id: string | null, frame: number | null = null, eventId?: string, origin: RecordingSource = { runId: data?.run.runId ?? "", kind: "participants" }, mode: "replay" | null = null, preserve = false) => {
    const navigationState = { ...(id ? recordingState(origin) : {}), ...(preserve ? { humanishStudyNavigation: data?.run.runId } : {}) };
    setReportRoute(null); pushHash(formatHash(id, frame, mode, eventId), navigationState); setSource(origin);
    setRoute(parseHash(window.location.hash)); setComparison(false); setSavedMessage("");
    setPreservePlayback(preserve);
    setNavigationRevision((value) => value + 1);
    if (id) focus(() => contentRef.current);
  };
  const toGrid = () => openParticipant(null, null, undefined, undefined, null, true);
  const openReport = (id = "") => { pushHash(reportHash(id)); setReportRoute(id); setRoute(parseHash("")); setComparison(false); setMonitoring(false); };
  const returnToSource = () => {
    if (source.kind === "finding") {
      openReport(source.findingId);
      focus(() => [...document.querySelectorAll<HTMLButtonElement>("[data-finding]")].find((button) => button.dataset.finding === source.findingId));
    } else if (source.kind === "concerns") {
      setConcernsOpen(true); openReport();
      focus(() => document.querySelector<HTMLElement>(".report-concerns > summary"));
    } else if (source.kind === "comparison") {
      pushHash(source.hash); setComparison(true); setCompareIds(routeCompareIds()); setRoute(parseHash(""));
      focus(() => contentRef.current);
    } else { toGrid(); focus(() => contentRef.current); }
  };
  const followLink = (event: MouseEvent<HTMLAnchorElement>, navigate: () => void) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate();
  };
  const toggleLibrary = () => {
    if (libraryAsDrawer) { setDrawerOpen((v) => !v); return; }
    setSideOpen((v) => { try { window.localStorage.setItem("humanish-sidebar", v ? "closed" : "open"); } catch { /* session preference still works */ } return !v; });
  };
  const stepParticipant = (delta: number) => {
    if (!streams.length) return;
    const index = selected ? streams.findIndex((s) => s.id === selected.id) : 0;
    const next = streams[(index + delta + streams.length) % streams.length];
    if (!next) return;
    const cited = source.kind === "finding" ? report?.findings.find((finding) => finding.id === source.findingId)?.moments.filter((moment) => moment.streamId === next.id) : undefined;
    const moment = data ? cited?.map((entry) => resolveReportMoment(data, next.id, entry.eventId)).find(Boolean) : undefined;
    openParticipant(next.id, moment?.frameIndex ?? null, moment?.eventId, source, studyPlayback.reviewing ? "replay" : null, source.kind === "participants");
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input,select,textarea,[contenteditable=true],[role=dialog],[role=menu]")) return;
      if (event.key === "Escape" && !document.fullscreenElement) {
        if (monitoring) setMonitoring(false);
        else if (selected) returnToSource();
        else if (comparison) toGrid();
      }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [selected, comparison, monitoring, source]);
  const model = useMemo(() => selected && !(route.eventId && route.frame === null) ? buildPlayerModel(selected) ?? ((isActiveStream(selected) && ["browser", "ui", "codex-ui"].includes(selected.kind)) || (isServedOrigin(window.location.protocol) && liveEmbedUrl(selected) !== null) ? { frames: [], rows: [], avgFrameMs: 1500, paced: "avg" as const } : null) : null, [selected, route.eventId, route.frame]);
  const selectedLane = selected ? studyPlayback.recording.lanes.get(selected.id) : undefined;
  const sharedPlayer = !!selected && !!model && source.kind === "participants" && (selectedLane?.times !== null || !selectedLane?.model);
  const appliedNavigation = useRef("");
  useLayoutEffect(() => {
    if (!data) return;
    const key = `${data.run.runId}:${navigationRevision}`;
    if (appliedNavigation.current === key) return;
    if (!selected) return;
    appliedNavigation.current = key;
    if (!sharedPlayer) return;
    if (preservePlayback && studyPlayback.reviewing) return;
    if (route.mode === "live" && connection.state !== "offline") studyPlayback.latest();
    else if (route.frame !== null) studyPlayback.selectFrame(selected.id, route.frame, route.eventId);
    else if (route.mode !== "replay" && connection.state !== "offline" && isActiveStream(selected)) studyPlayback.latest();
    else if (model?.frames.length) studyPlayback.selectFrame(selected.id, route.mode === "live" ? model.frames.length - 1 : 0, route.eventId);
    else studyPlayback.seek(studyPlayback.recording.startMs ?? Number.NaN);
  }, [data?.run.runId, navigationRevision, selected, sharedPlayer, preservePlayback, route, model, connection.state, studyPlayback]);
  useEffect(() => {
    if (reportActive || comparison || (selected && !sharedPlayer)) studyPlayback.pause();
  }, [reportActive, comparison, selected, sharedPlayer, studyPlayback.pause]);
  const previousUpdating = useRef(connection.state !== "offline");
  useEffect(() => {
    const updating = connection.state !== "offline";
    if (previousUpdating.current && !updating && selected && sharedPlayer && !studyPlayback.reviewing) {
      if (model?.frames.length) studyPlayback.selectFrame(selected.id, model.frames.length - 1);
      else studyPlayback.seek(studyPlayback.atMs ?? Number.NaN);
    }
    previousUpdating.current = updating;
  }, [connection.state, selected, sharedPlayer, model, studyPlayback]);
  const viewChanged = useCallback((view: PlayerView) => { if (selected) setPlayerView({ ...view, streamId: selected.id }); }, [selected?.id]);
  if (!data) return <EmptyState />;
  const selectedReview = report?.outcomes.find((outcome) => outcome.streamId === selected?.id);
  const selectedAnalysis = report?.participants?.find((participant) => participant.streamId === selected?.id);
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
    if (current.eventId && !model.rows.some((row) => row.id === current.eventId && !row.isFrame && row.frameIndex === current.frame)) {
      setSavedMessage("That recorded entry is no longer available."); return;
    }
    const moment: SavedMoment = { runId: data.run.runId, streamId: selected.id, itemId: frame.itemId, frame: frame.index, savedAt: new Date().toISOString(),
      ...(current.eventId ? { eventId: current.eventId } : {}) };
    setSavedMoments([...savedMoments.filter((m) => !(m.runId === moment.runId && m.streamId === moment.streamId && m.itemId === moment.itemId && m.eventId === moment.eventId)).slice(-49), moment]); setSavedMessage("Moment saved.");
  };
  const openMoment = (moment: SavedMoment) => {
    const stream = streams.find((s) => s.id === moment.streamId);
    const frame = stream ? buildPlayerModel(stream)?.frames.find((f) => f.itemId === moment.itemId) : null;
    if (!frame) { setSavedMessage("This saved frame is no longer in the available recording."); return false; }
    if (moment.eventId && !buildPlayerModel(stream!)?.rows.some((row) => row.id === moment.eventId && !row.isFrame && row.frameIndex === frame.index)) {
      setSavedMessage("This saved entry is no longer in its recorded capture interval."); return false;
    }
    openParticipant(moment.streamId, frame.index, moment.eventId);
    return true;
  };
  const currentMoments = savedMoments.filter((m) => m.runId === data.run.runId);
  const canSaveMoment = !!selected && playerView?.streamId === selected.id && playerView.mode === "replay" && playerView.frame !== null
    && (!playerView.eventId || !!model?.rows.some((row) => row.id === playerView.eventId && !row.isFrame && row.frameIndex === playerView.frame));
  const savedControl = <SavedMoments labels={labels} entryLabels={entryLabels} moments={currentMoments} canSave={canSaveMoment} stored={momentsStored} message={savedMessage} onSave={saveMoment} onOpen={openMoment}
          onRemove={(moment) => setSavedMoments(savedMoments.filter((m) => !(m.runId === moment.runId && m.streamId === moment.streamId && m.itemId === moment.itemId && m.eventId === moment.eventId)))} />;
  const participantContent = <>
    {selected || comparison ? <h2 className="sr-only">{selected ? `${labels.get(selected.id)} recording` : "Compare participants"}</h2> : null}
    {selected || (!comparison && compareIds.length > 0) ? <div className="study-context-actions">
      {selected ? <button className="recording-return" type="button" data-return-kind={source.kind} aria-label={source.kind === "finding" ? `Back to finding: ${report?.findings.find((finding) => finding.id === source.findingId)?.title ?? source.findingId}` : source.kind === "concerns" ? "Back to concerns considered" : source.kind === "comparison" ? "Back to comparison" : "Back to participants"} onClick={returnToSource}>← {source.kind === "finding" ? report?.findings.find((finding) => finding.id === source.findingId)?.title ?? "Back to finding" : source.kind === "concerns" ? "Back to concerns considered" : source.kind === "comparison" ? "Back to comparison" : "Back to participants"}</button> : null}
      {selected ? <ParticipantPager data={data} selected={selected} onStep={stepParticipant} /> : null}
      {selectedReview && selected ? <span className="report-outcome-context">Analyzed outcome: <strong>{selectedReview.label}</strong></span> : null}
      {!selected && !comparison && compareIds.length ? <span className="compare-selection"><button type="button" className="review-tool" onClick={openComparison}>Compare selected ({compareIds.length}/3)</button>{compareIds.length === 3 ? <span role="status">Comparison limit: 3 participants. Remove one to choose another.</span> : null}</span> : null}
    </div> : null}
    {comparison ? <Comparison data={data} streams={streams.filter((s) => compareIds.includes(s.id))} history={history} onBack={toGrid} onOpen={(id, frame) => openParticipant(id, frame, undefined, { runId: data.run.runId, kind: "comparison", hash: comparisonLocation.current || window.location.hash })} onLocationChange={rememberComparison} />
          : selected ? model ? <Player key={selected.id} recordedActorStatus={selectedReview ? selected.actor?.status : undefined} analysisReview={selectedAnalysis} data={data} stream={selected} model={model} initialFrame={route.frame} initialMode={route.mode ?? null} initialEventId={route.eventId ?? null} navigationRevision={navigationRevision} updating={connection.state !== "offline"} onViewChange={viewChanged} {...(sharedPlayer ? { studyPlayback: studyPlayback.playerControl(selected.id) } : {})} /> : <ParticipantStub key={selected.id} data={data} stream={selected} analysisReview={selectedAnalysis} selectedEventId={route.eventId} updating={connection.state !== "offline"} />
            : <StudyGrid key={data.run.runId} recording={studyPlayback.recording} atMs={studyPlayback.atMs} reviewing={studyPlayback.reviewing}
                page={gridPage.runId === data.run.runId ? gridPage.page : 0} onPageChange={(page) => setGridPage({ runId: data.run.runId, page })}
                tools={<GridOptions data={data} filters={filters} onFilters={setFilters} onMonitor={() => setMonitoring(true)}
                gridControl={<label className="tool"><span className="o-label">Preview size</span><select aria-label="Preview size" value={density} onChange={(e) => { if (isDensity(e.target.value)) setDensity(e.target.value); }}><option value="compact">Compact</option><option value="comfortable">Comfortable</option><option value="large">Large</option></select></label>} />} data={data} reviewOutcomes={report?.outcomes.length ? report.outcomes : undefined} streams={visible} onOpen={(id) => openParticipant(id, null, undefined, undefined, studyPlayback.reviewing ? "replay" : null, true)} density={density} pinnedIds={pinnedByRun} compareIds={compareIds} onPin={togglePin} onCompare={toggleCompare} now={now} updating={connection.state !== "offline"} />}
  </>;
  const needsAttention = connection.state === "retrying" || data.runtime?.state === "unknown" || data.runtime?.state === "interrupted";
  const studyLabel = library?.entries.find((entry) => entry.runId === data.run.runId)?.title;
  return <Tooltip.Provider delay={350}><div className={`observer-shell${monitoring ? " monitoring" : ""}`}>
    <a className="skip-observer" href="#observer-content" onClick={(event) => { event.preventDefault(); contentRef.current?.focus(); }}>Skip to evidence</a>
    <Topbar data={data} onLibrary={toggleLibrary} sideOpen={libraryAsDrawer ? drawerOpen : sideOpen} reviewControl={savedControl}
      {...(studyLabel ? { studyLabel } : {})} status={<RunStatus data={data} connection={connection} now={now} onRetry={retry} compact />} />
    <div className="frame">
      {!phone && sideOpen && !monitoring ? <Sidebar data={data} history={history} onRuns={toGrid} updating={connection.state !== "offline"} {...(library ? { library } : {})} /> : null}
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} label="Study library"><Sidebar data={data} history={history} onRuns={() => { toGrid(); setDrawerOpen(false); }} updating={connection.state !== "offline"} {...(library ? { library: { ...library, onSelect: (id: string) => { library.onSelect(id); setDrawerOpen(false); } } } : {})} /></Drawer>
      <div className="main">
        <section className="study-viewbar" aria-label="Study navigation">
          <nav className="study-views" aria-label="Study views">
            <a href="#" aria-label="All participants" aria-current={!findingsView ? "page" : undefined} onClick={(event) => followLink(event, toGrid)}>Participants <span>{streams.length}</span></a>
            {hasFindingsView ? <a href="#/report" aria-current={findingsView ? "page" : undefined} onClick={(event) => followLink(event, () => openReport())}>Findings <span aria-label={!report ? automaticNotice?.message : undefined}>{report ? report.findings.length : automaticNotice?.pending ? "…" : "—"}</span></a> : null}
          </nav>
          <ShareStatus data={data} />
        </section>
        {needsAttention || monitoring ? <RunStatus data={data} connection={connection} now={now} onRetry={retry} actions={monitoring ? <button type="button" className="review-tool" onClick={() => setMonitoring(false)}>Exit monitor</button> : null} /> : null}
        <main id="observer-content" ref={contentRef} tabIndex={-1} className={selected && model ? "content player-host" : "content"}
          onScroll={(event) => scrollPositions.current.set(contentView, event.currentTarget.scrollTop)}>
          {reportActive ? <StudyReport data={data} report={report} {...(analysis.automatic ? { automatic: analysis.automatic } : {})} snapshot={snapshot} now={now} findingId={reportRoute ?? ""} onFinding={id => {
            openReport(id);
            if (id) focus(() => {
              const target = [...document.querySelectorAll<HTMLButtonElement>("[data-finding]")].find(button => button.dataset.finding === id);
              target?.scrollIntoView({ block: "nearest" }); return target;
            });
          }} concernsOpen={concernsOpen} onConcernsOpen={setConcernsOpen}
            onOpen={(id, frame, eventId, findingId) => openParticipant(id, frame, eventId, findingId ? { runId: data.run.runId, kind: "finding", findingId } : { runId: data.run.runId, kind: "concerns" })} /> : participantContent}
        </main>
        {!reportActive && !comparison && (!selected || sharedPlayer) ? <StudyPlayback recording={studyPlayback.recording} atMs={studyPlayback.atMs}
          reviewing={studyPlayback.reviewing} playing={studyPlayback.playing} speed={studyPlayback.speed}
          canFollow={connection.state !== "offline" && isServedOrigin(window.location.protocol) && streams.some(isActiveStream)}
          onToggle={studyPlayback.toggle} onSeek={studyPlayback.seek} onSpeed={studyPlayback.setSpeed} onLatest={studyPlayback.latest} /> : null}
      </div>
    </div>
  </div></Tooltip.Provider>;
}
