import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import {
  runCodexAppServerSessionInPreparedRoot,
  type CodexAppServerRunOptions,
  type CodexAppServerRunResult,
  type CodexAppServerStatus
} from "./codex-app-server.js";
import {
  prepareContainedOutputDirectory,
  prepareContainedOutputFile,
  prepareManagedHumanishOutputDirectory,
  prepareSelectedOutputDirectory,
  prepareSelectedOutputFile,
  readContainedRegularFile,
  type PreparedOutputDirectory,
  type PreparedSelectedOutputFile,
  writeContainedOutputFile,
  writePreparedSelectedOutputFile
} from "./selected-output-paths.js";

export const CODEX_APP_SERVER_UI_SCHEMA = "humanish.codex-app-server-ui.v1";

type CodexAppServerUiStatus = "starting" | "running" | CodexAppServerStatus;

export interface CodexAppServerUiOptions {
  actorCommand?: string;
  cwd: string;
  keepOpen?: boolean;
  model?: string;
  port?: number;
  prompt: string;
  runRoot?: string;
  sandbox?: CodexAppServerRunOptions["sandbox"];
  serviceName?: string;
  stateFile?: string;
  timeoutMs: number;
}

export interface CodexAppServerUiState {
  schema: typeof CODEX_APP_SERVER_UI_SCHEMA;
  artifactRoot: string;
  cwd: string;
  promptDigest: string;
  reason: string;
  result?: CodexAppServerRunResult;
  runRoot: string;
  startedAt: string;
  status: CodexAppServerUiStatus;
  stateFile: string;
  updatedAt: string;
  url?: string;
}

export interface CodexAppServerUiController {
  close(): Promise<void>;
  completion: Promise<CodexAppServerUiState>;
  initialState: CodexAppServerUiState;
  stateFile: string;
  url: string;
}

export async function startCodexAppServerUi(options: CodexAppServerUiOptions): Promise<CodexAppServerUiController> {
  const cwd = path.resolve(options.cwd);
  const preparedRunRoot = options.runRoot === undefined
    ? await prepareManagedHumanishOutputDirectory(cwd, "codex-app-server-ui")
    : await prepareSelectedOutputDirectory(cwd, options.runRoot);
  const preparedStateFile: PreparedSelectedOutputFile | undefined = options.stateFile === undefined
    ? undefined
    : await prepareSelectedOutputFile(cwd, options.stateFile);
  const stateFile = preparedStateFile?.requestedPath ?? path.join(preparedRunRoot.requestedPath, "state.json");
  if (!preparedStateFile) {
    await prepareContainedOutputFile(preparedRunRoot, "state.json");
  }
  await prepareContainedOutputDirectory(preparedRunRoot, "codex-app-server");
  await Promise.all([
    prepareContainedOutputFile(preparedRunRoot, path.join("codex-app-server", "events.ndjson")),
    prepareContainedOutputFile(preparedRunRoot, path.join("codex-app-server", "summary.json")),
    prepareContainedOutputFile(preparedRunRoot, path.join("codex-app-server", "transcript.txt"))
  ]);
  const publicRunRoot = path.relative(cwd, preparedRunRoot.requestedPath) || ".";
  const publicStateFile = path.relative(cwd, stateFile) || path.basename(stateFile);

  let state: CodexAppServerUiState = {
    schema: CODEX_APP_SERVER_UI_SCHEMA,
    artifactRoot: publicRunRoot,
    cwd: "[target-cwd]",
    promptDigest: digestText(options.prompt),
    reason: "Codex app-server UI is starting.",
    runRoot: publicRunRoot,
    startedAt: new Date().toISOString(),
    status: "starting",
    stateFile: publicStateFile,
    updatedAt: new Date().toISOString()
  };

  const persistState = async (): Promise<void> => {
    const contents = `${JSON.stringify(state, null, 2)}\n`;
    if (preparedStateFile) {
      await writePreparedSelectedOutputFile(preparedStateFile, contents, "utf8");
    } else {
      await writeContainedOutputFile(preparedRunRoot, "state.json", contents, "utf8");
    }
  };

  const server = createServer(async (request, response) => {
    if (request.url === "/state") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8"
      });
      response.end(`${JSON.stringify(state)}\n`);
      return;
    }

    if (request.url?.startsWith("/artifact/")) {
      let requestPath: string;
      try {
        requestPath = decodeURIComponent(request.url.slice("/artifact/".length));
      } catch {
        response.writeHead(404);
        response.end("not found");
        return;
      }
      await serveArtifact({
        requestPath,
        response,
        runRoot: preparedRunRoot
      });
      return;
    }

    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8"
    });
    response.end(renderCodexAppServerUiHtml());
  });

  const url = await listen(server, options.port ?? 0);
  state = {
    ...state,
    reason: "Codex app-server actor is running.",
    status: "running",
    updatedAt: new Date().toISOString(),
    url
  };
  try {
    await persistState();
  } catch (error) {
    await closeServer(server);
    throw error;
  }

  const sessionOptions: CodexAppServerRunOptions = {
    cwd,
    prompt: options.prompt,
    runRoot: preparedRunRoot.physicalPath,
    timeoutMs: options.timeoutMs,
    ...(options.actorCommand ? { actorCommand: ["bash", "-lc", options.actorCommand] } : {}),
    approvalPolicy: "never",
    experimentalApi: true,
    ...(options.model === undefined ? {} : { model: options.model }),
    sandbox: options.sandbox ?? "read-only",
    serviceName: options.serviceName ?? "humanish"
  };
  const completion = runCodexAppServerSessionInPreparedRoot(sessionOptions, preparedRunRoot).then(
    async (result): Promise<CodexAppServerUiState> => {
      state = {
        ...state,
        reason: result.reason,
        result,
        status: result.status,
        updatedAt: new Date().toISOString()
      };
      try {
        await persistState();
      } catch (error) {
        await closeServer(server);
        throw error;
      }
      if (options.keepOpen !== true) {
        await closeServer(server);
      }
      return state;
    },
    async (error: unknown): Promise<CodexAppServerUiState> => {
      state = {
        ...state,
        reason: error instanceof Error ? error.message : String(error),
        status: "blocked",
        updatedAt: new Date().toISOString()
      };
      try {
        await persistState();
      } catch (persistError) {
        await closeServer(server);
        throw persistError;
      }
      await closeServer(server);
      return state;
    }
  );

  return {
    close: async () => closeServer(server),
    completion,
    initialState: state,
    stateFile,
    url
  };
}

