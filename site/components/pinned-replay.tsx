"use client";

import { useEffect, useRef } from "react";
import PersonaLane from "./persona-lane";
import TerminalCast, { type TerminalLine } from "./terminal-cast";
import { resolveCover } from "@/lib/covers";
import { prefersReducedMotion } from "@/lib/theme";

/**
 * PinnedReplay — the 7-step scroll walkthrough of one real run, ported
 * verbatim from the POC: a tall track pins a rail + stage; scroll advances
 * discrete steps; rail items are clickable; a 420ms idle-snap centers the
 * nearest step (cancelled by any fresh input; disabled for reduced motion);
 * lane covers resolve as their step activates. Below 1024px — or without
 * JS — CSS stacks the panels as a readable list and covers resolve via IO.
 */

const BRIEF_YAML = `<span class="cy">run:</span> <span class="cv">cua-2026-08-07T17-44-48-760Z-87389419</span>
<span class="cy">date:</span> <span class="cv">2026-08-07</span>
<span class="cy">subject:</span>
  <span class="cc"># open-source virtual whiteboard</span>
  <span class="cy">app:</span> <span class="cv">Excalidraw</span>
  <span class="cy">clone:</span> <span class="cv">excalidraw/excalidraw · commit-pinned</span>
<span class="cy">desktop:</span> <span class="cv">hosted sandbox · 1920×1080</span>
<span class="cy">lanes:</span>
  - <span class="ca">01</span> <span class="cv">diagram-login-flow</span>
  - <span class="ca">02</span> <span class="cv">sticky-notes</span>
  - <span class="ca">03</span> <span class="cv">sketch-shapes</span>
  - <span class="ca">04</span> <span class="cv">export-drawing</span>`;

const RAIL_ITEMS: Array<[string, string, string, boolean?]> = [
  ["00", "Brief", "the lab, in YAML"],
  ["01", "Lane 01", "diagram-login-flow"],
  ["02", "Lane 02", "sticky-notes"],
  ["03", "Lane 03", "sketch-shapes · gave up", true],
  ["04", "Lane 04", "export-drawing"],
  ["05", "Bundle", "what landed in .humanish/"],
  ["06", "Verify", "16/16 checks"]
];

const VERIFY_CAST: TerminalLine[] = [
  { kind: "cmd", text: "$ humanish verify" },
  { kind: "ok", text: "redaction passed" },
  { kind: "ok", text: "actor engagement: live actor traces that claim goal_satisfied carry at least one action or message" },
  { kind: "ok", text: "actor verdict consistency: live pass verdicts do not hide failed, blocked, or timed-out actor traces" },
  { kind: "dim", text: "… 13 more checks" },
  { kind: "sum", text: "16/16 passed → status: local_only", note: "(RAW_SCREENSHOTS)" }
];

const LANES: Array<{
  idx: string;
  name: string;
  img: string;
  alt: string;
  reportLabel: string;
  report: string;
  passed: boolean;
}> = [
  {
    idx: "01",
    name: "diagram-login-flow",
    img: "/study/excalidraw-lane1.jpg",
    alt: "Keyframe from lane diagram-login-flow: the Excalidraw canvas on the sandbox desktop with two rectangles labeled Login and Dashboard connected by an arrow",
    reportLabel: "Final report — verbatim",
    report: "Done",
    passed: true
  },
  {
    idx: "02",
    name: "sticky-notes",
    img: "/study/excalidraw-lane2.jpg",
    alt: "Keyframe from lane sticky-notes: the Excalidraw canvas on the sandbox desktop with three colored to-do notes — Draft plan, Call team, Buy supplies",
    reportLabel: "Final report — verbatim",
    report: "Done.",
    passed: true
  },
  {
    idx: "03",
    name: "sketch-shapes",
    img: "/study/excalidraw-lane3.jpg",
    alt: "Keyframe from lane sketch-shapes: the Excalidraw canvas on the sandbox desktop with an ellipse, a rectangle, stray line strokes, and the freehand tool panel open — the lane gave up here",
    reportLabel: "Recorded reason — verbatim",
    report: "gave up: 8 consecutive turns with no change to the UI state",
    passed: false
  },
  {
    idx: "04",
    name: "export-drawing",
    img: "/study/excalidraw-lane4.jpg",
    alt: "Keyframe from lane export-drawing: the Excalidraw canvas on the sandbox desktop with a single large rectangle, deselected after the export flow",
    reportLabel: "Final report — verbatim",
    report: "Done",
    passed: true
  }
];

