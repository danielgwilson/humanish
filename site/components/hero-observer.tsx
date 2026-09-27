"use client";

import { useEffect, useRef, useState } from "react";
import { reducedMotion, useInView } from "./tour/use-in-view";

/** The Observer's logical viewport inside the frame; scaled down to the hero column. */
const STAGE_W = 1600;
const STAGE_H = 900;

/**
 * HeroObserver — the real Observer artifact of a saved run, in a frame, replaying itself.
 * The bundle under /runs/<slug>/observer/ is the same file humanish writes into a
 * repo; the URL parameters press play at 8x, loop, and collapse the library. It
 * loads only when the hero is on screen, shows the run's poster until the page is
 * ready, and stays a still under reduced motion (the viewer can press play).
 */
export default function HeroObserver({ slug, participants, title, speed = 8 }: { slug: string; participants: number; title: string; speed?: number }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const [ready, setReady] = useState(false);
  const { ref, inView } = useInView<HTMLDivElement>("200px");
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (inView) setArmed(true); }, [inView]);
  // Decided after hydration so the server and first client render agree. Phones get the
  // poster and the link: a scaled 8-participant grid is unreadable there and the replay
  // streams captures for as long as it plays.
  const [play, setPlay] = useState(true);
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    setPlay(!reducedMotion());
    const media = window.matchMedia("(max-width: 900px)");
    const sync = () => setPhone(media.matches);
    sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const fit = () => setScale(Math.min(1, frame.clientWidth / STAGE_W));
    fit();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    ro?.observe(frame);
    return () => ro?.disconnect();
  }, []);
  const src = `/runs/${slug}/observer/index.html?${play ? `autoplay=${speed}&loop=1&` : ""}sidebar=closed`;
  const full = `/runs/${slug}/observer/index.html`;
  return (
    <figure className="hero-observer rev" ref={ref} style={{ "--d": ".3s" } as React.CSSProperties}>
      <div className="ho-bar">
        <span className="lane-id"><b>Observer ·</b> {participants} participants · one lobby</span>
        <span className="chip chip-dot">{play ? `Replay ${speed}×` : "Replay"}</span>
      </div>
      <div className="ho-frame" ref={frameRef} style={{ height: Math.round(STAGE_H * scale) }}>
        {armed && !phone ? (
          <iframe
            className="ho-iframe"
            src={src}
            title={title}
            loading="lazy"
            style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }}
            onLoad={() => setReady(true)}
          />
        ) : null}
        <img className="ho-poster" src={`/runs/${slug}/poster.jpg`} alt={`${title}: the Observer grid of the saved run`} hidden={ready && !phone} />
      </div>
      <figcaption className="ho-foot">
        <span className="fl">Saved run</span>
        <span className="fq">{title}</span>
        <a className="ho-open" href={full} target="_blank" rel="noopener">Open the Observer ↗</a>
      </figcaption>
    </figure>
  );
}
