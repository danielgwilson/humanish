// HTTP handlers for one run's Observer: the page, its data with live status and runtime stream
// URLs, its analysis, and its media with byte ranges. serveObserver (render.ts) and the library
// server (serve.ts) both route requests through them.

import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { isAnalysisRecordPath, projectShareCheckedAnalysis } from "../analysis/sharing.js";
import { loadAnalysis } from "../analysis/load.js";
import type { LoadedAnalysis } from "../analysis/types.js";
import { listRuns } from "../run/stored-runs.js";
import { bindExistingRunArtifactPaths, isPathInside, isSafeRunIdSegment } from "../run/paths.js";
import { RUN_STATUS_FILE, RUN_STATUS_STALE_MS, isRunStatusRecord } from "../run/status.js";
import { renderObserverHtml } from "./artifact.js";
import {
  buildObserverData,
  recordedStreamEmbed,
  withObserverEndings,
  type ObserverData,
} from "./data.js";
import { buildArtifactSecurityHeaders } from "./http.js";
import {
  assertPinnedDirectory,
  openContainedFile,
  pinDirectChildDirectory,
  readContainedFile,
  relativeToRoot,
  sha256OfOpenedFile,
  type PinnedDirectory,
} from "./pinned-files.js";

export interface ObserverRuntimeStreamUrl {
  streamId: string;
  url: string;
  /** Set when the participant's sandbox is gone (finished or torn down). An ended stream's live URL is a
   *  dead noVNC page — the overlay stops injecting it so the tile falls back to the recorded
   *  evidence (keyframe replay/screenshot) instead of rendering "sandbox not found" (#357). */
  ended?: boolean;
}

/** Analysis cannot grant filesystem authority or make an otherwise readable recording disappear. */
async function readObserverAnalysis(runRoot: PinnedDirectory): Promise<LoadedAnalysis> {
  try {
    const runId = path.basename(runRoot.physicalPath);
    const cwd = path.dirname(path.dirname(path.dirname(runRoot.physicalPath)));
    const prepared = await bindExistingRunArtifactPaths(cwd, runId);
    if (
      prepared.physicalRunRoot !== runRoot.physicalPath ||
      prepared.runRootIdentity.birthtimeNs !== runRoot.birthtimeNs ||
      prepared.runRootIdentity.dev !== runRoot.dev ||
      prepared.runRootIdentity.ino !== runRoot.ino
    ) {
      throw new Error("ANALYSIS_STORAGE_CHANGED");
    }
    return projectShareCheckedAnalysis(await loadAnalysis(prepared));
  } catch {
    return {
      state: "invalid",
      analysis: null,
      corrections: [],
      warnings: ["Analysis could not be validated against this recording."],
    };
  }
}