async function serveArtifact(args: {
  requestPath: string;
  response: ServerResponse;
  runRoot: PreparedOutputDirectory;
}): Promise<void> {
  const body = await readContainedRegularFile(args.runRoot, args.requestPath);
  if (body) {
    args.response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": contentTypeFor(args.requestPath)
    });
    args.response.end(body);
    return;
  }
  args.response.writeHead(404);
  args.response.end("not found");
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".ndjson")) return "application/x-ndjson; charset=utf-8";
  return "text/plain; charset=utf-8";
}

async function listen(server: Server, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Codex app-server UI address was unavailable."));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/`);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function digestText(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function renderCodexAppServerUiHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Humanish Codex App-Server</title>
  <style>
    :root {
      --bg: #080a0d;
      --surface: #11151b;
      --surface-2: #171d25;
      --line: rgba(255,255,255,.1);
      --line-2: rgba(255,255,255,.16);
      --text: #eef2f7;
      --muted: #9aa4b2;
      --dim: #687281;
      --accent: #5f82ff;
      --green: #38d890;
      --red: #ff6258;
      --amber: #f2b84a;
      color-scheme: dark;
      font-family: "Geist", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); min-height: 100vh; }
    .shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
    header { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border-bottom: 1px solid var(--line); background: rgba(17,21,27,.95); position: sticky; top: 0; }
    .mark { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; border: 1px solid var(--line-2); background: radial-gradient(circle at 25% 20%, rgba(95,130,255,.4), transparent 65%), var(--surface-2); color: #c9d6ff; font-weight: 700; }
    .title { min-width: 0; }
    .title h1 { margin: 0; font-size: 15px; line-height: 1.2; letter-spacing: 0; }
    .title p { margin: 2px 0 0; color: var(--muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 74vw; }
    .pill { margin-left: auto; border: 1px solid var(--line-2); border-radius: 999px; padding: 7px 11px; color: var(--muted); background: var(--surface-2); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; text-transform: uppercase; letter-spacing: .12em; }
    .pill[data-status="passed"] { color: var(--green); border-color: rgba(56,216,144,.35); background: rgba(56,216,144,.12); }
    .pill[data-status="failed"], .pill[data-status="blocked"], .pill[data-status="timed_out"] { color: var(--red); border-color: rgba(255,98,88,.35); background: rgba(255,98,88,.12); }
    main { display: grid; grid-template-columns: 300px 1fr; min-height: 0; }
    aside { border-right: 1px solid var(--line); padding: 14px; background: #0c1015; min-width: 0; }
    section { padding: 14px; min-width: 0; overflow: auto; }
    .label { color: var(--dim); text-transform: uppercase; letter-spacing: .16em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; margin: 16px 0 7px; }
    .kv { display: grid; grid-template-columns: 76px 1fr; gap: 7px; padding: 7px 0; border-bottom: 1px solid var(--line); color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .kv b { color: var(--text); font-weight: 500; overflow-wrap: anywhere; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
    .metric { border: 1px solid var(--line); background: var(--surface); border-radius: 10px; padding: 12px; min-height: 72px; }
    .metric span { color: var(--dim); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .12em; font-size: 10px; }
    .metric strong { display: block; margin-top: 5px; font-size: 22px; }
    .panel { border: 1px solid var(--line); background: var(--surface); border-radius: 12px; margin-bottom: 12px; overflow: hidden; }
    .panel h2 { margin: 0; padding: 11px 12px; font-size: 13px; border-bottom: 1px solid var(--line); }
    .panel pre, .panel .empty { margin: 0; padding: 12px; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.55; max-height: 280px; overflow: auto; }
    .item { padding: 10px 12px; border-bottom: 1px solid var(--line); }
    .item:last-child { border-bottom: none; }
    .item b { display: block; font-size: 12px; margin-bottom: 3px; }
    .item code { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow-wrap: anywhere; }
    a { color: #b9c9ff; text-decoration: none; }
    @media (max-width: 860px) {
      main { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="mark">CT</div>
      <div class="title">
        <h1>Codex App-Server Actor</h1>
        <p id="subtitle">Connecting to Humanish state...</p>
      </div>
      <div class="pill" id="status" data-status="starting">STARTING</div>
    </header>
    <main>
      <aside>
        <div class="label">Session</div>
        <div class="kv"><span>Status</span><b id="side-status">starting</b></div>
        <div class="kv"><span>Thread</span><b id="thread">pending</b></div>
        <div class="kv"><span>Turn</span><b id="turn">pending</b></div>
        <div class="kv"><span>Model</span><b id="model">pending</b></div>
        <div class="kv"><span>Digest</span><b id="digest">pending</b></div>
        <div class="label">Artifacts</div>
        <div id="artifacts"></div>
      </aside>
      <section>
        <div class="grid" id="metrics"></div>
        <div class="panel"><h2>Latest Agent Message</h2><pre id="message">(waiting)</pre></div>
        <div class="panel"><h2>Reasoning Summary</h2><pre id="reasoning">(waiting)</pre></div>
        <div class="panel"><h2>Commands</h2><div id="commands" class="empty">(waiting)</div></div>
        <div class="panel"><h2>Approvals</h2><div id="approvals" class="empty">(none)</div></div>
      </section>
    </main>
  </div>
  <script>
    function esc(value) {
      return String(value == null ? "" : value).replace(/[&<>"']/g, function(ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;" })[ch];
      });
    }
    function latestText(items) {
      if (!Array.isArray(items) || !items.length) return "(waiting)";
      return items[items.length - 1].text || "(empty)";
    }
    function renderItems(items, empty, map) {
      if (!Array.isArray(items) || !items.length) return '<div class="empty">' + esc(empty) + '</div>';
      return items.map(map).join("");
    }
    async function tick() {
      try {
        var response = await fetch("/state", { cache: "no-store" });
        var state = await response.json();
        var trace = state.result && state.result.trace ? state.result.trace : {};
        var counts = trace.counts || {};
        document.getElementById("status").textContent = String(state.status || "unknown").toUpperCase();
        document.getElementById("status").dataset.status = state.status || "unknown";
        document.getElementById("side-status").textContent = state.status || "unknown";
        document.getElementById("subtitle").textContent = state.reason || state.url || "";
        document.getElementById("thread").textContent = trace.threadId || state.result?.threadId || "pending";
        document.getElementById("turn").textContent = trace.turnId || state.result?.turnId || "pending";
        document.getElementById("model").textContent = trace.model || state.result?.model || "pending";
        document.getElementById("digest").textContent = state.promptDigest || "pending";
        var metricDefs = [
          ["Messages", counts.messages || 0],
          ["Reasoning", counts.reasoning || 0],
          ["Commands", counts.commandOutputs || 0],
          ["Envelopes", counts.envelopes || 0]
        ];
        document.getElementById("metrics").innerHTML = metricDefs.map(function(entry) {
          return '<div class="metric"><span>' + esc(entry[0]) + '</span><strong>' + esc(entry[1]) + '</strong></div>';
        }).join("");
        document.getElementById("message").textContent = latestText(trace.messages);
        document.getElementById("reasoning").textContent = latestText(trace.reasoning);
        document.getElementById("commands").innerHTML = renderItems(trace.commands, "(waiting)", function(command) {
          return '<div class="item"><b>' + esc(command.command || "command") + '</b><code>' + esc(command.status || "") + " " + esc(command.outputTail || "") + '</code></div>';
        });
        document.getElementById("approvals").innerHTML = renderItems(trace.approvals, "(none)", function(approval) {
          return '<div class="item"><b>' + esc(approval.method || "approval") + '</b><code>' + esc(approval.decision || "") + " " + esc(approval.reason || "") + '</code></div>';
        });
        var artifacts = [];
        if (state.result?.tracePath) artifacts.push(["Trace", state.result.tracePath]);
        if (state.result?.eventsPath) artifacts.push(["Events", state.result.eventsPath]);
        if (state.result?.transcriptPath) artifacts.push(["Transcript", state.result.transcriptPath]);
        document.getElementById("artifacts").innerHTML = artifacts.length
          ? artifacts.map(function(entry) { return '<div class="item"><b>' + esc(entry[0]) + '</b><code><a href="/artifact/' + encodeURIComponent(entry[1]) + '">' + esc(entry[1]) + '</a></code></div>'; }).join("")
          : '<div class="empty">Artifacts will appear after completion.</div>';
      } catch (error) {
        document.getElementById("subtitle").textContent = "State polling failed: " + error.message;
      }
    }
    tick();
    setInterval(tick, 1000);
  </script>
</body>
</html>`;
}
