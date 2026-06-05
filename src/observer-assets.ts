// Mimetic Observer: client assets (CSS + browser JS).
//
// This file is the redesigned Observer surface ported from the Claude Design
// handoff (HTML/CSS/JS prototype) into the repo's self-contained renderer.
// `observer.ts` injects `observerCss()` into a <style> and `observerClientJs()`
// into a <script>, then hydrates from an embedded `observer-data.v1` JSON blob
// and polls `observer-data.json` (served mode) for live updates.
//
// IMPORTANT: `observerClientJs()` runs verbatim in the browser. It is emitted
// from a TS template literal, so it intentionally avoids backticks, `${`, and
// backslash escapes; literal UTF-8 characters and `String.fromCharCode` are
// used instead. Keep it that way when editing.

export function observerCss(): string {
  return `
/* ============================================================
   Mimetic Observer · redesign
   Design tokens + shell. Dark is default; [data-theme="light"]
   on <html> flips the palette. All accent/status colors are
   semantic tokens so the whole UI re-themes from one place.
   ============================================================ */

:root {
  /* surfaces */
  --bg: #0a0b0d;
  --surface-0: #0d0f12;
  --surface-1: #14171b;
  --surface-2: #1a1e23;
  --surface-3: #232830;
  --stream-void: #050608;

  /* hairlines */
  --line: rgba(255, 255, 255, 0.065);
  --line-2: rgba(255, 255, 255, 0.11);
  --line-3: rgba(255, 255, 255, 0.18);

  /* text */
  --text-1: #f2f4f6;
  --text-2: #a6aeb6;
  --text-3: #6d747d;
  --text-4: #464c54;

  /* brand + status */
  --accent: #4d7cfe;
  --accent-2: #7ea6ff;
  --accent-ink: #cdddff;
  --cyan: #41c8e6;
  --green: #34d399;
  --teal: #2dc3a6;
  --amber: #f0a92b;
  --red: #fb5d52;
  --violet: #a78bfa;

  --accent-soft: color-mix(in oklab, var(--accent) 18%, transparent);
  --green-soft: color-mix(in oklab, var(--green) 16%, transparent);
  --amber-soft: color-mix(in oklab, var(--amber) 16%, transparent);
  --red-soft: color-mix(in oklab, var(--red) 16%, transparent);
  --cyan-soft: color-mix(in oklab, var(--cyan) 16%, transparent);

  --radius: 10px;
  --radius-sm: 7px;
  --radius-lg: 16px;
  --radius-pill: 999px;

  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-2: 0 8px 30px rgba(0, 0, 0, 0.4);
  --shadow-pop: 0 20px 60px rgba(0, 0, 0, 0.55);

  --sans: "Geist", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "Geist Mono", ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace;

  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --header-h: 54px;
  --toolbar-h: 50px;

  --tile-min: 380px;
  --accent-color: var(--accent); /* overridable by Tweaks */
}

html[data-theme="light"] {
  --bg: #eef0f3;
  --surface-0: #f6f7f9;
  --surface-1: #ffffff;
  --surface-2: #ffffff;
  --surface-3: #eceef2;
  --stream-void: #0b0d10;
  --line: rgba(15, 20, 30, 0.09);
  --line-2: rgba(15, 20, 30, 0.14);
  --line-3: rgba(15, 20, 30, 0.22);
  --text-1: #14171c;
  --text-2: #525a64;
  --text-3: #828a94;
  --text-4: #aeb5bd;
  --shadow-1: 0 1px 2px rgba(20, 28, 40, 0.08);
  --shadow-2: 0 8px 30px rgba(20, 28, 40, 0.12);
  --shadow-pop: 0 20px 60px rgba(20, 28, 40, 0.22);
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  height: 100%;
  overflow: hidden;
}

body {
  background: var(--bg);
  color: var(--text-1);
  font-family: var(--sans);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

button { font-family: inherit; cursor: pointer; color: inherit; background: none; border: none; }
a { color: inherit; text-decoration: none; }

:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
  border-radius: 4px;
}

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: var(--line-3); background-clip: padding-box; }

.mono { font-family: var(--mono); font-feature-settings: "tnum" 1, "zero" 1; }
.eyebrow {
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-3);
}

/* ============================================================ APP SHELL */
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  position: relative;
}
.hdr, .toolbar { flex: none; }
.stage { flex: 1 1 0; }

/* top-edge run progress line */
.runline {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  z-index: 60;
  background: transparent;
  pointer-events: none;
}
.runline > span {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--accent-color), var(--accent-2));
  box-shadow: 0 0 12px color-mix(in oklab, var(--accent-color) 70%, transparent);
  transition: width 900ms var(--ease-out);
  border-radius: 0 2px 2px 0;
}
.runline[data-status="failed"] > span { background: linear-gradient(90deg, var(--red), #ff8b82); box-shadow: 0 0 12px var(--red-soft); }
.runline[data-status="passed"] > span,
.runline[data-status="complete"] > span { background: linear-gradient(90deg, var(--green), #7ef0c4); box-shadow: 0 0 12px var(--green-soft); }

/* ============================================================ HEADER */
.hdr {
  display: flex;
  align-items: center;
  gap: 14px;
  height: var(--header-h);
  padding: 0 16px;
  background: var(--surface-0);
  border-bottom: 1px solid var(--line);
  position: relative;
  z-index: 40;
}
.hdr-brand { display: flex; align-items: center; gap: 10px; flex: none; }
.brand-mark {
  width: 26px; height: 26px; border-radius: 8px;
  display: grid; place-items: center;
  background: radial-gradient(circle at 30% 25%, color-mix(in oklab, var(--accent-color) 55%, transparent), transparent 70%), var(--surface-2);
  border: 1px solid var(--line-2);
  position: relative;
  overflow: hidden;
  color: var(--accent-ink);
}
.brand-mark svg { width: 16px; height: 16px; }
.brand-word { font-size: 13px; font-weight: 600; letter-spacing: -0.01em; }
.brand-word b { color: var(--accent-color); font-weight: 600; }

.hdr-run {
  display: flex; flex-direction: column; gap: 1px; min-width: 0;
  padding-left: 14px; margin-left: 2px;
  border-left: 1px solid var(--line);
}
.hdr-run-title {
  font-size: 13.5px; font-weight: 560; color: var(--text-1);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 42vw;
  letter-spacing: -0.01em;
}
.hdr-run-sub {
  display: flex; align-items: center; gap: 7px;
  font-size: 11px; color: var(--text-3); min-width: 0;
}
.hdr-run-sub .dot-sep { width: 2.5px; height: 2.5px; border-radius: 50%; background: var(--text-4); flex: none; }
.hdr-persona { color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.run-chip {
  font-family: var(--mono); font-size: 10px; color: var(--text-3);
  background: var(--surface-2); border: 1px solid var(--line);
  padding: 1px 6px; border-radius: var(--radius-sm); cursor: pointer;
  white-space: nowrap; transition: border-color .15s, color .15s;
}
.run-chip:hover { border-color: var(--line-3); color: var(--text-1); }

.hdr-spacer { flex: 1; }

/* status pill */
.status-pill {
  display: inline-flex; align-items: center; gap: 8px;
  height: 30px; padding: 0 12px 0 11px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  border: 1px solid var(--line-2);
  font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--text-1); flex: none;
}
.status-pill[data-tone="running"]  { background: var(--accent-soft); border-color: color-mix(in oklab, var(--accent) 35%, transparent); color: var(--accent-ink); }
.status-pill[data-tone="passed"], .status-pill[data-tone="complete"] { background: var(--green-soft); border-color: color-mix(in oklab, var(--green) 35%, transparent); color: color-mix(in oklab, var(--green) 70%, white); }
.status-pill[data-tone="blocked"] { background: var(--amber-soft); border-color: color-mix(in oklab, var(--amber) 35%, transparent); color: color-mix(in oklab, var(--amber) 80%, white); }
.status-pill[data-tone="failed"]  { background: var(--red-soft); border-color: color-mix(in oklab, var(--red) 35%, transparent); color: color-mix(in oklab, var(--red) 75%, white); }
.status-pill .pct { color: inherit; opacity: .65; }

/* lane counts */
.lane-counts { display: flex; align-items: center; gap: 2px; flex: none; }
.lane-count {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 9px; border-radius: var(--radius-sm);
  font-family: var(--mono); font-size: 11px; color: var(--text-2);
  transition: background .15s;
}
.lane-count:hover { background: var(--surface-2); }
.lane-count b { color: var(--text-1); font-weight: 600; }
.lane-count[data-dim="true"] { opacity: .4; }

.icon-btn {
  width: 32px; height: 32px; border-radius: var(--radius-sm);
  display: grid; place-items: center; color: var(--text-2);
  border: 1px solid transparent; transition: background .15s, color .15s, border-color .15s; flex: none;
}
.icon-btn:hover { background: var(--surface-2); color: var(--text-1); }
.icon-btn[aria-pressed="true"] { background: var(--surface-3); color: var(--text-1); border-color: var(--line-2); }
.icon-btn svg { width: 17px; height: 17px; }

.hdr-runs {
  display: inline-flex; align-items: center; gap: 7px;
  height: 32px; padding: 0 12px; border-radius: var(--radius-sm);
  border: 1px solid var(--line-2); color: var(--text-2);
  font-size: 12px; transition: background .15s, color .15s; flex: none;
}
.hdr-runs:hover { background: var(--surface-2); color: var(--text-1); }
.hdr-runs svg { width: 15px; height: 15px; }

/* ============================================================ TOOLBAR */
.toolbar {
  display: flex; align-items: center; gap: 10px;
  height: var(--toolbar-h); padding: 0 16px;
  background: var(--surface-0); border-bottom: 1px solid var(--line);
  position: relative; z-index: 30;
  overflow-x: auto; overflow-y: hidden;
  scrollbar-width: none;
}
.toolbar::-webkit-scrollbar { display: none; }

.filter-group { display: flex; align-items: center; gap: 3px; flex: none; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px; border-radius: var(--radius-pill);
  border: 1px solid var(--line); color: var(--text-2);
  font-size: 11.5px; white-space: nowrap;
  transition: background .15s, color .15s, border-color .15s;
}
.chip:hover { border-color: var(--line-2); color: var(--text-1); }
.chip[aria-pressed="true"] { background: var(--surface-3); color: var(--text-1); border-color: var(--line-2); }
.chip .chip-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.chip .chip-n { font-family: var(--mono); font-size: 10.5px; color: var(--text-3); }
.chip[aria-pressed="true"] .chip-n { color: var(--text-2); }

.tb-sep { width: 1px; height: 22px; background: var(--line); flex: none; }
.tb-spacer { flex: 1; min-width: 8px; }

/* search */
.tb-search {
  display: flex; align-items: center; gap: 7px;
  height: 28px; padding: 0 10px; border-radius: var(--radius-sm);
  border: 1px solid var(--line); color: var(--text-3); flex: none;
  min-width: 150px; transition: border-color .15s;
}
.tb-search:focus-within { border-color: var(--line-3); }
.tb-search svg { width: 14px; height: 14px; flex: none; }
.tb-search input {
  background: none; border: none; color: var(--text-1); font-family: var(--sans);
  font-size: 12px; width: 100%; outline: none;
}
.tb-search input::placeholder { color: var(--text-4); }

/* segmented control (density, media, view) */
.seg {
  display: inline-flex; align-items: center; padding: 2px;
  background: var(--surface-1); border: 1px solid var(--line); border-radius: var(--radius-sm); flex: none;
}
.seg button {
  display: inline-flex; align-items: center; gap: 6px;
  height: 24px; padding: 0 9px; border-radius: 5px;
  font-size: 11px; color: var(--text-3); white-space: nowrap;
  transition: color .15s, background .15s;
}
.seg button svg { width: 14px; height: 14px; }
.seg button:hover { color: var(--text-1); }
.seg button[aria-pressed="true"] { background: var(--surface-3); color: var(--text-1); box-shadow: var(--shadow-1); }
.seg button:disabled { opacity: .4; cursor: not-allowed; }

.tb-label { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-4); font-family: var(--mono); flex: none; }

/* ============================================================ GRID */
.stage { position: relative; min-height: 0; overflow: hidden; }
.grid-scroll { height: 100%; overflow-y: auto; overflow-x: hidden; padding: 16px; }
.grid {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(auto-fill, minmax(min(var(--tile-min), 100%), 1fr));
  align-content: start;
}

.tile {
  display: flex; flex-direction: column;
  background: var(--surface-1);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
  cursor: pointer;
  position: relative;
  transition: border-color .18s var(--ease), transform .18s var(--ease), box-shadow .18s var(--ease);
}
.tile:hover { border-color: var(--line-3); transform: translateY(-2px); box-shadow: var(--shadow-2); }
.tile:hover .tile-open { opacity: 1; transform: none; }
.tile[data-selected="true"] { border-color: color-mix(in oklab, var(--accent) 60%, transparent); box-shadow: 0 0 0 1px color-mix(in oklab, var(--accent) 45%, transparent); }

.tile-head {
  display: flex; align-items: center; gap: 8px;
  padding: 0 10px; height: 32px; flex: none;
  border-bottom: 1px solid var(--line);
  background: var(--surface-1);
}
.tile-idx { font-family: var(--mono); font-size: 10px; color: var(--text-4); flex: none; }
.tile-name { font-size: 12px; font-weight: 520; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.kind-badge {
  font-family: var(--mono); font-size: 9px; letter-spacing: .08em; text-transform: uppercase;
  padding: 2px 6px; border-radius: 5px; flex: none;
  background: var(--surface-3); color: var(--text-2);
}
.kind-badge[data-kind="ui"], .kind-badge[data-kind="browser"] { color: var(--violet); background: color-mix(in oklab, var(--violet) 14%, transparent); }
.kind-badge[data-kind="terminal"] { color: var(--green); background: var(--green-soft); }
.kind-badge[data-kind="tui"] { color: var(--cyan); background: var(--cyan-soft); }
.kind-badge[data-kind="codex-ui"] { color: var(--accent-2); background: var(--accent-soft); }
.tile-dims { font-family: var(--mono); font-size: 9px; color: var(--text-4); flex: none; }
.tile-open {
  width: 22px; height: 22px; border-radius: 5px; display: grid; place-items: center;
  color: var(--text-2); background: var(--surface-2); border: 1px solid var(--line-2);
  opacity: 0; transform: translateX(3px); transition: opacity .15s, transform .15s; flex: none;
}
.tile-open svg { width: 13px; height: 13px; }

/* status pip */
.pip { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--text-4); position: relative; }
.pip[data-status="queued"]   { background: var(--text-4); }
.pip[data-status="preparing"]{ background: var(--cyan); }
.pip[data-status="running"]  { background: var(--accent); }
.pip[data-status="passed"], .pip[data-status="complete"] { background: var(--green); }
.pip[data-status="contract_proof_only"] { background: var(--teal); }
.pip[data-status="blocked"], .pip[data-status="timed_out"] { background: var(--amber); }
.pip[data-status="failed"]   { background: var(--red); }
.pip[data-live="true"]::after {
  content: ""; position: absolute; inset: -3px; border-radius: 50%;
  background: currentColor; opacity: .35; animation: ping 1.6s var(--ease-out) infinite;
}
.pip[data-status="running"][data-live="true"] { color: var(--accent); }
.pip[data-status="preparing"][data-live="true"] { color: var(--cyan); }

.tile-surface {
  position: relative; background: var(--stream-void);
  aspect-ratio: var(--aspect, 16 / 9);
  width: 100%; overflow: hidden; flex: none;
}
.tile-foot {
  display: flex; align-items: center; gap: 8px;
  padding: 0 10px; height: 30px; flex: none;
  border-top: 1px solid var(--line); background: var(--surface-1);
}
.tile-foot-text { font-size: 11px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.tile-foot-text .now-dot { color: var(--accent); margin-right: 6px; }
.mini-prog { width: 46px; height: 3px; border-radius: 2px; background: var(--line); overflow: hidden; flex: none; }
.mini-prog > span { display: block; height: 100%; background: var(--accent); transition: width .6s var(--ease-out); }
.tile-foot[data-status="failed"] .mini-prog > span { background: var(--red); }
.tile-foot[data-status="blocked"] .mini-prog > span,
.tile-foot[data-status="timed_out"] .mini-prog > span { background: var(--amber); }
.tile-foot[data-status="passed"] .mini-prog > span,
.tile-foot[data-status="complete"] .mini-prog > span,
.tile-foot[data-status="contract_proof_only"] .mini-prog > span { background: var(--green); }

/* ============================================================ STREAM SURFACES */
.surface-fill { position: absolute; inset: 0; width: 100%; height: 100%; }
.live-stream-mount { position: absolute; inset: 0; overflow: hidden; background: #000; }
.live-stream-overlay { position: absolute; overflow: hidden; pointer-events: none; z-index: 2; }
.live-stream-overlay[data-focus="true"] .bw-lab-dock { max-height: 86px; }
.live-stream-overlay[data-focus="true"] .bw-chip-v { max-width: min(420px, 38vw); }

/* browser/ui mock */
.bw { position: absolute; inset: 0; display: flex; flex-direction: column; background: #0b0d10; }
.bw-chrome {
  display: flex; align-items: center; gap: 6px; padding: 0 9px; height: 26px; flex: none;
  background: #16181c; border-bottom: 1px solid rgba(255,255,255,.06);
}
.bw-dots { display: flex; gap: 4px; }
.bw-dots i { width: 7px; height: 7px; border-radius: 50%; background: #353a40; }
.bw-url {
  flex: 1; height: 16px; border-radius: 4px; background: #0d0f12; border: 1px solid rgba(255,255,255,.06);
  display: flex; align-items: center; padding: 0 7px; gap: 5px;
  font-family: var(--mono); font-size: 8.5px; color: #6f767e; min-width: 0;
}
.bw-url svg { width: 8px; height: 8px; flex: none; }
.bw-url span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bw-viewport { flex: 1; position: relative; overflow: hidden; background: #fbfcfd; }
.bw-app-wait { position: absolute; inset: 0; display: grid; place-items: center; align-content: center; gap: 8px; background: #fbfcfd; color: #5a626c; text-align: center; padding: 16px; }
.bw-app-wait .wait-spinner { border-color: rgba(20,28,40,.12); border-top-color: var(--accent); }
.bw-lab-dock {
  position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 8;
  display: flex; align-items: flex-end; gap: 5px; flex-wrap: wrap;
  max-height: 54px; overflow: hidden; pointer-events: none;
}
.bw-lab-chip {
  min-width: 0; max-width: 100%; pointer-events: auto;
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 7px; border-radius: 6px;
  background: rgba(8,10,13,.78); backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,.12);
  color: var(--text-2); box-shadow: var(--shadow-1);
}
a.bw-lab-chip:hover { border-color: rgba(255,255,255,.22); color: var(--text-1); }
.bw-lab-chip[data-tone="live"] { color: var(--accent-2); border-color: color-mix(in oklab, var(--accent) 35%, transparent); }
.bw-lab-chip[data-tone="ok"] { color: var(--green); border-color: color-mix(in oklab, var(--green) 34%, transparent); }
.bw-lab-chip[data-tone="warn"] { color: var(--amber); border-color: color-mix(in oklab, var(--amber) 34%, transparent); }
.bw-lab-chip[data-tone="err"] { color: var(--red); border-color: color-mix(in oklab, var(--red) 34%, transparent); }
.bw-chip-k {
  flex: none; font-family: var(--mono); font-size: 8.5px; letter-spacing: .08em;
  text-transform: uppercase; color: currentColor;
}
.bw-chip-v {
  min-width: 0; max-width: min(240px, 42vw);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--mono); font-size: 9px; color: var(--text-2);
}
.focus-stage-area .bw-lab-dock { max-height: 86px; }
.focus-stage-area .bw-chip-v { max-width: min(420px, 38vw); }
.bw-cursor {
  position: absolute; width: 16px; height: 16px; z-index: 5; pointer-events: none;
  transition: left 1.1s var(--ease), top 1.1s var(--ease);
  filter: drop-shadow(0 1px 2px rgba(0,0,0,.4));
}
.bw-click {
  position: absolute; width: 26px; height: 26px; border-radius: 50%; z-index: 4;
  border: 2px solid var(--accent); margin: -13px 0 0 -13px; pointer-events: none;
  animation: clickpulse 1.4s var(--ease-out) infinite;
}

/* the fake app being driven */
.app-mock { position: absolute; inset: 0; padding: 14px; color: #1a1d22; font-size: 10px; }
.app-mock .am-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.am-logo { display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 11px; color: #14171c; }
.am-logo i { width: 14px; height: 14px; border-radius: 4px; background: linear-gradient(135deg, var(--accent), var(--violet)); }
.am-nav { display: flex; gap: 10px; color: #8a929b; font-size: 9px; }
.am-h { font-size: 16px; font-weight: 700; letter-spacing: -0.02em; color: #11141a; margin: 6px 0 3px; }
.am-p { color: #6a727b; line-height: 1.45; max-width: 80%; }
.am-field { margin-top: 10px; height: 26px; border-radius: 6px; border: 1px solid #e2e6ea; background: #fff; display: flex; align-items: center; padding: 0 9px; color: #9aa0a8; font-size: 9px; }
.am-field[data-focus="true"] { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 18%, transparent); }
.am-btn { margin-top: 9px; height: 28px; border-radius: 7px; background: #11141a; color: #fff; display: inline-flex; align-items: center; padding: 0 16px; font-size: 10px; font-weight: 600; }
.am-btn[data-variant="accent"] { background: var(--accent); }
.am-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
.am-card { border: 1px solid #e6e9ed; border-radius: 8px; padding: 9px; background: #fff; }
.am-card .am-ck { height: 5px; width: 40%; background: #e9edf1; border-radius: 3px; margin-bottom: 6px; }
.am-card .am-cl { height: 4px; width: 80%; background: #f0f3f6; border-radius: 3px; margin-bottom: 4px; }

/* terminal */
.term { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--stream-void); font-family: var(--mono); }
.term-bar { display: flex; align-items: center; gap: 7px; padding: 0 10px; height: 24px; flex: none; background: rgba(255,255,255,.03); border-bottom: 1px solid var(--line); }
.term-bar .tprompt { color: var(--green); font-size: 11px; }
.term-bar .ttitle { flex: 1; font-size: 10px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.term-bar .tstat { font-size: 8.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-3); }
.term-body { flex: 1; min-height: 0; overflow: hidden; padding: 9px 10px; font-size: 11px; line-height: 1.55; display: flex; flex-direction: column; justify-content: flex-end; }
.focus-stage-area .term-body { justify-content: flex-start; overflow-y: auto; font-size: 12.5px; }
.term-line { display: flex; gap: 9px; white-space: pre-wrap; overflow-wrap: anywhere; animation: line-in .25s var(--ease-out) both; }
.term-num { color: var(--text-4); flex: none; width: 18px; text-align: right; user-select: none; }
.term-txt { color: var(--text-2); }
.term-txt.ok { color: var(--green); }
.term-txt.warn { color: var(--amber); }
.term-txt.err { color: var(--red); }
.term-txt.cmd { color: var(--text-1); }
.term-txt.dim { color: var(--text-3); }
.term-caret { display: inline-block; width: 7px; height: 13px; background: var(--green); vertical-align: middle; animation: blink 1.1s steps(2) infinite; margin-left: 2px; }

/* codex agent session */
.codex { position: absolute; inset: 0; display: flex; flex-direction: column; background: #0c0e11; }
.codex-bar { display: flex; align-items: center; gap: 7px; padding: 0 10px; height: 26px; flex: none; background: #131519; border-bottom: 1px solid var(--line); font-family: var(--mono); font-size: 9px; color: var(--text-3); }
.codex-bar .cx-spark { color: var(--accent-2); display: inline-flex; }
.codex-body { flex: 1; min-height: 0; overflow: hidden; padding: 11px; display: flex; flex-direction: column; gap: 8px; }
.focus-stage-area .codex-body { overflow-y: auto; }
.cx-msg { max-width: 86%; padding: 7px 10px; border-radius: 10px; font-size: 10.5px; line-height: 1.45; animation: line-in .3s var(--ease-out) both; }
.cx-msg.user { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 3px; }
.cx-msg.agent { align-self: flex-start; background: var(--surface-2); color: var(--text-1); border: 1px solid var(--line); border-bottom-left-radius: 3px; }
.cx-tool { align-self: flex-start; display: inline-flex; align-items: center; gap: 7px; font-family: var(--mono); font-size: 9.5px; color: var(--text-3); padding: 5px 9px; border-radius: 7px; border: 1px solid var(--line); background: var(--surface-1); }
.cx-tool .cx-spin { width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid var(--line-3); border-top-color: var(--accent); animation: spin 1s linear infinite; flex: none; }
.cx-tool svg { width: 12px; height: 12px; color: var(--green); }

/* waiting / proof / empty surface */
.wait { position: absolute; inset: 0; display: grid; place-items: center; background:
  radial-gradient(circle at 50% 38%, color-mix(in oklab, var(--accent) 12%, transparent), transparent 42%),
  repeating-linear-gradient(0deg, transparent 0 26px, color-mix(in oklab, white 3%, transparent) 26px 27px);
  text-align: center; padding: 16px;
}
.wait-inner { display: grid; justify-items: center; gap: 11px; max-width: 80%; }
.wait-spinner { width: 30px; height: 30px; border-radius: 50%; border: 2px solid var(--line-2); border-top-color: var(--accent); animation: spin 1.1s linear infinite; }
.wait-icon { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 9px; background: var(--surface-2); border: 1px solid var(--line-2); }
.wait-icon svg { width: 18px; height: 18px; }
.wait-icon[data-tone="amber"] { color: var(--amber); border-color: color-mix(in oklab, var(--amber) 35%, transparent); }
.wait-icon[data-tone="red"] { color: var(--red); border-color: color-mix(in oklab, var(--red) 35%, transparent); }
.wait-icon[data-tone="green"] { color: var(--green); border-color: color-mix(in oklab, var(--green) 35%, transparent); }
.wait-title { font-family: var(--mono); font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-1); }
.wait-sub { font-size: 11px; color: var(--text-3); line-height: 1.5; }

/* tile live tag overlay */
.live-tag {
  position: absolute; top: 8px; right: 8px; z-index: 6;
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 8px; border-radius: var(--radius-pill);
  background: rgba(8,10,13,.7); backdrop-filter: blur(8px);
  border: 1px solid var(--line-2);
  font-family: var(--mono); font-size: 8.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-1);
}

/* ============================================================ FOCUS VIEW */
.focus {
  display: grid;
  grid-template-columns: var(--rail-w, 188px) 1fr var(--side-w, 360px);
  height: 100%; min-height: 0;
}
.focus[data-rail="collapsed"] { --rail-w: 0px; }

/* breadcrumb bar lives in the stage column header */
.focus-rail {
  background: var(--surface-0); border-right: 1px solid var(--line);
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
  transition: width .2s var(--ease);
}
.focus-rail-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px 8px; }
.focus-rail-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 12px; display: flex; flex-direction: column; gap: 4px; }
.rail-item {
  display: flex; align-items: center; gap: 9px; padding: 8px 9px; border-radius: var(--radius-sm);
  text-align: left; width: 100%; transition: background .14s; position: relative;
}
.rail-item:hover { background: var(--surface-2); }
.rail-item[data-selected="true"] { background: var(--surface-3); }
.rail-item[data-selected="true"]::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 2px; border-radius: 2px; background: var(--accent); }
.rail-thumb { width: 40px; height: 26px; border-radius: 5px; background: var(--stream-void); border: 1px solid var(--line); flex: none; overflow: hidden; position: relative; display: grid; place-items: center; color: var(--text-3); }
.rail-meta { min-width: 0; flex: 1; }
.rail-name { font-size: 11.5px; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rail-sub { font-family: var(--mono); font-size: 9px; color: var(--text-3); display: flex; align-items: center; gap: 5px; }

.focus-stage { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg); }
.focus-bar {
  display: flex; align-items: center; gap: 12px; padding: 0 14px; height: 46px; flex: none;
  background: var(--surface-0); border-bottom: 1px solid var(--line);
}
.crumbs { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-3); min-width: 0; }
.crumbs button { color: var(--text-3); transition: color .15s; white-space: nowrap; }
.crumbs button:hover { color: var(--text-1); }
.crumbs .sep { color: var(--text-4); }
.crumbs .cur { color: var(--text-1); font-weight: 520; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.crumbs .crumb-rail-toggle { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 6px; border: 1px solid var(--line-2); }
.crumbs .crumb-rail-toggle:hover { background: var(--surface-2); }
.crumbs .crumb-rail-toggle svg { width: 15px; height: 15px; }
.focus-status { display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px; border-radius: var(--radius-pill); font-family: var(--mono); font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; background: var(--surface-2); border: 1px solid var(--line-2); }
.focus-nav { display: flex; align-items: center; gap: 2px; }
.focus-stepper { font-family: var(--mono); font-size: 10px; color: var(--text-3); padding: 0 4px; }

.focus-stage-area { flex: 1; min-height: 0; min-width: 0; display: grid; place-items: center; padding: 22px; overflow: auto; position: relative; }
.focus-frame {
  position: relative; background: var(--stream-void); border-radius: var(--radius-lg);
  border: 1px solid var(--line-2); box-shadow: var(--shadow-pop); overflow: hidden;
  aspect-ratio: var(--aspect, 16 / 9);
  max-width: 100%; max-height: 100%;
  width: auto; height: 100%;
}
@supports not (aspect-ratio: 1) { .focus-frame { height: 100%; width: 100%; } }

/* side panel */
.focus-side { background: var(--surface-0); border-left: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.side-context { flex: none; padding: 16px; border-bottom: 1px solid var(--line); }
.side-persona-row { display: flex; align-items: center; gap: 10px; }
.side-avatar { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; background: var(--surface-2); border: 1px solid var(--line-2); color: var(--accent-2); font-weight: 600; font-size: 13px; flex: none; }
.side-persona-name { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.side-persona-id { font-family: var(--mono); font-size: 10px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.side-goal { margin-top: 13px; }
.side-goal-text { font-size: 12.5px; color: var(--text-2); margin-top: 4px; line-height: 1.5; }
.side-now { margin-top: 13px; padding: 10px 11px; border-radius: var(--radius-sm); background: var(--surface-1); border: 1px solid var(--line); }
.side-now-row { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
.side-now-text { font-size: 12.5px; color: var(--text-1); line-height: 1.45; }

.side-tabs { display: flex; flex: none; padding: 0 8px; gap: 2px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
.side-tabs::-webkit-scrollbar { display: none; }
.side-tab { display: inline-flex; align-items: center; gap: 6px; padding: 11px 10px; font-size: 11.5px; color: var(--text-3); border-bottom: 2px solid transparent; white-space: nowrap; transition: color .15s; }
.side-tab:hover { color: var(--text-1); }
.side-tab[aria-selected="true"] { color: var(--text-1); border-bottom-color: var(--accent); }
.side-tab .tab-n { font-family: var(--mono); font-size: 9.5px; padding: 1px 5px; border-radius: 999px; background: var(--surface-3); color: var(--text-2); }
.side-body { flex: 1; min-height: 0; overflow-y: auto; }

.evt { display: grid; grid-template-columns: auto 1fr; gap: 11px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.evt-rail { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.evt-icon { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; background: var(--surface-2); border: 1px solid var(--line); flex: none; }
.evt-icon svg { width: 12px; height: 12px; color: var(--text-3); }
.evt[data-level="warn"] .evt-icon { color: var(--amber); border-color: color-mix(in oklab, var(--amber) 30%, transparent); }
.evt[data-level="warn"] .evt-icon svg { color: var(--amber); }
.evt[data-level="error"] .evt-icon { color: var(--red); border-color: color-mix(in oklab, var(--red) 30%, transparent); }
.evt[data-level="error"] .evt-icon svg { color: var(--red); }
.evt-conn { flex: 1; width: 1px; background: var(--line); min-height: 8px; }
.evt-text { font-size: 12px; color: var(--text-1); line-height: 1.45; }
.evt-meta { font-family: var(--mono); font-size: 9.5px; color: var(--text-3); margin-top: 4px; letter-spacing: .04em; display: flex; gap: 7px; flex-wrap: wrap; }
.evt-type { color: var(--text-2); }

.file-row { display: flex; align-items: center; gap: 11px; padding: 11px 16px; border-bottom: 1px solid var(--line); transition: background .14s; }
.file-row:hover { background: var(--surface-1); }
.file-row[data-selected="true"] { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--accent); }
.file-row > button, .file-row > a:not(.file-open) { display: flex; align-items: center; gap: 11px; min-width: 0; flex: 1; text-align: left; }
.file-ic { width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center; background: var(--surface-2); border: 1px solid var(--line); color: var(--text-2); flex: none; }
.file-ic svg { width: 14px; height: 14px; }
.file-meta { min-width: 0; flex: 1; }
.file-name { font-size: 12.5px; color: var(--text-1); }
.file-path { font-family: var(--mono); font-size: 9.5px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.file-kind { font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-3); padding: 2px 7px; border-radius: 5px; background: var(--surface-2); flex: none; }
.file-open { font-family: var(--mono); font-size: 9px; color: var(--accent-2); padding: 3px 6px; border-radius: 5px; border: 1px solid var(--line); flex: none; }
.file-open:hover { background: var(--surface-3); }
.file-inspector { border-bottom: 1px solid var(--line); background: var(--surface-1); }
.fi-head { padding: 14px 16px 12px; border-bottom: 1px solid var(--line); }
.fi-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.fi-title h3 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: -0.01em; }
.fi-status { font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: .08em; padding: 2px 7px; border-radius: 999px; background: var(--surface-3); color: var(--text-2); }
.fi-status[data-status="passed"] { background: var(--green-soft); color: var(--green); }
.fi-status[data-status="needs_review"], .fi-status[data-status="blocked"] { background: var(--amber-soft); color: var(--amber); }
.fi-summary { margin-top: 7px; color: var(--text-2); font-size: 11.5px; line-height: 1.45; }
.fi-section { padding: 12px 16px; border-bottom: 1px solid var(--line); }
.fi-section:last-child { border-bottom: 0; }
.fi-section-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.fi-section-title span:first-child { font-family: var(--mono); font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-3); }
.fi-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.fi-stat { padding: 8px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-0); min-width: 0; }
.fi-stat-k { font-family: var(--mono); font-size: 8.5px; color: var(--text-3); text-transform: uppercase; letter-spacing: .08em; }
.fi-stat-v { margin-top: 2px; font-size: 13px; font-weight: 600; color: var(--text-1); overflow-wrap: anywhere; }
.fi-check { display: grid; grid-template-columns: auto 1fr; gap: 8px; padding: 8px 0; border-top: 1px solid var(--line); }
.fi-check:first-child { border-top: 0; padding-top: 0; }
.fi-dot { width: 18px; height: 18px; border-radius: 6px; display: grid; place-items: center; background: var(--surface-2); border: 1px solid var(--line); color: var(--text-3); }
.fi-check[data-ok="true"] .fi-dot { color: var(--green); border-color: color-mix(in oklab, var(--green) 30%, transparent); background: var(--green-soft); }
.fi-check[data-ok="false"] .fi-dot { color: var(--amber); border-color: color-mix(in oklab, var(--amber) 30%, transparent); background: var(--amber-soft); }
.fi-check-name { font-size: 12px; color: var(--text-1); }
.fi-check-detail { margin-top: 2px; font-size: 11px; color: var(--text-3); line-height: 1.4; }
.fi-tree { max-height: 260px; overflow: auto; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-0); padding: 7px 0; }
.fi-tree-row { display: grid; grid-template-columns: auto 1fr auto; gap: 7px; padding: 3px 9px; font-family: var(--mono); font-size: 9.5px; color: var(--text-2); }
.fi-tree-row[data-type="directory"] { color: var(--accent-2); }
.fi-tree-size { color: var(--text-4); }
.fi-pre { margin: 0; max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); font-size: 10px; line-height: 1.45; background: var(--surface-0); border: 1px solid var(--line); border-radius: 7px; padding: 10px; color: var(--text-2); }
.fi-preview + .fi-preview { margin-top: 10px; }
.fi-preview-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; font-family: var(--mono); font-size: 9.5px; color: var(--text-3); }
.fi-load { padding: 24px 16px; color: var(--text-3); text-align: center; }

.tab-empty { padding: 36px 24px; text-align: center; color: var(--text-3); font-size: 12px; }

/* ============================================================ HISTORY DRAWER */
.scrim { position: fixed; inset: 0; background: rgba(4,6,9,.5); backdrop-filter: blur(2px); z-index: 70; animation: fade-in .2s ease; }
html[data-theme="light"] .scrim { background: rgba(20,28,40,.32); }
.drawer {
  position: fixed; top: 0; bottom: 0; right: 0; z-index: 71;
  width: min(420px, 100vw); background: var(--surface-0);
  border-left: 1px solid var(--line-2); box-shadow: var(--shadow-pop);
  display: flex; flex-direction: column; animation: slide-in .28s var(--ease);
}
.drawer-head { display: flex; align-items: flex-start; justify-content: space-between; padding: 18px 18px 14px; border-bottom: 1px solid var(--line); }
.drawer-head h2 { margin: 4px 0 0; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
.drawer-list { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; }
.run-row { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 11px; align-items: center; padding: 12px; border-radius: var(--radius); transition: background .14s; width: 100%; text-align: left; }
.run-row:hover { background: var(--surface-1); }
.run-row[data-active="true"] { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--accent); }
.run-row .pip { grid-row: span 2; }
.run-row-id { font-family: var(--mono); font-size: 11.5px; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.run-row-meta { font-family: var(--mono); font-size: 9.5px; color: var(--text-3); }
.run-row-stat { font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: .08em; color: var(--text-2); grid-row: span 2; justify-self: end; }

/* ============================================================ POPOVER (run details) */
.pop { position: absolute; z-index: 55; top: calc(var(--header-h) - 4px); left: 16px; width: 300px;
  background: var(--surface-1); border: 1px solid var(--line-2); border-radius: var(--radius); box-shadow: var(--shadow-pop);
  padding: 6px; animation: pop-in .16s var(--ease-out); }
.pop-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 9px; border-radius: var(--radius-sm); }
.pop-row + .pop-row { border-top: 1px solid var(--line); }
.pop-k { font-size: 11px; color: var(--text-3); }
.pop-v { font-family: var(--mono); font-size: 11px; color: var(--text-1); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px; }
.pop-v .tag { padding: 1px 6px; border-radius: 5px; background: var(--surface-3); display: inline-flex; align-items: center; gap: 5px; }
.pop-v .tag[data-tone="green"] { color: var(--green); background: var(--green-soft); }

/* ============================================================ TWEAKS POPOVER */
.tweaks-pop { position: absolute; z-index: 56; top: calc(var(--header-h) - 4px); right: 16px; width: 264px;
  background: var(--surface-1); border: 1px solid var(--line-2); border-radius: var(--radius); box-shadow: var(--shadow-pop);
  padding: 12px; animation: pop-in .16s var(--ease-out); }
.tw-sec { font-family: var(--mono); font-size: 9px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-4); margin: 10px 2px 7px; }
.tw-sec:first-child { margin-top: 2px; }
.tw-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.tw-label { font-size: 12px; color: var(--text-2); }
.tw-seg { display: inline-flex; padding: 2px; background: var(--surface-0); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.tw-seg button { height: 22px; padding: 0 8px; border-radius: 5px; font-size: 10.5px; color: var(--text-3); text-transform: capitalize; }
.tw-seg button[aria-pressed="true"] { background: var(--surface-3); color: var(--text-1); }
.tw-swatches { display: inline-flex; gap: 6px; }
.tw-swatch { width: 18px; height: 18px; border-radius: 50%; border: 2px solid transparent; }
.tw-swatch[aria-pressed="true"] { border-color: var(--text-1); }

/* ============================================================ EMPTY STATE (no matches) */
.grid-empty { grid-column: 1 / -1; display: grid; place-items: center; padding: 60px 20px; text-align: center; gap: 12px; color: var(--text-3); }
.grid-empty .ge-icon { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: var(--surface-1); border: 1px solid var(--line-2); color: var(--text-3); }
.grid-empty h3 { margin: 0; font-size: 14px; color: var(--text-1); font-weight: 560; }
.grid-empty button.linklike { color: var(--accent-2); }

/* ============================================================ RESPONSIVE */
@media (max-width: 1100px) {
  :root { --side-w: 320px; }
  .hdr-run-title { max-width: 32vw; }
  .lane-count .lc-label { display: none; }
}
@media (max-width: 860px) {
  .focus { display: block; height: 100%; min-height: 0; overflow-y: auto; }
  .focus-rail { display: none; }
  .focus-stage { min-height: auto; }
  .focus-bar { position: sticky; top: 0; z-index: 25; }
  .focus-stage-area {
    display: block; min-height: min(60vh, 560px); height: auto;
    padding: 14px; overflow: visible;
  }
  .focus-frame {
    width: 100%; height: auto; max-height: none;
    min-height: 280px;
  }
  .focus-side {
    position: relative; left: auto; right: auto; bottom: auto; top: auto; z-index: auto;
    min-height: 360px; max-height: none; border-left: none; border-top: 1px solid var(--line-2);
    border-radius: 0; box-shadow: none; transform: none;
  }
  .focus-side[data-sheet="open"], .focus-side[data-sheet="closed"] { transform: none; }
  .sheet-grip { display: none; }
}
.sheet-grip { display: none; align-items: center; justify-content: center; gap: 8px; height: 40px; flex: none; border-bottom: 1px solid var(--line); cursor: grab; }
.sheet-grip::before { content: ""; width: 36px; height: 4px; border-radius: 2px; background: var(--line-3); }

@media (max-width: 720px) {
  :root { --header-h: 50px; }
  .brand-word, .hdr-runs span { display: none; }
  .hdr-run { padding-left: 10px; }
  .hdr-run-title { max-width: 40vw; font-size: 12.5px; }
  .lane-counts { display: none; }
  .run-chip { display: none; }
  .toolbar { gap: 7px; }
  .tb-search { min-width: 0; width: 130px; }
  .tb-label { display: none; }
  .grid-scroll { padding: 12px; }
  .grid { gap: 11px; grid-template-columns: 1fr; }
  .seg.density-seg button span { display: none; }
}
@media (max-width: 480px) {
  .seg.media-seg button span, .seg.view-seg button span { display: none; }
}

/* ============================================================ KEYFRAMES */
@keyframes ping { 0% { transform: scale(.6); opacity: .5; } 100% { transform: scale(2.4); opacity: 0; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes blink { 0%, 50% { opacity: 1; } 50.01%, 100% { opacity: 0; } }
@keyframes tile-in { from { opacity: 0; transform: translateY(8px) scale(.99); } to { opacity: 1; transform: none; } }
@keyframes line-in { from { transform: translateY(4px); } to { transform: none; } }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes slide-in { from { transform: translateX(20px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes pop-in { from { transform: translateY(-6px) scale(.98); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes clickpulse { 0% { transform: scale(.5); opacity: .9; } 100% { transform: scale(1.5); opacity: 0; } }
@keyframes console-up { from { opacity: 0; } to { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
}
html[data-motion="reduced"] *, html[data-motion="reduced"] *::before, html[data-motion="reduced"] *::after {
  animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important;
}

/* ============================================================ DROPDOWN FILTERS */
.dd { position: relative; flex: none; }
.dd-trigger {
  display: inline-flex; align-items: center; gap: 7px;
  height: 30px; padding: 0 9px 0 11px; border-radius: var(--radius-sm);
  border: 1px solid var(--line-2); color: var(--text-2); font-size: 12px;
  transition: background .15s, color .15s, border-color .15s; white-space: nowrap;
}
.dd-trigger:hover { background: var(--surface-2); color: var(--text-1); }
.dd-trigger[data-active="true"] { background: var(--surface-3); color: var(--text-1); border-color: var(--line-3); }
.dd-trigger svg:last-child { color: var(--text-3); }
.dd-trigger-inner { display: inline-flex; align-items: center; gap: 7px; }
.dd-badge {
  min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px;
  background: var(--accent-color); color: #fff; font-family: var(--mono); font-size: 9.5px;
  display: inline-grid; place-items: center; font-weight: 600;
}
.dd-menu {
  position: fixed; z-index: 90;
  background: var(--surface-1); border: 1px solid var(--line-2); border-radius: var(--radius);
  box-shadow: var(--shadow-pop); padding: 5px; animation: pop-in .14s var(--ease-out);
}
.dd-row {
  display: flex; align-items: center; gap: 9px; width: 100%; padding: 8px 9px;
  border-radius: var(--radius-sm); text-align: left; color: var(--text-2); font-size: 12.5px;
  transition: background .12s;
}
.dd-row:hover { background: var(--surface-2); color: var(--text-1); }
.dd-row-all { color: var(--text-1); }
.dd-row-label { flex: 1; }
.dd-row-n { color: var(--text-3); font-size: 11px; }
.dd-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dd-check {
  width: 16px; height: 16px; border-radius: 5px; border: 1px solid var(--line-3);
  display: grid; place-items: center; flex: none; color: #fff; transition: background .12s, border-color .12s;
}
.dd-check[data-on="true"] { background: var(--accent-color); border-color: var(--accent-color); }
.dd-check svg { width: 11px; height: 11px; }
.dd-sep { height: 1px; background: var(--line); margin: 5px 4px; }

.tb-result { font-family: var(--mono); font-size: 11px; color: var(--text-3); flex: none; padding-left: 2px; }

/* compact icon-only segmented controls on the right */
.seg.view-seg button, .seg.media-seg button, .seg.density-seg button { width: 30px; padding: 0; justify-content: center; }

/* ============================================================ STATUS INDICATOR (header) */
.si-badges { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.si-badge {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px;
  border-radius: var(--radius-pill); border: 1px solid transparent; transition: background .15s, border-color .15s;
}
.si-badge:hover { background: var(--surface-2); }
.si-badge[aria-pressed="true"] { background: var(--surface-3); border-color: var(--line-2); }
.si-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.si-n { font-size: 12px; color: var(--text-1); font-weight: 600; }

.si-bar { display: inline-flex; align-items: center; gap: 9px; flex: none; min-width: 140px; }
.si-bar-track { display: flex; height: 8px; flex: 1; border-radius: 999px; overflow: hidden; background: var(--surface-3); gap: 2px; }
.si-bar-seg { min-width: 4px; cursor: pointer; transition: filter .15s; }
.si-bar-seg:hover { filter: brightness(1.2); }
.si-bar-label { font-size: 11px; color: var(--text-2); }

.si-ring { display: inline-flex; align-items: center; gap: 8px; padding: 2px 6px 2px 2px; border-radius: var(--radius-pill); transition: background .15s; }
.si-ring:hover { background: var(--surface-2); }
.si-ring-meta { display: flex; flex-direction: column; line-height: 1.1; align-items: flex-start; }
.si-ring-pct { font-size: 12px; color: var(--text-1); font-weight: 600; }
.si-ring-issue { font-size: 9.5px; }

/* ============================================================ FOCUS SIDE COLLAPSE */
.focus[data-side="collapsed"] { --side-w: 0px; grid-template-columns: var(--rail-w, 188px) 1fr; }
.focus[data-side="collapsed"][data-rail="collapsed"] { grid-template-columns: 1fr; }
.focus[data-rail="collapsed"]:not([data-side="collapsed"]) { grid-template-columns: 1fr var(--side-w, 360px); }

/* ============================================================ RUN CONSOLE */
.console {
  display: flex; flex-direction: column; min-height: 0; flex: none;
  background: var(--surface-0); border-top: 1px solid var(--line-2);
  box-shadow: 0 -10px 30px rgba(0,0,0,.25); animation: console-up .26s var(--ease);
}
.console-head { display: flex; align-items: center; gap: 11px; padding: 0 12px; height: 38px; flex: none; border-bottom: 1px solid var(--line); }
.console-title { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-1); font-weight: 520; }
.console-title svg { color: var(--text-3); }
.console-cmd { font-size: 10.5px; color: var(--text-3); background: var(--surface-2); padding: 2px 7px; border-radius: 5px; }
.console-live { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent-2); }
.console-meta { font-size: 10.5px; color: var(--text-3); }
.console-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 12px; font-size: 11.5px; line-height: 1.6; }
.console-line { display: flex; gap: 12px; }
.console-t { color: var(--text-4); flex: none; user-select: none; }
.console-txt { color: var(--text-2); overflow-wrap: anywhere; }
.console-txt.info { color: var(--text-2); }
.console-txt.ok { color: var(--green); }
.console-txt.warn { color: var(--amber); }
.console-txt.err { color: var(--red); }
.console-txt.dim { color: var(--text-3); }

@media (max-width: 720px) {
  .tb-result { display: none; }
  .dd-trigger-inner span { max-width: 64px; overflow: hidden; text-overflow: ellipsis; }
  .console { height: 200px !important; }
}

/* ============================================================ STATUS BAR (persistent footer) */
.statusbar {
  display: flex; align-items: center; gap: 12px; flex: none;
  height: 30px; padding: 0 12px;
  background: var(--surface-0); border-top: 1px solid var(--line-2);
  font-size: 11.5px; position: relative; z-index: 25;
}
.sb-status { display: inline-flex; align-items: center; gap: 7px; flex: none; }
.sb-status-label { font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-2); }
.sb-status[data-tone="running"] .sb-status-label { color: var(--accent-2); }
.sb-status[data-tone="failed"] .sb-status-label { color: var(--red); }
.sb-status[data-tone="blocked"] .sb-status-label { color: var(--amber); }
.sb-status[data-tone="complete"] .sb-status-label { color: var(--green); }
.sb-pct { color: var(--text-3); font-size: 11px; }
.sb-prog { width: 90px; height: 4px; border-radius: 999px; background: var(--surface-3); overflow: hidden; flex: none; }
.sb-prog > span { display: block; height: 100%; background: var(--accent-color); transition: width .6s var(--ease-out); }
.sb-prog > span[data-tone="failed"] { background: var(--red); }
.sb-prog > span[data-tone="complete"] { background: var(--green); }
.sb-prog > span[data-tone="blocked"] { background: var(--amber); }
.sb-counts { display: inline-flex; align-items: center; gap: 8px; flex: none; }
.sb-count { display: inline-flex; align-items: center; gap: 5px; color: var(--text-2); }
.sb-count .si-dot { width: 7px; height: 7px; border-radius: 50%; }
.sb-run { color: var(--text-4); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.sb-console {
  display: inline-flex; align-items: center; gap: 8px; flex: none; max-width: 52vw;
  height: 30px; padding: 0 4px 0 11px; color: var(--text-2);
  border-left: 1px solid var(--line); transition: color .15s, background .15s;
}
.sb-console:hover { color: var(--text-1); background: var(--surface-1); }
.sb-console[aria-expanded="true"] { color: var(--text-1); background: var(--surface-2); }
.sb-console svg:first-child { color: var(--text-3); }
.sb-console-label { font-size: 11.5px; flex: none; }
.sb-console-peek { display: inline-flex; align-items: center; gap: 8px; min-width: 0; padding-left: 8px; border-left: 1px solid var(--line); }
.sb-peek-t { color: var(--text-4); flex: none; font-size: 10px; }
.sb-peek-txt { color: var(--text-3); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 30vw; }
.sb-peek-txt.ok { color: color-mix(in oklab, var(--green) 80%, var(--text-2)); }
.sb-peek-txt.warn { color: color-mix(in oklab, var(--amber) 85%, var(--text-2)); }
.sb-peek-txt.err { color: color-mix(in oklab, var(--red) 85%, var(--text-2)); }
.sb-chev { display: inline-grid; place-items: center; color: var(--text-3); transition: transform .2s var(--ease); }
.sb-chev.open { transform: rotate(180deg); }
/* when docked above the bar, drop the console's bottom rounding/shadow seam */
.console + .statusbar { border-top-color: var(--line); }

@media (max-width: 720px) {
  .sb-counts, .sb-run, .sb-prog { display: none; }
  .sb-console-label { display: none; }
  .sb-peek-txt { max-width: 44vw; }
}
@media (max-width: 480px) {
  .sb-console-peek { display: none; }
}
`;
}

