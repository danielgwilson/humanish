"use client";

import Image from "next/image";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { reducedMotion, useInView } from "./tour/use-in-view";

/** The Observer's logical viewport inside the frame; scaled to the hero column or the lightbox. */
const STAGE_W = 1600;
const STAGE_H = 900;

/**
 * HeroObserver — the real Observer artifact of a saved run, in a frame, replaying itself.
 * The bundle under /runs/<slug>/observer/ is the same file humanish writes into a repo;
 * the URL parameters press play, loop, and collapse the library. In the hero the frame
 * is a picture: a click-catcher covers it and a click expands the same iframe into a
 * full-viewport lightbox, where the Observer is interactive. The iframe never remounts,
 * so playback continues across expand, collapse and window resizes. It loads only when
 * the hero is on screen, shows the run's poster until the page is ready, and stays a
 * still under reduced motion (the viewer can press play). Phones get the poster and the
 * link: a scaled eight-participant grid is unreadable there and the replay streams
 * captures for as long as it plays.
 */
export default function HeroObserver({ slug, participants, title, facts, runId, speed = 6 }: { slug: string; participants: number; title: string; facts?: string; runId?: string; speed?: number }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const catchRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [fit, setFit] = useState({ scale: 0.5, left: 0, top: 0 });
  const [ready, setReady] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Reveals adds `.in` to `.rev` once; React rewrites the class list when it changes, so
  // after a collapse the element keeps its revealed state explicitly.
  const [revealed, setRevealed] = useState(false);
  const { ref, inView } = useInView<HTMLDivElement>("200px");
  const [armed, setArmed] = useState(false);
  // Decided once after hydration so the server and first client render agree.
  const [play, setPlay] = useState(true);
  const [phone, setPhone] = useState<boolean | null>(null);
  useEffect(() => {
    setPlay(!reducedMotion());
    setPhone(window.matchMedia("(max-width: 900px)").matches);
  }, []);
  useEffect(() => { if (inView && phone === false) setArmed(true); }, [inView, phone]);

  // Collapsed: the stage scales to the column width. Expanded: it scales to fit the
  // frame's width and height and sits centered.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const w = frame.clientWidth, h = frame.clientHeight;
      if (!expanded) { setFit({ scale: Math.min(1, w / STAGE_W), left: 0, top: 0 }); return; }
      const scale = Math.min(1, w / STAGE_W, h / STAGE_H);
      setFit({ scale, left: Math.max(0, (w - STAGE_W * scale) / 2), top: Math.max(0, (h - STAGE_H * scale) / 2) });
    };
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(frame);
    window.addEventListener("resize", measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); };
  }, [expanded]);

  const open = useCallback(() => { setExpanded(true); setRevealed(true); }, []);
  const close = useCallback(() => { setExpanded(false); }, []);
  useEffect(() => {
    if (!expanded) return;
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => {
      document.documentElement.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
      catchRef.current?.focus({ preventScroll: true });
    };
  }, [expanded, close]);

  // The artifact's URL carries a hash of the file, so a browser that cached an older artifact
  // (they were served immutable for a while) fetches the current one.
  const v = process.env.NEXT_PUBLIC_OBSERVER_ARTIFACT_V ?? "0";
  const src = `/runs/${slug}/observer/index.html?v=${v}&${play ? `autoplay=${speed}&loop=1&` : ""}sidebar=closed`;
  const full = `/runs/${slug}/observer/index.html?v=${v}`;
  const showPoster = !(ready && phone === false);
  return (
    <figure className={expanded ? "hero-observer expanded" : revealed ? "hero-observer rev in" : "hero-observer rev"} ref={ref} style={{ "--d": ".3s" } as React.CSSProperties}
      role={expanded ? "dialog" : undefined} aria-modal={expanded ? true : undefined} aria-label={expanded ? `${title}, Observer replay` : undefined}>
      <div className="ho-bar">
        <span className="lane-id"><b>Example ·</b> {participants} synthetic players in one game lobby</span>
        <span className="ho-bar-end">
          <span className="chip chip-dot">{play ? `Replay ${speed}×` : "Replay"}</span>
          {expanded ? <><span className="ho-esc">Esc closes</span><button type="button" className="ho-close" ref={closeRef} onClick={close}>Close ✕</button></> : null}
        </span>
      </div>
      <div className="ho-frame" ref={frameRef} style={expanded ? undefined : { height: Math.round(STAGE_H * fit.scale) }}>
        {armed ? (
          <iframe
            className="ho-iframe"
            src={src}
            title={title}
            // In the hero the frame is a picture: inert keeps Tab and the arrow keys on the page
            // (a keyboard-first participant lost document scrolling to the embed). The lightbox lifts it.
            inert={!expanded}
            style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${fit.scale})`, left: fit.left, top: fit.top }}
            onLoad={() => setReady(true)}
          />
        ) : null}
        <Image className="ho-poster" src={`/runs/${slug}/poster.jpg`} alt={`${title}: the Observer grid of the saved run`} width={1440} height={950} sizes="(max-width: 900px) 100vw, 720px" quality={70} loading="eager" hidden={!showPoster} />
        {!expanded && phone === false ? (
          <button type="button" className="ho-catch" ref={catchRef} onClick={open} aria-label="Expand the Observer replay">
            <span className="ho-hint">Click to expand</span>
          </button>
        ) : null}
      </div>
      <figcaption className="ho-foot">
        <span className="fl">Result</span>
        <span className="fq">
          {(facts ?? title).split(" \u00b7 ").map((fact, i) => (
            <Fragment key={fact}>
              {i > 0 ? " \u00b7 " : null}
              <span className="ho-fact">{fact}</span>
            </Fragment>
          ))}
        </span>
        <a className="ho-open" href={full} target="_blank" rel="noopener">Open the Observer ↗</a>
        {runId ? <code className="ho-run">run {runId}</code> : null}
      </figcaption>
    </figure>
  );
}
