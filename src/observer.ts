import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadRunBundle, verifyRun } from "./run.js";
import type { RunBundle } from "./run.js";

export const OBSERVER_SCHEMA = "mimetic.observer-result.v1";

export interface ObserverResult {
  schema: typeof OBSERVER_SCHEMA;
  ok: boolean;
  cwd: string;
  run: string;
  observerPath?: string;
  bundlePath?: string;
  warnings: string[];
  error?: {
    code: "MIMETIC_RUN_NOT_FOUND" | "MIMETIC_INVALID_RUN_BUNDLE";
    message: string;
  };
}

export async function renderObserver(cwdInput: string, runInput: string): Promise<ObserverResult> {
  const cwd = path.resolve(cwdInput);
  const verified = await verifyRun(cwd, runInput);

  if (!verified.ok) {
    return {
      schema: OBSERVER_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      warnings: [],
      error: {
        code: verified.error?.code ?? "MIMETIC_INVALID_RUN_BUNDLE",
        message: verified.error?.message ?? "Run bundle failed verification."
      }
    };
  }

  const loaded = await loadRunBundle(cwd, runInput);

  if (!loaded) {
    return {
      schema: OBSERVER_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      warnings: [],
      error: {
        code: "MIMETIC_RUN_NOT_FOUND",
        message: `Run not found: ${runInput}`
      }
    };
  }

  const observerDir = path.join(loaded.runDir, "observer");
  const observerPath = path.join(observerDir, "index.html");
  await mkdir(observerDir, { recursive: true });
  await writeFile(observerPath, renderObserverHtml(loaded.bundle), "utf8");

  return {
    schema: OBSERVER_SCHEMA,
    ok: true,
    cwd,
    run: runInput,
    observerPath: path.relative(cwd, observerPath),
    bundlePath: loaded.bundlePath,
    warnings: [
      "Static observer is generated from bundle evidence only.",
      "Dry-run observer does not claim product behavior proof."
    ]
  };
}

function renderObserverHtml(bundle: RunBundle): string {
  const lifecycle = bundle.lifecycle
    .map((event) => `<li><strong>${escapeHtml(event.event)}</strong><span>${escapeHtml(event.message)}</span><time>${escapeHtml(event.at)}</time></li>`)
    .join("\n");
  const gaps = bundle.review.gaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join("\n");
  const feedback = bundle.feedbackCandidates.length === 0
    ? "<p>No feedback candidates in this dry-run bundle.</p>"
    : `<pre>${escapeHtml(JSON.stringify(bundle.feedbackCandidates, null, 2))}</pre>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Mimetic Observer - ${escapeHtml(bundle.runId)}</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #18211f;
        --muted: #5f6d68;
        --line: #d5ddd7;
        --surface: #f6f7f2;
        --accent: #0f766e;
        --warn: #9a3412;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--surface);
        color: var(--ink);
        font-family: ui-sans-serif, system-ui, sans-serif;
        line-height: 1.45;
      }
      main {
        max-width: 1120px;
        margin: 0 auto;
        padding: 32px;
      }
      header, section {
        border-bottom: 1px solid var(--line);
        padding: 24px 0;
      }
      h1, h2, p { margin: 0; }
      h1 { font-size: 32px; }
      h2 { font-size: 18px; margin-bottom: 12px; }
      .meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
        margin-top: 20px;
      }
      .field {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px;
        background: white;
      }
      .label {
        display: block;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
      }
      .value { font-weight: 650; overflow-wrap: anywhere; }
      ul { margin: 0; padding-left: 20px; }
      .timeline {
        list-style: none;
        padding: 0;
        display: grid;
        gap: 8px;
      }
      .timeline li {
        display: grid;
        grid-template-columns: minmax(160px, 220px) 1fr minmax(180px, auto);
        gap: 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px;
        background: white;
      }
      time { color: var(--muted); font-size: 13px; }
      .status { color: var(--accent); font-weight: 700; }
      .warning { color: var(--warn); }
      pre {
        overflow: auto;
        padding: 12px;
        background: #101816;
        color: #e9f5ef;
        border-radius: 8px;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Mimetic Observer</h1>
        <p class="status">${escapeHtml(bundle.review.verdict)}</p>
        <div class="meta">
          ${field("Run", bundle.runId)}
          ${field("Mode", bundle.mode)}
          ${field("Scenario", bundle.scenario.id)}
          ${field("Persona", bundle.persona.id)}
          ${field("Redaction", bundle.redaction.status)}
          ${field("Source", bundle.source.mimeticSource)}
        </div>
      </header>
      <section>
        <h2>Summary</h2>
        <p>${escapeHtml(bundle.review.summary)}</p>
      </section>
      <section>
        <h2>Lifecycle</h2>
        <ul class="timeline">
          ${lifecycle}
        </ul>
      </section>
      <section>
        <h2>Evidence Gaps</h2>
        <ul class="warning">
          ${gaps}
        </ul>
      </section>
      <section>
        <h2>Feedback Candidates</h2>
        ${feedback}
      </section>
      <section>
        <h2>Bundle</h2>
        <pre>${escapeHtml(JSON.stringify(bundle, null, 2))}</pre>
      </section>
    </main>
  </body>
</html>
`;
}

function field(label: string, value: string): string {
  return `<div class="field"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