export default function PinnedReplay() {
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const rm = prefersReducedMotion();
    const mqDesk = window.matchMedia("(min-width:1024px)");
    const hasIO = "IntersectionObserver" in window;

    const panels = Array.from(track.querySelectorAll<HTMLElement>(".panel"));
    const ritems = Array.from(track.querySelectorAll<HTMLButtonElement>(".ritem"));
    const fill = track.querySelector<HTMLElement>("#pf");
    const N = panels.length;
    let idx = -1;
    let snapT: ReturnType<typeof setTimeout> | null = null;
    let ticking = false;

    const metrics = () => {
      const r = track.getBoundingClientRect();
      const total = track.offsetHeight - window.innerHeight;
      const y = Math.min(Math.max(-r.top, 0), Math.max(total, 1));
      const abs = r.top + (window.scrollY || window.pageYOffset);
      return { y, total, abs };
    };
    const setStep = (i: number) => {
      if (i === idx) return;
      idx = i;
      panels.forEach((p, k) => {
        p.classList.toggle("on", k === i);
        p.classList.toggle("past", k < i);
      });
      ritems.forEach((b, k) => {
        b.classList.toggle("on", k === i);
        b.classList.toggle("done", k < i);
        if (k === i) {
          b.setAttribute("aria-current", "step");
        } else {
          b.removeAttribute("aria-current");
        }
      });
      const cv = panels[i]?.querySelector<HTMLCanvasElement>("canvas.cover");
      if (cv) resolveCover(cv, 220);
    };
    const queueSnap = () => {
      if (rm || !mqDesk.matches) return;
      if (snapT) clearTimeout(snapT);
      snapT = setTimeout(() => {
        const m = metrics();
        if (m.total <= 0 || m.y <= 0 || m.y >= m.total) return;
        const step = m.total / N;
        const center = (Math.min(N - 1, Math.floor((m.y / m.total) * N)) + 0.5) * step;
        const delta = center - m.y;
        if (Math.abs(delta) > 8 && Math.abs(delta) < step * 0.46) {
          window.scrollTo({ top: m.abs + center, behavior: "smooth" });
        }
      }, 420);
    };
    const update = () => {
      if (!mqDesk.matches) return;
      const m = metrics();
      if (m.total <= 0) return;
      const p = m.y / m.total;
      setStep(Math.min(N - 1, Math.floor(p * N)));
      if (fill) fill.style.transform = `scaleY(${p})`;
      queueSnap();
    };
    const toStep = (k: number) => {
      const m = metrics();
      if (m.total <= 0) return;
      const step = m.total / N;
      window.scrollTo({ top: m.abs + (k + 0.5) * step, behavior: rm ? "auto" : "smooth" });
    };

    const onRailClick = (e: Event) => {
      const b = e.currentTarget as HTMLButtonElement;
      toStep(parseInt(b.getAttribute("data-i") || "0", 10));
    };
    ritems.forEach((b) => b.addEventListener("click", onRailClick));

    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          update();
        });
      }
    };
    const onResize = () => update();
    const cancelSnap = () => {
      if (snapT) clearTimeout(snapT);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    const cancelEvents = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    cancelEvents.forEach((ev) => window.addEventListener(ev, cancelSnap, { passive: true }));

    setStep(0);
    update();

    let cio: IntersectionObserver | null = null;
    if (!mqDesk.matches && hasIO) {
      cio = new IntersectionObserver(
        (es) => {
          es.forEach((en) => {
            if (!en.isIntersecting) return;
            resolveCover(en.target.querySelector<HTMLCanvasElement>("canvas.cover"), 260);
            cio?.unobserve(en.target);
          });
        },
        { threshold: 0.35 }
      );
      panels.forEach((p) => {
        if (p.querySelector("canvas.cover")) cio?.observe(p);
      });
    }

    return () => {
      if (snapT) clearTimeout(snapT);
      ritems.forEach((b) => b.removeEventListener("click", onRailClick));
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      cancelEvents.forEach((ev) => window.removeEventListener(ev, cancelSnap));
      cio?.disconnect();
    };
  }, []);

  return (
    <div className="wt-track" id="runtrack" ref={trackRef}>
      <div className="wt-sticky">
        <p className="runband" aria-hidden="true"><span>Run <b>cua-2026-08-07T17-44-48-760Z-87389419</b> · 2026-08-07</span><span>3/4 lanes passed · verify 16/16 checks</span></p>
        <nav className="rail" aria-label="Run steps">
          <span className="rail-k">Replay · one real run</span>
          <span className="rtrack" aria-hidden="true"><i id="pf"></i></span>
          {RAIL_ITEMS.map(([ridx, b, i, fail], k) => (
            <button className={fail ? "ritem ritem-fail" : "ritem"} data-i={k} key={ridx}>
              <span className="ridx">{ridx}</span>
              <span className="rtx"><b>{b}</b><i>{i}</i></span>
            </button>
          ))}
        </nav>

        <div className="stage">
          <article className="panel" data-i="0">
            <header className="pbar"><span className="pl"><b className="pidx">00</b><span className="pname">brief · the lab</span></span><span className="pr">lab.yaml</span></header>
            <div className="pbody pbody-brief">
              <dl className="brief-facts">
                <div><dt>Subject</dt><dd>Excalidraw</dd></div>
                <div><dt>Desktop</dt><dd>hosted · 1920×1080</dd></div>
                <div><dt>Lanes</dt><dd>4 · parallel</dd></div>
                <div><dt>Date</dt><dd>2026-08-07</dd></div>
              </dl>
              <pre className="code" dangerouslySetInnerHTML={{ __html: BRIEF_YAML }} />
            </div>
            <footer className="pcap"><p className="prep"><span className="plab">The lab</span>One YAML lab declares the persona, its four missions, and a commit-pinned Excalidraw clone. Each lane gets its own hosted 1920×1080 desktop.</p></footer>
          </article>

          {LANES.map((lane, i) => (
            <PersonaLane {...lane} dataI={i + 1} sizer={i === 0} key={lane.idx} />
          ))}

          <article className="panel" data-i="5">
            <header className="pbar"><span className="pl"><b className="pidx">05</b><span className="pname">bundle · evidence</span></span><span className="pr">.humanish/ · gitignored</span></header>
            <div className="pbody">
              <div className="ledger">
                <div className="lh">.humanish/runs/cua-2026-08-07T17-44-48-760Z-87389419<span>4 lanes</span></div>
                <div className="lrow"><span className="ln"><em>├</em>screenshots</span><span className="ld">every screenshot each lane saw · 28 frames</span></div>
                <div className="lrow"><span className="ln"><em>├</em>action traces</span><span className="ld">ordered, end to end</span></div>
                <div className="lrow"><span className="ln"><em>├</em>lifecycle events</span><span className="ld">launch to landing</span></div>
                <div className="lrow"><span className="ln"><em>├</em>estimated cost</span><span className="ld">~$1.54 · estimated (rates as of 2026-08-05)</span></div>
                <div className="lrow"><span className="ln"><em>└</em>wall-clock</span><span className="ld">6m 06s · run created → last lane landed</span></div>
              </div>
            </div>
            <footer className="pcap"><p className="prep"><span className="plab">Where it lands</span>The run lands in gitignored <code>.humanish/</code>: every screenshot each lane saw, ordered action traces, lifecycle events, and estimated cost at dated rates.</p></footer>
          </article>

          <article className="panel panel-dark" data-i="6">
            <header className="pbar"><span className="pl"><b className="pidx">06</b><span className="pname">verify · share-safety</span></span><span className="pr">fail-closed</span></header>
            <div className="pbody">
              <TerminalCast lines={VERIFY_CAST} />
            </div>
            <footer className="pcap"><p className="prep"><span className="plab">The gate</span><code>humanish verify</code> grades the bundle fail-closed. This run: 16/16 checks passed — and the bundle still grades <code>local_only</code>, because it holds full-fidelity screenshots. Publishing these crops was a reviewed, deliberate act.</p></footer>
          </article>
        </div>
      </div>
    </div>
  );
}
