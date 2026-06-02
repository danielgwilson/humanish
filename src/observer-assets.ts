export function observerCss(): string {
  return `
:root {
  --obs-bg: #0a0a0a;
  --obs-bg-1: #0f0f10;
  --obs-bg-2: #141416;
  --obs-bg-3: #1a1a1c;
  --obs-bg-4: #232326;
  --obs-line: rgba(255, 255, 255, 0.06);
  --obs-line-2: rgba(255, 255, 255, 0.1);
  --obs-line-3: rgba(255, 255, 255, 0.18);
  --obs-fg-1: #f4f4f3;
  --obs-fg-2: #b6b6b1;
  --obs-fg-3: #7a7a75;
  --obs-fg-4: #4d4d49;
  --obs-blue: #3f71fa;
  --obs-blue-soft: rgba(63, 113, 250, 0.16);
  --obs-blue-line: rgba(63, 113, 250, 0.4);
  --obs-sky: #70d8fa;
  --obs-amber: #d48806;
  --obs-amber-soft: rgba(212, 136, 6, 0.14);
  --obs-red: #e0584a;
  --obs-red-soft: rgba(224, 88, 74, 0.14);
  --obs-green: #38b07a;
  --obs-green-soft: rgba(56, 176, 122, 0.14);
  --sans: "Geist", "Aptos", "Avenir Next", "Helvetica Neue", system-ui, sans-serif;
  --mono: "ABCDiatypeMono", "Geist Mono", "SFMono-Regular", ui-monospace, Consolas, monospace;
  --display: "Knapp", "Geist", ui-serif, Georgia, serif;
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
}

* { box-sizing: border-box; }

html,
body {
  margin: 0;
  padding: 0;
  height: 100%;
  overflow: hidden;
}

body {
  background: var(--obs-bg);
  color: var(--obs-fg-1);
  font-family: var(--sans);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

button {
  font-family: inherit;
  cursor: pointer;
}

button:focus-visible,
a:focus-visible,
.tile:focus-visible {
  outline: 2px solid var(--obs-blue);
  outline-offset: 2px;
}

a { color: inherit; }

::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track { background: transparent; }

::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 8px;
}

::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.16); }

.obs-eyebrow {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--obs-fg-3);
}

.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--obs-bg);
}

.rp {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--obs-line);
  background: var(--obs-bg-1);
  flex: none;
}

.rp-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  flex-wrap: wrap;
  row-gap: 8px;
  container-type: inline-size;
  container-name: rp-bar;
}

.rp-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.rp-brand-mark {
  width: 16px;
  height: 16px;
  border: 1px solid var(--obs-blue);
  border-radius: 50%;
  display: inline-block;
  position: relative;
  box-shadow: inset 0 0 0 3px rgba(63, 113, 250, 0.16);
}

.rp-brand-mark::after {
  content: "";
  position: absolute;
  width: 6px;
  height: 6px;
  left: 4px;
  top: 4px;
  border: 1px solid var(--obs-sky);
  transform: rotate(45deg);
}

.rp-brand-text {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--obs-fg-2);
}

.rp-divider,
.sub-divider {
  width: 1px;
  height: 12px;
  background: var(--obs-line-2);
  flex-shrink: 0;
}

.rp-current {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-shrink: 0;
}

.pulse-dot,
.pip,
.rp-chip-dot,
.sub-filter-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}

.pulse-dot { animation: pulse-dot 1.4s ease-in-out infinite; }

.rp-current .pulse-dot { color: var(--obs-blue); }

.rp-current-label {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--obs-fg-1);
}

.rp-current-step {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--obs-fg-3);
}

.rp-progress {
  flex: 1 1 80px;
  height: 3px;
  background: var(--obs-line);
  border-radius: 2px;
  overflow: hidden;
  min-width: 60px;
  max-width: 320px;
}

.rp-progress > span {
  display: block;
  height: 100%;
  background: var(--obs-blue);
  transition: width 600ms var(--ease);
  width: 0%;
}

.rp-meta {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--obs-fg-3);
  white-space: nowrap;
  flex-shrink: 0;
}

.rp-meta strong {
  color: var(--obs-fg-1);
  font-weight: 500;
}

.rp-chips {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.rp-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--obs-line);
  border-radius: 2px;
  background: transparent;
  font-family: var(--mono);
}

.rp-chip[data-active="true"] { background: var(--obs-bg-2); }

.rp-chip-label {
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--obs-fg-3);
}

.rp-chip-count {
  font-size: 11px;
  color: var(--obs-fg-1);
  font-weight: 500;
}

.rp-chip[data-dim="true"] { opacity: 0.55; }

.rp-toggle,
.sub-action,
.sub-filter,
.kind-filter,
.sub-density-btn {
  border-radius: 2px;
  background: transparent;
  color: var(--obs-fg-2);
  border: 1px solid var(--obs-line);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.rp-toggle {
  padding: 3px 8px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.rp-stepper {
  display: grid;
  padding: 12px 20px 14px;
  border-top: 1px solid var(--obs-line);
  gap: 0;
}

.rp-stepper[hidden] { display: none; }

.rp-stepper-cell {
  position: relative;
  padding-right: 16px;
  display: grid;
  grid-template-rows: 14px auto auto;
  row-gap: 6px;
  align-content: start;
}

.rp-stepper-cell:last-child { padding-right: 0; }

.rp-stepper-mark {
  position: relative;
  display: flex;
  align-items: center;
  height: 14px;
  z-index: 1;
}

.rp-stepper-mark > span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

.rp-stepper-mark[data-state="done"] > span { background: var(--obs-blue); }

.rp-stepper-mark[data-state="active"] > span {
  width: 7px;
  height: 7px;
  background: var(--obs-sky);
  animation: pulse-dot 1.4s ease-in-out infinite;
}

.rp-stepper-mark[data-state="pending"] > span { background: var(--obs-fg-4); }

.rp-stepper-label {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--obs-fg-1);
  white-space: nowrap;
}

.rp-stepper-desc {
  font-size: 11px;
  color: var(--obs-fg-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rp-stepper-conn {
  position: absolute;
  left: 14px;
  right: 0;
  top: 6px;
  height: 1px;
  background: var(--obs-line);
  z-index: 0;
}

.rp-stepper-cell[data-state="done"] .rp-stepper-conn { background: var(--obs-blue); }

.sub-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--obs-line);
  background: var(--obs-bg);
  flex: none;
  min-height: 41px;
}

.sub-count {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--obs-fg-3);
}

.sub-count strong {
  color: var(--obs-fg-1);
  font-weight: 500;
}

.sub-filters,
.sub-kind-filters {
  display: flex;
  gap: 4px;
  min-width: 0;
}

.sub-filter,
.kind-filter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  white-space: nowrap;
}

.sub-filter[aria-pressed="true"],
.kind-filter[aria-pressed="true"],
.sub-density-btn[aria-pressed="true"] {
  background: var(--obs-bg-3);
  color: var(--obs-fg-1);
}

.sub-filter-count,
.kind-filter-count { color: var(--obs-fg-3); }

.sub-spacer {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.sub-density-btn {
  width: 26px;
  height: 22px;
  color: var(--obs-fg-3);
}

.sub-action {
  padding: 4px 9px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.sub-action[aria-pressed="true"] {
  background: var(--obs-amber-soft);
  color: var(--obs-amber);
}

.sub-action[data-mode-toggle="true"][aria-pressed="true"] {
  background: var(--obs-blue-soft);
  color: #8aa9ff;
}

.history-panel {
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 30;
  width: min(390px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  background: rgba(15, 15, 16, 0.98);
  border-right: 1px solid var(--obs-line-2);
  box-shadow: 24px 0 80px rgba(0, 0, 0, 0.45);
}

.history-panel[hidden] { display: none; }

.history-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  border-bottom: 1px solid var(--obs-line);
}

.history-head h2 {
  margin: 4px 0 0;
  font-size: 18px;
  line-height: 1.15;
  font-weight: 500;
  color: var(--obs-fg-1);
}

.history-close {
  width: 28px;
  height: 28px;
  border: 1px solid var(--obs-line);
  border-radius: 2px;
  background: transparent;
  color: var(--obs-fg-2);
  font-size: 18px;
  line-height: 1;
}

.history-current {
  padding: 12px 16px;
  border-bottom: 1px solid var(--obs-line);
  font-family: var(--mono);
  font-size: 10px;
  color: var(--obs-fg-3);
}

.history-list {
  flex: 1 1 0;
  min-height: 0;
  overflow: auto;
}

.history-run {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px 12px;
  padding: 12px 16px;
  border: 0;
  border-bottom: 1px solid var(--obs-line);
  background: transparent;
  color: inherit;
  text-align: left;
  text-decoration: none;
}

.history-run:hover,
.history-run[data-active="true"] { background: var(--obs-bg-3); }

.history-run[data-active="true"] { box-shadow: inset 2px 0 0 var(--obs-blue); }

.history-run-id {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--obs-fg-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-run-meta,
.history-run-counts {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--obs-fg-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-run-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--obs-fg-2);
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

.history-empty {
  padding: 16px;
  color: var(--obs-fg-3);
}

.grid-shell {
  flex: 1;
  padding: 16px;
  min-height: 0;
  min-width: 0;
  overflow: auto;
}

.grid-shell[hidden] { display: none; }

.tile-grid {
  position: relative;
  width: 100%;
}

.tile {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr) auto;
  background: var(--obs-bg-2);
  border: 1px solid var(--obs-line);
  position: relative;
  overflow: hidden;
  cursor: pointer;
  min-width: 0;
}

.tile-grid > .tile {
  position: absolute;
  margin: 0;
}

.tile:hover { border-color: var(--obs-line-2); }

.tile[data-selected="true"] {
  box-shadow:
    0 0 0 1px var(--obs-blue),
    0 0 0 4px var(--obs-blue-soft);
}

.tile-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 7px;
  height: 22px;
  border-bottom: 1px solid var(--obs-line);
  background: var(--obs-bg-1);
  flex: none;
}

.tile-idx {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--obs-fg-3);
  letter-spacing: 0.05em;
}

.tile-role {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--obs-green);
  flex: none;
}

.tile-name {
  font-size: 11px;
  color: var(--obs-fg-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.tile-view {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--obs-fg-3);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.tile-stream-shell {
  position: relative;
  background: #050505;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
  height: 100%;
  width: 100%;
  max-width: 100%;
}

.tile-stream-shell::after {
  content: "";
  position: absolute;
  inset: 0;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
  pointer-events: none;
}

.media-surface {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  overflow: hidden;
}

.media-surface > iframe,
.media-surface > img {
  display: block;
  width: 100%;
  height: 100%;
  max-width: 100%;
  object-fit: contain;
  background: #050505;
  border: 0;
}

.tile .media-surface > iframe,
.tile .media-surface > img { pointer-events: none; }

.terminal-surface,
.live-waiting-surface,
.synthetic-codex,
.placeholder-surface {
  width: 100%;
  height: 100%;
}

.terminal-surface {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  background: #050505;
  color: var(--obs-fg-2);
  font-family: var(--mono);
  overflow: hidden;
}

.terminal-bar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  border-bottom: 1px solid var(--obs-line);
  background: rgba(255, 255, 255, 0.03);
}

.terminal-prompt { color: var(--obs-green); }

.terminal-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--obs-fg-1);
  font-size: 10px;
}

.terminal-status {
  color: var(--obs-fg-3);
  font-size: 9px;
  text-transform: uppercase;
}

.terminal-body {
  min-height: 0;
  overflow: hidden;
  padding: 8px;
  font-size: 10px;
  line-height: 1.45;
}

.focus .terminal-body {
  overflow: auto;
  font-size: 12px;
}

.terminal-line {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 8px;
  min-width: 0;
}

.terminal-line-prefix {
  color: var(--obs-fg-4);
  text-align: right;
}

.terminal-line-text {
  color: var(--obs-fg-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.synthetic-codex,
.placeholder-surface {
  background: #101010;
  padding: 10px;
  color: #181b1a;
}

.codex-frame {
  height: 100%;
  border-radius: 8px;
  overflow: hidden;
  background: #f7f8f4;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.32);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}

.codex-chrome {
  height: 30px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-bottom: 1px solid #d9ded8;
  background: #eef1ed;
  font-family: var(--mono);
  font-size: 9px;
  color: #59645f;
}

.live-waiting-surface {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #020202;
  color: var(--obs-fg-2);
  font-family: var(--mono);
}

.live-waiting-surface::before {
  content: "";
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 50% 42%, rgba(63, 113, 250, 0.12), transparent 34%),
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px);
  background-size: auto, 100% 28px;
  opacity: 0.7;
}

.live-waiting-inner {
  position: relative;
  z-index: 1;
  width: min(360px, calc(100% - 32px));
  display: grid;
  justify-items: center;
  gap: 12px;
  text-align: center;
}

.live-spinner {
  width: 34px;
  height: 34px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-top-color: var(--obs-blue);
  border-radius: 50%;
  animation: live-spin 1s linear infinite;
}

.live-waiting-title {
  color: var(--obs-fg-1);
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.live-waiting-url {
  max-width: 100%;
  color: var(--obs-fg-3);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-waiting-status {
  max-width: 100%;
  color: var(--obs-fg-2);
  font-size: 10px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.chrome-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #c9d0ca;
}

.codex-url {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-body {
  min-height: 0;
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  background: #f8f8f5;
}

.codex-rail {
  border-right: 1px solid #dadfda;
  padding: 12px;
  display: grid;
  align-content: start;
  gap: 8px;
}

.codex-thread {
  height: 24px;
  border-radius: 4px;
  background: #e8ece7;
}

.codex-main {
  padding: 16px;
  display: grid;
  align-content: start;
  gap: 12px;
}

.codex-bubble {
  min-height: 38px;
  border: 1px solid #d7ddd7;
  border-radius: 8px;
  background: white;
}

.codex-bubble.dark {
  background: #17201d;
  border-color: #17201d;
}

.placeholder-surface {
  display: flex;
  align-items: center;
  justify-content: center;
}

.placeholder-box {
  max-width: 320px;
  padding: 18px;
  border: 1px solid var(--obs-line-2);
  color: var(--obs-fg-2);
  background: var(--obs-bg-1);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.45;
}

.tile-cap {
  height: 22px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 52px;
  align-items: center;
  gap: 8px;
  padding: 0 7px;
  border-top: 1px solid var(--obs-line);
  background: var(--obs-bg-1);
}

.tile-cap-eyebrow {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  color: var(--obs-fg-3);
  text-transform: uppercase;
}

.tile-cap-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--obs-fg-2);
  font-size: 11px;
}

.tile-cap-bar {
  height: 2px;
  background: var(--obs-line);
  overflow: hidden;
}

.tile-cap-bar > span {
  display: block;
  height: 100%;
  background: var(--obs-blue);
}

.tile-cap[data-status="failed"] .tile-cap-bar > span,
.tile-cap[data-status="blocked"] .tile-cap-bar > span { background: var(--obs-red); }

.tile-cap[data-status="complete"] .tile-cap-bar > span,
.tile-cap[data-status="contract_proof_only"] .tile-cap-bar > span { background: var(--obs-green); }

.pip[data-status="queued"] { color: var(--obs-fg-4); }
.pip[data-status="preparing"] { color: var(--obs-sky); }
.pip[data-status="running"] { color: var(--obs-blue); }
.pip[data-status="complete"] { color: var(--obs-green); }
.pip[data-status="contract_proof_only"] { color: var(--obs-green); }
.pip[data-status="blocked"] { color: var(--obs-amber); }
.pip[data-status="failed"] { color: var(--obs-red); }

.focus {
  display: flex;
  flex: 1 1 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  background: var(--obs-bg);
}

.focus[hidden] { display: none; }

.focus-rail {
  width: 56px;
  flex: none;
  border-right: 1px solid var(--obs-line);
  background: var(--obs-bg-1);
  display: flex;
  flex-direction: column;
  padding: 10px 0;
  gap: 4px;
  overflow-y: auto;
}

.focus-rail-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 6px 4px;
  background: transparent;
  border: 0;
  border-left: 2px solid transparent;
  width: 100%;
}

.focus-rail-item[data-selected="true"] {
  background: var(--obs-bg-3);
  border-left-color: var(--obs-blue);
}

.focus-rail-idx {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--obs-fg-3);
}

.focus-rail-item[data-selected="true"] .focus-rail-idx { color: var(--obs-fg-1); }

.focus-stage {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: #050505;
}

.focus-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  background: var(--obs-bg-1);
  border-bottom: 1px solid var(--obs-line);
  flex: none;
}

.focus-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 2px;
  background: transparent;
  color: var(--obs-fg-2);
  border: 1px solid var(--obs-line-2);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.focus-id {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--obs-fg-3);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.focus-persona {
  font-size: 13px;
  color: var(--obs-fg-1);
}

.focus-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 2px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  background: rgba(255, 255, 255, 0.06);
  color: var(--obs-fg-1);
}

.focus-status-badge[data-status="running"],
.focus-status-badge[data-status="preparing"] {
  background: var(--obs-blue-soft);
  color: #8aa9ff;
}

.focus-status-badge[data-status="blocked"] {
  background: var(--obs-amber-soft);
  color: #e9b04b;
}

.focus-status-badge[data-status="failed"] {
  background: var(--obs-red-soft);
  color: #ee8a7e;
}

.focus-status-badge[data-status="complete"],
.focus-status-badge[data-status="contract_proof_only"] {
  background: var(--obs-green-soft);
  color: #6dd0a3;
}

.focus-stats {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--obs-fg-3);
}

.focus-stats strong {
  color: var(--obs-fg-1);
  font-weight: 500;
}

.focus-stage-area {
  flex: 1 1 0;
  min-height: 0;
  min-width: 0;
  padding: 0;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
}

.focus-stage-area .tile-stream-shell {
  flex: none;
  width: auto;
  height: auto;
  margin: 0 auto;
  aspect-ratio: var(--stream-aspect, 16 / 9);
}

.focus-side {
  width: 380px;
  flex: none;
  border-left: 1px solid var(--obs-line);
  background: var(--obs-bg-1);
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.focus-side-context {
  flex: 0 1 auto;
  max-height: min(46vh, 430px);
  min-height: 0;
  overflow-y: auto;
  border-bottom: 1px solid var(--obs-line);
}

.focus-side-head { padding: 20px 20px 16px; }

.focus-side-head h2 {
  font-family: var(--display);
  font-size: 22px;
  font-weight: 400;
  margin: 6px 0 0;
  line-height: 1.15;
  color: var(--obs-fg-1);
}

.focus-side-goal { margin-top: 14px; }

.focus-side-goal-text {
  font-size: 13px;
  color: var(--obs-fg-2);
  margin-top: 4px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.focus-side-thinking {
  padding: 14px 20px;
  background: var(--obs-bg-2);
}

.focus-side-thinking-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.focus-side-thinking-row .obs-eyebrow { color: var(--obs-blue); }

.focus-side-thinking-text {
  font-size: 13px;
  color: var(--obs-fg-1);
  font-style: italic;
  line-height: 1.45;
}

.focus-tabs {
  display: flex;
  border-bottom: 1px solid var(--obs-line);
  flex: none;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}

.focus-tab {
  padding: 10px 12px;
  background: transparent;
  color: var(--obs-fg-3);
  border: 0;
  border-bottom: 1px solid transparent;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  white-space: nowrap;
}

.focus-tab[aria-selected="true"] {
  background: var(--obs-bg-2);
  color: var(--obs-fg-1);
  border-bottom-color: var(--obs-blue);
}

.focus-tab-badge {
  font-size: 9px;
  color: var(--obs-fg-3);
}

.focus-tabbody {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
}

.event-row,
.artifact-row {
  display: flex;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--obs-line);
}

.event-row-icon {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--obs-fg-3);
  flex: none;
  margin-top: 2px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.event-row[data-kind="warn"] .event-row-icon,
.event-row[data-kind="blocked"] .event-row-icon { color: var(--obs-amber); }

.event-row[data-kind="error"] .event-row-icon,
.event-row[data-kind="failed"] .event-row-icon { color: var(--obs-red); }

.event-row[data-kind="complete"] .event-row-icon { color: var(--obs-green); }

.event-row-text,
.artifact-row-text {
  font-size: 12px;
  color: var(--obs-fg-1);
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.event-row-meta,
.artifact-row-meta {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--obs-fg-3);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-top: 2px;
}

.artifact-row a {
  color: var(--obs-fg-1);
  text-decoration: none;
}

@container rp-bar (max-width: 1100px) {
  .rp-meta { display: none; }
}

@keyframes pulse-dot {
  0%, 100% { transform: scale(1); opacity: 0.65; }
  50% { transform: scale(1.35); opacity: 1; }
}

@keyframes live-spin {
  to { transform: rotate(360deg); }
}
`;
}

