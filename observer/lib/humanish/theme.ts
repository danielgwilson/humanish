"use client";

/**
 * Theme plumbing shared by every canvas island.
 *
 * Ported from the POC's theme block: canvases paint with the resolved values
 * of --crowd-ink / --accent-canvas / --cover-bg, so on any theme change they
 * re-read the tokens and repaint. The toggle writes data-theme on <html>
 * (persisted to localStorage by the toggle itself); the OS-level
 * prefers-color-scheme listener covers system flips while no explicit
 * choice is set.
 */

export const TH = { ink: "28,26,22", accent: "#2b3fd6", cover: "#ffffff" };

const redraws: Array<() => void> = [];
let wired = false;

export function themeVals(): void {
  const cs = getComputedStyle(document.documentElement);
  TH.ink = cs.getPropertyValue("--crowd-ink").trim() || TH.ink;
  TH.accent = cs.getPropertyValue("--accent-canvas").trim() || TH.accent;
  TH.cover = cs.getPropertyValue("--cover-bg").trim() || TH.cover;
}

export function curTheme(): "light" | "dark" {
  const a = document.documentElement.getAttribute("data-theme");
  if (a === "light" || a === "dark") return a;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function syncTheme(): void {
  themeVals();
  redraws.forEach((f) => f());
}

export function onThemeRedraw(fn: () => void): () => void {
  wire();
  redraws.push(fn);
  return () => {
    const i = redraws.indexOf(fn);
    if (i !== -1) redraws.splice(i, 1);
  };
}

function wire(): void {
  if (wired) return;
  wired = true;
  themeVals();
  const mqDark = window.matchMedia("(prefers-color-scheme: dark)");
  if (mqDark.addEventListener) mqDark.addEventListener("change", syncTheme);
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
