import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildObserverData } from "./observer-data.js";
import type { ObserverData } from "./observer-data.js";
import { observerClientJs, observerCss } from "./observer-assets.js";
import { listRuns, loadRunBundle, verifyRun } from "./run.js";
import {
  bindExistingRunArtifactPaths,
  isPathInside,
  isSafeRunIdSegment,
  resolveLatestRunDirectory,
  type PreparedRunArtifactPaths,
  validatePreparedRunArtifactPaths
} from "./run-paths.js";
import {
  writeContainedOutputFile
} from "./selected-output-paths.js";

export const OBSERVER_SCHEMA = "humanish.observer-result.v1";

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
    code: "HUMANISH_RUN_NOT_FOUND" | "HUMANISH_INVALID_RUN_BUNDLE";
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

export interface ObserverRuntimeStreamUrl {
  streamId: string;
  url: string;
}

interface PinnedDirectory {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly physicalPath: string;
}

interface PinnedFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

const observerRuntimeStreamUrls = new WeakMap<ObserverResult, ObserverRuntimeStreamUrl[]>();
const observerPreparedRunPaths = new WeakMap<ObserverResult, PreparedRunArtifactPaths>();

export function attachObserverRuntimeStreamUrls(result: ObserverResult, streams: ObserverRuntimeStreamUrl[]): void {
  observerRuntimeStreamUrls.set(result, streams.filter((stream) => stream.streamId && stream.url));
}

export async function renderObserver(
  cwdInput: string,
  runInput: string,
  options: ObserverOptions = {}
): Promise<ObserverResult> {
  const cwd = path.resolve(cwdInput);
  let selection: ObserverRunSelection | null;
  try {
    selection = await resolveObserverRunSelection(cwd, runInput);
  } catch {
    selection = null;
  }

  if (!selection) {
    return observerRunError(cwd, runInput, "HUMANISH_RUN_NOT_FOUND", `Run not found: ${runInput}`);
  }

  let preparedRunPaths;
  try {
    const selectedPhysicalCwd = path.dirname(path.dirname(selection.runsRoot.physicalPath));
    preparedRunPaths = await bindExistingRunArtifactPaths(selectedPhysicalCwd, selection.runId);
    if (
      preparedRunPaths.physicalRunsRoot !== selection.runsRoot.physicalPath
      || preparedRunPaths.physicalRunRoot !== selection.runRoot.physicalPath
      || preparedRunPaths.runsRootIdentity.dev !== selection.runsRoot.dev
      || preparedRunPaths.runsRootIdentity.ino !== selection.runsRoot.ino
      || preparedRunPaths.runRootIdentity.dev !== selection.runRoot.dev
      || preparedRunPaths.runRootIdentity.ino !== selection.runRoot.ino
    ) {
      throw new Error("Observer run selection changed physical identity.");
    }
  } catch {
    return observerRunError(cwd, runInput, "HUMANISH_INVALID_RUN_BUNDLE", "Observer run storage is unavailable or unsafe.");
  }

  await validatePreparedRunArtifactPaths(preparedRunPaths);
  const selectedPhysicalCwd = path.dirname(path.dirname(selection.runsRoot.physicalPath));
  const verified = await verifyRun(selectedPhysicalCwd, selection.runId);
  await validatePreparedRunArtifactPaths(preparedRunPaths);

  if (!verified.ok) {
    return observerRunError(
      cwd,
      runInput,
      verified.error?.code === "HUMANISH_RUN_NOT_FOUND" ? "HUMANISH_RUN_NOT_FOUND" : "HUMANISH_INVALID_RUN_BUNDLE",
      verified.error?.message ?? "Run bundle failed verification."
    );
  }

  const loaded = await loadRunBundle(selectedPhysicalCwd, selection.runId);
  await validatePreparedRunArtifactPaths(preparedRunPaths);
  if (!loaded) {
    return observerRunError(cwd, runInput, "HUMANISH_RUN_NOT_FOUND", `Run not found: ${runInput}`);
  }

  if (
    loaded.bundle.runId !== selection.runId
    || await realpath(loaded.runDir) !== preparedRunPaths.physicalRunRoot
  ) {
    throw new Error("Observer output directory does not match the selected run.");
  }

  const observerPath = path.join(preparedRunPaths.physicalRunRoot, "observer", "index.html");
  const observerData = buildObserverData(loaded.bundle);

  await writeContainedOutputFile(
    preparedRunPaths,
    path.join("observer", "observer-data.json"),
    `${JSON.stringify(observerData, null, 2)}\n`,
    "utf8"
  );
  await writeContainedOutputFile(
    preparedRunPaths,
    path.join("observer", "index.html"),
    renderObserverHtml(observerData),
    "utf8"
  );
  await validatePreparedRunArtifactPaths(preparedRunPaths);

  const relativeObserverPath = path.join(preparedRunPaths.relativeRunRoot, "observer", "index.html");
  const relativeObserverDataPath = path.join(preparedRunPaths.relativeRunRoot, "observer", "observer-data.json");
  const relativeEventsPath = path.join(preparedRunPaths.relativeRunRoot, "events.ndjson");
  const observerUrl = pathToFileURL(observerPath).href;
  const openResult = options.open === true ? openTarget(observerPath) : { opened: false };

  const result: ObserverResult = {
    schema: OBSERVER_SCHEMA,
    ok: true,
    cwd,
    run: loaded.bundle.runId,
    observerPath: relativeObserverPath,
    observerDataPath: relativeObserverDataPath,
    eventsPath: relativeEventsPath,
    observerUrl,
    bundlePath: loaded.bundlePath,
    opened: openResult.opened,
    ...(openResult.command ? { openCommand: openResult.command } : {}),
    warnings: [
      loaded.bundle.mode === "live"
        ? "Observer renders verified local evidence artifacts; runtime stream auth URLs are not persisted."
        : "Observer renders local contract evidence only; dry-run lanes do not claim product behavior proof.",
      "Before filing public feedback, use `humanish feedback issue` so redaction and public-safety checks gate the payload.",
      ...(openResult.warning ? [openResult.warning] : [])
    ]
  };
  observerPreparedRunPaths.set(result, preparedRunPaths);
  return result;
}