export function observerClientJs(): string {
  return `
(function () {
  var DATA_FILE = "observer-data.json";
  var embedded = JSON.parse(document.getElementById("observer-data").textContent || "null");
  var currentData = embedded;
  var focusedId = focusedIdFromLocation();
  var preferScreenshots = false;
  var mediaPreferenceTouched = false;
  var activeStatus = "all";
  var activeKind = "all";
  var density = Number(readPref("density", 4));
  var stepperOpen = readPref("stepperOpen", false) === true;
  var historyOpen = readPref("historyOpen", false) === true;
  var historyIndex = null;
  var activeFocusTab = "events";
  var refreshTimer = null;
  var historyTimer = null;

  var RUN_PHASES = [
    { id: "packet", label: "Packet prep", desc: "Reading run bundle" },
    { id: "persona", label: "Persona plan", desc: "Persona and scenario loaded" },
    { id: "streams", label: "Stream mount", desc: "Observer lanes mounted" },
    { id: "evidence", label: "Evidence review", desc: "Artifacts and events linked" },
    { id: "ready", label: "Observer ready", desc: "Operator console live" }
  ];

  var GRID_SCALE_STREAM_HEIGHT = { 2: 180, 3: 260, 4: 360, 5: 500 };

  function getElement(id) {
    var node = document.getElementById(id);
    if (!node) throw new Error("Missing observer element: " + id);
    return node;
  }

  function render() {
    var liveAvailable = hasLiveStreams(currentData);
    if (!mediaPreferenceTouched || !liveAvailable) {
      preferScreenshots = preferredScreenshotMode(currentData);
    }
    document.title = "Mimetic Observer - " + currentData.run.runId;
    renderProgress();
    renderSubBar();
    renderStreams();
    renderFocus();
    renderHistoryPanel();
  }

  function renderProgress() {
    var counts = countStatuses(currentData.streams);
    var total = currentData.streams.length || 1;
    var phaseIndex = currentData.run.status === "contract_proof_only" || currentData.run.status === "complete" ? 4 : 3;
    var progress = Math.min(1, (counts.complete + counts.proof + counts.running * 0.62 + counts.blocked) / total);
    var pulse = getElement("rp-current-pulse");
    var label = getElement("rp-current-label");
    var step = getElement("rp-current-step");
    var meta = getElement("rp-meta");
    var fill = getElement("rp-progress").querySelector("span");

    pulse.style.color = currentData.run.status === "failed" ? "var(--obs-red)" : "var(--obs-blue)";
    label.textContent = currentData.run.status === "contract_proof_only" ? "Proof snapshot" : RUN_PHASES[phaseIndex].label;
    step.textContent = "- step " + String(phaseIndex + 1) + "/" + String(RUN_PHASES.length);
    if (fill) fill.style.width = String(Math.round(progress * 100)) + "%";

    meta.replaceChildren();
    appendMeta(meta, currentData.run.runId, true);
    appendMeta(meta, shortTime(currentData.run.createdAt), false);
    appendMeta(meta, currentData.run.mode, false);
    appendMeta(meta, currentData.run.packageName || "local project", false);
    appendMeta(meta, currentData.publicSafety.publishable ? "publishable" : "local evidence", false);

    getElement("rp-chips").replaceChildren(
      chip("Live", counts.running, "var(--obs-blue)"),
      chip("Blocked", counts.blocked, "var(--obs-amber)"),
      chip("Error", counts.failed, "var(--obs-red)"),
      chip("Done", counts.complete, "var(--obs-green)"),
      chip("Proof", counts.proof, "var(--obs-green)")
    );

    var stepper = getElement("rp-stepper");
    var toggle = getElement("rp-toggle");
    toggle.setAttribute("aria-expanded", stepperOpen ? "true" : "false");
    toggle.textContent = stepperOpen ? "Collapse" : "Phases";
    stepper.hidden = !stepperOpen;
    if (stepperOpen) {
      stepper.style.gridTemplateColumns = "repeat(" + RUN_PHASES.length + ", 1fr)";
      stepper.replaceChildren.apply(stepper, RUN_PHASES.map(function (phase, index) {
        var cell = document.createElement("div");
        var state = index < phaseIndex ? "done" : index === phaseIndex ? "active" : "pending";
        cell.className = "rp-stepper-cell";
        cell.dataset.state = state;
        var mark = document.createElement("div");
        mark.className = "rp-stepper-mark";
        mark.dataset.state = state;
        mark.append(document.createElement("span"));
        var lbl = document.createElement("span");
        lbl.className = "rp-stepper-label";
        lbl.textContent = phase.label;
        var desc = document.createElement("span");
        desc.className = "rp-stepper-desc";
        desc.textContent = phase.desc;
        cell.append(mark, lbl, desc);
        if (index < RUN_PHASES.length - 1) {
          var conn = document.createElement("div");
          conn.className = "rp-stepper-conn";
          cell.append(conn);
        }
        return cell;
      }));
    } else {
      stepper.replaceChildren();
    }
  }

  function appendMeta(root, value, strong) {
    if (!value) return;
    if (root.childNodes.length > 0) root.append(document.createTextNode(" - "));
    if (strong) {
      var node = document.createElement("strong");
      node.textContent = value;
      root.append(node);
    } else {
      root.append(document.createTextNode(value));
    }
  }

  function chip(label, count, color) {
    var node = document.createElement("span");
    node.className = "rp-chip";
    node.dataset.active = String(count > 0);
    node.dataset.dim = String(count === 0);
    node.style.color = color;
    var dot = document.createElement("span");
    dot.className = "rp-chip-dot";
    var lbl = document.createElement("span");
    lbl.className = "rp-chip-label";
    lbl.textContent = label;
    var cnt = document.createElement("span");
    cnt.className = "rp-chip-count";
    cnt.textContent = String(count).padStart(2, "0");
    node.append(dot, lbl, cnt);
    return node;
  }

  function renderSubBar() {
    var counts = countStatuses(currentData.streams);
    var kindCounts = countKinds(currentData.streams);
    getElement("sub-mode").textContent = focusedId ? "Watch focus" : "Watch grid";
    getElement("sub-count").textContent = String(currentData.streams.length);
    getElement("sub-filters").replaceChildren(
      statusFilter("all", "All", currentData.streams.length, null),
      statusFilter("running", "Live", counts.running, "var(--obs-blue)"),
      statusFilter("blocked", "Blocked", counts.blocked + counts.failed, "var(--obs-amber)"),
      statusFilter("complete", "Done", counts.complete, "var(--obs-green)"),
      statusFilter("proof", "Proof", counts.proof, "var(--obs-green)")
    );
    getElement("sub-kind-filters").replaceChildren(
      kindFilter("all", "All", currentData.streams.length),
      kindFilter("ui", "UI", kindCounts.ui + kindCounts.browser),
      kindFilter("terminal", "CLI", kindCounts.terminal),
      kindFilter("tui", "TUI", kindCounts.tui),
      kindFilter("codex-ui", "Codex", kindCounts["codex-ui"])
    );

    Array.prototype.forEach.call(document.querySelectorAll(".sub-density-btn"), function (button) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.density) === density));
    });
    getElement("streams").dataset.density = String(density);

    var mediaToggle = getElement("media-toggle");
    var liveAvailable = hasLiveStreams(currentData);
    mediaToggle.disabled = !liveAvailable;
    mediaToggle.setAttribute("aria-disabled", String(!liveAvailable));
    mediaToggle.textContent = !liveAvailable ? "Replay" : preferScreenshots ? "Screenshot" : "Live";
    mediaToggle.setAttribute("aria-pressed", String(preferScreenshots));

    var gridMode = getElement("grid-mode");
    var focusMode = getElement("focus-mode");
    gridMode.hidden = Boolean(focusedId);
    gridMode.setAttribute("aria-pressed", String(!focusedId));
    focusMode.setAttribute("aria-pressed", String(Boolean(focusedId)));
    focusMode.textContent = focusedId ? "Focused" : "Focus";

    var historyToggle = getElement("history-toggle");
    var historyDivider = getElement("history-divider");
    var hasHistory = Boolean(historyIndex && historyIndex.runs && historyIndex.runs.length);
    historyToggle.hidden = !hasHistory;
    historyDivider.hidden = !hasHistory;
    historyToggle.setAttribute("aria-expanded", String(historyOpen));
  }

  function statusFilter(id, label, count, color) {
    var button = document.createElement("button");
    button.className = "sub-filter";
    button.type = "button";
    button.setAttribute("aria-pressed", String(activeStatus === id));
    button.dataset.filter = id;
    if (color) {
      button.style.color = color;
      var dot = document.createElement("span");
      dot.className = "sub-filter-dot";
      button.append(dot);
    }
    var text = document.createElement("span");
    text.textContent = label;
    text.style.color = activeStatus === id ? "var(--obs-fg-1)" : "var(--obs-fg-2)";
    var cnt = document.createElement("span");
    cnt.className = "sub-filter-count";
    cnt.textContent = String(count).padStart(2, "0");
    button.append(text, cnt);
    button.addEventListener("click", function () {
      activeStatus = id;
      renderSubBar();
      renderStreams();
    });
    return button;
  }

  function kindFilter(id, label, count) {
    var button = document.createElement("button");
    button.className = "kind-filter";
    button.type = "button";
    button.setAttribute("aria-pressed", String(activeKind === id));
    var text = document.createElement("span");
    text.textContent = label;
    var cnt = document.createElement("span");
    cnt.className = "kind-filter-count";
    cnt.textContent = String(count).padStart(2, "0");
    button.append(text, cnt);
    button.addEventListener("click", function () {
      activeKind = id;
      renderSubBar();
      renderStreams();
    });
    return button;
  }

  function renderStreams() {
    var root = getElement("streams");
    var inFocus = Boolean(focusedId);
    getElement("grid-shell").hidden = inFocus;
    getElement("focus").hidden = !inFocus;
    if (inFocus) return;
    var visible = visibleStreams();
    var idsKey = JSON.stringify(visible.map(function (stream) { return stream.id; }));
    if (root.dataset.idsKey !== idsKey) {
      root.dataset.idsKey = idsKey;
      root.replaceChildren.apply(root, visible.map(function (stream, index) {
        var tile = renderTile(stream, index);
        tile.style.left = "0px";
        tile.style.top = "0px";
        tile.style.width = "100%";
        return tile;
      }));
    } else {
      Array.prototype.forEach.call(root.children, function (child, index) {
        var fresh = renderTile(visible[index], index);
        child.replaceWith(fresh);
      });
    }
    layoutPackedGrid();
  }

  function renderTile(stream, index) {
    var tile = document.createElement("article");
    tile.className = "tile";
    tile.dataset.streamId = stream.id;
    tile.dataset.mediaKey = streamMediaKey(stream);
    tile.dataset.selected = String(stream.id === focusedId);
    var aspect = streamAspect(stream);
    tile.dataset.aspect = aspect.kind;
    tile.dataset.aspectWidth = String(aspect.width);
    tile.dataset.aspectHeight = String(aspect.height);
    tile.title = stream.sim.personaId + " - " + stream.label;
    tile.tabIndex = 0;
    tile.setAttribute("role", "button");
    tile.setAttribute("aria-label", "Open stream " + String(index + 1).padStart(2, "0") + ": " + stream.label);
    tile.addEventListener("click", function () { focusStream(stream.id, true); });
    tile.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        focusStream(stream.id, true);
      }
    });
    tile.append(renderTileHead(stream, index), renderTileStream(stream, false), renderTileCap(stream));
    return tile;
  }

  function renderTileHead(stream, index) {
    var head = document.createElement("header");
    head.className = "tile-head";
    var idx = document.createElement("span");
    idx.className = "tile-idx";
    idx.textContent = String(index + 1).padStart(2, "0");
    var pip = document.createElement("span");
    pip.className = "pip";
    pip.dataset.status = stream.status || "unknown";
    var role = document.createElement("span");
    role.className = "tile-role";
    role.textContent = stream.kindLabel || stream.kind;
    var name = document.createElement("span");
    name.className = "tile-name";
    name.textContent = compactLabel(stream.sim.personaId || stream.label);
    var view = document.createElement("span");
    view.className = "tile-view";
    view.textContent = viewLabel(stream);
    head.append(idx, pip, role, name, view);
    return head;
  }

  function renderTileStream(stream, inFocus) {
    var shell = document.createElement("div");
    shell.className = "tile-stream-shell";
    shell.dataset.focus = String(Boolean(inFocus));
    var aspect = streamAspect(stream);
    shell.style.setProperty("--stream-aspect", aspect.width + " / " + aspect.height);
    shell.dataset.streamWidth = String(aspect.width);
    shell.dataset.streamHeight = String(aspect.height);
    var surface = document.createElement("div");
    surface.className = "media-surface";

    if (preferScreenshots && stream.ui && stream.ui.screenshotUrl) {
      var img = document.createElement("img");
      img.src = stream.ui.screenshotUrl;
      img.alt = "Screenshot for " + stream.id;
      surface.append(img);
    } else if ((stream.kind === "terminal" || stream.kind === "tui") && stream.terminal) {
      appendTerminal(surface, stream, inFocus);
    } else if ((stream.kind === "ui" || stream.kind === "browser") && stream.embed && stream.embed.url && !preferScreenshots) {
      var iframe = document.createElement("iframe");
      iframe.src = stream.embed.url;
      iframe.title = stream.label;
      iframe.loading = "lazy";
      surface.append(iframe);
    } else if (stream.kind === "codex-ui") {
      appendCodex(surface, stream);
    } else if (stream.kind === "ui" || stream.kind === "browser") {
      appendBrowser(surface, stream);
    } else {
      appendPlaceholder(surface, stream);
    }

    shell.append(surface);
    return shell;
  }

  function appendTerminal(surface, stream, inFocus) {
    var terminal = document.createElement("div");
    terminal.className = "terminal-surface";
    var bar = document.createElement("div");
    bar.className = "terminal-bar";
    var prompt = document.createElement("span");
    prompt.className = "terminal-prompt";
    prompt.textContent = "$";
    var title = document.createElement("span");
    title.className = "terminal-title";
    title.textContent = stream.terminal.title || stream.label;
    var status = document.createElement("span");
    status.className = "terminal-status";
    status.textContent = stream.statusLabel || stream.status;
    bar.append(prompt, title, status);
    var body = document.createElement("div");
    body.className = "terminal-body";
    var lines = String(stream.terminalPlain || stream.terminal.tail || "").split("\\n").filter(Boolean);
    if (lines.length === 0) lines = ["No terminal transcript recorded yet."];
    var limit = inFocus ? 120 : 36;
    lines.slice(-limit).forEach(function (line, index) {
      var row = document.createElement("div");
      row.className = "terminal-line";
      var prefix = document.createElement("span");
      prefix.className = "terminal-line-prefix";
      prefix.textContent = String(index + 1).padStart(2, "0");
      var text = document.createElement("span");
      text.className = "terminal-line-text";
      text.textContent = line;
      row.append(prefix, text);
      body.append(row);
    });
    terminal.append(bar, body);
    surface.append(terminal);
  }

  function appendBrowser(surface, stream) {
    var outer = document.createElement("div");
    outer.className = "live-waiting-surface";
    var inner = document.createElement("div");
    inner.className = "live-waiting-inner";
    var spinner = document.createElement("div");
    spinner.className = "live-spinner";
    spinner.setAttribute("aria-hidden", "true");
    var title = document.createElement("div");
    title.className = "live-waiting-title";
    title.textContent = stream.status === "contract_proof_only" ? "Contract proof only" : "Waiting for live desktop";
    var url = document.createElement("div");
    url.className = "live-waiting-url";
    url.textContent = stream.ui && stream.ui.route ? stream.ui.route : stream.label;
    var status = document.createElement("div");
    status.className = "live-waiting-status";
    status.textContent = stream.sim.currentStep || stream.summary || stream.statusLabel || "Live surface not connected yet.";
    inner.append(spinner, title, url, status);
    outer.append(inner);
    surface.append(outer);
  }

  function appendCodex(surface, stream) {
    var outer = document.createElement("div");
    outer.className = "synthetic-codex";
    var frame = document.createElement("div");
    frame.className = "codex-frame";
    var chrome = document.createElement("div");
    chrome.className = "codex-chrome";
    chrome.append(dot(), dot(), dot());
    var url = document.createElement("span");
    url.className = "codex-url";
    url.textContent = "codex.app-server/session";
    chrome.append(url);
    var body = document.createElement("div");
    body.className = "codex-body";
    var rail = document.createElement("div");
    rail.className = "codex-rail";
    rail.append(thread(), thread(), thread());
    var main = document.createElement("div");
    main.className = "codex-main";
    main.append(bubble("dark"), bubble(""), bubble(""), bubble("dark"));
    body.append(rail, main);
    frame.append(chrome, body);
    outer.append(frame);
    surface.append(outer);
  }

  function appendPlaceholder(surface, stream) {
    var holder = document.createElement("div");
    holder.className = "placeholder-surface";
    var box = document.createElement("div");
    box.className = "placeholder-box";
    box.textContent = stream.summary || "Observer lane awaiting evidence.";
    holder.append(box);
    surface.append(holder);
  }

  function renderTileCap(stream) {
    var cap = document.createElement("footer");
    cap.className = "tile-cap";
    cap.dataset.status = stream.status || "unknown";
    var eyebrow = document.createElement("span");
    eyebrow.className = "tile-cap-eyebrow";
    eyebrow.textContent = stream.kindLabel || stream.kind;
    var text = document.createElement("span");
    text.className = "tile-cap-text";
    text.textContent = stream.sim.currentStep || stream.statusLabel || stream.status;
    var bar = document.createElement("div");
    bar.className = "tile-cap-bar";
    var fill = document.createElement("span");
    fill.style.width = String(Math.max(8, Math.min(100, Number(stream.sim.progress || 0)))) + "%";
    bar.append(fill);
    cap.append(eyebrow, text, bar);
    return cap;
  }

  function renderFocus() {
    var focus = getElement("focus");
    document.body.classList.toggle("focused", Boolean(focusedId));
    if (!focusedId) {
      focus.replaceChildren();
      return;
    }
    var stream = currentData.streams.find(function (item) { return item.id === focusedId; });
    if (!stream) {
      focusedId = null;
      focus.replaceChildren();
      return;
    }
    var rail = document.createElement("aside");
    rail.className = "focus-rail";
    currentData.streams.forEach(function (candidate, index) {
      var item = document.createElement("button");
      item.className = "focus-rail-item";
      item.type = "button";
      item.dataset.selected = String(candidate.id === focusedId);
      item.addEventListener("click", function () { focusStream(candidate.id, true); });
      var idx = document.createElement("span");
      idx.className = "focus-rail-idx";
      idx.textContent = String(index + 1).padStart(2, "0");
      var pip = document.createElement("span");
      pip.className = "pip";
      pip.dataset.status = candidate.status || "unknown";
      item.append(idx, pip);
      rail.append(item);
    });

    var stage = document.createElement("section");
    stage.className = "focus-stage";
    var toolbar = document.createElement("header");
    toolbar.className = "focus-toolbar";
    var back = document.createElement("button");
    back.className = "focus-back";
    back.type = "button";
    back.textContent = "Back to grid";
    back.addEventListener("click", exitFocus);
    var id = document.createElement("span");
    id.className = "focus-id";
    id.textContent = stream.id;
    var persona = document.createElement("span");
    persona.className = "focus-persona";
    persona.textContent = stream.sim.personaId + " / " + stream.kindLabel;
    var badge = document.createElement("span");
    badge.className = "focus-status-badge";
    badge.dataset.status = stream.status || "unknown";
    var badgePip = document.createElement("span");
    badgePip.className = "pip";
    badgePip.dataset.status = stream.status || "unknown";
    var badgeText = document.createElement("span");
    badgeText.textContent = stream.statusLabel || stream.status;
    badge.append(badgePip, badgeText);
    var stats = document.createElement("span");
    stats.className = "focus-stats";
    stats.textContent = viewLabel(stream) + " - events " + stream.timeline.length;
    toolbar.append(back, id, persona, badge, stats);
    var area = document.createElement("div");
    area.className = "focus-stage-area";
    area.append(renderTileStream(stream, true));
    stage.append(toolbar, area);

    var side = renderFocusSide(stream);
    focus.replaceChildren(rail, stage, side);
    fitFocusMedia();
  }

  function renderFocusSide(stream) {
    var side = document.createElement("aside");
    side.className = "focus-side";
    var context = document.createElement("div");
    context.className = "focus-side-context";
    var head = document.createElement("div");
    head.className = "focus-side-head";
    var eyebrow = document.createElement("span");
    eyebrow.className = "obs-eyebrow";
    eyebrow.textContent = "Persona";
    var h2 = document.createElement("h2");
    h2.textContent = currentData.run.persona.name;
    var goal = document.createElement("div");
    goal.className = "focus-side-goal";
    var goalEyebrow = document.createElement("span");
    goalEyebrow.className = "obs-eyebrow";
    goalEyebrow.textContent = "Goal";
    var goalText = document.createElement("div");
    goalText.className = "focus-side-goal-text";
    goalText.textContent = currentData.run.scenario.goal;
    goal.append(goalEyebrow, goalText);
    head.append(eyebrow, h2, goal);
    var think = document.createElement("div");
    think.className = "focus-side-thinking";
    var thinkRow = document.createElement("div");
    thinkRow.className = "focus-side-thinking-row";
    var dotNode = document.createElement("span");
    dotNode.className = "pulse-dot";
    var thinkEyebrow = document.createElement("span");
    thinkEyebrow.className = "obs-eyebrow";
    thinkEyebrow.textContent = "Now";
    thinkRow.append(dotNode, thinkEyebrow);
    var thinkText = document.createElement("div");
    thinkText.className = "focus-side-thinking-text";
    thinkText.textContent = stream.sim.currentStep || stream.summary || stream.statusLabel;
    think.append(thinkRow, thinkText);
    context.append(head, think);

    var tabs = document.createElement("div");
    tabs.className = "focus-tabs";
    tabs.setAttribute("role", "tablist");
    var tabBody = document.createElement("div");
    tabBody.className = "focus-tabbody";
    var tabDefs = [
      { id: "events", label: "Events", count: stream.timeline.length },
      { id: "actions", label: "Trace", count: stream.timeline.length },
      { id: "artifacts", label: "Files", count: stream.artifacts.length },
      { id: "logs", label: "Logs", count: stream.terminalPlain ? stream.terminalPlain.split("\\n").length : 0 }
    ];
    tabDefs.forEach(function (tab) {
      var button = document.createElement("button");
      button.className = "focus-tab";
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(activeFocusTab === tab.id));
      button.textContent = tab.label + " ";
      var badge = document.createElement("span");
      badge.className = "focus-tab-badge";
      badge.textContent = String(tab.count);
      button.append(badge);
      button.addEventListener("click", function () {
        activeFocusTab = tab.id;
        renderFocus();
      });
      tabs.append(button);
    });
    fillTabBody(tabBody, stream);
    side.append(context, tabs, tabBody);
    return side;
  }

  function fillTabBody(tabBody, stream) {
    if (activeFocusTab === "artifacts") {
      tabBody.replaceChildren.apply(tabBody, stream.artifacts.map(function (artifact) {
        var row = document.createElement("div");
        row.className = "artifact-row";
        var icon = document.createElement("span");
        icon.className = "event-row-icon";
        icon.textContent = "file";
        var text = document.createElement("div");
        text.className = "artifact-row-text";
        var link = document.createElement("a");
        link.href = artifact.path;
        link.textContent = artifact.label;
        text.append(link);
        var meta = document.createElement("div");
        meta.className = "artifact-row-meta";
        meta.textContent = artifact.kind + " - " + artifact.path;
        text.append(meta);
        row.append(icon, text);
        return row;
      }));
      return;
    }
    if (activeFocusTab === "logs") {
      var surface = document.createElement("div");
      surface.className = "terminal-surface";
      var body = document.createElement("div");
      body.className = "terminal-body";
      String(stream.terminalPlain || "No log text recorded.").split("\\n").filter(Boolean).forEach(function (line, index) {
        var row = document.createElement("div");
        row.className = "terminal-line";
        var prefix = document.createElement("span");
        prefix.className = "terminal-line-prefix";
        prefix.textContent = String(index + 1).padStart(2, "0");
        var text = document.createElement("span");
        text.className = "terminal-line-text";
        text.textContent = line;
        row.append(prefix, text);
        body.append(row);
      });
      surface.append(body);
      tabBody.replaceChildren(surface);
      return;
    }
    var rows = stream.timeline.length ? stream.timeline : currentData.events.slice(-12);
    tabBody.replaceChildren.apply(tabBody, rows.map(function (event) { return eventRow(event); }));
  }

  function eventRow(event) {
    var row = document.createElement("div");
    row.className = "event-row";
    row.dataset.kind = event.level || event.type || "info";
    var icon = document.createElement("span");
    icon.className = "event-row-icon";
    icon.textContent = event.level || "info";
    var body = document.createElement("div");
    var text = document.createElement("div");
    text.className = "event-row-text";
    text.textContent = event.message;
    var meta = document.createElement("div");
    meta.className = "event-row-meta";
    meta.textContent = compact([shortTime(event.at), event.type, event.streamId]).join(" - ");
    body.append(text, meta);
    row.append(icon, body);
    return row;
  }

  function renderHistoryPanel() {
    var panel = getElement("history-panel");
    var current = getElement("history-current");
    var list = getElement("history-list");
    var hasHistory = Boolean(historyIndex && historyIndex.runs && historyIndex.runs.length);
    panel.hidden = !historyOpen || !hasHistory;
    if (!hasHistory) {
      current.replaceChildren();
      list.replaceChildren();
      return;
    }
    current.textContent = "Current " + currentData.run.runId + " - Latest " + (historyIndex.latestRunId || "none");
    list.replaceChildren.apply(list, historyIndex.runs.slice(0, 80).map(function (run) {
      var link = document.createElement("a");
      link.className = "history-run";
      link.href = run.href;
      link.dataset.active = String(run.runId === currentData.run.runId);
      var id = document.createElement("span");
      id.className = "history-run-id";
      id.textContent = run.runId;
      var status = document.createElement("span");
      status.className = "history-run-status";
      var pip = document.createElement("span");
      pip.className = "pip";
      pip.dataset.status = run.status || "unknown";
      var statusText = document.createElement("span");
      statusText.textContent = run.status || "unknown";
      status.append(pip, statusText);
      var meta = document.createElement("span");
      meta.className = "history-run-meta";
      meta.textContent = compact([run.mode, run.createdAt ? shortTime(run.createdAt) : null]).join(" - ");
      var counts = document.createElement("span");
      counts.className = "history-run-counts";
      counts.textContent = String(run.streamCount || 0) + " streams";
      link.append(id, status, meta, counts);
      return link;
    }));
  }

  function layoutPackedGrid() {
    var shell = getElement("grid-shell");
    var root = getElement("streams");
    var tiles = Array.prototype.slice.call(root.querySelectorAll(".tile"));
    if (tiles.length === 0) {
      root.style.height = "0px";
      return;
    }
    var styles = getComputedStyle(shell);
    var padX = parseFloat(styles.paddingLeft || "16") + parseFloat(styles.paddingRight || "16");
    var innerW = Math.max(0, shell.clientWidth - padX);
    var gap = 8;
    var headerH = 22;
    var captionH = 22;
    var rowStreamH = GRID_SCALE_STREAM_HEIGHT[density] || GRID_SCALE_STREAM_HEIGHT[4];
    var x = 0;
    var y = 0;
    var rowH = 0;
    tiles.forEach(function (tile) {
      var aspectW = Number(tile.dataset.aspectWidth) || 16;
      var aspectH = Number(tile.dataset.aspectHeight) || 9;
      var ratio = aspectW / aspectH || 16 / 9;
      var streamH = rowStreamH;
      var tileW = Math.round(streamH * ratio);
      if (tileW > innerW) {
        tileW = Math.round(innerW);
        streamH = tileW / ratio;
      }
      var tileH = Math.round(streamH + headerH + captionH);
      if (x > 0 && x + tileW > innerW) {
        x = 0;
        y = y + rowH + gap;
        rowH = 0;
      }
      tile.style.left = String(x) + "px";
      tile.style.top = String(y) + "px";
      tile.style.width = String(tileW) + "px";
      tile.style.height = String(tileH) + "px";
      x = x + tileW + gap;
      rowH = Math.max(rowH, tileH);
    });
    root.style.height = String(y + rowH) + "px";
  }

  function fitFocusMedia() {
    requestAnimationFrame(function () {
      Array.prototype.forEach.call(document.querySelectorAll(".focus-stage-area .tile-stream-shell"), function (shell) {
        var area = shell.parentElement;
        if (!area) return;
        var width = Number(shell.dataset.streamWidth) || 16;
        var height = Number(shell.dataset.streamHeight) || 9;
        var rect = area.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        var scale = Math.min(rect.width / width, rect.height / height);
        shell.style.width = String(Math.max(1, Math.floor(width * scale))) + "px";
        shell.style.height = String(Math.max(1, Math.floor(height * scale))) + "px";
      });
    });
  }

  function visibleStreams() {
    return currentData.streams.filter(function (stream) {
      if (activeKind !== "all") {
        if (activeKind === "ui" && stream.kind !== "ui" && stream.kind !== "browser") return false;
        if (activeKind !== "ui" && stream.kind !== activeKind) return false;
      }
      if (activeStatus === "all") return true;
      if (activeStatus === "running") return stream.status === "running" || stream.status === "preparing";
      if (activeStatus === "blocked") return stream.status === "blocked" || stream.status === "failed";
      if (activeStatus === "complete") return stream.status === "complete";
      if (activeStatus === "proof") return stream.status === "contract_proof_only";
      return true;
    });
  }

  function countStatuses(streams) {
    return streams.reduce(function (acc, stream) {
      if (stream.status === "running" || stream.status === "preparing") acc.running += 1;
      else if (stream.status === "blocked") acc.blocked += 1;
      else if (stream.status === "failed") acc.failed += 1;
      else if (stream.status === "complete") acc.complete += 1;
      else if (stream.status === "contract_proof_only") acc.proof += 1;
      else acc.queued += 1;
      return acc;
    }, { running: 0, blocked: 0, failed: 0, complete: 0, proof: 0, queued: 0 });
  }

  function countKinds(streams) {
    return streams.reduce(function (acc, stream) {
      acc[stream.kind] = (acc[stream.kind] || 0) + 1;
      return acc;
    }, { ui: 0, browser: 0, terminal: 0, tui: 0, "codex-ui": 0, artifact: 0, summary: 0 });
  }

  function streamAspect(stream) {
    if (stream.kind === "terminal" || stream.kind === "tui") return { kind: "terminal", width: 16, height: 10 };
    var vp = stream.viewport || {};
    var width = Number(vp.width) || (stream.kind === "codex-ui" ? 16 : 16);
    var height = Number(vp.height) || (stream.kind === "codex-ui" ? 10 : 9);
    return { kind: height > width ? "mobile" : "desktop", width: width, height: height };
  }

  function streamMediaKey(stream) {
    return [stream.kind, stream.status, stream.updatedAt, preferScreenshots ? "screenshot" : "live"].join(":");
  }

  function viewLabel(stream) {
    var vp = stream.viewport || {};
    if (stream.kind === "terminal") return "CLI";
    if (stream.kind === "tui") return "TUI";
    if (stream.kind === "codex-ui") return "CODEX";
    if (vp.width && vp.height) return Number(vp.height) > Number(vp.width) ? "MOB" : "DSK";
    return "SIM";
  }

  function preferredScreenshotMode(data) {
    return !hasLiveStreams(data) && data.streams.some(function (stream) { return Boolean(stream.ui && stream.ui.screenshotUrl); });
  }

  function hasLiveStreams(data) {
    return data.streams.some(function (stream) {
      return Boolean(stream.embed && stream.embed.url) || stream.transport === "sse" || stream.transport === "app-server" || stream.transport === "pty";
    });
  }

  function focusStream(id, show) {
    focusedId = show ? knownFocusedId(id) : null;
    writeFocusLocation(focusedId);
    render();
  }

  function exitFocus() {
    focusStream(null, false);
  }

  function focusedIdFromLocation() {
    var match = (window.location.hash || "").match(/^#focus=(.+)$/);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch (_error) { return null; }
  }

  function writeFocusLocation(id) {
    var url = new URL(window.location.href);
    url.hash = id ? "focus=" + encodeURIComponent(id) : "";
    if (url.href === window.location.href) return;
    window.history.replaceState({ focusedId: id }, "", url);
  }

  function syncFocusFromLocation() {
    var next = knownFocusedId(focusedIdFromLocation());
    if (next === focusedId) return;
    focusedId = next;
    render();
  }

  function knownFocusedId(id) {
    if (id && currentData.streams.some(function (stream) { return stream.id === id; })) return id;
    return currentData.streams.length ? currentData.streams[0].id : null;
  }

  async function refresh() {
    if (location.protocol === "file:") return;
    try {
      var response = await fetch(DATA_FILE, { cache: "no-store" });
      if (response.ok) {
        currentData = await response.json();
        render();
      }
    } catch (_error) {}
  }

  async function refreshHistoryIndex() {
    if (location.protocol === "file:") return;
    try {
      var response = await fetch("/_mimetic/history.json", { cache: "no-store" });
      if (!response.ok) throw new Error("history " + response.status);
      historyIndex = await response.json();
      renderSubBar();
      renderHistoryPanel();
    } catch (_error) {
      historyIndex = null;
      historyOpen = false;
      renderSubBar();
      renderHistoryPanel();
    }
  }

  function readPref(key, fallback) {
    try {
      var raw = window.localStorage.getItem("mimetic-observer:" + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_error) {
      return fallback;
    }
  }

  function writePref(key, value) {
    try { window.localStorage.setItem("mimetic-observer:" + key, JSON.stringify(value)); } catch (_error) {}
  }

  function shortTime(value) {
    if (!value) return "";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function compact(values) {
    return values.filter(function (value) { return value !== null && value !== undefined && value !== ""; });
  }

  function compactLabel(value) {
    return String(value || "sim").replace(/^builtin-/, "").replace(/-/g, " ");
  }

  function dot() {
    var node = document.createElement("span");
    node.className = "chrome-dot";
    return node;
  }

  function thread() {
    var node = document.createElement("div");
    node.className = "codex-thread";
    return node;
  }

  function bubble(extra) {
    var node = document.createElement("div");
    node.className = "codex-bubble " + extra;
    return node;
  }

  Array.prototype.forEach.call(document.querySelectorAll(".sub-density-btn"), function (button) {
    button.addEventListener("click", function () {
      density = Number(button.dataset.density);
      writePref("density", density);
      renderSubBar();
      getElement("streams").dataset.density = String(density);
      layoutPackedGrid();
    });
  });

  getElement("rp-toggle").addEventListener("click", function () {
    stepperOpen = !(getElement("rp-toggle").getAttribute("aria-expanded") === "true");
    writePref("stepperOpen", stepperOpen);
    renderProgress();
  });

  getElement("media-toggle").addEventListener("click", function () {
    if (!hasLiveStreams(currentData)) return;
    mediaPreferenceTouched = true;
    preferScreenshots = !preferScreenshots;
    render();
  });

  getElement("focus-mode").addEventListener("click", function () {
    focusStream(focusedId || (currentData.streams[0] && currentData.streams[0].id), true);
  });

  getElement("grid-mode").addEventListener("click", exitFocus);

  getElement("history-toggle").addEventListener("click", function () {
    historyOpen = !historyOpen;
    writePref("historyOpen", historyOpen);
    renderSubBar();
    renderHistoryPanel();
  });

  getElement("history-close").addEventListener("click", function () {
    historyOpen = false;
    writePref("historyOpen", historyOpen);
    renderSubBar();
    renderHistoryPanel();
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && historyOpen) {
      historyOpen = false;
      writePref("historyOpen", historyOpen);
      renderSubBar();
      renderHistoryPanel();
      return;
    }
    if (event.key === "Escape" && focusedId) exitFocus();
    if (focusedId && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      var list = currentData.streams;
      var index = list.findIndex(function (stream) { return stream.id === focusedId; });
      if (index >= 0) {
        var next = event.key === "ArrowRight" ? (index + 1) % list.length : (index - 1 + list.length) % list.length;
        focusStream(list[next].id, true);
      }
    }
  });

  window.addEventListener("popstate", syncFocusFromLocation);
  window.addEventListener("hashchange", syncFocusFromLocation);
  window.addEventListener("resize", function () {
    fitFocusMedia();
    layoutPackedGrid();
  });

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(function () { layoutPackedGrid(); }).observe(getElement("grid-shell"));
  }

  render();
  refresh().then(function () {
    if (location.protocol !== "file:") {
      refreshTimer = setInterval(refresh, 2500);
      void refreshHistoryIndex();
      historyTimer = setInterval(refreshHistoryIndex, 30000);
    }
  });
}());
`;
}