/** internal: consumed by src/observer/serve.ts */
export async function serveRunPath(
  runRoot: PinnedDirectory,
  relativePath: string,
  response: ServerResponse,
  runtimeStreamUrls: ObserverRuntimeStreamUrl[] = [],
  request?: Pick<IncomingMessage, "method" | "headers">,
): Promise<void> {
  const root = runRoot.physicalPath;
  const filePath = path.resolve(root, relativePath === "" ? "observer/index.html" : relativePath);

  if (!isPathInside(root, filePath)) {
    writeResponse(response, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  // Alias spellings such as observer//observer-data.json must use the same projection,
  // not fall through to a raw persisted file and inherit a forged runtime grant.
  const cleanedRelativePath = path.relative(root, filePath).split(path.sep).join("/");
  // Derived records have a validated projection endpoint below. Never let generic
  // file serving bypass its current-content checks or a warmed source-only admission cache.
  const derivedRoot = cleanedRelativePath.split("/")[0];
  const derivedLeaf = path.posix.basename(cleanedRelativePath);
  if (
    derivedRoot === ".analysis-lock" ||
    derivedLeaf.startsWith(".humanish-write-") ||
    isAnalysisRecordPath(cleanedRelativePath)
  ) {
    writeResponse(response, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  if (cleanedRelativePath === "observer/index.html") {
    const observerData = await readObserverData(runRoot, runtimeStreamUrls);
    if (!observerData) {
      writeResponse(response, 404, "Observer data not found", "text/plain; charset=utf-8");
      return;
    }
    const analysis = await readObserverAnalysis(runRoot);
    writeResponse(
      response,
      200,
      renderObserverHtml(observerData, { analysis }),
      "text/html; charset=utf-8",
    );
    return;
  }

  if (cleanedRelativePath === "observer/observer-data.json") {
    const observerData = await readObserverData(runRoot, runtimeStreamUrls);
    if (!observerData) {
      writeResponse(response, 404, "Observer data not found", "text/plain; charset=utf-8");
      return;
    }
    writeResponse(
      response,
      200,
      JSON.stringify(observerData, null, 2),
      "application/json; charset=utf-8",
    );
    return;
  }

  if (cleanedRelativePath === "observer/study-analysis.json") {
    writeResponse(
      response,
      200,
      JSON.stringify(await readObserverAnalysis(runRoot)),
      "application/json; charset=utf-8",
    );
    return;
  }

  if (path.extname(filePath).toLowerCase() === ".mp4") {
    await serveContainedMedia(runRoot, filePath, response, request);
    return;
  }

  try {
    const body = await readContainedFile(runRoot, filePath);
    if (!body) {
      writeResponse(response, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    response.writeHead(200, {
      ...buildArtifactSecurityHeaders(),
      "content-type": contentTypeForPath(filePath),
    });
    response.end(body);
  } catch {
    writeResponse(response, 404, "Not found", "text/plain; charset=utf-8");
  }
}

async function readObserverData(
  runRoot: PinnedDirectory,
  runtimeStreamUrls: ObserverRuntimeStreamUrl[] = [],
): Promise<ObserverData | null> {
  // Best-effort load from either source. Both reads swallow all errors on
  // purpose: this runs on every browser poll of a live run, where run.json may
  // be absent, still being written (a partial-JSON parse error), or superseded
  // by observer-data.json. A transient failure just falls through to the next
  // source, or to null -> a 404 the poller retries; it must not surface a 500.
  try {
    const bundleBytes = await readContainedFile(
      runRoot,
      path.join(runRoot.physicalPath, "run.json"),
    );
    if (!bundleBytes) throw new Error("run.json unavailable");
    const bundle = JSON.parse(bundleBytes.toString("utf8")) as Parameters<
      typeof buildObserverData
    >[0];
    return withRuntimeStreamUrls(
      await withLocalRunStatus(runRoot, buildObserverData(bundle)),
      runtimeStreamUrls,
    );
  } catch {}

  try {
    const observerBytes = await readContainedFile(
      runRoot,
      path.join(runRoot.physicalPath, "observer", "observer-data.json"),
    );
    if (!observerBytes) throw new Error("observer-data.json unavailable");
    return withRuntimeStreamUrls(
      await withLocalRunStatus(
        runRoot,
        withObserverEndings(JSON.parse(observerBytes.toString("utf8")) as ObserverData),
      ),
      runtimeStreamUrls,
    );
  } catch {}

  return null;
}

/**
 * Liveness is a current read of a contained local status record, separate from run evidence.
 * A stale heartbeat means unknown: neither an old timestamp nor a persisted PID proves that a
 * process died (the evidence may have been copied from another machine). No PID is served/probed.
 */
async function withLocalRunStatus(
  runRoot: PinnedDirectory,
  input: ObserverData,
): Promise<ObserverData> {
  // A served observation must never be inherited from a persisted projection or export.
  const { runtime: _persistedRuntime, ...data } = input;
  try {
    const bytes = await readContainedFile(
      runRoot,
      path.join(runRoot.physicalPath, RUN_STATUS_FILE),
    );
    if (!bytes) return data;
    const record: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !isRunStatusRecord(record) ||
      record.runId !== data.run.runId ||
      record.mode !== data.run.mode ||
      record.runId !== path.basename(runRoot.physicalPath)
    )
      return data;
    const now = Date.now();
    const started = Date.parse(record.startedAt);
    const updated = Date.parse(record.updatedAt);
    const timestampsValid =
      Number.isFinite(started) && Number.isFinite(updated) && started <= updated && updated <= now;
    let state: NonNullable<ObserverData["runtime"]>["state"] = "unknown";
    if (timestampsValid) {
      if (record.state === "finished") {
        state = "finished";
      } else if (record.state === "running" && now - updated <= RUN_STATUS_STALE_MS) {
        state = "running";
      }
    }
    return {
      ...data,
      runtime: { state, observedAt: new Date(now).toISOString(), source: "local-run-status" },
    };
  } catch {
    return data;
  }
}

/** internal: exported for the #357 lifecycle tests. */
export function withRuntimeStreamUrls(
  data: ObserverData,
  runtimeStreamUrls: ObserverRuntimeStreamUrl[],
): ObserverData {
  const byStream = new Map(runtimeStreamUrls.map((stream) => [stream.streamId, stream]));
  return {
    ...data,
    streams: data.streams.map((input) => {
      // JSON projections are untrusted, including fallback observer-data.json. A marker saved in
      // a bundle is never authority; only this process's attached runtime map grants it again.
      const stream =
        input.embed === undefined ? input : { ...input, embed: recordedStreamEmbed(input.embed) };
      const runtime = byStream.get(stream.id);
      if (!runtime) return stream;
      if (runtime.ended) return { ...stream, liveEnded: true };
      const url = runtimeDesktopUrl(runtime.url);
      if (!url) return stream;
      return {
        ...stream,
        ...(stream.liveEnded === true ? { liveEnded: false } : {}),
        embed: {
          ...(stream.embed ?? { title: stream.label }),
          kind: "iframe",
          url,
          runtimeDesktop: true,
        },
        transport: "sse",
        url,
      };
    }),
  };
}

function runtimeDesktopUrl(value: string): string | null {
  if (!value || value.length > 16_384 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** internal: consumed by src/observer/serve.ts */
export async function buildHistoryIndex(
  proofRoot: PinnedDirectory,
  // When set, a run is listed only if this returns a root, and its summary is read through it.
  admitRun?: (runId: string, pinned: PinnedDirectory) => Promise<PinnedDirectory | null>,
): Promise<{
  latestRunId: string | null;
  runs: Array<{
    runId: string;
    createdAt: string | null;
    mode: string | null;
    href: string;
    status: string;
    runtimeState?: NonNullable<ObserverData["runtime"]>["state"];
    streamCount: number;
    estimatedCostUsd: number | null;
    costRatesAsOf: string | null;
    costPlaceholder: boolean;
  }>;
}> {
  await assertPinnedDirectory(proofRoot);
  const physicalCwd = path.dirname(path.dirname(proofRoot.physicalPath));
  const listed = await listRuns(physicalCwd);
  const runs = await Promise.all(
    listed.runs.slice(0, 80).map(async (run) => {
      const pinned = await pinDirectChildDirectory(proofRoot, run.runId);
      const root = pinned && admitRun ? await admitRun(run.runId, pinned) : pinned;
      if (admitRun && !root) return null;
      const data = root ? await readObserverData(root) : null;
      // listRuns read run.json before admission, so an admitted run's fields come from its
      // guarded read instead.
      return {
        runId: run.runId,
        createdAt: admitRun ? (data?.run.createdAt ?? null) : run.createdAt,
        mode: admitRun ? (data?.run.mode ?? null) : run.mode,
        href: `/_humanish/runs/${encodeURIComponent(run.runId)}/observer/index.html`,
        status: data?.run.status ?? "unknown",
        ...(data?.runtime ? { runtimeState: data.runtime.state } : {}),
        streamCount: data?.streams.length ?? 0,
        // Labeled run-total cost estimate (advisory; null when the run carries no cost summary).
        estimatedCostUsd: data?.cost?.estimatedTotalUsd ?? null,
        costRatesAsOf: data?.cost?.ratesAsOf ?? null,
        costPlaceholder: data?.cost?.placeholder ?? false,
      };
    }),
  );

  await assertPinnedDirectory(proofRoot);
  return {
    latestRunId: listed.latest && isSafeRunIdSegment(listed.latest) ? listed.latest : null,
    runs: runs.filter((run) => run !== null),
  };
}

/** internal: consumed by src/observer/serve.ts */
export function matchRunRoute(pathname: string): { runId: string; relativePath: string } | null {
  const match = pathname.match(/^\/_humanish\/runs\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  try {
    const runId = decodeURIComponent(match[1] ?? "");
    if (!isSafeRunIdSegment(runId)) return null;
    return {
      runId,
      relativePath: decodeURIComponent(match[2] || "observer/index.html"),
    };
  } catch {
    return null;
  }
}

function byteRange(
  value: string | string[] | undefined,
  size: number,
): { start: number; end: number } | "invalid" | null {
  if (value === undefined) return null;
  if (Array.isArray(value) || value.includes(",")) return "invalid";
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return "invalid";
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  )
    return "invalid";
  return { start, end: Math.min(requestedEnd, size - 1) };
}

async function serveContainedMedia(
  root: PinnedDirectory,
  filePath: string,
  response: ServerResponse,
  request?: Pick<IncomingMessage, "method" | "headers">,
): Promise<void> {
  const opened = await openContainedFile(root, filePath);
  if (!opened) {
    writeResponse(response, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  // Checked once, at open: bytes stored into the file while it streams are not re-hashed.
  if (
    root.admitsContent !== undefined &&
    !root.admitsContent(relativeToRoot(root, filePath), await sha256OfOpenedFile(opened.handle))
  ) {
    await opened.handle.close();
    writeResponse(response, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  const range = byteRange(request?.headers.range, opened.size);
  if (range === "invalid") {
    await opened.handle.close();
    response.writeHead(416, {
      ...buildArtifactSecurityHeaders(),
      "accept-ranges": "bytes",
      "content-range": `bytes */${opened.size}`,
      "content-length": "0",
    });
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, opened.size - 1);
  const status = range ? 206 : 200;
  response.writeHead(status, {
    ...buildArtifactSecurityHeaders(),
    "accept-ranges": "bytes",
    "content-type": "video/mp4",
    "content-length": String(opened.size === 0 ? 0 : end - start + 1),
    ...(range ? { "content-range": `bytes ${start}-${end}/${opened.size}` } : {}),
  });
  if (request?.method === "HEAD" || opened.size === 0) {
    await opened.handle.close();
    response.end();
    return;
  }
  let stream: ReturnType<FileHandle["createReadStream"]> | undefined;
  try {
    stream = opened.handle.createReadStream({ start, end, autoClose: false });
    await new Promise<void>((resolve, reject) => {
      stream!.once("error", reject);
      response.once("finish", resolve);
      response.once("close", resolve);
      stream!.pipe(response);
    });
  } catch {
    // Headers already describe a fixed byte interval. A late disk/read failure
    // cannot become a second HTTP response; terminate the incomplete body.
    response.destroy();
  } finally {
    stream?.destroy();
    await opened.handle.close().catch(() => undefined);
  }
}

export function writeResponse(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType,
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
