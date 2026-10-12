import { useRef, useState, type ReactNode } from "react";

import type { ObserverData, ObserverStream } from "@/lib/observer-data";
import type { PlayerModel } from "@/lib/player-model";
import type { PlayerView } from "@/lib/player-state";
import type { StudyPlayerControl } from "@/lib/use-study-playback";
import { usePlayerPlayback, type PlayerPlayback } from "@/lib/use-player-playback";
import { usePlayerPreferences } from "@/lib/use-player-preferences";
import { formatHash } from "@/lib/route";
import { participantLabels } from "@/lib/participant-label";
import type { Zoom } from "./player-stage";
import { PlayerReviewTools, PlayerTransport } from "./player-controls";
import {
  PlayerEvidenceNote,
  PlayerScreen,
  SelectedEntry,
  useRecordingFallback,
} from "./player-evidence";
import { PlayerFilmstrip } from "./player-filmstrip";
import { PlayerInspector } from "./player-inspector";
import { formatRunTime } from "../../src/run/run-clock.js";
import type { ParticipantAnalysis as AnalysisReview } from "@/lib/study-report";
import "@/styles/player.css";

interface PlayerProps {
  /** Return and participant paging controls, shown at the start of the heading line. */
  navigation?: ReactNode;
  /** The analyzed outcome, shown after the recorded status. */
  outcome?: ReactNode;
  data: ObserverData;
  stream: ObserverStream;
  model: PlayerModel;
  initialFrame?: number | null;
  initialMode?: "live" | "replay" | null;
  initialEventId?: string | null;
  recordedActorStatus?: string | undefined;
  analysisReview?: AnalysisReview | undefined;
  /** Shared study clock owns playback; this view only projects its participant. */
  studyPlayback?: StudyPlayerControl | undefined;
  /** An explicit in-app navigation may repeat the original address after local seeking. */
  navigationRevision?: number;
  /** Source capability, not the most recent poll result; transient failures stay updating. */
  updating?: boolean;
  onViewChange?: (view: PlayerView) => void;
}

export function Player({
  data,
  stream,
  model,
  initialFrame = null,
  initialMode = null,
  initialEventId = null,
  navigationRevision = 0,
  updating = true,
  onViewChange,
  recordedActorStatus,
  analysisReview,
  studyPlayback,
  navigation,
  outcome,
}: PlayerProps) {
  const prefs = usePlayerPreferences();
  const { preferences } = prefs;
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [feedPage, setFeedPage] = useState<number | null>(null);
  const [streamRevision, setStreamRevision] = useState(0);
  const status = usePlayerNotice();
  const playback = usePlayerPlayback({
    stream,
    model,
    initialFrame,
    initialMode,
    initialEventId,
    navigationRevision,
    updating,
    studyPlayback,
    speed: preferences.speed,
    skipWaits: preferences.skipWaits,
    onViewChange,
    onNavigate: (reason) => {
      setFeedPage(null);
      if (reason === "seek") status.setNotice(null);
    },
  });
  const recording = useRecordingFallback(stream, studyPlayback);
  const viewerRef = useRef<HTMLDivElement>(null);
  const participantName = participantLabels(data.streams).get(stream.id) ?? stream.label;
  const fullscreen = () => void status.toggleFullscreen(viewerRef.current, playback.controlled);
  const copyMoment = () => {
    const { current, selectedRow } = playback;
    if (!current) return;
    // Deliberately copies a replay address, even while following the live desktop.
    void status.copyLink(
      `${window.location.href.split("#")[0] ?? ""}${formatHash(stream.id, current.index, null, selectedRow?.id)}`,
    );
  };
  return (
    <div
      className="player evidence-player"
      data-inspector={preferences.inspector ? "open" : "closed"}
    >
      <div className="viewer" ref={viewerRef}>
        <PlayerHeading
          navigation={navigation}
          outcome={outcome}
          name={participantName}
          status={statusLabel(stream, playback, updating, recordedActorStatus)}
          playback={playback}
          inspector={preferences.inspector}
          onToggleInspector={prefs.toggleInspector}
          onReloadStream={() => {
            setStreamRevision((value) => value + 1);
            status.setNotice(
              "Reloading the read-only desktop connection. This does not restart the participant; connection health is managed by the provider.",
            );
          }}
        />
        <SelectedEntry model={model} playback={playback} />
        <PlayerScreen
          stream={stream}
          model={model}
          playback={playback}
          studyPlayback={studyPlayback}
          recording={recording}
          updating={updating}
          zoom={zoom}
          streamRevision={streamRevision}
          label={participantName}
        />
        {!playback.controlled ? (
          <PlayerTransport
            model={model}
            playback={playback}
            speed={preferences.speed}
            onCycleSpeed={prefs.cycleSpeed}
            onFullscreen={fullscreen}
          />
        ) : null}
        <PlayerReviewTools
          model={model}
          stream={stream}
          playback={playback}
          skipWaits={preferences.skipWaits}
          onSkipWaits={prefs.setSkipWaits}
          zoom={zoom}
          onZoom={setZoom}
          onFullscreen={fullscreen}
          onCopyMoment={copyMoment}
        />
        <PlayerEvidenceNote
          stream={stream}
          model={model}
          playback={playback}
          studyPlayback={studyPlayback}
          recording={recording}
        />
        {status.notice ? (
          <p className="player-notice" role="status">
            {status.notice}
          </p>
        ) : null}
        {status.manualLink ? (
          <label className="moment-fallback">
            Moment link
            <input
              readOnly
              value={status.manualLink}
              aria-label="Moment link"
              onFocus={(event) => event.target.select()}
            />
          </label>
        ) : null}
        {model.frames.length > 0 ? (
          <PlayerFilmstrip model={model} frame={playback.frame} onSeek={playback.seek} />
        ) : null}
      </div>
      <PlayerInspector
        open={preferences.inspector}
        width={preferences.width}
        onResize={prefs.resizeInspector}
        data={data}
        stream={stream}
        model={model}
        playback={playback}
        analysisReview={analysisReview}
        name={participantName}
        feedPage={feedPage}
        onFeedPage={setFeedPage}
      />
    </div>
  );
}

