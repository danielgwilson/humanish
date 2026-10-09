import { Tooltip } from "@base-ui/react/tooltip";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Comparison } from "./components/comparison";
import { EmptyState } from "./components/empty-state";
import { ParticipantStub } from "./components/participant-stub";
import { Player } from "./components/player";
import { RecordingReturn } from "./components/recording-return";
import { RunStatus } from "./components/run-status";
import { ServerStoppedNotice } from "./components/server-stopped";
import { SavedMoments } from "./components/saved-moments";
import { Sidebar, type StudyLibrary } from "./components/sidebar";
import { Drawer } from "./components/ui/drawer";
import { StudyReport } from "./components/study-report";
import { ReviewerNotes } from "./components/reviewer-notes";
import type { StudyReport as ReportData } from "./lib/study-report";
import "./styles/study-report.css";
import { StudyGrid } from "./components/study-grid";
import { StudyPlayback } from "./components/study-playback";
import "./styles/study-playback.css";
import { ParticipantPager, Topbar } from "./components/topbar";
import { GridOptions, type GridFilters } from "./components/grid-options";
import { ShareStatus } from "./components/study-details";
import { isActiveStream, isServedOrigin } from "./lib/live";
import type { ObserverData } from "./lib/observer-data";
import { participantLabels } from "./lib/participant-label";
import { isDensity, isStringList, usePreference } from "./lib/preferences";
import { projectStudyAnalysis, type LoadedAnalysis } from "./lib/study-analysis";
import { useObserverFeed } from "./lib/use-observer-feed";
import { automaticAnalysisNotice } from "./lib/automatic-analysis";
import { useStudyPlayback } from "./lib/use-study-playback";
import type { RunNote, RunNotesState } from "./lib/run-notes";
import { useRunNotes } from "./lib/use-run-notes";
import { sidebarClosedByUrl, useAutoplay } from "./lib/autoplay";
import { useObserverNavigation } from "./lib/use-observer-navigation";
import { useParticipantPlayer } from "./lib/use-participant-player";
import { useSavedMoments } from "./lib/use-saved-moments";

const NO_FILTERS: GridFilters = { status: "", kind: "", query: "" };
const isFilters = (v: unknown): v is GridFilters =>
  !!v &&
  typeof v === "object" &&
  ["status", "kind", "query"].every(
    (k) =>
      typeof (v as Record<string, unknown>)[k] === "string" &&
      ((v as Record<string, string>)[k]?.length ?? 0) < 256,
  );

