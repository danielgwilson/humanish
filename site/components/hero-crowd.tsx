"use client";

import { useEffect, useRef } from "react";
import { TH, curTheme, onThemeRedraw, prefersReducedMotion } from "@/lib/theme";

/**
 * HeroCrowd — the dash-field crowd behind the hero, ported verbatim from the
 * POC's initCrowd(): an offscreen luminance scene of abstract figures sampled
 * into horizontal dash strokes, IO-gated rAF loop, pointer hover lift,
 * theme-aware repaint. Reduced motion draws a single finished frame.
 * The CSS .crowd-fallback behind the canvas covers the no-JS case.
 */
export default function HeroCrowd() {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const cnv = wrap.querySelector("canvas");
    if (!cnv || !cnv.getContext) return;
    const ctx = cnv.getContext("2d");
    if (!ctx) return;
    const off = document.createElement("canvas");
    const octx = off.getContext("2d", { willReadFrequently: true });
    if (!octx) return;

    const rm = prefersReducedMotion();
    const hasIO = "IntersectionObserver" in window;
    const CELL = 9;
    let W = 0;
    let H = 0;
    let gw = 0;
    let gh = 0;
    interface Fig { x: number; y: number; s: number; ph: number; p: number; acc: boolean; acc2: boolean }
    let figs: Fig[] = [];
    let px = -1e4;
    let py = -1e4;
    const t0 = performance.now();
    let running = false;
    let raf = 0;
    let disposed = false;

    function size() {
      if (!wrap || !cnv || !ctx) return;
      const r = wrap.getBoundingClientRect();
      W = Math.max(1, r.width | 0);
      H = Math.max(1, r.height | 0);
      const d = Math.min(2, window.devicePixelRatio || 1);
      cnv.width = W * d;
      cnv.height = H * d;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      gw = Math.ceil(W / CELL);
      gh = Math.ceil(H / CELL);
      off.width = gw;
      off.height = gh;
      layout();
    }
    function layout() {
      figs = [];
      const rows = H > 420 ? 5 : 3;
      for (let r = 0; r < rows; r++) {
        const p = rows > 1 ? r / (rows - 1) : 1;
        const s = 0.62 + p * 1.05;
        const y = H * 0.05 + p * (H * 0.84);
        const gap = 88 * s;
        const n = Math.ceil(W / gap) + 2;
        for (let i = 0; i < n; i++) {
          const x = (i + (r % 2) * 0.5) * gap + ((r * 53 + i * 31) % 41) - 44;
          const jy = ((i * 29 + r * 17) % 23) - 11;
          figs.push({
            x,
            y: y + jy,
            s: s * (0.92 + ((i * 13 + r * 7) % 5) * 0.04),
            ph: r * 7 + i * 2.7,
            p,
            acc: ((r * 31 + i * 17) % 6) === 0,
            acc2: ((r * 13 + i * 11) % 7) === 0 && x > W * 0.55
          });
        }
      }
    }
    function scene(now: number) {
      if (!octx) return;
      const t = (now - t0) / 1000;
      const darkNow = curTheme() === "dark";
      octx.setTransform(1 / CELL, 0, 0, 1 / CELL, 0, 0);
      octx.fillStyle = "#070707";
      octx.fillRect(0, 0, W + CELL, H + CELL);
      for (let k = 0; k < figs.length; k++) {
        const f = figs[k]!;
        const s = f.s;
        const col = f.acc || (darkNow && f.acc2) ? "rgba(255,0,0," : "rgba(255,255,255,";
        const act = 0.78 + 0.18 * Math.sin(t * 1.5 + f.ph) * (0.5 + f.p * 0.5);
        octx.fillStyle = col + act.toFixed(3) + ")";
        octx.beginPath();
        octx.arc(f.x, f.y, 12.5 * s, 0, 7);
        octx.fill();
        octx.beginPath();
        octx.ellipse(f.x, f.y + 21 * s, 21 * s, 15 * s, 0, 0, 7);
        octx.fill();
        const g = 0.32 + 0.13 * Math.sin(t * 2.1 + f.ph * 1.7);
        octx.fillStyle = col + g.toFixed(3) + ")";
        octx.fillRect(f.x - 20 * s, f.y + 15 * s, 40 * s, 22 * s);
      }
    }
    function draw(now: number) {
      if (!ctx || !octx) return;
      scene(now);
      const d = octx.getImageData(0, 0, gw, gh).data;
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, W, H);
      const buckets: Record<string, number[]> = {};
      for (let y = 0; y < gh; y++) {
        const wob = Math.sin(t * 1.25 + y * 0.5) * 2.6;
        for (let x = 0; x < gw; x++) {
          const i4 = (y * gw + x) * 4;
          const R = d[i4] ?? 0;
          let L = R / 255;
          const cx = x * CELL + CELL / 2 + wob;
          const cy = y * CELL + CELL / 2;
          const dx = cx - px;
          const dy = cy - py;
          const d2 = dx * dx + dy * dy;
          let hov = 0;
          if (d2 < 12100) {
            hov = 1 - Math.sqrt(d2) / 110;
            L = Math.min(1, L + hov * 0.55);
          }
          if (L < 0.07) continue;
          const isAcc = (d[i4 + 1] ?? 0) < R * 0.55;
          const len = Math.min(CELL - 1.2, 1.1 + L * (CELL - 1.6));
          const th = L > 0.55 ? 3 : L > 0.26 ? 2 : 1;
          const key = (hov > 0.12 || isAcc ? "a" : "i") + th;
          const b = buckets[key] || (buckets[key] = []);
          b.push(cx - len / 2, cy, len);
        }
      }
      for (const key in buckets) {
        const arr = buckets[key]!;
        const th = +key.slice(1);
        ctx.beginPath();
        for (let j = 0; j < arr.length; j += 3) {
          ctx.moveTo(arr[j]!, arr[j + 1]!);
          ctx.lineTo(arr[j]! + arr[j + 2]!, arr[j + 1]!);
        }
        ctx.lineWidth = th === 3 ? 3.1 : th === 2 ? 2 : 1.1;
        ctx.lineCap = "round";
        ctx.strokeStyle =
          key[0] === "a" ? TH.accent : `rgba(${TH.ink},${Math.min(1, 0.38 + th * 0.22).toFixed(2)})`;
        ctx.stroke();
      }
    }

    const cleanups: Array<() => void> = [];
    size();
    const art = wrap.closest(".hero-art");
    if (art) art.classList.add("live");

    if (rm) {
      draw(t0 + 900);
      cleanups.push(onThemeRedraw(() => draw(t0 + 900)));
      const onResize = () => {
        size();
        draw(t0 + 900);
      };
      window.addEventListener("resize", onResize);
      cleanups.push(() => window.removeEventListener("resize", onResize));
    } else {
      const loop = (now: number) => {
        if (disposed) return;
        draw(now);
        raf = running ? requestAnimationFrame(loop) : 0;
      };
      if (hasIO) {
        const io = new IntersectionObserver(
          (e) => {
            running = e[0]?.isIntersecting ?? false;
            if (running && !raf) raf = requestAnimationFrame(loop);
          },
          { rootMargin: "80px" }
        );
        io.observe(cnv);
        cleanups.push(() => io.disconnect());
      } else {
        running = true;
        raf = requestAnimationFrame(loop);
      }
      cleanups.push(onThemeRedraw(() => {
        if (!running) draw(performance.now());
      }));
      const onMove = (e: PointerEvent) => {
        const r = cnv.getBoundingClientRect();
        px = e.clientX - r.left;
        py = e.clientY - r.top;
      };
      const onLeave = () => {
        px = py = -1e4;
      };
      cnv.addEventListener("pointermove", onMove);
      cnv.addEventListener("pointerleave", onLeave);
      window.addEventListener("resize", size);
      cleanups.push(() => {
        cnv.removeEventListener("pointermove", onMove);
        cnv.removeEventListener("pointerleave", onLeave);
        window.removeEventListener("resize", size);
      });
    }

    return () => {
      disposed = true;
      running = false;
      if (raf) cancelAnimationFrame(raf);
      cleanups.forEach((f) => f());
    };
  }, []);

  return (
    <div className="crowd-wrap" aria-hidden="true" ref={wrapRef}>
      <div className="crowd-fallback"></div>
      <canvas id="crowd"></canvas>
    </div>
  );
}