function observerRunError(
  cwd: string,
  run: string,
  code: NonNullable<ObserverResult["error"]>["code"],
  message: string
): ObserverResult {
  return {
    schema: OBSERVER_SCHEMA,
    ok: false,
    cwd,
    run,
    warnings: [],
    error: { code, message }
  };
}

interface ObserverRunSelection {
  readonly runId: string;
  readonly runRoot: PinnedDirectory;
  readonly runsRoot: PinnedDirectory;
}

async function resolveObserverRunSelection(cwd: string, runInput: string): Promise<ObserverRunSelection | null> {
  const runsRoot = await pinDirectory(path.join(cwd, ".humanish", "runs"));
  if (runInput !== "latest") {
    const runRoot = isSafeRunIdSegment(runInput)
      ? await pinDirectChildDirectory(runsRoot, runInput)
      : null;
    return runRoot ? { runId: runInput, runRoot, runsRoot } : null;
  }

  const latestBytes = await readContainedFile(runsRoot, path.join(runsRoot.physicalPath, "latest.json"));
  if (!latestBytes) return null;
  const pointer = JSON.parse(latestBytes.toString("utf8")) as { path?: unknown; runId?: unknown };
  if (typeof pointer.runId !== "string" || typeof pointer.path !== "string" || !isSafeRunIdSegment(pointer.runId)) {
    return null;
  }
  const declared = resolveLatestRunDirectory(cwd, { path: pointer.path, runId: pointer.runId });
  if (!declared) return null;
  const expected = path.join(runsRoot.physicalPath, pointer.runId);
  const runRoot = await pinDirectChildDirectory(runsRoot, pointer.runId);
  if (!runRoot || runRoot.physicalPath !== expected) return null;
  return { runId: pointer.runId, runRoot, runsRoot };
}

