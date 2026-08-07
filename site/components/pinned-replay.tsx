"use client";

import { useEffect, useRef } from "react";
import CoverCanvas from "./cover-canvas";
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

const BRIEF_YAML = `<span class="cy">run:</span> <span class="cv">drawdb-study-20260801-wide-05</span>
<span class="cy">date:</span> <span class="cv">2026-08-01</span>
<span class="cy">subject:</span>
  <span class="cc"># open-source DB diagram editor</span>
  <span class="cy">app:</span> <span class="cv">drawDB</span>
  <span class="cy">checkout:</span> <span class="cv">local · commit-pinned</span>
<span class="cy">desktop:</span> <span class="cv">hosted sandbox · 1920×1080</span>
<span class="cy">lanes:</span>
  - <span class="ca">01</span> <span class="cv">create-customers</span>
  - <span class="ca">02</span> <span class="cv">add-order-field</span>
  - <span class="ca">03</span> <span class="cv">inspect-products-sql</span>
  - <span class="ca">04</span> <span class="cv">add-canvas-note</span>`;

const RAIL_ITEMS: Array<[string, string, string]> = [
  ["00", "Brief", "the lab, in YAML"],
  ["01", "Lane 01", "create-customers"],
  ["02", "Lane 02", "add-order-field"],
  ["03", "Lane 03", "inspect-products-sql"],
  ["04", "Lane 04", "add-canvas-note"],
  ["05", "Bundle", "what landed in .humanish/"],
  ["06", "Verify", "15/15 checks"]
];

const LANES: Array<{
  idx: string;
  name: string;
  img: string;
  alt: string;
  report: string;
}> = [
  {
    idx: "01",
    name: "create-customers",
    img: "/study/lane1.jpg",
    alt: "Keyframe from lane 01: the drawDB editor on the sandbox desktop with a customers table holding an email TEXT field",
    report: "customers + email (TEXT)"
  },
  {
    idx: "02",
    name: "add-order-field",
    img: "/study/lane2.jpg",
    alt: "Keyframe from lane 02: the drawDB editor on the sandbox desktop with an orders table holding a customer_id INTEGER field",
    report: "orders + customer_id (INTEGER)"
  },
  {
    idx: "03",
    name: "inspect-products-sql",
    img: "/study/lane3.jpg",
    alt: "Keyframe from lane 03: drawDB export dialog on the sandbox desktop showing generated CREATE TABLE SQL for products",
    report: "products SQL generated"
  },
  {
    idx: "04",
    name: "add-canvas-note",
    img: "/study/lane4.jpg",
    alt: "Keyframe from lane 04: the drawDB canvas on the sandbox desktop with a newly created note element",
    report: "note created"
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
        <p className="runband" aria-hidden="true"><span>Run <b>drawdb-study-20260801-wide-05</b> · 2026-08-01</span><span>4/4 lanes passed · verify 15/15 checks</span></p>
        <nav className="rail" aria-label="Run steps">
          <span className="rail-k">Replay · one real run</span>
          <span className="rtrack" aria-hidden="true"><i id="pf"></i></span>
          {RAIL_ITEMS.map(([ridx, b, i], k) => (
            <button className="ritem" data-i={k} key={ridx}>
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
                <div><dt>Subject</dt><dd>drawDB</dd></div>
                <div><dt>Desktop</dt><dd>hosted · 1920×1080</dd></div>
                <div><dt>Lanes</dt><dd>4 · parallel</dd></div>
                <div><dt>Date</dt><dd>2026-08-01</dd></div>
              </dl>
              <pre className="code" dangerouslySetInnerHTML={{ __html: BRIEF_YAML }} />
            </div>
            <footer className="pcap"><p className="prep"><span className="plab">The lab</span>One YAML lab declares the personas, their missions, and a commit-pinned drawDB checkout. Each lane gets its own hosted 1920×1080 desktop.</p></footer>
          </article>

          {LANES.map((lane, i) => (
            <article className="panel" data-i={i + 1} key={lane.idx} {...(i === 0 ? { "data-sizer": "" } : {})}>
              <header className="pbar"><span className="pl"><b className="pidx">{lane.idx}</b><span className="pname">{lane.name}</span></span><span className="pr">observer · replay</span></header>
              <div className="pmedia"><img src={lane.img} alt={lane.alt} /><CoverCanvas n={lane.idx} /></div>
              <footer className="pcap"><p className="prep"><span className="plab">Final report — verbatim</span><q>{lane.report}</q></p><span className="chip chip-pass">Passed</span></footer>
            </article>
          ))}

          <article className="panel" data-i="5">
            <header className="pbar"><span className="pl"><b className="pidx">05</b><span className="pname">bundle · evidence</span></span><span className="pr">.humanish/ · gitignored</span></header>
            <div className="pbody">
              <div className="ledger">
                <div className="lh">.humanish/drawdb-study-20260801-wide-05<span>4 lanes</span></div>
                <div className="lrow"><span className="ln"><em>├</em>screenshots</span><span className="ld">every screenshot each persona saw</span></div>
                <div className="lrow"><span className="ln"><em>├</em>action traces</span><span className="ld">ordered, end to end</span></div>
                <div className="lrow"><span className="ln"><em>├</em>lifecycle events</span><span className="ld">launch to landing</span></div>
                <div className="lrow"><span className="ln"><em>├</em>estimated cost</span><span className="ld">at dated rates · est —</span></div>
                <div className="lrow"><span className="ln"><em>└</em>wall-clock</span><span className="ld">— · not recorded</span></div>
              </div>
            </div>
            <footer className="pcap"><p className="prep"><span className="plab">Where it lands</span>The run lands in gitignored <code>.humanish/</code>: every screenshot each persona saw, ordered action traces, lifecycle events, and estimated cost at dated rates.</p></footer>
          </article>

          <article className="panel panel-dark" data-i="6">
            <header className="pbar"><span className="pl"><b className="pidx">06</b><span className="pname">verify · share-safety</span></span><span className="pr">fail-closed</span></header>
            <div className="pbody">
              <div className="vterm">
                <p className="vln vp">$ humanish verify</p>
                <p className="vln"><span className="vok">ok</span>  redaction passed</p>
                <p className="vln"><span className="vok">ok</span>  actor engagement: live actor traces that claim goal_satisfied carry at least one action or message</p>
                <p className="vln"><span className="vok">ok</span>  cost estimate labeling: estimates never presented as exact</p>
                <p className="vln vdim">… 12 more checks</p>
                <p className="vln vsum">15/15 passed → status: <span className="vok">share_ready</span></p>
              </div>
            </div>
            <footer className="pcap"><p className="prep"><span className="plab">The gate</span><code>humanish verify</code> grades the bundle fail-closed. This run: 15/15.</p><span className="chip chip-dot">share_ready</span></footer>
          </article>
        </div>
      </div>
    </div>
  );
}