export function App({
  data: initialData,
  snapshot = false,
  report: suppliedReport,
  library,
  analysis: initialAnalysis,
  notes: initialNotes,
}: {
  data: ObserverData | null;
  snapshot?: boolean;
  report?: ReportData;
  library?: StudyLibrary;
  analysis?: LoadedAnalysis;
  /** The run-notes slot: reviewer notes, and the token for adding one. */
  notes?: RunNotesState;
}) {
  const { data, history, connection, retry, analysis } = useObserverFeed(
    initialData,
    snapshot,
    initialAnalysis,
  );
  const runNotes = useRunNotes(initialNotes, data?.run.runId, snapshot);
  const report = useMemo(
    () => suppliedReport ?? (data ? projectStudyAnalysis(analysis, data) : undefined),
    [suppliedReport, analysis, data],
  );
  const hasFindingsView =
    !!report || !!analysis.automatic || runNotes.notes.length > 0 || runNotes.unreadable;
  const [density, setDensity] = usePreference("density", "comfortable", isDensity);
  const [filters, setFilters] = usePreference("filters", NO_FILTERS, isFilters);
  const [pinnedByRun, setPinnedByRun] = usePreference(
    `pins-${initialData?.run.runId ?? "empty"}`,
    [] as string[],
    isStringList,
  );
  const [gridPage, setGridPage] = useState({ runId: data?.run.runId ?? "", page: 0 });
  const [now, setNow] = useState(Date.now);
  const automaticNotice = analysis.automatic
    ? automaticAnalysisNotice(analysis.automatic, snapshot, now)
    : undefined;
  const [sideOpen, setSideOpen] = useState(() => {
    if (sidebarClosedByUrl(window.location.search)) return false;
    try {
      const saved = window.localStorage.getItem("humanish-sidebar");
      return (
        saved === "open" ||
        (saved !== "closed" && (!snapshot || (library?.entries.length ?? 0) > 1))
      );
    } catch {
      return true;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [phone, setPhone] = useState(
    () =>
      typeof window.matchMedia === "function" && window.matchMedia("(max-width: 880px)").matches,
  );
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const media = window.matchMedia?.("(max-width: 880px)");
    const resize = () => {
      setPhone(media?.matches ?? false);
      if (!media?.matches) setDrawerOpen(false);
    };
    media?.addEventListener("change", resize);
    resize(); // Reconcile a resize between the initial render and subscription.
    return () => {
      clearInterval(timer);
      media?.removeEventListener("change", resize);
    };
  }, []);
  const runId = data?.run.runId ?? "";
  const streams = data?.streams ?? [];
  const updating = connection.state !== "offline";
  const studyPlayback = useStudyPlayback(runId, streams);
  useAutoplay(studyPlayback);
  const navigation = useObserverNavigation({
    data,
    report,
    findingsAvailable: hasFindingsView,
    reviewing: studyPlayback.reviewing,
  });
  const { selected, route, source, comparison, compareIds, monitoring } = navigation;
  const player = useParticipantPlayer(runId, navigation, studyPlayback, updating);
  const { model } = player;
  const savedMoments = useSavedMoments({
    runId,
    streams,
    selected,
    model,
    open: (streamId, frame, eventId) => navigation.openParticipant(streamId, { frame, eventId }),
    revision: navigation.revision,
  });
  // The viewport and explicit preference own the shell, never the selected view.
  const libraryAsDrawer = phone;
  const reportActive = navigation.findingId !== null;
  const findingsView =
    reportActive ||
    (!!selected &&
      !!report &&
      (source.kind === "finding" || source.kind === "concerns" || source.kind === "design"));
  /** Seeks the study timeline to a note and shows its participant, or every participant. */
  const openNote = (note: RunNote) => {
    const start = studyPlayback.recording.startMs;
    if (start !== null) studyPlayback.seek(start + note.atMs);
    if (note.participant !== null && streams.some((stream) => stream.id === note.participant))
      navigation.openParticipant(note.participant, { replay: true, keepClock: true });
    else navigation.toGrid();
  };
  const followLink = (event: MouseEvent<HTMLAnchorElement>, navigate: () => void) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    navigate();
  };
  const toggleLibrary = () => {
    if (libraryAsDrawer) {
      setDrawerOpen((v) => !v);
      return;
    }
    setSideOpen((v) => {
      try {
        window.localStorage.setItem("humanish-sidebar", v ? "closed" : "open");
      } catch {
        /* session preference still works */
      }
      return !v;
    });
  };
  if (!data) return <EmptyState />;
  const selectedReview = report?.outcomes.find((outcome) => outcome.streamId === selected?.id);
  const selectedAnalysis = report?.participants?.find(
    (participant) => participant.streamId === selected?.id,
  );
  const labels = participantLabels(streams);
  const visible = streams.filter((s) => {
    if (
      filters.status === "__active"
        ? !isActiveStream(s)
        : filters.status && s.statusLabel !== filters.status
    )
      return false;
    if (filters.kind && s.kindLabel !== filters.kind) return false;
    return `${labels.get(s.id)} ${s.label} ${s.id} ${s.laneId ?? ""} ${s.sim.personaId}`
      .toLowerCase()
      .replace(/[-_]+/g, " ")
      .includes(filters.query.toLowerCase().replace(/[-_]+/g, " "));
  });
  const togglePin = (id: string) =>
    setPinnedByRun(
      pinnedByRun.includes(id)
        ? pinnedByRun.filter((v) => v !== id)
        : [...pinnedByRun.slice(-49), id],
    );
  const recordingNavigation = selected ? (
    <>
      <RecordingReturn
        source={source}
        findings={report?.findings}
        onReturn={navigation.returnToSource}
      />
      <ParticipantPager data={data} selected={selected} onStep={navigation.step} />
    </>
  ) : null;
  const outcomeContext = selectedReview ? (
    <span className="report-outcome-context">
      Analyzed outcome: <strong>{selectedReview.label}</strong>
    </span>
  ) : null;
  const participantContent = (
    <>
      {selected || comparison ? (
        <h2 className="sr-only">
          {selected ? `${labels.get(selected.id)} recording` : "Compare participants"}
        </h2>
      ) : null}
      {/* The player shows this navigation in its heading line, above the frame. */}
      {(selected && !model) || (!selected && !comparison && compareIds.length > 0) ? (
        <div className="study-context-actions">
          {recordingNavigation}
          {selected ? outcomeContext : null}
          {!selected && !comparison && compareIds.length ? (
            <span className="compare-selection">
              <button type="button" className="review-tool" onClick={navigation.openComparison}>
                Compare selected ({compareIds.length}/3)
              </button>
              {compareIds.length === 3 ? (
                <span role="status">
                  Comparison limit: 3 participants. Remove one to choose another.
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
      {comparison ? (
        <Comparison
          serverStopped={connection.serverStopped === true}
          data={data}
          streams={streams.filter((s) => compareIds.includes(s.id))}
          history={history}
          onBack={navigation.toGrid}
          onOpen={(id, frame) =>
            navigation.openParticipant(id, { frame, from: { kind: "comparison" } })
          }
          onLocationChange={navigation.rememberComparison}
        />
      ) : selected ? (
        model ? (
          <Player
            key={selected.id}
            recordedActorStatus={selectedReview ? selected.actor?.status : undefined}
            analysisReview={selectedAnalysis}
            data={data}
            stream={selected}
            model={model}
            initialFrame={route.frame}
            initialMode={route.mode ?? null}
            initialEventId={route.eventId ?? null}
            navigation={recordingNavigation}
            outcome={outcomeContext}
            navigationRevision={navigation.revision}
            updating={connection.state !== "offline"}
            onViewChange={savedMoments.onViewChange}
            {...(player.control ? { studyPlayback: player.control } : {})}
          />
        ) : (
          <ParticipantStub
            key={selected.id}
            data={data}
            stream={selected}
            analysisReview={selectedAnalysis}
            selectedEventId={route.eventId}
            updating={connection.state !== "offline"}
          />
        )
      ) : (
        <StudyGrid
          key={data.run.runId}
          serverStopped={connection.serverStopped === true}
          recording={studyPlayback.recording}
          atMs={studyPlayback.atMs}
          reviewing={studyPlayback.reviewing}
          page={gridPage.runId === data.run.runId ? gridPage.page : 0}
          onPageChange={(page) => setGridPage({ runId: data.run.runId, page })}
          tools={
            <GridOptions
              data={data}
              filters={filters}
              onFilters={setFilters}
              density={density}
              onDensity={setDensity}
              onMonitor={() => navigation.monitor(true)}
            />
          }
          data={data}
          reviewOutcomes={report?.outcomes.length ? report.outcomes : undefined}
          analysisSpend={analysis.spend}
          streams={visible}
          onOpen={(id) =>
            navigation.openParticipant(id, { replay: studyPlayback.reviewing, keepClock: true })
          }
          density={density}
          pinnedIds={pinnedByRun}
          compareIds={compareIds}
          onPin={togglePin}
          onCompare={navigation.toggleCompare}
          now={now}
          updating={connection.state !== "offline"}
        />
      )}
    </>
  );
  const needsAttention =
    connection.state === "retrying" ||
    data.runtime?.state === "unknown" ||
    data.runtime?.state === "interrupted";
  const studyLabel = library?.entries.find((entry) => entry.runId === data.run.runId)?.title;
  return (
    <Tooltip.Provider delay={350}>
      <div className={`observer-shell${monitoring ? " monitoring" : ""}`}>
        <a
          className="skip-observer"
          href="#observer-content"
          onClick={(event) => {
            event.preventDefault();
            navigation.content.ref.current?.focus();
          }}
        >
          Skip to evidence
        </a>
        <Topbar
          data={data}
          onLibrary={toggleLibrary}
          sideOpen={libraryAsDrawer ? drawerOpen : sideOpen}
          reviewControl={<SavedMoments labels={labels} {...savedMoments.control} />}
          {...(studyLabel ? { studyLabel } : {})}
          status={
            <RunStatus data={data} connection={connection} now={now} onRetry={retry} compact />
          }
        />
        <div className="frame">
          {!phone && !monitoring ? (
            <Sidebar
              collapsed={!sideOpen}
              data={data}
              history={history}
              onRuns={navigation.toGrid}
              updating={connection.state !== "offline"}
              {...(library ? { library } : {})}
            />
          ) : null}
          <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} label="Study library">
            <Sidebar
              data={data}
              history={history}
              onRuns={() => {
                navigation.toGrid();
                setDrawerOpen(false);
              }}
              updating={connection.state !== "offline"}
              {...(library
                ? {
                    library: {
                      ...library,
                      onSelect: (id: string) => {
                        library.onSelect(id);
                        setDrawerOpen(false);
                      },
                    },
                  }
                : {})}
            />
          </Drawer>
          <div className="main">
            <section className="study-viewbar" aria-label="Study navigation">
              <nav className="study-views" aria-label="Study views">
                <a
                  href="#"
                  aria-label="All participants"
                  aria-current={!findingsView ? "page" : undefined}
                  onClick={(event) => followLink(event, navigation.toGrid)}
                >
                  Participants <span>{streams.length}</span>
                </a>
                {hasFindingsView ? (
                  <a
                    href="#/report"
                    aria-current={findingsView ? "page" : undefined}
                    onClick={(event) => followLink(event, () => navigation.openReport())}
                  >
                    Findings{" "}
                    <span aria-label={!report ? automaticNotice?.message : undefined}>
                      {report ? report.findings.length : automaticNotice?.pending ? "…" : "—"}
                    </span>
                    {runNotes.notes.length ? (
                      <span className="viewbar-notes">
                        {runNotes.notes.length} {runNotes.notes.length === 1 ? "note" : "notes"}
                      </span>
                    ) : null}
                  </a>
                ) : null}
              </nav>
              <ShareStatus data={data} />
            </section>
            {connection.serverStopped ? (
              <ServerStoppedNotice data={data} connection={connection} now={now} onRetry={retry} />
            ) : null}
            {(needsAttention && !connection.serverStopped) || monitoring ? (
              <RunStatus
                data={data}
                connection={connection}
                now={now}
                onRetry={retry}
                actions={
                  monitoring ? (
                    <button
                      type="button"
                      className="review-tool"
                      onClick={() => navigation.monitor(false)}
                    >
                      Exit monitor
                    </button>
                  ) : null
                }
              />
            ) : null}
            <main
              id="observer-content"
              tabIndex={-1}
              className={selected && model ? "content player-host" : "content"}
              {...navigation.content}
            >
              {reportActive ? (
                <StudyReport
                  data={data}
                  report={report}
                  {...(analysis.automatic ? { automatic: analysis.automatic } : {})}
                  snapshot={snapshot}
                  now={now}
                  findingId={navigation.findingId ?? ""}
                  onFinding={navigation.selectFinding}
                  concernsOpen={navigation.concernsOpen}
                  onConcernsOpen={navigation.setConcernsOpen}
                  onOpen={(id, frame, eventId, findingId) =>
                    navigation.openParticipant(id, {
                      frame,
                      eventId,
                      from: findingId ? { kind: "finding", findingId } : { kind: "concerns" },
                    })
                  }
                  onOpenDesign={(id, frame, eventId) =>
                    navigation.openParticipant(id, { frame, eventId, from: { kind: "design" } })
                  }
                />
              ) : (
                participantContent
              )}
              {reportActive &&
              (runNotes.notes.length > 0 || runNotes.save || runNotes.unreadable) ? (
                <ReviewerNotes
                  notes={runNotes.notes}
                  labels={labels}
                  unreadable={runNotes.unreadable}
                  writable={!!runNotes.save}
                  onOpen={openNote}
                />
              ) : null}
            </main>
            {!reportActive && !comparison && (!selected || player.shared) ? (
              <StudyPlayback
                recording={studyPlayback.recording}
                atMs={studyPlayback.atMs}
                reviewing={studyPlayback.reviewing}
                playing={studyPlayback.playing}
                speed={studyPlayback.speed}
                canFollow={
                  connection.state !== "offline" &&
                  isServedOrigin(window.location.protocol) &&
                  streams.some(isActiveStream)
                }
                onToggle={studyPlayback.toggle}
                onSeek={studyPlayback.seek}
                onSpeed={studyPlayback.setSpeed}
                onLatest={studyPlayback.latest}
                notes={runNotes.notes}
                noteParticipant={selected ? (labels.get(selected.id) ?? selected.id) : null}
                {...(runNotes.save
                  ? {
                      onAddNote: (atMs: number, text: string) =>
                        runNotes.save!({ atMs, participant: selected?.id ?? null, text }),
                    }
                  : {})}
              />
            ) : null}
          </div>
        </div>
      </div>
    </Tooltip.Provider>
  );
}