export async function serveObserver(
  result: ObserverResult,
  options: ObserverServeOptions = {}
): Promise<ObserverServer> {
  if (!result.ok || !result.observerPath) {
    throw new Error("Cannot serve an observer result that did not render successfully.");
  }

  const cwd = path.resolve(result.cwd);
  const retainedRunPaths = observerPreparedRunPaths.get(result);
  const preparedRunPaths = retainedRunPaths
    ? await validatePreparedRunArtifactPaths(retainedRunPaths)
    : await bindExistingRunArtifactPaths(cwd, result.run);
  const runRoot = await pinDirectory(preparedRunPaths.physicalRunRoot);
  const proofRoot = await pinDirectory(preparedRunPaths.physicalRunsRoot);
  const expectedRelativeObserverPath = path.join(preparedRunPaths.relativeRunRoot, "observer", "index.html");
  if (result.observerPath !== expectedRelativeObserverPath) {
    throw new Error("Observer path does not match the selected run.");
  }
  // The live server renders observer/index.html from the pinned run bundle on
  // each request, so an attached in-progress Observer legitimately has no
  // static index file yet. The exact lexical result path was checked above;
  // keep serving from the identity-bound physical run root.
  const observerPath = path.join(preparedRunPaths.physicalRunRoot, "observer", "index.html");
  if (observerPath !== path.join(runRoot.physicalPath, "observer", "index.html")) {
    throw new Error("Observer path does not match the selected run.");
  }
  const runtimeStreamUrls = () => observerRuntimeStreamUrls.get(result) ?? [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

      if (url.pathname === "/") {
        response.writeHead(302, { location: "/observer/index.html" });
        response.end();
        return;
      }

      if (url.pathname === "/_humanish/history.json") {
        const history = await buildHistoryIndex(proofRoot);
        writeResponse(response, 200, JSON.stringify(history, null, 2), "application/json; charset=utf-8");
        return;
      }

      if (url.pathname.startsWith("/_humanish/runs/")) {
        const runRoute = matchRunRoute(url.pathname);
        if (!runRoute) {
          writeResponse(response, 404, "Run not found", "text/plain; charset=utf-8");
          return;
        }
        const targetRoot = await pinDirectChildDirectory(proofRoot, runRoute.runId);
        if (!targetRoot) {
          writeResponse(response, 404, "Run not found", "text/plain; charset=utf-8");
          return;
        }
        await serveRunPath(targetRoot, runRoute.relativePath || "observer/index.html", response, runtimeStreamUrls());
        return;
      }

      await serveRunPath(runRoot, decodeURIComponent(url.pathname.slice(1)), response, runtimeStreamUrls());
    } catch {
      writeResponse(response, 500, "Observer request failed", "text/plain; charset=utf-8");
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
<title>Humanish Observer - ${escapeHtml(data.run.runId)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;450;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${observerCss()}</style>
</head>
<body>
<div class="app" id="app" aria-label="Humanish Observer mission control">
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
  runRoot: PinnedDirectory,
  relativePath: string,
  response: ServerResponse,
  runtimeStreamUrls: ObserverRuntimeStreamUrl[] = []
): Promise<void> {
  const root = runRoot.physicalPath;
  const cleanedRelativePath = relativePath === "" ? "observer/index.html" : relativePath;
  const filePath = path.resolve(root, cleanedRelativePath);

  if (!isPathInside(root, filePath)) {
    writeResponse(response, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  if (cleanedRelativePath === "observer/index.html") {
    const observerData = await readObserverData(runRoot, runtimeStreamUrls);
    if (!observerData) {
      writeResponse(response, 404, "Observer data not found", "text/plain; charset=utf-8");
      return;
    }
    writeResponse(response, 200, renderObserverHtml(observerData), "text/html; charset=utf-8");
    return;
  }

  if (cleanedRelativePath === "observer/observer-data.json") {
    const observerData = await readObserverData(runRoot, runtimeStreamUrls);
    if (!observerData) {
      writeResponse(response, 404, "Observer data not found", "text/plain; charset=utf-8");
      return;
    }
    writeResponse(response, 200, JSON.stringify(observerData, null, 2), "application/json; charset=utf-8");
    return;
  }

  try {
    const body = await readContainedFile(runRoot, filePath);
    if (!body) {
      writeResponse(response, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
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
  runRoot: PinnedDirectory,
  runtimeStreamUrls: ObserverRuntimeStreamUrl[] = []
): Promise<ObserverData | null> {
  // Best-effort load from either source. Both reads swallow all errors on
  // purpose: this runs on every browser poll of a live run, where run.json may
  // be absent, still being written (a partial-JSON parse error), or superseded
  // by observer-data.json. A transient failure just falls through to the next
  // source, or to null -> a 404 the poller retries; it must not surface a 500.
  try {
    const bundleBytes = await readContainedFile(runRoot, path.join(runRoot.physicalPath, "run.json"));
    if (!bundleBytes) throw new Error("run.json unavailable");
    const bundle = JSON.parse(bundleBytes.toString("utf8")) as Parameters<typeof buildObserverData>[0];
    return withRuntimeStreamUrls(buildObserverData(bundle), runtimeStreamUrls);
  } catch {}

  try {
    const observerBytes = await readContainedFile(
      runRoot,
      path.join(runRoot.physicalPath, "observer", "observer-data.json")
    );
    if (!observerBytes) throw new Error("observer-data.json unavailable");
    return withRuntimeStreamUrls(
      JSON.parse(observerBytes.toString("utf8")) as ObserverData,
      runtimeStreamUrls
    );
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

async function buildHistoryIndex(proofRoot: PinnedDirectory): Promise<{
  latestRunId: string | null;
  runs: Array<{ runId: string; createdAt: string | null; mode: string | null; href: string; status: string; streamCount: number }>;
}> {
  await assertPinnedDirectory(proofRoot);
  const physicalCwd = path.dirname(path.dirname(proofRoot.physicalPath));
  const listed = await listRuns(physicalCwd);
  const runs = await Promise.all(
    listed.runs.slice(0, 80).map(async (run) => {
      const root = await pinDirectChildDirectory(proofRoot, run.runId);
      const data = root ? await readObserverData(root) : null;
      return {
        runId: run.runId,
        createdAt: run.createdAt,
        mode: run.mode,
        href: `/_humanish/runs/${encodeURIComponent(run.runId)}/observer/index.html`,
        status: data?.run.status ?? "unknown",
        streamCount: data?.streams.length ?? 0
      };
    })
  );

  await assertPinnedDirectory(proofRoot);
  return {
    latestRunId: listed.latest && isSafeRunIdSegment(listed.latest) ? listed.latest : null,
    runs
  };
}

function matchRunRoute(pathname: string): { runId: string; relativePath: string } | null {
  const match = pathname.match(/^\/_humanish\/runs\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  try {
    const runId = decodeURIComponent(match[1] ?? "");
    if (!isSafeRunIdSegment(runId)) return null;
    return {
      runId,
      relativePath: decodeURIComponent(match[2] || "observer/index.html")
    };
  } catch {
    return null;
  }
}

async function readContainedFile(root: PinnedDirectory, filePathInput: string): Promise<Buffer | null> {
  const filePath = path.resolve(filePathInput);
  if (!isPathInside(root.physicalPath, filePath)) {
    return null;
  }

  try {
    await assertPinnedDirectory(root);
    const expectedStats = await inspectContainedRegularFile(root, filePath);
    if (!expectedStats) {
      return null;
    }

    const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const openedStats = await handle.stat({ bigint: true });
      if (
        !openedStats.isFile()
        || openedStats.nlink !== 1n
        || openedStats.dev !== expectedStats.dev
        || openedStats.ino !== expectedStats.ino
      ) {
        return null;
      }
      const recheckedStats = await inspectContainedRegularFile(root, filePath);
      if (
        !recheckedStats
        || recheckedStats.dev !== expectedStats.dev
        || recheckedStats.ino !== expectedStats.ino
      ) {
        return null;
      }
      await assertPinnedDirectory(root);
      const body = await handle.readFile();
      await assertPinnedDirectory(root);
      return body;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function inspectContainedRegularFile(
  root: PinnedDirectory,
  filePath: string
): Promise<PinnedFileIdentity | null> {
  const relative = path.relative(root.physicalPath, filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }

  const segments = relative.split(path.sep).filter(Boolean);
  let current = root.physicalPath;
  let fileIdentity: PinnedFileIdentity | null = null;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stats = await lstat(current, { bigint: true });
    if (stats.isSymbolicLink()) return null;
    if (index < segments.length - 1) {
      if (!stats.isDirectory()) return null;
    } else {
      if (!stats.isFile() || stats.nlink !== 1n) return null;
      fileIdentity = { dev: stats.dev, ino: stats.ino };
    }
  }

  if (await realpath(filePath) !== filePath) return null;
  return fileIdentity;
}

async function pinDirectory(directoryInput: string): Promise<PinnedDirectory> {
  const physicalPath = await realpath(path.resolve(directoryInput));
  const stats = await lstat(physicalPath, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Observer roots must be physical directories.");
  }
  return Object.freeze({ dev: stats.dev, ino: stats.ino, physicalPath });
}

async function pinDirectChildDirectory(root: PinnedDirectory, name: string): Promise<PinnedDirectory | null> {
  if (!isSafeRunIdSegment(name)) return null;
  try {
    await assertPinnedDirectory(root);
    const candidate = path.join(root.physicalPath, name);
    const pinned = await pinDirectory(candidate);
    if (pinned.physicalPath !== candidate || path.dirname(pinned.physicalPath) !== root.physicalPath) {
      return null;
    }
    await assertPinnedDirectory(root);
    return pinned;
  } catch {
    return null;
  }
}

async function assertPinnedDirectory(root: PinnedDirectory): Promise<void> {
  const stats = await lstat(root.physicalPath, { bigint: true });
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.dev !== root.dev
    || stats.ino !== root.ino
    || await realpath(root.physicalPath) !== root.physicalPath
  ) {
    throw new Error("Observer root identity changed.");
  }
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

export function openTarget(target: string): { opened: boolean; command?: string; warning?: string } {
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
