"use client";

import { useEffect, useMemo, useState } from "react";
import type { TourLane } from "@/lib/tour-types";
import { elapsed } from "@/lib/tour-types";
import { reducedMotion, useInView } from "./use-in-view";

/** Provider reasoning summaries arrive with a bold markdown title; show them as plain text. */
const plain = (s: string | undefined | null) => (s ?? "").replace(/\*\*([^*]+)\*\*\s*/g, "$1: ").replace(/\s+/g, " ").trim();

/**
 * ParticipantsGrid — the Observer's study grid from a multi-participant run. Each card
 * replays its own captures in step with the others on one clock, then settles on the
 * recorded ending. Statuses and reports are the bundle's; nothing is scripted.
 */
export default function ParticipantsGrid({ slug, lanes, frameSize, names, stepMs = 1700 }: {
  slug: string; lanes: TourLane[]; frameSize: { w: number; h: number }; names: Record<string, string>; stepMs?: number;
}) {
  const maxFrames = Math.max(...lanes.map((l) => l.frames.length));
  const [tick, setTick] = useState(0);
  const { ref, inView } = useInView<HTMLDivElement>("120px");
  const rm = useMemo(() => reducedMotion(), []);
  useEffect(() => {
    if (rm || !inView) return;
    const id = setInterval(() => setTick((t) => (t + 1) % (maxFrames + 3)), stepMs);
    return () => clearInterval(id);
  }, [inView, rm, maxFrames, stepMs]);
  const t0 = lanes.map((l) => l.frames[0]?.at).filter(Boolean).sort()[0] ?? "";

  return (
    <div className="pg" ref={ref}>
      {lanes.map((lane) => {
        const k = rm ? lane.frames.length - 1 : Math.min(tick, lane.frames.length - 1);
        const finished = rm || tick >= lane.frames.length;
        const f = lane.frames[k];
        const ending = lane.completionReason === "goal_satisfied" ? "reached the goal" : lane.completionReason === "budget_exhausted" || /time budget/.test(lane.reason ?? "") ? "ran out of time" : (lane.completionReason ?? lane.status ?? "ended");
        return (
          <article className={`pg-card${finished ? " done" : ""}`} key={lane.laneId ?? lane.lane ?? ""}>
            <header>
              <span className="pg-name">{names[lane.laneId ?? ""] ?? lane.laneId}</span>
              <span className={`chip ${finished ? (lane.completionReason === "goal_satisfied" ? "chip-pass" : "chip-dot chip-mute") : "chip-dot"}`}>
                {finished ? ending : f?.at && t0 ? `running · ${elapsed(t0, f.at)}` : `running · capture ${k + 1} / ${lane.frames.length}`}
              </span>
            </header>
            <div className="pg-shot" style={{ aspectRatio: `${frameSize.w} / ${frameSize.h}` }}>
              {lane.frames.map((fr, idx) => (
                <img key={fr.id} src={`/runs/${slug}/${fr.file}`} alt={idx === k ? `${names[lane.laneId ?? ""] ?? lane.laneId}, ${fr.title}` : ""} className={idx === k ? "on" : ""} loading="lazy" decoding="async" />
              ))}
            </div>
            <footer>
              <span className="fl">{lane.persona} · {lane.counts?.actions ?? "?"} actions · {lane.counts?.screenshots ?? lane.frames.length} captures</span>
              <p>{finished ? (lane.reason ?? "").split("\n").slice(-1)[0]?.slice(0, 220) : (plain(f?.reasoningBefore.at(-1)?.text) || (f?.actionsBefore.map((a) => a.title).slice(-3).join(" · ") ?? ""))}</p>
            </footer>
          </article>
        );
      })}
    </div>
  );
}
