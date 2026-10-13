import { filterParticipants } from "@/lib/grid-filters";
import type { HistoryIndex } from "@/lib/live";
import type { ObserverData } from "@/lib/observer-data";
import type { PlayerModel } from "@/lib/player-model";
import type { PlayerView } from "@/lib/player-state";
import type { StudyReport } from "@/lib/study-report";
import type { GridPreferences } from "@/lib/use-grid-preferences";
import type { ObserverNavigation } from "@/lib/use-observer-navigation";
import type { StudyPlayback, StudyPlayerControl } from "@/lib/use-study-playback";
import type { RunAnalysisCost } from "../../src/run/run-cost.js";
import { Comparison } from "./comparison";
import { GridOptions, GridStatusSummary } from "./grid-options";
import { ParticipantStub } from "./participant-stub";
import { Player } from "./player";
import { RecordingReturn } from "./recording-return";
import { StudyGrid } from "./study-grid";
import { ParticipantPager } from "./topbar";

type GridPlayback = Pick<StudyPlayback, "recording" | "atMs" | "reviewing">;

/**
 * The Participants view: the grid, one participant's recording (the player, or the stub when it
 * has no frames), or the comparison. A frame-free participant gets its way back, pager and
 * analyzed outcome on a line above the evidence; the player shows them in its own heading. On the
 * grid that line holds the compare selection.
 */
export function ParticipantsView({
  data,
  labels,
  navigation,
  player,
  playback,
  onViewChange,
  serverStopped,
  updating,
  history,
  report,
  analysisSpend,
  grid,
  now,
}: {
  data: ObserverData;
  labels: Map<string, string>;
  navigation: ObserverNavigation;
  player: { model: PlayerModel | null; control: StudyPlayerControl | undefined };
  playback: GridPlayback;
  onViewChange: (view: PlayerView) => void;
  serverStopped: boolean;
  updating: boolean;
  history: HistoryIndex | null;
  report: StudyReport | undefined;
  analysisSpend: RunAnalysisCost | undefined;
  grid: GridPreferences;
  now: number;
}) {
  const { selected, route, source, comparison, compareIds } = navigation;
  const { model } = player;
  const streams = data.streams;
  const selectedReview = report?.outcomes.find((outcome) => outcome.streamId === selected?.id);
  const selectedAnalysis = report?.participants?.find(
    (participant) => participant.streamId === selected?.id,
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
  return (
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
          serverStopped={serverStopped}
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
            updating={updating}
            onViewChange={onViewChange}
            {...(player.control ? { studyPlayback: player.control } : {})}
          />
        ) : (
          <ParticipantStub
            key={selected.id}
            data={data}
            stream={selected}
            analysisReview={selectedAnalysis}
            selectedEventId={route.eventId}
            updating={updating}
          />
        )
      ) : (
        <ParticipantGrid
          key={data.run.runId}
          data={data}
          labels={labels}
          navigation={navigation}
          playback={playback}
          serverStopped={serverStopped}
          updating={updating}
          report={report}
          analysisSpend={analysisSpend}
          grid={grid}
          now={now}
        />
      )}
    </>
  );
}

/** The grid with its status row and view options, in the order and page the reviewer chose. */
function ParticipantGrid({
  data,
  labels,
  navigation,
  playback,
  serverStopped,
  updating,
  report,
  analysisSpend,
  grid,
  now,
}: {
  data: ObserverData;
  labels: Map<string, string>;
  navigation: Pick<
    ObserverNavigation,
    "compareIds" | "openParticipant" | "toggleCompare" | "monitor"
  >;
  playback: GridPlayback;
  serverStopped: boolean;
  updating: boolean;
  report: StudyReport | undefined;
  analysisSpend: RunAnalysisCost | undefined;
  grid: GridPreferences;
  now: number;
}) {
  return (
    <StudyGrid
      serverStopped={serverStopped}
      recording={playback.recording}
      atMs={playback.atMs}
      reviewing={playback.reviewing}
      page={grid.page}
      onPageChange={grid.setPage}
      statusSummary={
        <GridStatusSummary data={data} filters={grid.filters} onFilters={grid.changeFilters} />
      }
      tools={
        <GridOptions
          data={data}
          filters={grid.filters}
          onFilters={grid.changeFilters}
          density={grid.density}
          onDensity={grid.setDensity}
          onMonitor={() => navigation.monitor(true)}
        />
      }
      data={data}
      reviewOutcomes={report?.outcomes.length ? report.outcomes : undefined}
      analysisSpend={analysisSpend}
      streams={filterParticipants(data.streams, grid.filters, labels)}
      onOpen={(id) =>
        navigation.openParticipant(id, { replay: playback.reviewing, keepClock: true })
      }
      density={grid.density}
      pinnedIds={grid.pinnedIds}
      compareIds={navigation.compareIds}
      onPin={grid.togglePin}
      onCompare={navigation.toggleCompare}
      now={now}
      updating={updating}
    />
  );
}