export function observerClientJs(): string {
  return `
(function () {
  "use strict";

  // ---------------------------------------------------------------- hydrate
  var DATA_FILE = "observer-data.json";
  var REFRESH_MS = 5000;
  var dataEl = document.getElementById("observer-data");
  var currentData = null;
  try { currentData = JSON.parse((dataEl && dataEl.textContent) || "null"); } catch (e) { currentData = null; }
  if (!currentData || typeof currentData !== "object") currentData = {};
  if (!currentData.run) currentData.run = {};
  if (!currentData.streams) currentData.streams = [];
  if (!currentData.events) currentData.events = [];

  var app = document.getElementById("app");
  var historyIndex = null;
  var refreshTimer = null;
  var historyTimer = null;
  var openDd = null;
  var NL = String.fromCharCode(10);
  var TIMES = String.fromCharCode(215);

  // ---------------------------------------------------------------- prefs
  function readPref(key, fallback) {
    try { var raw = window.localStorage.getItem("mimetic-observer:" + key); return raw == null ? fallback : JSON.parse(raw); }
    catch (e) { return fallback; }
  }
  function writePref(key, value) {
    try { window.localStorage.setItem("mimetic-observer:" + key, JSON.stringify(value)); } catch (e) {}
  }

  function focusFromHash() {
    var h = String(window.location.hash || "");
    if (h.indexOf("focus=") < 0) return null;
    try { return decodeURIComponent(h.split("focus=")[1].split("&")[0]); } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- state
  var initialFocusId = focusFromHash();
  var S = {
    view: initialFocusId ? "focus" : "grid",
    focusedId: initialFocusId,
    statusSel: [],
    kindSel: [],
    query: "",
    media: "live",
    historyOpen: false,
    detailsOpen: false,
    tweaksOpen: false,
    consoleOpen: false,
    filePath: null,
    railCollapsed: !!readPref("railCollapsed", false),
    sideCollapsed: !!readPref("sideCollapsed", false),
    sheetOpen: false,
    tab: "events",
    theme: readPref("theme", "dark"),
    accent: readPref("accent", "#4d7cfe"),
    density: readPref("density", "comfortable"),
    statusViz: readPref("statusViz", "badges"),
    motion: readPref("motion", "full")
  };
  var artifactCache = {};
  var liveStreamFrames = {};
  var liveStreamHost = null;
  var liveStreamLayoutRaf = null;

  // ---------------------------------------------------------------- tone / labels
  var TONE = {
    queued: "queued", preparing: "running", running: "running",
    passed: "complete", complete: "complete", contract_proof_only: "complete",
    blocked: "blocked", timed_out: "blocked", failed: "failed"
  };
  var STATUS_LABEL = {
    queued: "Queued", preparing: "Preparing", running: "Running", passed: "Passed",
    complete: "Complete", contract_proof_only: "Proof only", blocked: "Blocked",
    timed_out: "Timed out", failed: "Failed"
  };
  function tone(s) { return TONE[s] || "queued"; }
  function statusLabel(s) { return STATUS_LABEL[s] || s || "Unknown"; }
  function kindGroup(k) { return k === "browser" ? "ui" : k; }

  // ---------------------------------------------------------------- esc / icons
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  var P = ' fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
  var ICONS = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.4"' + P + '/><rect x="14" y="3" width="7" height="7" rx="1.4"' + P + '/><rect x="3" y="14" width="7" height="7" rx="1.4"' + P + '/><rect x="14" y="14" width="7" height="7" rx="1.4"' + P + '/>',
    focus: '<rect x="3" y="4" width="18" height="16" rx="2"' + P + '/><path d="M3 9h18"' + P + '/>',
    expand: '<path d="M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4M15 20h4a1 1 0 0 0 1-1v-4"' + P + '/>',
    search: '<circle cx="11" cy="11" r="7"' + P + '/><path d="m20 20-3-3"' + P + '/>',
    clock: '<circle cx="12" cy="12" r="9"' + P + '/><path d="M12 7v5l3 2"' + P + '/>',
    sun: '<circle cx="12" cy="12" r="4"' + P + '/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"' + P + '/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"' + P + '/>',
    chevL: '<path d="m15 18-6-6 6-6"' + P + '/>',
    chevR: '<path d="m9 18 6-6-6-6"' + P + '/>',
    x: '<path d="M6 6l12 12M18 6 6 18"' + P + '/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5"' + P + '/><circle cx="16" cy="6" r="2"' + P + '/><circle cx="8" cy="12" r="2"' + P + '/><circle cx="13" cy="18" r="2"' + P + '/>',
    comfy: '<rect x="3" y="4" width="18" height="7" rx="1.4"' + P + '/><rect x="3" y="13" width="18" height="7" rx="1.4"' + P + '/>',
    compact: '<rect x="3" y="4" width="8" height="7" rx="1.2"' + P + '/><rect x="13" y="4" width="8" height="7" rx="1.2"' + P + '/><rect x="3" y="13" width="8" height="7" rx="1.2"' + P + '/><rect x="13" y="13" width="8" height="7" rx="1.2"' + P + '/>',
    dense: '<rect x="3" y="4" width="5" height="5" rx="1"' + P + '/><rect x="10" y="4" width="5" height="5" rx="1"' + P + '/><rect x="17" y="4" width="4" height="5" rx="1"' + P + '/><rect x="3" y="11" width="5" height="5" rx="1"' + P + '/><rect x="10" y="11" width="5" height="5" rx="1"' + P + '/><rect x="17" y="11" width="4" height="5" rx="1"' + P + '/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"' + P + '/><circle cx="9" cy="10" r="1.6"' + P + '/><path d="m4 18 5-4 4 3 3-2 4 3"' + P + '/>',
    live: '<circle cx="12" cy="12" r="3"' + P + '/><path d="M6.5 6.5a8 8 0 0 0 0 11M17.5 6.5a8 8 0 0 1 0 11M4 4a12 12 0 0 0 0 16M20 4a12 12 0 0 1 0 16"' + P + '/>',
    file: '<path d="M14 3v5h5"' + P + '/><path d="M6 3h8l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"' + P + '/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01"' + P + '/>',
    terminal: '<path d="m6 8 3.5 3L6 14M13 15h5"' + P + '/><rect x="3" y="4" width="18" height="16" rx="2"' + P + '/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"' + P + '/>',
    check: '<path d="m4 12 5 5L20 6"' + P + '/>',
    alert: '<path d="M12 8v5M12 16.5h.01"' + P + '/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"' + P + '/>',
    info: '<circle cx="12" cy="12" r="9"' + P + '/><path d="M12 11v5M12 8h.01"' + P + '/>',
    globe: '<circle cx="12" cy="12" r="9"' + P + '/><path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18"' + P + '/>',
    lock: '<rect x="4.5" y="10" width="15" height="10" rx="2"' + P + '/><path d="M8 10V7a4 4 0 0 1 8 0v3"' + P + '/>',
    caret: '<path d="m6 9 6 6 6-6"' + P + '/>',
    filter: '<path d="M3 5h18l-7 8.2V20l-4-2.2v-4.6L3 5Z"' + P + '/>',
    panelRight: '<rect x="3" y="4" width="18" height="16" rx="2"' + P + '/><path d="M15 4v16"' + P + '/>'
  };
  function icon(name, size) {
    var s = size || 18;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" aria-hidden="true">' + (ICONS[name] || ICONS.info) + '</svg>';
  }
  function pip(status, live) {
    return '<span class="pip" data-status="' + esc(status) + '" data-live="' + (live ? "true" : "false") + '"></span>';
  }

  // ---------------------------------------------------------------- derive (observer-data.v1 -> display)
  function laneName(s) { return s.label || (s.sim && s.sim.summary) || s.id || "lane"; }
  function laneRoute(s) { return (s.ui && (s.ui.route || s.ui.appUrl || s.ui.nestedObserverUrl)) || s.url || (s.terminal && s.terminal.title) || ""; }
  function laneProgress(s) {
    if (s.sim && typeof s.sim.progress === "number") return Math.max(0, Math.min(100, Math.round(s.sim.progress)));
    var t = tone(s.status);
    return (t === "complete" || t === "failed") ? 100 : 0;
  }
  function laneStep(s) { return (s.sim && s.sim.currentStep) || s.statusLabel || statusLabel(s.status); }
  function laneSummary(s) { return (s.sim && s.sim.summary) || ""; }
  function laneEvents(s) { return s.timeline || []; }
  function laneArtifacts(s) { return s.artifacts || []; }

  function aspectFor(s) {
    if (s.kind === "terminal" || s.kind === "tui") return "16 / 10";
    var vp = s.viewport;
    if (vp && vp.height > vp.width) return vp.width + " / " + vp.height;
    return "16 / 9";
  }
  function dimsFor(s) {
    if (s.kind === "terminal") return "CLI";
    if (s.kind === "tui") return "TUI";
    if (s.kind === "codex-ui") return "CODEX";
    var vp = s.viewport;
    if (vp) return vp.width > vp.height ? (vp.width + TIMES + vp.height) : "MOB";
    return "SIM";
  }
  function initials(name) {
    var parts = String(name || "").replace(/[^a-zA-Z0-9]+/g, " ").trim().split(" ");
    return (((parts[0] || "")[0] || "") + ((parts[1] || "")[0] || "")).toUpperCase();
  }
  function laneCounts(streams) {
    var c = { running: 0, complete: 0, blocked: 0, failed: 0 };
    streams.forEach(function (s) {
      var t = tone(s.status);
      if (t === "running") c.running += 1;
      else if (t === "complete") c.complete += 1;
      else if (t === "blocked") c.blocked += 1;
      else if (t === "failed") c.failed += 1;
    });
    return c;
  }
  function shortTime(v) {
    if (!v) return "";
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function shortStamp(v) {
    if (!v) return "";
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function hasText(low, list) {
    for (var i = 0; i < list.length; i += 1) { if (low.indexOf(list[i]) >= 0) return true; }
    return false;
  }
  function classify(line) {
    var t = String(line == null ? "" : line).trim();
    if (!t) return "dim";
    var c0 = t.charAt(0);
    if (c0 === "$" || c0 === "#" || c0 === ">") return "cmd";
    var low = t.toLowerCase();
    if (t.indexOf("FAIL") >= 0 || t.indexOf("✗") >= 0 || t.indexOf("✘") >= 0 ||
        hasText(low, ["fail", "error", "not found", "missing", "cannot", "denied", "unreachable", "unresolved"])) return "err";
    if (t.indexOf("✓") >= 0 || t.indexOf("✔") >= 0 ||
        hasText(low, ["ok ", " ok", "passed", "granted", "ready", "success", "succeeded", "completed", "emitted", "scaffolded"])) return "ok";
    if (t.indexOf("⚠") >= 0 || hasText(low, ["warn", "pending", "timeout", "timed out", "retry", "skipped", "best-effort", "blocked"])) return "warn";
    if ("┌│└├─╭╰╮╯═┐┘".indexOf(c0) >= 0) return "dim";
    return "";
  }
  function termLines(s) {
    var raw = (s.terminalPlain != null ? s.terminalPlain : (s.terminal ? s.terminal.tail : "")) || "";
    var arr = String(raw).split(NL);
    while (arr.length && arr[arr.length - 1].trim() === "") arr.pop();
    return arr.map(function (line) { return { text: line, cls: classify(line) }; });
  }
  function clip(v, n) {
    var s = String(v == null ? "" : v).trim();
    if (!s) return "";
    return s.length > n ? (s.slice(0, Math.max(0, n - 1)) + "…") : s;
  }
  function shortSurfaceValue(v) {
    var s = String(v == null ? "" : v).trim();
    if (!s) return "";
    var cut = s.split("?")[0].split("#")[0];
    var parts = cut.split("/");
    var tail = parts.filter(function (p) { return !!p; }).slice(-2).join("/");
    return clip(tail || cut || s, 48);
  }
  function linkHref(v, artifactPath) {
    var raw = String(v == null ? "" : v).trim();
    var low = raw.toLowerCase();
    if (!raw) return "";
    if (low.indexOf("http://") === 0 || low.indexOf("https://") === 0 || low.indexOf("file:") === 0) return raw;
    if (raw.indexOf("://") >= 0) return "";
    if (raw.charAt(0) === "/" || raw.indexOf("..") >= 0) return "";
    return artifactPath ? ("../" + raw) : raw;
  }
  function firstArtifactKind(s, kind) {
    var arts = laneArtifacts(s);
    for (var i = 0; i < arts.length; i += 1) {
      if (arts[i] && arts[i].kind === kind) return arts[i];
    }
    return null;
  }
  function artifactKinds(arts) {
    var seen = {}, out = [];
    arts.forEach(function (a) {
      var k = (a && a.kind) || "file";
      if (!seen[k]) { seen[k] = true; out.push(k); }
    });
    var shown = out.slice(0, 3).join("+");
    return shown + (out.length > 3 ? "+" : "");
  }
  function terminalExcerpt(s) {
    var lines = termLines(s).filter(function (ln) { return !!String(ln.text || "").trim(); });
    if (!lines.length) return "";
    return clip(lines[lines.length - 1].text, 88);
  }
  function completionTone(c) {
    var t = tone(c && c.status);
    return t === "running" ? "live" : t === "complete" ? "ok" : t === "blocked" ? "warn" : c && c.status === "failed" ? "err" : "info";
  }
  function completionText(c) {
    if (!c) return "";
    var bits = [statusLabel(c.status)];
    if (typeof c.exitCode === "number") bits.push("exit " + c.exitCode);
    if (typeof c.nestedObserverPresent === "boolean") bits.push("observer " + (c.nestedObserverPresent ? "present" : "missing"));
    if (typeof c.nestedVerifyPassed === "boolean") bits.push("verify " + (c.nestedVerifyPassed ? "passed" : "failed"));
    if (c.reason) bits.push(c.reason);
    return clip(bits.join(" · "), 110);
  }
  function labChip(kind, label, detail, href, toneName) {
    var title = label + (detail ? ": " + detail : "");
    var inner = '<span class="bw-chip-k">' + esc(label) + '</span>' + (detail ? '<span class="bw-chip-v">' + esc(detail) + '</span>' : "");
    var attrs = ' class="bw-lab-chip" data-kind="' + esc(kind) + '" data-tone="' + esc(toneName || "info") + '" title="' + esc(title) + '"';
    if (href) return '<a' + attrs + ' href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" data-action="external">' + inner + '</a>';
    return '<span' + attrs + '>' + inner + '</span>';
  }
  function browserLiveUrl(s) {
    return (s.embed && s.embed.kind === "iframe" && s.embed.url) || s.url || "";
  }
  function liveStreamMount(s, liveUrl) {
    return '<div class="live-stream-mount surface-fill" data-live-stream-id="' + esc(s.id) + '" data-live-stream-url="' + esc(liveUrl) + '" data-live-stream-title="' + esc(laneName(s) || "live stream") + '">'
      + '<div class="bw-app-wait"><div class="wait-spinner" style="width:24px;height:24px"></div>'
      + '<div class="mono" style="font-size:9px">connecting live stream</div></div></div>';
  }
  function browserShot(s) {
    var art = firstArtifactKind(s, "screenshot");
    return (s.ui && s.ui.screenshotUrl) || (s.embed && s.embed.kind === "screenshot" && s.embed.url) || (art && linkHref(art.path, true)) || "";
  }
  function browserHasLabSignals(s) {
    var ui = s.ui || {};
    return !!(browserLiveUrl(s) || browserShot(s) || ui.appUrl || ui.nestedObserverUrl || ui.nestedObserverPath || ui.state || s.completion || terminalExcerpt(s) || laneArtifacts(s).length);
  }
  function browserLabDock(s, shot) {
    var ui = s.ui || {};
    var chips = [];
    var appUrl = ui.appUrl || "";
    var nestedArt = firstArtifactKind(s, "observer");
    var nested = ui.nestedObserverUrl || ui.nestedObserverPath || (nestedArt && nestedArt.path) || "";
    var completion = s.completion || null;
    var shotArt = firstArtifactKind(s, "screenshot");
    var arts = laneArtifacts(s);
    var tail = terminalExcerpt(s);

    if (appUrl) chips.push(labChip("app", "app", shortSurfaceValue(appUrl), linkHref(appUrl, false), "live"));
    if (nested) chips.push(labChip("observer", "observer", shortSurfaceValue(nested), linkHref(nested, !!(nestedArt && nested === nestedArt.path)), "info"));
    else if (completion && typeof completion.nestedObserverPresent === "boolean") chips.push(labChip("observer", "observer", completion.nestedObserverPresent ? "present" : "missing", "", completion.nestedObserverPresent ? "ok" : "warn"));
    if (completion) chips.push(labChip("completion", "status", completionText(completion), "", completionTone(completion)));
    if (tail) chips.push(labChip("terminal", "terminal", tail, "", "info"));
    if (shot || shotArt) chips.push(labChip("screenshot", "shot", shot ? (S.media === "screenshot" ? "viewing fallback" : "fallback ready") : "artifact", shot ? linkHref(shot, false) : linkHref(shotArt.path, true), "info"));
    if (arts.length) chips.push(labChip("artifact", "files", arts.length + " " + artifactKinds(arts), "", "info"));
    if (ui.state && !completion) chips.push(labChip("state", "state", clip(ui.state, 72), "", "info"));
    if (!chips.length) return "";
    return '<div class="bw-lab-dock" aria-label="Browser lane lab surfaces">' + chips.slice(0, 6).join("") + '</div>';
  }

  function consoleLines() {
    var rows = [];
    var lc = currentData.run.lifecycle || [];
    lc.forEach(function (e) { rows.push({ at: e.at, lvl: "info", text: e.message || e.event || "" }); });
    (currentData.events || []).forEach(function (e) {
      var prefix = e.simId ? (e.simId + "  ") : "";
      rows.push({ at: e.at, lvl: (e.level === "error" ? "err" : e.level === "warn" ? "warn" : "info"), text: prefix + (e.message || e.type || "") });
    });
    rows.sort(function (a, b) { return String(a.at || "").localeCompare(String(b.at || "")); });
    if (!rows.length) rows.push({ at: "", lvl: "dim", text: "No orchestrator log lines recorded for this run." });
    return rows.map(function (r) { return { t: shortTime(r.at), lvl: r.lvl, text: r.text }; });
  }

  // ---------------------------------------------------------------- overall
  function overallStatus() {
    var ss = currentData.streams;
    if (ss.some(function (s) { return tone(s.status) === "running"; })) return "running";
    if (ss.some(function (s) { return s.status === "failed"; })) return "failed";
    if (ss.some(function (s) { return tone(s.status) === "blocked"; })) return "blocked";
    if (!ss.length) return currentData.run.status || "queued";
    return "complete";
  }
  function overallPct() {
    var ss = currentData.streams;
    if (!ss.length) return 0;
    var sum = 0;
    ss.forEach(function (s) { sum += laneProgress(s); });
    return Math.round(sum / ss.length);
  }
  function hasLive() { return currentData.streams.some(function (s) { return tone(s.status) === "running"; }); }

  function statusCount(id) { return currentData.streams.filter(function (s) { return tone(s.status) === id; }).length; }
  function kindCount(id) { return currentData.streams.filter(function (s) { return kindGroup(s.kind) === id; }).length; }

  function filteredStreams() {
    var q = S.query.trim().toLowerCase();
    return currentData.streams.filter(function (s) {
      if (S.statusSel.length && S.statusSel.indexOf(tone(s.status)) < 0) return false;
      if (S.kindSel.length && S.kindSel.indexOf(kindGroup(s.kind)) < 0) return false;
      if (q && (laneName(s) + " " + (s.kindLabel || "") + " " + laneRoute(s)).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  // ================================================================ SURFACES
  function liveTag() {
    return '<span class="live-tag">' + pip("running", true) + ' Live</span>';
  }
  function waitSurface(s) {
    var st = s.status, inner;
    if (st === "blocked" || st === "timed_out") {
      inner = '<div class="wait-icon" data-tone="amber">' + icon("alert") + '</div>'
        + '<div class="wait-title">' + (st === "timed_out" ? "Lane timed out" : "Lane blocked") + '</div>'
        + '<div class="wait-sub">' + esc(laneStep(s)) + '</div>';
    } else if (st === "failed") {
      inner = '<div class="wait-icon" data-tone="red">' + icon("x") + '</div>'
        + '<div class="wait-title">Lane failed</div>'
        + '<div class="wait-sub">' + esc(laneStep(s)) + '</div>';
    } else if (st === "contract_proof_only") {
      inner = '<div class="wait-icon" data-tone="green">' + icon("check") + '</div>'
        + '<div class="wait-title">Contract proof only</div>'
        + '<div class="wait-sub">' + esc(laneSummary(s) || laneStep(s)) + '</div>';
    } else {
      inner = '<div class="wait-spinner"></div>'
        + '<div class="wait-title">Waiting for substrate</div>'
        + '<div class="wait-sub">' + esc(laneRoute(s) || laneStep(s)) + '</div>';
    }
    return '<div class="wait"><div class="wait-inner">' + inner + '</div></div>';
  }
  function browserSurface(s) {
    var live = tone(s.status) === "running";
    var route = laneRoute(s) || "(local)";
    var liveUrl = browserLiveUrl(s);
    var shot = browserShot(s);
    var dock = browserLabDock(s, shot);
    var body;
    if (liveUrl && S.media === "live") body = liveStreamMount(s, liveUrl);
    else if (shot) body = '<img class="surface-fill" style="object-fit:cover;object-position:top" src="' + esc(shot) + '" alt="viewport screenshot"/>';
    else body = '<div class="bw-app-wait"><div class="wait-spinner" style="width:24px;height:24px"></div>'
      + '<div class="mono" style="font-size:9px">' + esc(route) + '</div>'
      + '<div style="font-size:10px">' + esc(laneStep(s)) + '</div></div>';
    return '<div class="bw">'
      + '<div class="bw-chrome"><div class="bw-dots"><i></i><i></i><i></i></div>'
      + '<div class="bw-url">' + icon("lock", 8) + '<span>' + esc(route) + '</span></div></div>'
      + '<div class="bw-viewport">' + body + (liveUrl && S.media === "live" ? "" : dock) + '</div>'
      + (live ? liveTag() : "")
      + '</div>';
  }
  function terminalSurface(s, focus) {
    var lines = termLines(s);
    var live = tone(s.status) === "running";
    var shown = focus ? lines : lines.slice(-9);
    var start = lines.length - shown.length;
    var rows = shown.map(function (ln, i) {
      return '<div class="term-line">'
        + (focus ? '<span class="term-num">' + pad2(start + i + 1) + '</span>' : '')
        + '<span class="term-txt ' + ln.cls + '">' + esc(ln.text || " ") + '</span></div>';
    }).join("");
    var title = s.kind === "tui" ? (laneRoute(s) || "codex --tui") : (laneName(s) || laneRoute(s));
    var stat = s.kind === "tui" ? "PTY" : "SNAPSHOT";
    return '<div class="term">'
      + '<div class="term-bar"><span class="tprompt">$</span><span class="ttitle">' + esc(title) + '</span><span class="tstat">' + stat + '</span></div>'
      + '<div class="term-body">' + rows
      + (live ? '<div class="term-line"><span class="term-txt cmd">$<span class="term-caret"></span></span></div>' : '')
      + '</div></div>';
  }
  function codexSurface(s) {
    var live = tone(s.status) === "running";
    var parts = [];
    var summary = laneSummary(s) || (s.codex && s.codex.contract) || laneStep(s);
    if (summary) parts.push('<div class="cx-msg agent">' + esc(summary) + '</div>');
    var receipts = termLines(s);
    receipts.forEach(function (ln, i) {
      var pending = live && i === receipts.length - 1;
      parts.push('<div class="cx-tool">' + (pending ? '<span class="cx-spin"></span>' : icon("check", 12)) + '<span>' + esc(ln.text) + '</span></div>');
    });
    if (live) parts.push('<div class="cx-tool"><span class="cx-spin"></span><span>thinking…</span></div>');
    return '<div class="codex">'
      + '<div class="codex-bar"><span class="cx-spark">' + icon("spark", 11) + '</span> ' + esc(laneRoute(s) || "codex.app-server · session") + '</div>'
      + '<div class="codex-body">' + parts.join("") + '</div>'
      + (live ? liveTag() : "")
      + '</div>';
  }
  function streamSurface(s, focus) {
    var k = s.kind, st = s.status;
    var hasTail = !!(s.terminal && s.terminal.tail && String(s.terminal.tail).trim());
    if ((st === "blocked" || st === "timed_out") && !hasTail && !((k === "ui" || k === "browser") && browserHasLabSignals(s))) return waitSurface(s);
    if (k === "ui" || k === "browser") {
      if ((st === "blocked" || st === "timed_out" || st === "failed" || st === "contract_proof_only") && !browserHasLabSignals(s)) return waitSurface(s);
      return browserSurface(s);
    }
    if (k === "terminal" || k === "tui") return hasTail ? terminalSurface(s, focus) : waitSurface(s);
    if (k === "codex-ui") {
      if (st === "contract_proof_only" && !hasTail) return waitSurface(s);
      return codexSurface(s);
    }
    return waitSurface(s);
  }

  // ================================================================ HEADER
  function statusCountsModel() {
    var lc = laneCounts(currentData.streams);
    return [
      { id: "running", label: "live", color: "var(--accent-2)", count: lc.running },
      { id: "complete", label: "done", color: "var(--green)", count: lc.complete },
      { id: "blocked", label: "blocked", color: "var(--amber)", count: lc.blocked },
      { id: "failed", label: "failed", color: "var(--red)", count: lc.failed }
    ];
  }
  function buildStatusIndicator(counts, pct) {
    var shown = counts.filter(function (c) { return c.count > 0; });
    if (S.statusViz === "bar") {
      var segs = shown.map(function (c) {
        return '<span class="si-bar-seg" title="' + c.count + ' ' + c.label + '" data-action="status:' + c.id + '" style="flex-grow:' + c.count + ';background:' + c.color + '"></span>';
      }).join("");
      return '<div class="si-bar" role="group" aria-label="Lane status"><div class="si-bar-track">' + segs + '</div><span class="si-bar-label mono">' + pct + '%</span></div>';
    }
    if (S.statusViz === "ring") {
      var present = shown;
      var sum = present.reduce(function (a, c) { return a + c.count; }, 0) || 1;
      var issues = counts.filter(function (c) { return c.id === "blocked" || c.id === "failed"; }).reduce(function (a, c) { return a + c.count; }, 0);
      var running = (counts.filter(function (c) { return c.id === "running"; })[0] || {}).count || 0;
      var R = 9, CIRC = 2 * Math.PI * R, acc = 0;
      var arcs = present.map(function (c) {
        var frac = c.count / sum, len = frac * CIRC;
        var seg = '<circle cx="13" cy="13" r="' + R + '" fill="none" stroke="' + c.color + '" stroke-width="3.5" stroke-dasharray="' + len + ' ' + (CIRC - len) + '" stroke-dashoffset="' + (-acc * CIRC) + '" transform="rotate(-90 13 13)"></circle>';
        acc += frac;
        return seg;
      }).join("");
      var meta = issues > 0
        ? '<span class="si-ring-issue mono" style="color:var(--amber)">' + issues + ' ⚠</span>'
        : running > 0
          ? '<span class="si-ring-issue mono" style="color:var(--accent-2)">' + running + ' live</span>'
          : '<span class="si-ring-issue mono" style="color:var(--green)">done</span>';
      return '<button class="si-ring" data-action="status:' + (issues ? "blocked" : "all") + '" title="' + pct + '% complete">'
        + '<svg width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="' + R + '" fill="none" stroke="var(--line)" stroke-width="3.5"></circle>' + arcs + '</svg>'
        + '<span class="si-ring-meta"><span class="si-ring-pct mono">' + pct + '%</span>' + meta + '</span></button>';
    }
    return '<div class="si-badges" role="group" aria-label="Lane status">' + shown.map(function (c) {
      var glow = c.id === "running" ? ";box-shadow:0 0 0 3px color-mix(in oklab, " + c.color + " 22%, transparent)" : "";
      return '<button class="si-badge" aria-pressed="' + (S.statusSel.indexOf(c.id) >= 0 ? "true" : "false") + '" title="' + c.count + ' ' + c.label + '" data-action="status:' + c.id + '">'
        + '<span class="si-dot" style="background:' + c.color + glow + '"></span><span class="si-n mono">' + c.count + '</span></button>';
    }).join("") + '</div>';
  }
  function buildHeader() {
    var run = currentData.run;
    var overall = overallStatus(), pct = overallPct();
    var counts = statusCountsModel();
    var title = (run.scenario && run.scenario.title) || "Mimetic run";
    var persona = (run.persona && run.persona.name) || "";
    return '<header class="hdr">'
      + '<div class="hdr-brand"><span class="brand-mark">' + icon("live", 15) + '</span><span class="brand-word">Mimetic <b>Observer</b></span></div>'
      + '<div class="hdr-run">'
      + '<div class="hdr-run-title" title="' + esc(title) + '">' + esc(title) + '</div>'
      + '<div class="hdr-run-sub"><span class="hdr-persona">' + esc(persona) + '</span><span class="dot-sep"></span>'
      + '<button class="run-chip mono" data-action="toggle-details" aria-expanded="' + (S.detailsOpen ? "true" : "false") + '">' + esc(run.runId || "run") + '</button></div></div>'
      + '<div class="hdr-spacer"></div>'
      + buildStatusIndicator(counts, pct)
      + '<span class="status-pill" data-tone="' + tone(overall) + '">' + pip(overall, tone(overall) === "running") + statusLabel(overall) + '<span class="pct mono">' + pct + '%</span></span>'
      + '<button class="hdr-runs" data-action="open-history">' + icon("clock", 15) + '<span>Runs</span></button>'
      + '<button class="icon-btn" data-action="toggle-tweaks" aria-label="Settings" aria-pressed="' + (S.tweaksOpen ? "true" : "false") + '">' + icon("sliders") + '</button>'
      + '<button class="icon-btn" data-action="toggle-theme" aria-label="Toggle theme">' + icon(S.theme === "light" ? "moon" : "sun") + '</button>'
      + '</header>';
  }

  // ================================================================ TOOLBAR
  var STATUS_OPTS = [
    { id: "running", label: "Live", color: "var(--accent-2)" },
    { id: "complete", label: "Done", color: "var(--green)" },
    { id: "blocked", label: "Blocked", color: "var(--amber)" },
    { id: "failed", label: "Failed", color: "var(--red)" }
  ];
  var KIND_OPTS = [
    { id: "ui", label: "Browser" },
    { id: "terminal", label: "CLI" },
    { id: "tui", label: "TUI" },
    { id: "codex-ui", label: "Codex" }
  ];
  function optLabel(opts, id) {
    for (var i = 0; i < opts.length; i += 1) { if (opts[i].id === id) return opts[i].label; }
    return id;
  }
  function ddTrigger(kind, label, iconName, sel, opts) {
    var allOn = sel.length === 0;
    var summary = allOn ? label : (sel.length === 1 ? optLabel(opts, sel[0]) : (sel.length + " selected"));
    return '<div class="dd"><button id="dd-trigger-' + kind + '" class="dd-trigger" data-action="dd:' + kind + '" data-active="' + (allOn ? "false" : "true") + '" aria-haspopup="true" aria-expanded="' + (openDd === kind ? "true" : "false") + '">'
      + '<span class="dd-trigger-inner">' + (iconName ? icon(iconName, 14) : "") + '<span>' + esc(summary) + '</span></span>'
      + (allOn ? "" : '<span class="dd-badge">' + sel.length + '</span>')
      + icon("caret", 13) + '</button></div>';
  }
  function buildToolbar() {
    var total = currentData.streams.length;
    var shown = filteredStreams().length;
    return '<div class="toolbar">'
      + ddTrigger("status", "Status", "filter", S.statusSel, STATUS_OPTS)
      + ddTrigger("kind", "Kind", null, S.kindSel, KIND_OPTS)
      + '<label class="tb-search">' + icon("search", 14)
      + '<input data-role="search" type="text" placeholder="Filter lanes…" value="' + esc(S.query) + '" aria-label="Filter lanes by name or persona"/></label>'
      + '<span class="tb-result mono">' + shown + ' / ' + total + '</span>'
      + '<div class="tb-spacer"></div>'
      + '<div class="seg view-seg" role="group" aria-label="View mode">'
      + '<button aria-pressed="' + (S.view === "grid" ? "true" : "false") + '" title="Grid view" data-action="view:grid">' + icon("grid", 15) + '</button>'
      + '<button aria-pressed="' + (S.view === "focus" ? "true" : "false") + '" title="Focus view" data-action="view:focus">' + icon("focus", 15) + '</button></div>'
      + '<div class="seg media-seg" role="group" aria-label="Media mode">'
      + '<button aria-pressed="' + (S.media === "live" ? "true" : "false") + '"' + (hasLive() ? "" : " disabled") + ' title="Live streams" data-action="media:live">' + icon("live", 15) + '</button>'
      + '<button aria-pressed="' + (S.media === "screenshot" ? "true" : "false") + '" title="Screenshots" data-action="media:screenshot">' + icon("image", 15) + '</button></div>'
      + '<div class="seg density-seg" role="group" aria-label="Tile density">'
      + '<button aria-pressed="' + (S.density === "comfortable" ? "true" : "false") + '" title="Comfortable" data-action="density:comfortable">' + icon("comfy", 15) + '</button>'
      + '<button aria-pressed="' + (S.density === "compact" ? "true" : "false") + '" title="Compact" data-action="density:compact">' + icon("compact", 15) + '</button>'
      + '<button aria-pressed="' + (S.density === "dense" ? "true" : "false") + '" title="Dense" data-action="density:dense">' + icon("dense", 15) + '</button></div>'
      + '</div>';
  }
  function buildDdMenu() {
    if (!openDd) return "";
    var kind = openDd;
    var label = kind === "status" ? "Status" : "Kind";
    var opts = kind === "status" ? STATUS_OPTS : KIND_OPTS;
    var sel = kind === "status" ? S.statusSel : S.kindSel;
    var cnt = kind === "status" ? statusCount : kindCount;
    var allOn = sel.length === 0;
    var rows = '<button class="dd-row dd-row-all" data-action="dd-all:' + kind + '"><span class="dd-check" data-on="' + (allOn ? "true" : "false") + '">' + (allOn ? icon("check", 11) : "") + '</span><span class="dd-row-label">All ' + label.toLowerCase() + '</span></button><div class="dd-sep"></div>';
    rows += opts.map(function (o) {
      var on = sel.indexOf(o.id) >= 0;
      return '<button class="dd-row" data-action="dd-row:' + kind + ':' + o.id + '"><span class="dd-check" data-on="' + (on ? "true" : "false") + '">' + (on ? icon("check", 11) : "") + '</span>'
        + (o.color ? '<span class="dd-dot" style="background:' + o.color + '"></span>' : "")
        + '<span class="dd-row-label">' + o.label + '</span><span class="dd-row-n mono">' + cnt(o.id) + '</span></button>';
    }).join("");
    return '<div class="dd-menu" id="dd-menu" data-dd="' + kind + '" role="menu" style="visibility:hidden">' + rows + '</div>';
  }

  // ================================================================ GRID
  var TILE_MIN = { comfortable: "440px", compact: "330px", dense: "240px" };
  function buildTile(s, i) {
    var live = tone(s.status) === "running";
    return '<article class="tile" data-selected="' + (s.id === S.focusedId ? "true" : "false") + '" tabindex="0" role="button" data-action="open:' + esc(s.id) + '" aria-label="Open lane ' + pad2(i + 1) + ': ' + esc(laneName(s)) + '">'
      + '<header class="tile-head"><span class="tile-idx mono">' + pad2(i + 1) + '</span>' + pip(s.status, live)
      + '<span class="tile-name" title="' + esc(laneName(s)) + '">' + esc(laneName(s)) + '</span>'
      + '<span class="kind-badge" data-kind="' + esc(s.kind) + '">' + esc(s.kindLabel || s.kind) + '</span>'
      + '<span class="tile-dims mono">' + esc(dimsFor(s)) + '</span>'
      + '<span class="tile-open">' + icon("expand", 13) + '</span></header>'
      + '<div class="tile-surface" style="--aspect:' + aspectFor(s) + '">' + streamSurface(s, false) + '</div>'
      + '<footer class="tile-foot" data-status="' + esc(s.status) + '"><span class="tile-foot-text">' + (live ? '<span class="now-dot">▸</span>' : '') + esc(laneStep(s)) + '</span>'
      + '<span class="mini-prog"><span style="width:' + laneProgress(s) + '%"></span></span></footer>'
      + '</article>';
  }
  function buildGrid() {
    var streams = filteredStreams();
    if (!streams.length) {
      var msg = S.query ? ('Nothing matches "' + esc(S.query) + '".') : "Try a different status or kind.";
      return '<div class="grid-scroll"><div class="grid"><div class="grid-empty">'
        + '<div class="ge-icon">' + icon("search", 20) + '</div><h3>No lanes match your filters</h3>'
        + '<div>' + msg + ' <button class="linklike" data-action="clear-filters">Clear filters</button></div></div></div></div>';
    }
    var tiles = streams.map(function (s, i) { return buildTile(s, i); }).join("");
    return '<div class="grid-scroll"><div class="grid" style="--tile-min:' + TILE_MIN[S.density] + '">' + tiles + '</div></div>';
  }

  // ================================================================ FOCUS
  function focusIndex() {
    var ss = currentData.streams;
    var idx = -1;
    for (var i = 0; i < ss.length; i += 1) { if (ss[i].id === S.focusedId) { idx = i; break; } }
    return idx < 0 ? 0 : idx;
  }
  function railIcon(kind) {
    if (kind === "terminal" || kind === "tui") return "terminal";
    if (kind === "codex-ui") return "spark";
    return "globe";
  }
  function artifactHref(a) {
    return a && a.path ? linkHref(a.path, true) : "";
  }
  function ensureArtifactLoaded(a) {
    if (!a || !a.path || a.kind !== "filesystem") return;
    var key = a.path;
    if (artifactCache[key]) return;
    if (location.protocol === "file:") {
      artifactCache[key] = { status: "offline", text: "", json: null };
      return;
    }
    var href = artifactHref(a);
    if (!href) {
      artifactCache[key] = { status: "error", text: "", json: null, error: "Artifact path is not fetchable." };
      return;
    }
    artifactCache[key] = { status: "loading", text: "", json: null };
    fetch(href, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }).then(function (text) {
      var json = null;
      try { json = JSON.parse(text); } catch (e) {}
      artifactCache[key] = { status: "loaded", text: text, json: json };
      render();
    }).catch(function (e) {
      artifactCache[key] = { status: "error", text: "", json: null, error: e && e.message ? e.message : "Fetch failed." };
      render();
    });
  }
  function formatBytes(n) {
    if (typeof n !== "number" || !isFinite(n)) return "";
    if (n < 1024) return n + "b";
    if (n < 1024 * 1024) return Math.round(n / 102.4) / 10 + "kb";
    return Math.round(n / 1024 / 102.4) / 10 + "mb";
  }
  function renderGenericArtifact(a, state) {
    if (!state || state.status === "loading") return '<div class="fi-load"><span class="wait-spinner" style="width:18px;height:18px;display:inline-block;vertical-align:middle;margin-right:8px"></span>Loading artifact…</div>';
    if (state.status === "offline") return '<div class="fi-load">Static file view cannot hydrate artifacts inline. Open the artifact link directly.</div>';
    if (state.status === "error") return '<div class="fi-load">Could not load artifact: ' + esc(state.error || "unknown error") + '</div>';
    return '<div class="file-inspector"><div class="fi-head"><div class="fi-title"><h3>' + esc(a.label || a.path) + '</h3><span class="fi-status">artifact</span></div>'
      + '<div class="fi-summary mono">' + esc(a.path) + '</div></div>'
      + '<div class="fi-section"><pre class="fi-pre">' + esc(state.text || "") + '</pre></div></div>';
  }
  function renderSetupQualityArtifact(a, state) {
    if (!state || state.status !== "loaded" || !state.json || state.json.schema !== "mimetic.setup-quality.v1") {
      return renderGenericArtifact(a, state);
    }
    var q = state.json;
    var checks = q.checks || [];
    var mim = q.mimetic || {};
    var scripts = q.packageScripts || {};
    var tree = q.tree || [];
    var previews = q.previews || [];
    var scriptRows = Object.keys(scripts).sort().slice(0, 18).map(function (key) {
      return '<div class="fi-tree-row"><span>$</span><span>' + esc(key) + '</span><span class="fi-tree-size">' + esc(scripts[key]) + '</span></div>';
    }).join("");
    var treeRows = tree.slice(0, 160).map(function (entry) {
      return '<div class="fi-tree-row" data-type="' + esc(entry.type || "file") + '"><span>' + (entry.type === "directory" ? "dir" : "file") + '</span><span>' + esc(entry.path) + '</span><span class="fi-tree-size">' + esc(formatBytes(entry.sizeBytes)) + '</span></div>';
    }).join("");
    var previewRows = previews.length ? previews.map(function (preview) {
      return '<div class="fi-preview"><div class="fi-preview-head"><span>' + esc(preview.path) + '</span><span>' + esc(preview.language || "text") + (preview.truncated ? " · truncated" : "") + '</span></div><pre class="fi-pre">' + esc(preview.text || "") + '</pre></div>';
    }).join("") : '<div class="tab-empty">No raw file previews persisted for this run.</div>';
    return '<div class="file-inspector"><div class="fi-head"><div class="fi-title"><h3>Setup quality</h3><span class="fi-status" data-status="' + esc(q.status || "unknown") + '">' + esc(q.status || "unknown") + '</span></div>'
      + '<div class="fi-summary">' + esc(q.summary || "") + '</div><div class="fi-summary mono">' + esc(a.path) + '</div></div>'
      + '<div class="fi-section"><div class="fi-grid">'
      + '<div class="fi-stat"><div class="fi-stat-k">personas</div><div class="fi-stat-v">' + esc(mim.personaCount || 0) + '</div></div>'
      + '<div class="fi-stat"><div class="fi-stat-k">scenarios</div><div class="fi-stat-v">' + esc(mim.scenarioCount || 0) + '</div></div>'
      + '<div class="fi-stat"><div class="fi-stat-k">config</div><div class="fi-stat-v">' + (mim.configPresent ? "present" : "missing") + '</div></div>'
      + '<div class="fi-stat"><div class="fi-stat-k">runtime ignore</div><div class="fi-stat-v">' + (mim.gitignoreContainsRuntimeIgnore ? "present" : "missing") + '</div></div>'
      + '</div></div>'
      + '<div class="fi-section"><div class="fi-section-title"><span>Checks</span><span class="mono">' + checks.filter(function (c) { return c.ok; }).length + ' / ' + checks.length + '</span></div>'
      + checks.map(function (check) { return '<div class="fi-check" data-ok="' + (check.ok ? "true" : "false") + '"><span class="fi-dot">' + icon(check.ok ? "check" : "alert", 11) + '</span><div><div class="fi-check-name">' + esc(check.label) + '</div><div class="fi-check-detail">' + esc(check.detail) + '</div></div></div>'; }).join("") + '</div>'
      + '<div class="fi-section"><div class="fi-section-title"><span>Package scripts</span><span class="mono">' + Object.keys(scripts).length + '</span></div><div class="fi-tree">' + (scriptRows || '<div class="tab-empty">No package scripts captured.</div>') + '</div></div>'
      + '<div class="fi-section"><div class="fi-section-title"><span>Tree</span><span class="mono">' + tree.length + '</span></div><div class="fi-tree">' + (treeRows || '<div class="tab-empty">No tree entries captured.</div>') + '</div></div>'
      + '<div class="fi-section"><div class="fi-section-title"><span>Previews</span><span class="mono">' + previews.length + '</span></div>' + previewRows + '</div></div>';
  }
  function buildFilesTab(s) {
    var arts = laneArtifacts(s);
    if (!arts.length) return '<div class="tab-empty">No evidence artifacts linked.</div>';
    var selected = null;
    for (var i = 0; i < arts.length; i += 1) {
      if (arts[i].path === S.filePath) { selected = arts[i]; break; }
    }
    if (!selected) {
      for (var j = 0; j < arts.length; j += 1) {
        if (arts[j].kind === "filesystem") { selected = arts[j]; break; }
      }
    }
    var inspector = "";
    if (selected && selected.kind === "filesystem") {
      ensureArtifactLoaded(selected);
      inspector = renderSetupQualityArtifact(selected, artifactCache[selected.path]);
    }
    var rows = arts.map(function (a) {
      var href = artifactHref(a);
      var isSelected = selected && selected.path === a.path;
      var inspectable = a.kind === "filesystem";
      var main = inspectable
        ? '<button data-action="inspect-file:' + esc(a.path) + '"><span class="file-ic">' + icon("file", 14) + '</span><span class="file-meta"><div class="file-name">' + esc(a.label) + '</div><div class="file-path mono">' + esc(a.path) + '</div></span><span class="file-kind">' + esc(a.kind) + '</span></button>'
        : '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" data-action="external"><span class="file-ic">' + icon("file", 14) + '</span><span class="file-meta"><div class="file-name">' + esc(a.label) + '</div><div class="file-path mono">' + esc(a.path) + '</div></span><span class="file-kind">' + esc(a.kind) + '</span></a>';
      return '<div class="file-row" data-selected="' + (isSelected ? "true" : "false") + '">' + main
        + (href ? '<a class="file-open" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" data-action="external">open</a>' : "")
        + '</div>';
    }).join("");
    return inspector + rows;
  }
  function buildSideBody(s) {
    if (S.tab === "events") {
      var evs = laneEvents(s);
      if (!evs.length) return '<div class="tab-empty">No lifecycle events recorded yet.</div>';
      return evs.map(function (ev, i) {
        var ic = (ev.level === "error" || ev.level === "warn") ? "alert" : "info";
        return '<div class="evt" data-level="' + esc(ev.level) + '"><div class="evt-rail"><span class="evt-icon">' + icon(ic, 12) + '</span>' + (i === evs.length - 1 ? '' : '<span class="evt-conn"></span>') + '</div>'
          + '<div><div class="evt-text">' + esc(ev.message) + '</div><div class="evt-meta"><span class="evt-type mono">' + esc(ev.type) + '</span><span>· ' + esc(shortTime(ev.at) || "just now") + '</span></div></div></div>';
      }).join("");
    }
    if (S.tab === "files") {
      return buildFilesTab(s);
    }
    var lines = termLines(s);
    if (!lines.length) lines = [{ text: "No log text recorded for this lane.", cls: "dim" }];
    var rows = lines.map(function (ln, i) {
      return '<div class="term-line"><span class="term-num">' + pad2(i + 1) + '</span><span class="term-txt ' + ln.cls + '">' + esc(ln.text || " ") + '</span></div>';
    }).join("");
    return '<div class="term" style="position:static;height:100%"><div class="term-body" style="overflow-y:auto">' + rows + '</div></div>';
  }
  function buildFocus() {
    var ss = currentData.streams;
    if (!ss.length) return '<div class="grid-empty"><h3>No lanes in this run.</h3></div>';
    var idx = focusIndex();
    var s = ss[idx];
    var run = currentData.run;
    var live = tone(s.status) === "running";
    var tabs = [
      { id: "events", label: "Events", n: laneEvents(s).length },
      { id: "files", label: "Files", n: laneArtifacts(s).length },
      { id: "logs", label: "Logs", n: termLines(s).length }
    ];
    var rail = '<aside class="focus-rail" aria-label="Lanes"><div class="focus-rail-head"><span class="eyebrow">' + ss.length + ' lanes</span>'
      + '<button class="icon-btn" style="width:26px;height:26px" data-action="toggle-rail" aria-label="Collapse lane rail">' + icon("chevL", 15) + '</button></div>'
      + '<div class="focus-rail-list">' + ss.map(function (r) {
        return '<button class="rail-item" data-selected="' + (r.id === s.id ? "true" : "false") + '" data-action="select:' + esc(r.id) + '">'
          + '<span class="rail-thumb">' + icon(railIcon(r.kind), 13) + '</span>'
          + '<span class="rail-meta"><span class="rail-name">' + esc(laneName(r)) + '</span><span class="rail-sub">' + pip(r.status, tone(r.status) === "running") + ' ' + esc(r.kindLabel || r.kind) + '</span></span></button>';
      }).join("") + '</div></aside>';

    var stage = '<section class="focus-stage"><header class="focus-bar"><div class="crumbs">'
      + (S.railCollapsed ? '<button class="crumb-rail-toggle" data-action="toggle-rail" aria-label="Show lane rail">' + icon("list", 15) + '</button>' : '')
      + '<button data-action="exit-focus">Grid</button><span class="sep">/</span>'
      + '<span class="mono" style="color:var(--text-3)">' + pad2(idx + 1) + '</span>'
      + '<span class="cur" title="' + esc(laneName(s)) + '">' + esc(laneName(s)) + '</span></div>'
      + '<div class="tb-spacer"></div>'
      + '<span class="focus-status" data-tone="' + tone(s.status) + '" style="color:' + statusColor(s.status) + '">' + pip(s.status, live) + ' ' + statusLabel(s.status) + '</span>'
      + '<div class="focus-nav"><button class="icon-btn" data-action="nav:-1" aria-label="Previous lane">' + icon("chevL") + '</button>'
      + '<span class="focus-stepper mono">' + (idx + 1) + ' / ' + ss.length + '</span>'
      + '<button class="icon-btn" data-action="nav:1" aria-label="Next lane">' + icon("chevR") + '</button></div>'
      + '<button class="icon-btn" data-action="toggle-side" aria-pressed="' + (S.sideCollapsed ? "false" : "true") + '" aria-label="Toggle details panel">' + icon("panelRight") + '</button>'
      + '<button class="icon-btn" data-action="exit-focus" aria-label="Close focus (Esc)">' + icon("x") + '</button></header>'
      + '<div class="focus-stage-area"><div class="focus-frame" style="--aspect:' + aspectFor(s) + '">' + streamSurface(s, true) + '</div></div></section>';

    var side = "";
    if (!S.sideCollapsed) {
      side = '<aside class="focus-side" data-sheet="' + (S.sheetOpen ? "open" : "closed") + '">'
        + '<button class="sheet-grip" data-action="toggle-sheet" aria-label="Toggle details"></button>'
        + '<div class="side-context"><div class="side-persona-row"><span class="side-avatar mono">' + esc(initials((run.persona && run.persona.name) || "")) + '</span>'
        + '<div style="min-width:0"><div class="side-persona-name">' + esc((run.persona && run.persona.name) || "Persona") + '</div><div class="side-persona-id mono">attempting · ' + esc(laneName(s)) + '</div></div></div>'
        + '<div class="side-goal"><span class="eyebrow">Goal</span><div class="side-goal-text">' + esc((run.scenario && run.scenario.goal) || laneSummary(s)) + '</div></div>'
        + '<div class="side-now"><div class="side-now-row">' + pip(s.status, live) + '<span class="eyebrow" style="color:' + (live ? "var(--accent-2)" : "var(--text-3)") + '">' + (live ? "Now" : "Last step") + '</span></div>'
        + '<div class="side-now-text">' + esc(laneStep(s)) + '</div></div></div>'
        + '<div class="side-tabs" role="tablist">' + tabs.map(function (t) {
          return '<button class="side-tab" role="tab" aria-selected="' + (S.tab === t.id ? "true" : "false") + '" data-action="tab:' + t.id + '">' + t.label + '<span class="tab-n">' + t.n + '</span></button>';
        }).join("") + '</div>'
        + '<div class="side-body">' + buildSideBody(s) + '</div></aside>';
    }
    return '<div class="focus" data-rail="' + (S.railCollapsed ? "collapsed" : "open") + '" data-side="' + (S.sideCollapsed ? "collapsed" : "open") + '">' + rail + stage + side + '</div>';
  }
  function statusColor(st) {
    var t = tone(st);
    return t === "running" ? "var(--accent-2)" : t === "complete" ? "var(--green)" : t === "blocked" ? "var(--amber)" : st === "failed" ? "var(--red)" : "var(--text-2)";
  }

  // ================================================================ CONSOLE + STATUSBAR
  function buildConsole() {
    var lines = consoleLines();
    var rows = lines.map(function (ln) {
      return '<div class="console-line"><span class="console-t">' + esc(ln.t) + '</span><span class="console-txt ' + ln.lvl + '">' + esc(ln.text) + '</span></div>';
    }).join("");
    var caretT = lines.length ? lines[lines.length - 1].t : "";
    return '<section class="console" style="height:230px" role="dialog" aria-label="Run console">'
      + '<header class="console-head"><span class="console-title">' + icon("terminal", 14) + ' Run console <span class="mono console-cmd">mimetic watch</span></span>'
      + (hasLive() ? '<span class="console-live">' + pip("running", true) + ' tailing</span>' : '')
      + '<div class="tb-spacer"></div><span class="console-meta mono">' + lines.length + ' lines</span>'
      + '<button class="icon-btn" style="width:28px;height:28px" data-action="toggle-console" aria-label="Close console">' + icon("x", 15) + '</button></header>'
      + '<div class="console-body mono" id="console-body">' + rows
      + '<div class="console-line"><span class="console-t">' + esc(caretT) + '</span><span class="console-txt"><span class="term-caret"></span></span></div></div></section>';
  }
  function buildStatusBar() {
    var overall = overallStatus(), pct = overallPct();
    var run = currentData.run;
    var counts = statusCountsModel().filter(function (c) { return c.count > 0; });
    var last = consoleLines();
    var lastLine = last[last.length - 1];
    var peek = (!S.consoleOpen && lastLine) ? ('<span class="sb-console-peek mono"><span class="sb-peek-t">' + esc(lastLine.t) + '</span><span class="sb-peek-txt ' + lastLine.lvl + '">' + esc(lastLine.text) + '</span></span>') : "";
    return '<footer class="statusbar">'
      + '<span class="sb-status" data-tone="' + tone(overall) + '">' + pip(overall, tone(overall) === "running") + '<span class="sb-status-label mono">' + statusLabel(overall) + '</span><span class="sb-pct mono">' + pct + '%</span></span>'
      + '<span class="sb-prog"><span style="width:' + pct + '%" data-tone="' + tone(overall) + '"></span></span>'
      + '<span class="sb-counts">' + counts.map(function (c) { return '<span class="sb-count" title="' + c.count + ' ' + c.label + '"><span class="si-dot" style="background:' + c.color + '"></span><span class="mono">' + c.count + '</span></span>'; }).join("") + '</span>'
      + '<span class="sb-run mono">' + esc((run.mode || "") + " · " + (run.runId || "")) + '</span>'
      + '<div class="tb-spacer"></div>'
      + '<button class="sb-console" aria-expanded="' + (S.consoleOpen ? "true" : "false") + '" data-action="toggle-console" title="Run console (backtick)">' + icon("terminal", 14)
      + '<span class="sb-console-label">Run console</span>' + peek
      + '<span class="sb-chev' + (S.consoleOpen ? " open" : "") + '">' + icon("caret", 13) + '</span></button>'
      + '</footer>';
  }

  // ================================================================ DRAWER + POPOVERS
  function buildPopover() {
    var run = currentData.run;
    return '<div class="pop" role="dialog" aria-label="Run details">'
      + popRow("Run id", esc(run.runId || ""))
      + popRow("Started", esc(shortStamp(run.createdAt)))
      + popRow("Mode", '<span class="tag">' + esc(run.mode || "") + '</span>')
      + popRow("Package", esc(run.packageName || "(none)"))
      + popRow("Evidence", '<span class="tag" data-tone="green">' + icon("lock", 10) + ' local-only</span>')
      + '</div>';
  }
  function popRow(k, v) { return '<div class="pop-row"><span class="pop-k">' + k + '</span><span class="pop-v">' + v + '</span></div>'; }

  function buildTweaks() {
    return '<div class="tweaks-pop" role="dialog" aria-label="Settings">'
      + '<div class="tw-sec">Appearance</div>'
      + twSeg("Theme", "theme", S.theme, [["dark", "dark"], ["light", "light"]])
      + '<div class="tw-row"><span class="tw-label">Accent</span><span class="tw-swatches">'
      + ["#4d7cfe", "#7c5cff", "#34d399", "#f0a92b", "#fb5d52"].map(function (col) {
        return '<button class="tw-swatch" aria-pressed="' + (S.accent === col ? "true" : "false") + '" data-action="tweak:accent:' + col + '" style="background:' + col + '" title="' + col + '"></button>';
      }).join("") + '</span></div>'
      + '<div class="tw-sec">Layout</div>'
      + twSeg("Density", "density", S.density, [["comfortable", "comfy"], ["compact", "compact"], ["dense", "dense"]])
      + twSeg("Status", "statusViz", S.statusViz, [["badges", "badges"], ["bar", "bar"], ["ring", "ring"]])
      + '<div class="tw-sec">Motion</div>'
      + twSeg("Motion", "motion", S.motion, [["full", "full"], ["reduced", "reduced"]])
      + '</div>';
  }
  function twSeg(label, key, value, opts) {
    return '<div class="tw-row"><span class="tw-label">' + label + '</span><span class="tw-seg">'
      + opts.map(function (o) { return '<button aria-pressed="' + (value === o[0] ? "true" : "false") + '" data-action="tweak:' + key + ':' + o[0] + '">' + o[1] + '</button>'; }).join("")
      + '</span></div>';
  }

  function historyRuns() {
    if (historyIndex && historyIndex.runs && historyIndex.runs.length) return historyIndex.runs;
    var run = currentData.run;
    return [{ runId: run.runId, createdAt: run.createdAt, mode: run.mode, status: overallStatus(), streamCount: currentData.streams.length, href: null }];
  }
  function buildDrawer() {
    var runs = historyRuns();
    var activeId = currentData.run.runId;
    var rows = runs.map(function (r) {
      var t = tone(r.status);
      var col = t === "running" ? "var(--accent-2)" : t === "complete" ? "var(--green)" : t === "blocked" ? "var(--amber)" : r.status === "failed" ? "var(--red)" : "var(--text-2)";
      var liveTagTxt = (r.runId === activeId && t === "running") ? '<span style="color:var(--accent-2)"> · live</span>' : "";
      return '<button class="run-row" data-active="' + (r.runId === activeId ? "true" : "false") + '" data-action="run:' + esc(r.runId) + '">'
        + pip(r.status, t === "running")
        + '<span class="run-row-id mono">' + esc(r.runId) + liveTagTxt + '</span>'
        + '<span class="run-row-stat" style="color:' + col + '">' + statusLabel(r.status) + '</span>'
        + '<span class="run-row-meta mono">' + esc((r.mode || "run") + " · " + (r.streamCount || 0) + " lanes · " + shortStamp(r.createdAt)) + '</span></button>';
    }).join("");
    return '<div class="scrim" data-action="close-history"></div><aside class="drawer" role="dialog" aria-label="Run history">'
      + '<header class="drawer-head"><div><span class="eyebrow">Run history</span><h2>Recent runs</h2></div>'
      + '<button class="icon-btn" data-action="close-history" aria-label="Close">' + icon("x") + '</button></header>'
      + '<div class="drawer-list">' + rows + '</div></aside>';
  }

  // ================================================================ RENDER
  function captureScrolls() {
    var map = {};
    [".grid-scroll", ".console-body", ".focus-rail-list", ".side-body", ".focus-stage-area", ".drawer-list"].forEach(function (sel) {
      var el = app.querySelector(sel);
      if (el) map[sel] = el.scrollTop;
    });
    return map;
  }
  function restoreScrolls(map) {
    Object.keys(map).forEach(function (sel) {
      var el = app.querySelector(sel);
      if (el) el.scrollTop = map[sel];
    });
  }
  function placeMenus() {
    var menu = document.getElementById("dd-menu");
    if (!menu) return;
    var kind = menu.getAttribute("data-dd");
    var trg = document.getElementById("dd-trigger-" + kind);
    if (!trg) { menu.style.visibility = "visible"; return; }
    var w = 210;
    var r = trg.getBoundingClientRect();
    var left = r.left;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
    menu.style.width = w + "px";
    menu.style.top = (r.bottom + 6) + "px";
    menu.style.left = left + "px";
    menu.style.visibility = "visible";
  }
  function ensureLiveStreamHost() {
    if (liveStreamHost) return liveStreamHost;
    if (!document.createElement) return null;
    var host = document.body || document.documentElement;
    if (!host || !host.appendChild) return null;
    liveStreamHost = document.createElement("div");
    liveStreamHost.setAttribute("data-live-stream-host", "true");
    liveStreamHost.style.position = "fixed";
    liveStreamHost.style.inset = "0";
    liveStreamHost.style.overflow = "visible";
    liveStreamHost.style.pointerEvents = "none";
    liveStreamHost.style.zIndex = "20";
    host.appendChild(liveStreamHost);
    return liveStreamHost;
  }
  function createLiveStreamRecord(id, url, title) {
    var host = ensureLiveStreamHost();
    if (!host) return null;
    var wrapper = document.createElement("div");
    wrapper.setAttribute("data-live-stream-wrapper", id);
    wrapper.style.position = "fixed";
    wrapper.style.overflow = "hidden";
    wrapper.style.background = "#000";
    wrapper.style.pointerEvents = "none";
    wrapper.style.display = "none";
    var frame = document.createElement("iframe");
    frame.style.position = "absolute";
    frame.style.border = "0";
    frame.style.margin = "0";
    frame.style.display = "block";
    frame.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", title || "live stream");
    frame.setAttribute("data-live-stream-frame", id);
    frame.src = url;
    var overlay = document.createElement("div");
    overlay.className = "live-stream-overlay";
    overlay.style.position = "absolute";
    overlay.style.overflow = "hidden";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "2";
    wrapper.appendChild(frame);
    wrapper.appendChild(overlay);
    host.appendChild(wrapper);
    return { url: url, wrapper: wrapper, frame: frame, overlay: overlay, overlayHtml: "" };
  }
  function removeLiveStreamRecord(id) {
    var rec = liveStreamFrames[id];
    if (rec && rec.wrapper && rec.wrapper.parentNode) rec.wrapper.parentNode.removeChild(rec.wrapper);
    delete liveStreamFrames[id];
  }
  function hideLiveStreamRecord(rec) {
    if (!rec || !rec.wrapper) return;
    rec.wrapper.style.display = "none";
    rec.wrapper.style.pointerEvents = "none";
  }
  function clipRect(rect) {
    var stage = app.querySelector && app.querySelector(".stage");
    var s = stage && stage.getBoundingClientRect ? stage.getBoundingClientRect() : null;
    var left = Math.max(rect.left, 0, s ? s.left : 0);
    var top = Math.max(rect.top, 0, s ? s.top : 0);
    var right = Math.min(rect.right, window.innerWidth || rect.right, s ? s.right : rect.right);
    var bottom = Math.min(rect.bottom, window.innerHeight || rect.bottom, s ? s.bottom : rect.bottom);
    return { left: left, top: top, right: right, bottom: bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }
  function layoutLiveStreamRecord(rec, mount, overlayHtml) {
    if (!rec || !mount || !mount.getBoundingClientRect) return hideLiveStreamRecord(rec);
    var rect = mount.getBoundingClientRect();
    var clipped = clipRect(rect);
    if (rect.width < 2 || rect.height < 2 || clipped.width < 2 || clipped.height < 2) return hideLiveStreamRecord(rec);
    rec.wrapper.style.display = "block";
    rec.wrapper.style.left = clipped.left + "px";
    rec.wrapper.style.top = clipped.top + "px";
    rec.wrapper.style.width = clipped.width + "px";
    rec.wrapper.style.height = clipped.height + "px";
    rec.wrapper.style.pointerEvents = S.view === "focus" ? "auto" : "none";
    rec.frame.style.left = (rect.left - clipped.left) + "px";
    rec.frame.style.top = (rect.top - clipped.top) + "px";
    rec.frame.style.width = rect.width + "px";
    rec.frame.style.height = rect.height + "px";
    rec.frame.style.pointerEvents = S.view === "focus" ? "auto" : "none";
    if (rec.overlay) {
      rec.overlay.style.left = rec.frame.style.left;
      rec.overlay.style.top = rec.frame.style.top;
      rec.overlay.style.width = rec.frame.style.width;
      rec.overlay.style.height = rec.frame.style.height;
      rec.overlay.setAttribute("data-focus", S.view === "focus" ? "true" : "false");
      if (rec.overlayHtml !== overlayHtml) {
        rec.overlay.innerHTML = overlayHtml || "";
        rec.overlayHtml = overlayHtml || "";
      }
    }
  }
  function reconcileLiveStreams() {
    if (!app.querySelectorAll || !document.createElement) return;
    var known = {};
    currentData.streams.forEach(function (s) {
      var url = browserLiveUrl(s);
      if (url) known[s.id] = { url: url, stream: s };
    });
    var mounts = app.querySelectorAll("[data-live-stream-id]");
    var visible = {};
    Array.prototype.forEach.call(mounts, function (mount) {
      var id = mount.getAttribute("data-live-stream-id");
      var url = mount.getAttribute("data-live-stream-url") || "";
      var title = mount.getAttribute("data-live-stream-title") || "live stream";
      if (!id || !url) return;
      var knownStream = known[id] && known[id].stream;
      var overlayHtml = knownStream ? browserLabDock(knownStream, browserShot(knownStream)) : "";
      var rec = liveStreamFrames[id];
      if (!rec || rec.url !== url) {
        removeLiveStreamRecord(id);
        rec = createLiveStreamRecord(id, url, title);
        if (!rec) return;
        liveStreamFrames[id] = rec;
      } else {
        rec.frame.setAttribute("title", title);
      }
      visible[id] = true;
      layoutLiveStreamRecord(rec, mount, overlayHtml);
    });
    Object.keys(liveStreamFrames).forEach(function (id) {
      var rec = liveStreamFrames[id];
      if (!known[id] || (rec && rec.url !== known[id].url)) removeLiveStreamRecord(id);
      else if (!visible[id]) hideLiveStreamRecord(rec);
    });
  }
  function scheduleLiveStreamLayout() {
    if (liveStreamLayoutRaf != null) return;
    var raf = window.requestAnimationFrame || function (fn) { return window.setTimeout(fn, 16); };
    liveStreamLayoutRaf = raf(function () {
      liveStreamLayoutRaf = null;
      reconcileLiveStreams();
    });
  }

  function render() {
    var docEl = document.documentElement;
    docEl.setAttribute("data-theme", S.theme);
    docEl.setAttribute("data-motion", S.motion);
    docEl.style.setProperty("--accent-color", S.accent);
    docEl.style.setProperty("--accent", S.accent);

    var ss = currentData.streams;
    if (!S.focusedId || !ss.some(function (s) { return s.id === S.focusedId; })) S.focusedId = ss.length ? ss[0].id : null;

    var active = document.activeElement;
    var searchFocused = !!(active && active.getAttribute && active.getAttribute("data-role") === "search");
    var caret = searchFocused ? active.selectionStart : null;
    var scrolls = captureScrolls();

    var parts = [];
    parts.push('<div class="runline" data-status="' + overallStatus() + '"><span style="width:' + overallPct() + '%"></span></div>');
    parts.push(buildHeader());
    if (S.detailsOpen) parts.push(buildPopover());
    if (S.tweaksOpen) parts.push(buildTweaks());
    parts.push(buildToolbar());
    parts.push('<main class="stage">' + (S.view === "grid" ? buildGrid() : buildFocus()) + '</main>');
    if (S.consoleOpen) parts.push(buildConsole());
    parts.push(buildStatusBar());
    if (S.historyOpen) parts.push(buildDrawer());
    parts.push(buildDdMenu());
    app.innerHTML = parts.join("");

    restoreScrolls(scrolls);
    if (searchFocused) {
      var inp = app.querySelector('[data-role="search"]');
      if (inp) { inp.focus(); try { inp.setSelectionRange(caret, caret); } catch (e) {} }
    }
    placeMenus();
    reconcileLiveStreams();
    var cb = document.getElementById("console-body");
    if (cb && scrolls[".console-body"] == null) cb.scrollTop = cb.scrollHeight;
  }

  // ================================================================ ACTIONS
  function toggleArr(arr, id) {
    var i = arr.indexOf(id);
    if (i >= 0) { arr.splice(i, 1); } else { arr.push(id); }
  }
  function writeHash(id) {
    var url = new URL(window.location.href);
    url.hash = id ? "focus=" + encodeURIComponent(id) : "";
    if (url.href !== window.location.href) window.history.replaceState({ focusedId: id }, "", url.href);
  }
  function openFocus(id) { S.focusedId = id; S.view = "focus"; writeHash(id); render(); }
  function exitFocus() { S.view = "grid"; writeHash(null); render(); }
  function navFocus(delta) {
    var ss = currentData.streams;
    if (!ss.length) return;
    var idx = focusIndex();
    var next = ((idx + delta) % ss.length + ss.length) % ss.length;
    S.focusedId = ss[next].id;
    writeHash(S.focusedId);
    render();
  }

  function handleAction(action) {
    var parts = action.split(":");
    var cmd = parts[0];
    var arg = parts[1];
    var arg2 = parts[2];
    switch (cmd) {
      case "open": openFocus(arg); break;
      case "select": S.focusedId = arg; writeHash(arg); render(); break;
      case "exit-focus": exitFocus(); break;
      case "view":
        if (arg === "focus" && !S.focusedId && currentData.streams[0]) S.focusedId = currentData.streams[0].id;
        S.view = arg; writeHash(arg === "focus" ? S.focusedId : null); render(); break;
      case "nav": navFocus(Number(arg)); break;
      case "toggle-rail": S.railCollapsed = !S.railCollapsed; writePref("railCollapsed", S.railCollapsed); render(); break;
      case "toggle-side": S.sideCollapsed = !S.sideCollapsed; writePref("sideCollapsed", S.sideCollapsed); render(); break;
      case "toggle-sheet": S.sheetOpen = !S.sheetOpen; render(); break;
      case "tab": S.tab = arg; render(); break;
      case "density": S.density = arg; writePref("density", arg); render(); break;
      case "media": if (arg === "live" && !hasLive()) break; S.media = arg; render(); break;
      case "status":
        if (arg === "all") S.statusSel = [];
        else toggleArr(S.statusSel, arg);
        render(); break;
      case "clear-filters": S.statusSel = []; S.kindSel = []; S.query = ""; render(); break;
      case "dd": openDd = (openDd === arg ? null : arg); render(); break;
      case "dd-all":
        if (arg === "status") S.statusSel = []; else S.kindSel = [];
        render(); break;
      case "dd-row":
        if (arg === "status") toggleArr(S.statusSel, arg2); else toggleArr(S.kindSel, arg2);
        render(); break;
      case "toggle-console": S.consoleOpen = !S.consoleOpen; render(); break;
      case "inspect-file": S.filePath = action.slice("inspect-file:".length); S.tab = "files"; render(); break;
      case "toggle-details": S.detailsOpen = !S.detailsOpen; S.tweaksOpen = false; render(); break;
      case "toggle-tweaks": S.tweaksOpen = !S.tweaksOpen; S.detailsOpen = false; render(); break;
      case "toggle-theme": S.theme = (S.theme === "light" ? "dark" : "light"); writePref("theme", S.theme); render(); break;
      case "tweak":
        S[arg] = arg2; writePref(arg, arg2); render(); break;
      case "open-history": S.historyOpen = true; render(); refreshHistoryIndex(); break;
      case "close-history": S.historyOpen = false; render(); break;
      case "run": gotoRun(arg); break;
      default: break;
    }
  }
  function gotoRun(runId) {
    if (runId === currentData.run.runId) { S.historyOpen = false; render(); return; }
    if (location.protocol === "file:") { S.historyOpen = false; render(); return; }
    window.location.href = "/_mimetic/runs/" + encodeURIComponent(runId) + "/observer/index.html";
  }

  // ================================================================ EVENTS (bound once)
  app.addEventListener("click", function (e) {
    var t = e.target.closest ? e.target.closest("[data-action]") : null;
    if (!t || !app.contains(t)) return;
    var action = t.getAttribute("data-action");
    if (t.tagName !== "A") e.preventDefault();
    handleAction(action);
  });
  app.addEventListener("input", function (e) {
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute("data-role") === "search") { S.query = t.value; render(); }
  });
  document.addEventListener("mousedown", function (e) {
    if (openDd) {
      var inMenu = e.target.closest && (e.target.closest(".dd-menu") || e.target.closest(".dd-trigger"));
      if (!inMenu) { openDd = null; render(); return; }
    }
    if (S.detailsOpen) {
      var inPop = e.target.closest && (e.target.closest(".pop") || e.target.closest(".run-chip"));
      if (!inPop) { S.detailsOpen = false; render(); }
    }
    if (S.tweaksOpen) {
      var inTw = e.target.closest && (e.target.closest(".tweaks-pop") || e.target.closest('[data-action="toggle-tweaks"]'));
      if (!inTw) { S.tweaksOpen = false; render(); }
    }
  });
  document.addEventListener("keydown", function (e) {
    var typing = document.activeElement && document.activeElement.tagName === "INPUT";
    if (e.key === "Escape") {
      if (openDd) { openDd = null; return render(); }
      if (S.detailsOpen) { S.detailsOpen = false; return render(); }
      if (S.tweaksOpen) { S.tweaksOpen = false; return render(); }
      if (S.consoleOpen) { S.consoleOpen = false; return render(); }
      if (S.historyOpen) { S.historyOpen = false; return render(); }
      if (S.view === "focus") { return exitFocus(); }
    }
    if ((e.key === String.fromCharCode(96) || e.key === "~") && !typing) { e.preventDefault(); S.consoleOpen = !S.consoleOpen; render(); }
    if (e.key === "/" && S.view === "grid" && !typing) {
      e.preventDefault();
      var el = app.querySelector(".tb-search input");
      if (el) el.focus();
    }
    if (S.view === "focus" && (e.key === "ArrowRight" || e.key === "ArrowLeft") && !typing) {
      navFocus(e.key === "ArrowRight" ? 1 : -1);
    }
  });
  window.addEventListener("hashchange", function () {
    var next = focusFromHash();
    if (next && currentData.streams.some(function (s) { return s.id === next; })) {
      S.focusedId = next; if (S.view !== "focus") S.view = "focus"; render();
    }
  });
  window.addEventListener("resize", function () { if (openDd) placeMenus(); scheduleLiveStreamLayout(); });
  app.addEventListener("scroll", scheduleLiveStreamLayout, true);

  // ================================================================ POLLING
  function dataKey(d) {
    var streams = (d.streams || []).map(function (s) {
      return {
        id: s.id,
        status: s.status,
        progress: laneProgress(s),
        step: laneStep(s),
        updatedAt: s.updatedAt,
        url: browserLiveUrl(s),
        route: laneRoute(s),
        tail: (s.terminalPlain || (s.terminal && s.terminal.tail) || "").slice(-1200),
        artifacts: (s.artifacts || []).map(function (a) { return [a.kind, a.path, a.label]; }),
        completion: s.completion || null
      };
    });
    var events = (d.events || []).slice(-200).map(function (e) { return [e.at, e.level, e.type, e.simId, e.streamId, e.message]; });
    var run = d.run || {};
    return JSON.stringify({
      run: [run.runId, run.status, (run.lifecycle || []).length, (run.knownGaps || []).length],
      summary: d.summary || {},
      streams: streams,
      events: events
    });
  }
  function refresh() {
    if (location.protocol === "file:") return Promise.resolve();
    return fetch(DATA_FILE, { cache: "no-store" }).then(function (r) {
      if (!r.ok) return;
      return r.json().then(function (d) {
        if (!d || !d.streams) return;
        var prev = dataKey(currentData);
        currentData = d;
        if (!currentData.run) currentData.run = {};
        if (!currentData.streams) currentData.streams = [];
        if (!currentData.events) currentData.events = [];
        if (dataKey(currentData) !== prev) render();
      });
    }).catch(function () {});
  }
  function refreshHistoryIndex() {
    if (location.protocol === "file:") return Promise.resolve();
    return fetch("/_mimetic/history.json", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("history " + r.status);
      return r.json();
    }).then(function (d) {
      historyIndex = d;
      if (S.historyOpen) render();
    }).catch(function () { historyIndex = null; if (S.historyOpen) render(); });
  }

  // ================================================================ BOOT
  render();
  refresh().then(function () {
    if (location.protocol !== "file:") {
      refreshTimer = setInterval(refresh, REFRESH_MS);
      refreshHistoryIndex();
      historyTimer = setInterval(refreshHistoryIndex, 30000);
    }
  });
}());
`;
}
