"use client";

import { TH, onThemeRedraw } from "./theme";

/**
 * Resolve covers: a dash-texture veil drawn over each evidence screenshot
 * that "resolves" left-to-right into the real image, once, when its panel
 * becomes active. Ported from the POC's initCovers/resolveCover.
 *
 * Reduced motion never registers a cover (the POC removes them), so those
 * visitors see finished states: the plain screenshots.
 */

const CELL = 8;

interface CoverItem {
  c: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  n: string;
  p: number;
  done: boolean;
  built: boolean;
  anim: boolean;
  start: number;
  lum: Uint8ClampedArray | null;
  gw: number;
  gh: number;
  W: number;
  H: number;
}

const items: CoverItem[] = [];
const byCanvas = new WeakMap<HTMLCanvasElement, CoverItem>();
let raf = 0;
let wired = false;

function hash(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

function build(it: CoverItem): void {
  const parent = it.c.parentElement;
  if (!parent) return;
  const r = parent.getBoundingClientRect();
  it.W = Math.max(1, r.width | 0);
  it.H = Math.max(1, r.height | 0);
  const d = Math.min(2, window.devicePixelRatio || 1);
  it.c.width = it.W * d;
  it.c.height = it.H * d;
  it.ctx.setTransform(d, 0, 0, d, 0, 0);
  it.gw = Math.ceil(it.W / CELL);
  it.gh = Math.ceil(it.H / CELL);
  const o = document.createElement("canvas");
  o.width = it.gw;
  o.height = it.gh;
  const oc = o.getContext("2d", { willReadFrequently: true });
  if (!oc) return;
  oc.setTransform(1 / CELL, 0, 0, 1 / CELL, 0, 0);
  oc.fillStyle = "#101010";
  oc.fillRect(0, 0, it.W + CELL, it.H + CELL);
  const Wd = it.W;
  const Hd = it.H;
  oc.fillStyle = "rgba(255,255,255,0.86)";
  oc.beginPath();
  oc.arc(Wd * 0.33, Hd * 0.4, Hd * 0.145, 0, 7);
  oc.fill();
  oc.beginPath();
  oc.ellipse(Wd * 0.33, Hd * 0.86, Hd * 0.3, Hd * 0.26, 0, 0, 7);
  oc.fill();
  oc.fillStyle = "rgba(255,255,255,0.95)";
  // Canvas cannot resolve var(); read the concrete --mono stack (next/font
  // family names) so the digits render in Geist Mono like the POC.
  const mono =
    getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() ||
    'ui-monospace,"SF Mono",Menlo,Consolas,monospace';
  oc.font = `500 ${Hd * 0.46}px ${mono}`;
  oc.textBaseline = "middle";
  oc.textAlign = "center";
  oc.fillText(it.n, Wd * 0.66, Hd * 0.52);
  it.lum = oc.getImageData(0, 0, it.gw, it.gh).data;
  it.built = true;
}

function drawItem(it: CoverItem): void {
  if (!it.built) build(it);
  if (!it.lum) return;
  const ctx = it.ctx;
  ctx.clearRect(0, 0, it.W, it.H);
  for (let y = 0; y < it.gh; y++) {
    const wob = Math.sin(y * 0.55) * 2.1;
    for (let x = 0; x < it.gw; x++) {
      const h = (x / it.gw) * 0.72 + hash(x, y) * 0.28;
      if (h < it.p) continue;
      ctx.fillStyle = TH.cover;
      ctx.fillRect(x * CELL - 0.5, y * CELL - 0.5, CELL + 1, CELL + 1);
      const L = (it.lum[(y * it.gw + x) * 4] ?? 0) / 255;
      if (L < 0.07) continue;
      const len = Math.min(CELL - 1.4, 1 + L * (CELL - 1.8));
      const frontier = h < it.p + 0.07 && it.p > 0;
      ctx.strokeStyle = frontier ? TH.accent : `rgba(${TH.ink},${0.18 + L * 0.55})`;
      ctx.lineWidth = 0.9 + L * 1.9;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x * CELL + CELL / 2 - len / 2 + wob, y * CELL + CELL / 2);
      ctx.lineTo(x * CELL + CELL / 2 + len / 2 + wob, y * CELL + CELL / 2);
      ctx.stroke();
    }
  }
}

function tick(now: number): void {
  let any = false;
  items.forEach((it) => {
    if (!it.anim || it.done) return;
    const e = Math.min(1, (now - it.start) / 950);
    const k = e < 0.5 ? 4 * e * e * e : 1 - Math.pow(-2 * e + 2, 3) / 2;
    it.p = k * 1.14;
    if (e >= 1) {
      it.done = true;
      it.anim = false;
      it.c.remove();
      return;
    }
    drawItem(it);
    any = true;
  });
  raf = any ? requestAnimationFrame(tick) : 0;
}

function wire(): void {
  if (wired) return;
  wired = true;
  onThemeRedraw(() => {
    items.forEach((it) => {
      if (!it.done) drawItem(it);
    });
  });
  window.addEventListener("resize", () => {
    items.forEach((it) => {
      if (it.done) return;
      it.built = false;
      drawItem(it);
    });
  });
}

/** Register a cover canvas; draws the veil immediately. Returns an unregister fn. */
export function registerCover(c: HTMLCanvasElement, n: string): () => void {
  wire();
  const ctx = c.getContext("2d");
  if (!ctx) return () => {};
  const it: CoverItem = {
    c,
    ctx,
    n,
    p: 0,
    done: false,
    built: false,
    anim: false,
    start: 0,
    lum: null,
    gw: 0,
    gh: 0,
    W: 0,
    H: 0
  };
  byCanvas.set(c, it);
  items.push(it);
  drawItem(it);
  return () => {
    const i = items.indexOf(it);
    if (i !== -1) items.splice(i, 1);
    byCanvas.delete(c);
  };
}

/** Resolve a cover into its screenshot after `delay` ms; runs once per cover. */
export function resolveCover(c: HTMLCanvasElement | null, delay?: number): void {
  const it = c ? byCanvas.get(c) : undefined;
  if (!it || it.done || it.anim) return;
  setTimeout(() => {
    if (it.done || it.anim) return;
    it.anim = true;
    it.start = performance.now();
    if (!raf) raf = requestAnimationFrame(tick);
  }, delay || 0);
}
