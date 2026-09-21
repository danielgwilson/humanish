"use client";

import { useEffect, useMemo, useState } from "react";
import type { TourLane } from "@/lib/tour-types";
import { elapsed } from "@/lib/tour-types";
import { reducedMotion, useInView } from "./use-in-view";

/** Provider reasoning summaries arrive with a bold markdown title; show them as plain text. */
const plain = (s: string | undefined | null) => (s ?? "").replace(/\*\*([^*]+)\*\*\s*/g, "$1: ").replace(/\s+/g, " ").trim();

/**
 * ReplayPlayer — the Observer's participant view rebuilt as a page component from a
 * real actor trace: the capture, the clicks pinned where they landed on that capture,
 * the participant's reasoning before acting, and the action list. Plays while on
 * screen; pauses when scrolled away; steps by hand under reduced motion.
 */
export default function ReplayPlayer({
  slug, lane, frameSize, stepMs = 1900, compact = false, label
}: { slug: string; lane: TourLane; frameSize: { w: number; h: number }; stepMs?: number; compact?: boolean; label: string }) {
  const frames = lane.frames;
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const { ref, inView } = useInView<HTMLDivElement>("120px");
  const rm = useMemo(() => reducedMotion(), []);
  const t0 = frames[0]?.at ?? "";

  useEffect(() => { if (!rm) setPlaying(inView); }, [inView, rm]);
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const id = setInterval(() => setI((k) => (k + 1) % frames.length), stepMs);
    return () => clearInterval(id);
  }, [playing, stepMs, frames.length]);

  const frame = frames[i];
  const next = frames[i + 1];
  // Actions recorded between this capture and the next happened on this screen.
  const pins = next?.actionsBefore ?? lane.trailingActions;
  const thought = next?.reasoningBefore.at(-1) ?? lane.trailingReasoning.at(-1);
  const flat = frames.flatMap((f, k) => f.actionsBefore.map((a) => ({ ...a, frame: k - 1 })));

  return (
    <div className={`rp${compact ? " rp-compact" : ""}`} ref={ref}>
      <div className="rp-head">
        <span className="rp-title">{label}</span>
        <span className="rp-meta">{frame?.title} · {elapsed(t0, frame?.at ?? t0)} · {i + 1} / {frames.length}</span>
      </div>
      <div className="rp-body">
        <div className="rp-stage" style={{ aspectRatio: `${frameSize.w} / ${frameSize.h}` }}>
          {frames.map((f, k) => (
            <img key={f.id} src={`/runs/${slug}/${f.file}`} alt={k === i ? `${f.title}: capture from the hosted desktop` : ""} className={k === i ? "on" : ""} loading={k === 0 ? "eager" : "lazy"} decoding="async" />
          ))}
          {pins.filter((a) => a.coord).map((a) => (
            <span key={a.id} className="rp-pin" style={{ left: `${(a.coord!.x / frameSize.w) * 100}%`, top: `${(a.coord!.y / frameSize.h) * 100}%` }} title={a.title}>
              <i /><b>{a.title}</b>
            </span>
          ))}
          {thought ? <p className="rp-thought"><span className="fl">{thought.message ? "message" : "reasoning"}</span>{plain(thought.text)}</p> : null}
        </div>
        {!compact ? (
          <ol className="rp-actions" aria-label="Recorded actions">
            {flat.map((a) => (
              <li key={a.id} className={a.frame === i ? "on" : a.frame < i ? "past" : ""}>
                <span className="rp-t">{elapsed(t0, a.at)}</span><code>{a.title}</code>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <div className="rp-bar">
        <button type="button" onClick={() => setI((k) => (k - 1 + frames.length) % frames.length)} aria-label="Previous capture">‹</button>
        <button type="button" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>{playing ? "Pause" : "Play"}</button>
        <button type="button" onClick={() => setI((k) => (k + 1) % frames.length)} aria-label="Next capture">›</button>
        <div className="rp-track" aria-hidden="true">{frames.map((f, k) => <i key={f.id} className={k <= i ? "done" : ""} onClick={() => setI(k)} />)}</div>
        <span className="rp-status">{lane.status === "passed" ? "reached the goal" : lane.completionReason ?? lane.status}</span>
      </div>
    </div>
  );
}
