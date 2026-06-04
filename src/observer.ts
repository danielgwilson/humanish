import { spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildObserverData } from "./observer-data.js";
import type { ObserverData } from "./observer-data.js";
import { observerClientJs, observerCss } from "./observer-assets.js";
import { listRuns, loadRunBundle, verifyRun } from "./run.js";

export const OBSERVER_SCHEMA = "mimetic.observer-result.v1";

export interface ObserverResult {
  schema: typeof OBSERVER_SCHEMA;
  ok: boolean;
  cwd: string;
  run: string;
  observerPath?: string;
  observerDataPath?: string;
  eventsPath?: string;
  observerUrl?: string;
  serverUrl?: string;
  bundlePath?: string;
  opened?: boolean;
  openCommand?: string;
  warnings: string[];
  error?: {
    code: "MIMETIC_RUN_NOT_FOUND" | "MIMETIC_INVALID_RUN_BUNDLE";
    message: string;
  };
}

export interface ObserverOptions {
  open?: boolean;
}

export interface ObserverServeOptions {
  open?: boolean;
  port?: number;
}

export interface ObserverServer {
  url: string;
  opened: boolean;
  openCommand?: string;
  warning?: string;
  close(): Promise<void>;
}

interface ObserverRuntimeStreamUrl {
  streamId: string;
  url: string;
}

const observerRuntimeStreamUrls = new WeakMap<ObserverResult, ObserverRuntimeStreamUrl[]>();

export function attachObserverRuntimeStreamUrls(result: ObserverResult, streams: ObserverRuntimeStreamUrl[]): void {
  observerRuntimeStreamUrls.set(result, streams.filter((stream) => stream.streamId && stream.url));
}

export async function renderObserver(
  cwdInput: string,
  runInput: string,
  options: ObserverOptions = {}
): Promise<ObserverResult> {
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
        code: verified.error?.code === "MIMETIC_RUN_NOT_FOUND" ? "MIMETIC_RUN_NOT_FOUND" : "MIMETIC_INVALID_RUN_BUNDLE",
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
  const observerDataPath = path.join(observerDir, "observer-data.json");
  const eventsPath = path.join(loaded.runDir, "events.ndjson");
  const observerData = buildObserverData(loaded.bundle);

  await mkdir(observerDir, { recursive: true });
  await writeJson(observerDataPath, observerData);
  await writeFile(observerPath, renderObserverHtml(observerData), "utf8");

  const relativeObserverPath = path.relative(cwd, observerPath);
  const observerUrl = pathToFileURL(observerPath).href;
  const openResult = options.open === true ? openTarget(observerPath) : { opened: false };

  return {
    schema: OBSERVER_SCHEMA,
    ok: true,
    cwd,
    run: loaded.bundle.runId,
    observerPath: relativeObserverPath,
    observerDataPath: path.relative(cwd, observerDataPath),
    eventsPath: path.relative(cwd, eventsPath),
    observerUrl,
    bundlePath: loaded.bundlePath,
    opened: openResult.opened,
    ...(openResult.command ? { openCommand: openResult.command } : {}),
    warnings: [
      loaded.bundle.mode === "live"
        ? "Observer renders verified local evidence artifacts; runtime stream auth URLs are not persisted."
        : "Observer renders local contract evidence only; dry-run lanes do not claim product behavior proof.",
      "Before filing public feedback, use `mimetic feedback issue` so redaction and public-safety checks gate the payload.",
      ...(openResult.warning ? [openResult.warning] : [])
    ]
  };
}

export async function serveObserver(
  result: ObserverResult,
  options: ObserverServeOptions = {}
): Promise<ObserverServer> {
  if (!result.ok || !result.observerPath) {
    throw new Error("Cannot serve an observer result that did not render successfully.");
  }

  const cwd = path.resolve(result.cwd);
  const observerPath = path.join(cwd, result.observerPath);
  const runRoot = path.dirname(path.dirname(observerPath));
  const proofRoot = path.dirname(runRoot);
  const runtimeStreamUrls = observerRuntimeStreamUrls.get(result) ?? [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

      if (url.pathname === "/") {
        response.writeHead(302, { location: "/observer/index.html" });
        response.end();
        return;
      }

      if (url.pathname === "/_mimetic/history.json") {
        const history = await buildHistoryIndex(cwd);
        writeResponse(response, 200, JSON.stringify(history, null, 2), "application/json; charset=utf-8");
        return;
      }

      const runRoute = matchRunRoute(url.pathname);
      if (runRoute) {
        const targetRoot = path.join(proofRoot, runRoute.runId);
        await serveRunPath(targetRoot, runRoute.relativePath || "observer/index.html", response, runtimeStreamUrls);
        return;
      }

      await serveRunPath(runRoot, decodeURIComponent(url.pathname.slice(1)), response, runtimeStreamUrls);
    } catch (error) {
      writeResponse(response, 500, error instanceof Error ? error.message : String(error), "text/plain; charset=utf-8");
    }
  });

  const port = await listen(server, options.port ?? 0);
  const url = `http://127.0.0.1:${port}/observer/index.html`;
  const openResult = options.open === true ? openTarget(url) : { opened: false };

  return {
    url,
    opened: openResult.opened,
    ...(openResult.command ? { openCommand: openResult.command } : {}),
    ...(openResult.warning ? { warning: openResult.warning } : {}),
    close: () => closeServer(server)
  };
}

