import { useEffect, useRef, useState } from "react";

import { formatDuration, runArtifactHref } from "@/lib/artifact-href";
import type { RecordingInterval } from "../../src/run/run-clock.js";
import { IconButton } from "./ui/icon-button";
import { ReviewIcon } from "./review-icon";

function audioLabel(sources: RecordingInterval["recording"]["audioSources"]): string {
  if (sources.length === 0) return "Screen only · no recorded audio";
  return sources
    .map((source) =>
      source === "microphone-input" ? "Microphone input offered" : "Speaker output",
    )
    .join(" · ");
}

export function RecordingVideo({
  interval,
  atMs,
  playing,
  speed,
  seekRevision,
  label,
  onUnavailable,
}: {
  interval: RecordingInterval;
  atMs: number;
  playing: boolean;
  speed: number;
  seekRevision: number;
  label: string;
  onUnavailable?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const atMsRef = useRef(atMs);
  const playAttemptRef = useRef(0);
  atMsRef.current = atMs;
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [playBlocked, setPlayBlocked] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  const href = runArtifactHref(interval.recording.path);
  const hasAudio = interval.recording.audioSources.length > 0;

  const syncToCursor = (video: HTMLVideoElement, thresholdSeconds = 0.04) => {
    const targetSeconds =
      Math.max(0, Math.min(interval.recording.durationMs, atMsRef.current - interval.startMs)) /
      1000;
    if (Math.abs(video.currentTime - targetSeconds) > thresholdSeconds)
      video.currentTime = targetSeconds;
  };

  const play = () => {
    const video = videoRef.current;
    if (!video) return;
    syncToCursor(video, 0.75);
    const attempt = ++playAttemptRef.current;
    void video
      .play()
      .then(() => {
        if (playAttemptRef.current === attempt) setPlayBlocked(false);
      })
      .catch(() => {
        if (playAttemptRef.current === attempt) setPlayBlocked(true);
      });
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    syncToCursor(video);
  }, [href, interval.recording.durationMs, interval.startMs, seekRevision]);

  useEffect(() => {
    const video = videoRef.current;
    if (video && playing && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
      syncToCursor(video, 0.75);
  }, [atMs, href, interval.recording.durationMs, interval.startMs, playing]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = speed;
    if (!playing) {
      video.pause();
      return;
    }
    play();
  }, [href, playing, speed]);

  const toggleSound = () => {
    setSoundEnabled((enabled) => !enabled);
    if (!soundEnabled && playing) play();
  };

  if (!href)
    return (
      <div className="recording-video-unavailable" role="status">
        Desktop video path is unavailable.
      </div>
    );
  return (
    <div className="recording-video-stage">
      <video
        ref={videoRef}
        src={href}
        aria-label={`${label} desktop recording`}
        playsInline
        preload="metadata"
        muted={!hasAudio || !soundEnabled}
        onLoadedMetadata={(event) => syncToCursor(event.currentTarget)}
        onCanPlay={() => {
          if (playing) play();
        }}
        onError={() => {
          setMediaFailed(true);
          onUnavailable?.();
        }}
      />
      <div className="recording-video-meta">
        <span>Desktop video · {formatDuration(interval.recording.durationMs)}</span>
        <span>{audioLabel(interval.recording.audioSources)}</span>
        {hasAudio ? (
          <IconButton
            className="recording-audio-toggle"
            label={soundEnabled ? "Mute recorded audio" : "Enable recorded audio"}
            hint={
              soundEnabled
                ? "Mute this participant's recorded audio"
                : "Play this participant's recorded audio"
            }
            onClick={toggleSound}
          >
            <ReviewIcon name={soundEnabled ? "speaker" : "speaker-off"} />
          </IconButton>
        ) : null}
        {!interval.recording.complete ? (
          <span>Partial desktop recording · capture ended before normal completion</span>
        ) : null}
        {playBlocked ? (
          <span role="status">
            Playback was blocked by the browser. Press Play study or enable recorded audio to try
            again.
          </span>
        ) : null}
        {mediaFailed ? (
          <span role="status">
            Desktop video could not load. Use recorded screenshots when available.
          </span>
        ) : null}
      </div>
    </div>
  );
}
