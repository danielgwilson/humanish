import { useEffect, useMemo, useState } from "react";
// Import order sets the order of the component stylesheets in the built page.
import { ParticipantsView } from "./components/participants-view";
import { EmptyState } from "./components/empty-state";
import { RunStatus } from "./components/run-status";
import { SavedMoments } from "./components/saved-moments";
import { ObserverShell } from "./components/observer-shell";
import type { StudyLibrary } from "./components/sidebar";
import { FindingsView } from "./components/findings-view";
import type { StudyReport as ReportData } from "./lib/study-report";
import "./styles/study-report.css";
import { StudyPlayback } from "./components/study-playback";
import "./styles/study-playback.css";
import { StudyNotices } from "./components/study-notices";
import { StudyViewbar } from "./components/study-viewbar";
import { isActiveStream, isServedOrigin } from "./lib/live";
import type { ObserverData, ObserverStream } from "./lib/observer-data";
import { participantLabels } from "./lib/participant-label";
import { projectStudyAnalysis, type LoadedAnalysis } from "./lib/study-analysis";
import { useObserverFeed } from "./lib/use-observer-feed";
import { automaticAnalysisNotice } from "./lib/automatic-analysis";
import {
  useStudyPlayback,
  type StudyPlayback as StudyPlaybackState,
} from "./lib/use-study-playback";
import type { RunNotesState } from "./lib/run-notes";
import { useRunNotes } from "./lib/use-run-notes";
import { useAutoplay } from "./lib/autoplay";
import { useGridPreferences } from "./lib/use-grid-preferences";
import { useLibraryLayout } from "./lib/use-library-layout";
import { useObserverNavigation } from "./lib/use-observer-navigation";
import { useParticipantPlayer } from "./lib/use-participant-player";
import { useSavedMoments } from "./lib/use-saved-moments";

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
  const runId = data?.run.runId ?? "";
  const grid = useGridPreferences(initialData?.run.runId, runId);
  const [now, setNow] = useState(Date.now);
  const automaticNotice = analysis.automatic
    ? automaticAnalysisNotice(analysis.automatic, snapshot, now)
    : undefined;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // The viewport and explicit preference own the shell, never the selected view.
  const layout = useLibraryLayout(snapshot, library?.entries.length ?? 0);
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
  const { selected, comparison, monitoring } = navigation;
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
  const reportActive = navigation.findingId !== null;
  if (!data) return <EmptyState />;
  const labels = participantLabels(streams);
  return (
    <ObserverShell
      layout={layout}
      data={data}
      history={history}
      library={library}
      updating={updating}
      monitoring={monitoring}
      onRuns={navigation.toGrid}
      onSkip={() => navigation.content.ref.current?.focus()}
      reviewControl={<SavedMoments labels={labels} {...savedMoments.control} />}
      status={<RunStatus data={data} connection={connection} now={now} onRetry={retry} compact />}
    >
      <StudyViewbar
        data={data}
        navigation={navigation}
        report={report}
        hasFindings={hasFindingsView}
        automaticNotice={automaticNotice}
        noteCount={runNotes.notes.length}
      />
      <StudyNotices
        data={data}
        connection={connection}
        now={now}
        onRetry={retry}
        monitoring={monitoring}
        onExitMonitor={() => navigation.monitor(false)}
      />
      <main
        id="observer-content"
        tabIndex={-1}
        className={selected && model ? "content player-host" : "content"}
        {...navigation.content}
      >
        {reportActive ? (
          <FindingsView
            data={data}
            report={report}
            automatic={analysis.automatic}
            snapshot={snapshot}
            now={now}
            navigation={navigation}
            notes={runNotes}
            labels={labels}
            playback={studyPlayback}
          />
        ) : (
          <ParticipantsView
            data={data}
            labels={labels}
            navigation={navigation}
            player={player}
            playback={studyPlayback}
            onViewChange={savedMoments.onViewChange}
            serverStopped={connection.serverStopped === true}
            updating={updating}
            history={history}
            report={report}
            analysisSpend={analysis.spend}
            grid={grid}
            now={now}
          />
        )}
      </main>
      {!reportActive && !comparison && (!selected || player.shared) ? (
        <StudyTimeline
          playback={studyPlayback}
          notes={runNotes}
          selected={selected}
          labels={labels}
          updating={updating}
          streams={streams}
        />
      ) : null}
    </ObserverShell>
  );
}

/**
 * The study playback bar under the grid or a participant who follows the study clock. It follows
 * the latest capture only on a served page whose feed updates while a participant is active. A
 * note added there belongs to the open participant, or to the whole study.
 */
function StudyTimeline({
  playback,
  notes,
  selected,
  labels,
  updating,
  streams,
}: {
  playback: StudyPlaybackState;
  notes: ReturnType<typeof useRunNotes>;
  selected: ObserverStream | null;
  labels: Map<string, string>;
  /** The feed still receives updates. */
  updating: boolean;
  streams: ObserverStream[];
}) {
  return (
    <StudyPlayback
      recording={playback.recording}
      atMs={playback.atMs}
      reviewing={playback.reviewing}
      playing={playback.playing}
      speed={playback.speed}
      canFollow={
        updating && isServedOrigin(window.location.protocol) && streams.some(isActiveStream)
      }
      onToggle={playback.toggle}
      onSeek={playback.seek}
      onSpeed={playback.setSpeed}
      onLatest={playback.latest}
      notes={notes.notes}
      noteParticipant={selected ? (labels.get(selected.id) ?? selected.id) : null}
      {...(notes.save
        ? {
            onAddNote: (atMs: number, text: string) =>
              notes.save!({ atMs, participant: selected?.id ?? null, text }),
          }
        : {})}
    />
  );
}
