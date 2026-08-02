export interface LibraryHistory {
  latestRunId: string | null;
  runs: Array<{
    runId: string;
    createdAt: string | null;
    mode: string | null;
    href: string;
    status: string;
    streamCount: number;
    /** Labeled run-total cost ESTIMATE (null when the run carries no cost summary). */
    estimatedCostUsd: number | null;
    costRatesAsOf: string | null;
    costPlaceholder: boolean;
  }>;
}

export interface LibraryRenderOptions {
  mode: "loopback" | "exposed" | "share-safe-open";
  safe: boolean;
  capabilities: { actions: boolean };
}

const STATUS_TONES: Record<string, string> = {
  passed: "#3fb970",
  running: "#4f8ff7",
  failed: "#e5534b",
  blocked: "#d29922",
  timed_out: "#d29922"
};

export function renderLibraryHtml(history: LibraryHistory, opts: LibraryRenderOptions): string {
  const emptyState = opts.safe
    ? "No share_ready runs yet — run `humanish verify` to see why."
    : "No runs yet — run `humanish watch` to create one.";

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Humanish Library</title>
<style>${libraryCss()}</style>
</head>
<body>
<header class="bar">
  <span class="mark">humanish</span>
  <span class="title">Run Library</span>
  <span class="mode">${escapeHtml(modeLabel(opts))}</span>
</header>
<main>
  <p class="note" id="note" hidden></p>
  <ul class="runs" id="runs"></ul>
  <p class="empty" id="empty" hidden>${escapeHtml(emptyState)}</p>
</main>
<script type="application/json" id="serve-capabilities">${escapeJsonScript(opts.capabilities)}</script>
<script type="application/json" id="library-data">${escapeJsonScript(history)}</script>
<script>${libraryClientJs()}</script>
</body>
</html>
`;
}

function modeLabel(opts: LibraryRenderOptions): string {
  const auth = opts.mode === "exposed" ? "edge-authed" : opts.mode === "share-safe-open" ? "open" : "loopback";
  return opts.safe ? `${auth} · share_ready only` : auth;
}

function libraryCss(): string {
  return `
:root { color-scheme: dark; }
* { box-sizing: border-box; margin: 0; }
body {
  background: #0c0e12; color: #e6e8ec; min-height: 100vh;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.bar {
  display: flex; align-items: baseline; gap: 0.6rem;
  padding: 1rem 1.1rem; border-bottom: 1px solid #1e222b;
  position: sticky; top: 0; background: rgba(12,14,18,0.95); backdrop-filter: blur(6px);
}
.mark { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 600; color: #9aa3b2; }
.title { font-weight: 600; }
.mode { margin-left: auto; font-size: 0.75rem; color: #9aa3b2; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
main { padding: 1rem 1.1rem 3rem; max-width: 44rem; margin: 0 auto; }
.note { font-size: 0.8rem; color: #d29922; padding: 0.5rem 0; }
.runs { list-style: none; padding: 0; display: grid; gap: 0.6rem; }
.runs a {
  display: block; text-decoration: none; color: inherit;
  border: 1px solid #1e222b; border-radius: 10px; padding: 0.8rem 0.9rem; background: #11141a;
}
.runs a:active { background: #171b23; }
.run-top { display: flex; align-items: center; gap: 0.5rem; }
.pip { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.pip.running { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }
.run-id {
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.8rem;
  overflow-wrap: anywhere;
}
.badge {
  margin-left: auto; flex: none; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em;
  border: 1px solid #2c5f8a; color: #7cb8ec; border-radius: 999px; padding: 0.1rem 0.5rem;
}
.badge.latest { border-color: #3fb970; color: #7ee2a8; }
.run-meta { margin-top: 0.35rem; font-size: 0.75rem; color: #9aa3b2; }
.empty { color: #9aa3b2; font-size: 0.85rem; padding: 2rem 0; text-align: center; }
`;
}

function libraryClientJs(): string {
  const tones = JSON.stringify(STATUS_TONES);
  return `
(function () {
  var TONES = ${tones};
  var POLL_MS = 15000;
  var stopped = false;

  function render(history) {
    var list = document.getElementById("runs");
    var empty = document.getElementById("empty");
    list.textContent = "";
    var runs = history.runs || [];
    empty.hidden = runs.length !== 0;
    for (var i = 0; i < runs.length; i += 1) {
      var run = runs[i];
      var item = document.createElement("li");
      var link = document.createElement("a");
      link.href = run.href;
      var top = document.createElement("div");
      top.className = "run-top";
      var pip = document.createElement("span");
      pip.className = run.status === "running" ? "pip running" : "pip";
      pip.style.background = TONES[run.status] || "#57606f";
      var id = document.createElement("span");
      id.className = "run-id";
      id.textContent = run.runId;
      top.appendChild(pip);
      top.appendChild(id);
      if (run.runId === history.latestRunId) {
        var latest = document.createElement("span");
        latest.className = "badge latest";
        latest.textContent = "latest";
        top.appendChild(latest);
      } else if (run.status === "running") {
        var live = document.createElement("span");
        live.className = "badge";
        live.textContent = "live";
        top.appendChild(live);
      }
      var meta = document.createElement("div");
      meta.className = "run-meta";
      var metaBits = [run.mode || "unknown", run.streamCount + " lanes", run.createdAt || ""];
      // Labeled cost token: ALWAYS "~$X est." (never a bare "$X"), so the library never implies an
      // authoritative charge. Null = omitted (advisory, fail-open on display).
      if (run.estimatedCostUsd != null) {
        metaBits.push("~$" + Number(run.estimatedCostUsd).toFixed(2) + " est." + (run.costPlaceholder ? " (placeholder)" : ""));
        if (run.costRatesAsOf) meta.title = "estimated, rates as of " + run.costRatesAsOf;
      }
      meta.textContent = metaBits.filter(Boolean).join(" \\u00b7 ");
      link.appendChild(top);
      link.appendChild(meta);
      item.appendChild(link);
      list.appendChild(item);
    }
  }

  function note(text) {
    var element = document.getElementById("note");
    element.hidden = !text;
    element.textContent = text || "";
  }

  function poll() {
    if (stopped) return;
    fetch("/_humanish/history.json", { cache: "no-store" }).then(function (response) {
      return response.json();
    }).then(function (history) {
      if (history) {
        note("");
        render(history);
      }
    }).catch(function () {
      note("connection lost \\u2014 retrying");
    }).then(function () {
      if (!stopped) setTimeout(poll, POLL_MS);
    });
  }

  render(JSON.parse(document.getElementById("library-data").textContent));
  setTimeout(poll, POLL_MS);
})();
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function escapeJsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