function renderObserverHtml(data: ObserverData): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Mimetic Observer - ${escapeHtml(data.run.runId)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;450;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${observerCss()}</style>
</head>
<body>
<div class="app" id="app" aria-label="Mimetic Observer mission control">
  <div class="boot" id="boot" aria-hidden="true"></div>
</div>
<noscript>This Observer renders local run evidence with JavaScript. Inspect the run bundle directly at <code>../run.json</code>.</noscript>
<script id="observer-data" type="application/json">${escapeJsonScript(data)}</script>
<script>${observerClientJs()}</script>
</body>
</html>
`;
}

async function serveRunPath(
  runRoot: string,
  relativePath: string,
  response: ServerResponse,
  runtimeStreamUrls: ObserverRuntimeStreamUrl[] = []
): Promise<void> {
  const root = path.resolve(runRoot);
  const cleanedRelativePath = relativePath === "" ? "observer/index.html" : relativePath;
  const filePath = path.resolve(root, cleanedRelativePath);

  if (!isPathInside(root, filePath)) {
    writeResponse(response, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  if (cleanedRelativePath === "observer/index.html") {
    const observerData = await readObserverData(root, runtimeStreamUrls);
    if (!observerData) {
      writeResponse(response, 404, "Observer data not found", "text/plain; charset=utf-8");
      return;
    }
    writeResponse(response, 200, renderObserverHtml(observerData), "text/html; charset=utf-8");
    return;
  }

  if (cleanedRelativePath === "observer/observer-data.json" && runtimeStreamUrls.length > 0) {
    const observerData = await readObserverData(root, runtimeStreamUrls);
    if (!observerData) {
      writeResponse(response, 404, "Observer data not found", "text/plain; charset=utf-8");
      return;
    }
    writeResponse(response, 200, JSON.stringify(observerData, null, 2), "application/json; charset=utf-8");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": contentTypeForPath(filePath)
    });
    response.end(body);
  } catch {
    writeResponse(response, 404, "Not found", "text/plain; charset=utf-8");
  }
}

async function readObserverData(
  runRoot: string,
  runtimeStreamUrls: ObserverRuntimeStreamUrl[] = []
): Promise<ObserverData | null> {
  try {
    return withRuntimeStreamUrls(
      JSON.parse(await readFile(path.join(runRoot, "observer", "observer-data.json"), "utf8")) as ObserverData,
      runtimeStreamUrls
    );
  } catch {}

  try {
    const bundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as Parameters<typeof buildObserverData>[0];
    return withRuntimeStreamUrls(buildObserverData(bundle), runtimeStreamUrls);
  } catch {}

  return null;
}

function withRuntimeStreamUrls(data: ObserverData, runtimeStreamUrls: ObserverRuntimeStreamUrl[]): ObserverData {
  if (runtimeStreamUrls.length === 0) {
    return data;
  }

  const urlsByStream = new Map(runtimeStreamUrls.map((stream) => [stream.streamId, stream.url]));
  return {
    ...data,
    streams: data.streams.map((stream) => {
      const runtimeUrl = urlsByStream.get(stream.id);
      if (!runtimeUrl) {
        return stream;
      }

      return {
        ...stream,
        embed: {
          ...(stream.embed ?? { title: stream.label }),
          kind: "iframe",
          url: runtimeUrl
        },
        transport: "sse",
        url: runtimeUrl
      };
    })
  };
}

async function buildHistoryIndex(cwd: string): Promise<{
  latestRunId: string | null;
  runs: Array<{ runId: string; createdAt: string | null; mode: string | null; href: string; status: string; streamCount: number }>;
}> {
  const listed = await listRuns(cwd);
  const runs = await Promise.all(
    listed.runs.slice(0, 80).map(async (run) => {
      const root = path.join(cwd, run.path);
      const data = await readObserverData(root);
      return {
        runId: run.runId,
        createdAt: run.createdAt,
        mode: run.mode,
        href: `/_mimetic/runs/${encodeURIComponent(run.runId)}/observer/index.html`,
        status: data?.run.status ?? "unknown",
        streamCount: data?.streams.length ?? 0
      };
    })
  );

  return { latestRunId: listed.latest, runs };
}

function matchRunRoute(pathname: string): { runId: string; relativePath: string } | null {
  const match = pathname.match(/^\/_mimetic\/runs\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  return {
    runId: decodeURIComponent(match[1] ?? ""),
    relativePath: decodeURIComponent(match[2] || "observer/index.html")
  };
}

function writeJson(filePath: string, value: unknown): Promise<void> {
  return writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeResponse(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType
  });
  response.end(body);
}

function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".ndjson":
      return "application/x-ndjson; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "text/plain; charset=utf-8";
  }
}

function openTarget(target: string): { opened: boolean; command?: string; warning?: string } {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return { opened: true, command: [command, ...args].join(" ") };
  } catch (error) {
    return {
      opened: false,
      command: [command, ...args].join(" "),
      warning: `Could not open observer automatically: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Observer server did not bind to a TCP port."));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function isPathInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