/**
 * The player's status line and the moment-link fallback, with the browser features that set
 * them. Fullscreen and the clipboard can each be refused or missing; the notice then says so and
 * the player stays usable.
 */
function usePlayerNotice() {
  const [notice, setNotice] = useState<string | null>(null);
  const [manualLink, setManualLink] = useState<string | null>(null);
  /** `withShell` takes the study shell around the viewer full screen as well. */
  const toggleFullscreen = async (viewer: HTMLElement | null, withShell: boolean) => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        // The study dock is a sibling of the player content, so fullscreen must
        // include their common shell rather than strand playback controls.
        const target = withShell ? (viewer?.closest<HTMLElement>(".main") ?? viewer) : viewer;
        if (target?.requestFullscreen) await target.requestFullscreen();
        else throw new Error("unavailable");
      }
      setNotice(null);
    } catch {
      setNotice(
        "Fullscreen is unavailable in this browser or was declined. The player remains usable here.",
      );
    }
  };
  const copyLink = async (link: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("unavailable");
      await navigator.clipboard.writeText(link);
      setManualLink(null);
      setNotice("Link copied to this recorded moment.");
    } catch {
      setManualLink(link);
      setNotice("Copy this moment link below. Clipboard access is unavailable.");
    }
  };
  return { notice, manualLink, setNotice, toggleFullscreen, copyLink };
}

/** What the heading says about the participant: the recorded status of a saved snapshot, or
 * whether a running participant shows its live desktop, latest capture or a replay. */
function statusLabel(
  stream: ObserverStream,
  playback: PlayerPlayback,
  updating: boolean,
  recordedActorStatus: string | undefined,
): string {
  const lifecycle = playback.preparing ? "Preparing" : "Running";
  return !updating
    ? recordedActorStatus
      ? `Actor record: ${recordedActorStatus}`
      : `Participant status: ${stream.statusLabel || stream.status}`
    : playback.active
      ? playback.live
        ? `${lifecycle} · Live desktop`
        : playback.following
          ? `${lifecycle} · Latest capture`
          : playback.controlled
            ? `${lifecycle} · Study replay`
            : `${lifecycle} · Replay at ${formatRunTime(playback.elapsed)}`
      : `${stream.status === "failed" || stream.status === "blocked" || stream.status === "timed_out" ? "Stopped" : "Finished"} · Recording`;
}

function PlayerHeading({
  navigation,
  outcome,
  name,
  status,
  playback,
  inspector,
  onToggleInspector,
  onReloadStream,
}: {
  navigation: ReactNode;
  outcome: ReactNode;
  name: string;
  status: string;
  playback: PlayerPlayback;
  inspector: boolean;
  onToggleInspector: () => void;
  onReloadStream: () => void;
}) {
  return (
    <div className="player-heading">
      {navigation ? <div className="player-navigation">{navigation}</div> : null}
      <div className="player-mode">
        <b className="player-participant" title={name}>
          {name}
        </b>
        <strong>{status}</strong>
        {outcome}
      </div>
      {playback.live ? (
        <button type="button" className="tbtn" onClick={onReloadStream}>
          Reload stream
        </button>
      ) : null}
      {playback.active && !playback.following ? (
        <button
          type="button"
          className="tbtn live-jump"
          aria-label="Jump to live"
          onClick={playback.jumpToLive}
        >
          Go live
        </button>
      ) : null}
      <button
        type="button"
        className="tbtn"
        aria-label={inspector ? "Hide inspector" : "Show inspector"}
        aria-expanded={inspector}
        onClick={onToggleInspector}
      >
        Inspector {inspector ? "−" : "+"}
      </button>
    </div>
  );
}
