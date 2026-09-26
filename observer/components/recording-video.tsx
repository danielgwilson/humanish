import { useEffect, useRef, useState } from "react";

import { runArtifactHref } from "@/lib/artifact-href";
import type { RecordingInterval } from "@/lib/grid-recording";

function audioLabel(sources: RecordingInterval["recording"]["audioSources"]): string {
  if (sources.length === 0) return "Screen only · no recorded audio";
  return sources.map((source) => source === "microphone-input" ? "Microphone input offered" : "Speaker output").join(" · ");
}

export function RecordingVideo({ interval, atMs, playing, speed, seekRevision, label }: {
  interval: RecordingInterval;
  atMs: number;
  playing: boolean;
  speed: number;
  seekRevision: number;
  label: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const atMsRef = useRef(atMs);
  atMsRef.current = atMs;
  const [failed, setFailed] = useState(false);
  const href = runArtifactHref(interval.recording.path);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const targetSeconds = Math.max(0, Math.min(interval.recording.durationMs, atMsRef.current - interval.startMs)) / 1000;
    if (Math.abs(video.currentTime - targetSeconds) > 0.04) video.currentTime = targetSeconds;
  }, [href, interval.recording.durationMs, interval.startMs, seekRevision]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = speed;
    if (!playing) {
      video.pause();
      return;
    }
    void video.play().then(() => setFailed(false)).catch(() => setFailed(true));
  }, [href, playing, speed]);

  if (!href) return <div className="recording-video-unavailable" role="status">Desktop video path is unavailable.</div>;
  return <div className="recording-video-stage">
    <video ref={videoRef} src={href} aria-label={`${label} desktop recording`} playsInline preload="metadata"
      muted={interval.recording.audioSources.length === 0} onError={() => setFailed(true)} />
    <div className="recording-video-meta">
      <span>{audioLabel(interval.recording.audioSources)}</span>
      {!interval.recording.complete ? <span>Partial desktop recording · capture ended before normal completion</span> : null}
      {failed ? <span role="status">Desktop video could not play. Recorded screenshots remain available.</span> : null}
    </div>
  </div>;
}
