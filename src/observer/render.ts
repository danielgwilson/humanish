import { spawn } from "node:child_process";
import { runNotFoundMessage } from "../run/run-not-found.js";
import { readAnalysisAccounting } from "../run/costs.js";
import { analysisCostOf } from "../run/run-cost.js";
import { accessSync, constants } from "node:fs";
import { realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { projectShareCheckedAnalysis } from "../analysis/sharing.js";
import { loadAnalysis } from "../analysis/load.js";
import {
  physicalCwdOf,
  runIdOf,
  bindExistingRunArtifactPaths,
  isSafeRunIdSegment,
  resolveLatestRunDirectory,
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths,
} from "../run/paths.js";
import { writeContainedOutputFile } from "../run/contained-output.js";
import { loadRunBundlePrepared, readRunJsonIfExists } from "../run/locate.js";
import { RUN_STATUS_FILE } from "../run/status.js";
import { verifyRunPrepared } from "../verify/verify.js";
import { renderObserverHtml } from "./artifact.js";
import { buildObserverData } from "./data.js";
import { buildServeSecurityHeaders, hostAllowed, parsePublicOrigin } from "./http.js";
import { listenOnLoopback } from "./listen.js";
import {
  pinDirectChildDirectory,
  pinDirectory,
  readContainedFile,
  type PinnedDirectory,
} from "./pinned-files.js";
import {
  buildHistoryIndex,
  matchRunRoute,
  serveRunPath,
  writeResponse,
  type ObserverRuntimeStreamUrl,
} from "./run-routes.js";
import { cli } from "../cli/invocation.js";

const OBSERVER_SCHEMA = "humanish.observer-result.v1";

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
  /** Internal producer pin: refreshing a finished run must not bind a replacement. */
  expectedRun?: PreparedRunArtifactPaths;
}

export interface ObserverServeOptions {
  open?: boolean;
  port?: number;
  /** Restrict history and evidence routes to the selected run. Exposed viewers always do this. */
  scope?: "run" | "library";
  // Exposed mode: when true, the live server enforces the same DNS-rebinding defense as the
  // run-library surface: a strict Host allowlist (loopback names seeded at bind, extended by
  // addPublicOrigin, 421 otherwise) plus the shared security headers on every response. Loopback
  // default (false) keeps local Host handling permissive. Frame-denial headers always apply.
  exposed?: boolean;
}

export interface ObserverServer {
  url: string;
  port: number;
  opened: boolean;
  openCommand?: string;
  warning?: string;
  // Declare an additional public origin (the tunnel URL or an operator --public-url). Extends the
  // Host allowlist so an authenticated edge forwarding under that Host is admitted; a no-op when the
  // server is not exposed. Never changes the loopback bind.
  addPublicOrigin(origin: string): void;
  close(): Promise<void>;
}

const observerRuntimeStreamUrls = new WeakMap<ObserverResult, ObserverRuntimeStreamUrl[]>();

const observerPreparedRunPaths = new WeakMap<ObserverResult, PreparedRunArtifactPaths>();

export function attachObserverRuntimeStreamUrls(
  result: ObserverResult,
  streams: ObserverRuntimeStreamUrl[],
): void {
  observerRuntimeStreamUrls.set(
    result,
    streams.filter((stream) => stream.streamId && stream.url),
  );
}

async function runNotFound(cwd: string, runInput: string): Promise<ObserverResult> {
  const message = await runNotFoundMessage(cwd, runInput);
  return observerRunError(cwd, runInput, "HUMANISH_RUN_NOT_FOUND", message);
}

export async function renderObserver(
  cwdInput: string,
  runInput: string,
  options: ObserverOptions = {},
): Promise<ObserverResult> {
  const cwd = path.resolve(cwdInput);
  let selection: ObserverRunSelection | null;
  try {
    if (options.expectedRun) {
      const prepared = options.expectedRun;
      if (runInput !== runIdOf(prepared) || (await realpath(cwd)) !== physicalCwdOf(prepared)) {
        throw new Error("Observer source pin does not match the selected run.");
      }
      await validatePreparedRunArtifactPaths(prepared);
      selection = {
        runId: runInput,
        runRoot: { ...prepared.runRootIdentity, physicalPath: prepared.physicalRunRoot },
        runsRoot: { ...prepared.runsRootIdentity, physicalPath: prepared.physicalRunsRoot },
      };
    } else {
      selection = await resolveObserverRunSelection(cwd, runInput);
    }
  } catch {
    selection = null;
  }

  if (!selection) {
    return runNotFound(cwd, runInput);
  }

  let preparedRunPaths;
  try {
    const selectedPhysicalCwd = path.dirname(path.dirname(selection.runsRoot.physicalPath));
    preparedRunPaths =
      options.expectedRun ??
      (await bindExistingRunArtifactPaths(selectedPhysicalCwd, selection.runId));
    if (
      preparedRunPaths.physicalRunsRoot !== selection.runsRoot.physicalPath ||
      preparedRunPaths.physicalRunRoot !== selection.runRoot.physicalPath ||
      preparedRunPaths.runsRootIdentity.birthtimeNs !== selection.runsRoot.birthtimeNs ||
      preparedRunPaths.runsRootIdentity.dev !== selection.runsRoot.dev ||
      preparedRunPaths.runsRootIdentity.ino !== selection.runsRoot.ino ||
      preparedRunPaths.runRootIdentity.birthtimeNs !== selection.runRoot.birthtimeNs ||
      preparedRunPaths.runRootIdentity.dev !== selection.runRoot.dev ||
      preparedRunPaths.runRootIdentity.ino !== selection.runRoot.ino
    ) {
      throw new Error("Observer run selection changed physical identity.");
    }
  } catch {
    return observerRunError(
      cwd,
      runInput,
      "HUMANISH_INVALID_RUN_BUNDLE",
      "Observer run storage is unavailable or unsafe.",
    );
  }

  await validatePreparedRunArtifactPaths(preparedRunPaths);
  const selectedPhysicalCwd = path.dirname(path.dirname(selection.runsRoot.physicalPath));
  const verified = await verifyRunPrepared(selectedPhysicalCwd, selection.runId, preparedRunPaths);
  await validatePreparedRunArtifactPaths(preparedRunPaths);

  if (!verified.ok && verified.recordingOk !== true) {
    return observerRunError(
      cwd,
      runInput,
      verified.error?.code === "HUMANISH_RUN_NOT_FOUND"
        ? "HUMANISH_RUN_NOT_FOUND"
        : "HUMANISH_INVALID_RUN_BUNDLE",
      verified.error?.message ?? "Run bundle failed verification.",
    );
  }

  const loaded = await loadRunBundlePrepared(selectedPhysicalCwd, preparedRunPaths);
  await validatePreparedRunArtifactPaths(preparedRunPaths);
  if (!loaded) {
    return runNotFound(cwd, runInput);
  }

  if (
    loaded.bundle.runId !== selection.runId ||
    (await realpath(loaded.runDir)) !== preparedRunPaths.physicalRunRoot
  ) {
    throw new Error("Observer output directory does not match the selected run.");
  }

  const observerPath = path.join(preparedRunPaths.physicalRunRoot, "observer", "index.html");
  const spend = analysisCostOf(await readAnalysisAccounting(preparedRunPaths));
  const analysis = {
    ...projectShareCheckedAnalysis(await loadAnalysis(preparedRunPaths)),
    ...(spend === null ? {} : { spend }),
  };
  // A run.json without an outcome is in progress, interrupted, or older than the field: its
  // status.json says which, and holds an older run's ok.
  const statusRecord =
    loaded.bundle.outcome === undefined
      ? await readRunJsonIfExists(preparedRunPaths, RUN_STATUS_FILE)
      : undefined;
  const observerData = buildObserverData(loaded.bundle, undefined, statusRecord);
  observerData.publicSafety.share = {
    status: verified.shareSafety.status,
    verifiedAt: new Date().toISOString(),
    reasons: verified.shareSafety.reasons.map((reason) => reason.code),
  };

  await writeContainedOutputFile(
    preparedRunPaths,
    path.join("observer", "observer-data.json"),
    `${JSON.stringify(observerData, null, 2)}\n`,
    "utf8",
  );
  await writeContainedOutputFile(
    preparedRunPaths,
    path.join("observer", "study-analysis.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
    "utf8",
  );
  await writeContainedOutputFile(
    preparedRunPaths,
    path.join("observer", "index.html"),
    renderObserverHtml(observerData, { analysis }),
    "utf8",
  );
  await validatePreparedRunArtifactPaths(preparedRunPaths);

  const relativeObserverPath = path.join(
    preparedRunPaths.relativeRunRoot,
    "observer",
    "index.html",
  );
  const relativeObserverDataPath = path.join(
    preparedRunPaths.relativeRunRoot,
    "observer",
    "observer-data.json",
  );
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
        : "This is a dry run: its participants are synthetic and no product behavior was tested.",
      `Before filing public feedback, use \`${cli("feedback issue")}\` so redaction and public-safety checks gate the payload.`,
      ...(openResult.warning ? [openResult.warning] : []),
    ],
  };
  observerPreparedRunPaths.set(result, preparedRunPaths);
  return result;
}

function observerRunError(
  cwd: string,
  run: string,
  code: NonNullable<ObserverResult["error"]>["code"],
  message: string,
): ObserverResult {
  return {
    schema: OBSERVER_SCHEMA,
    ok: false,
    cwd,
    run,
    warnings: [],
    error: { code, message },
  };
}

interface ObserverRunSelection {
  readonly runId: string;
  readonly runRoot: PinnedDirectory;
  readonly runsRoot: PinnedDirectory;
}

async function resolveObserverRunSelection(
  cwd: string,
  runInput: string,
): Promise<ObserverRunSelection | null> {
  const runsRoot = await pinDirectory(path.join(cwd, ".humanish", "runs"));
  if (runInput !== "latest") {
    const runRoot = isSafeRunIdSegment(runInput)
      ? await pinDirectChildDirectory(runsRoot, runInput)
      : null;
    return runRoot ? { runId: runInput, runRoot, runsRoot } : null;
  }

  const latestBytes = await readContainedFile(
    runsRoot,
    path.join(runsRoot.physicalPath, "latest.json"),
  );
  if (!latestBytes) return null;
  const pointer = JSON.parse(latestBytes.toString("utf8")) as { path?: unknown; runId?: unknown };
  if (
    typeof pointer.runId !== "string" ||
    typeof pointer.path !== "string" ||
    !isSafeRunIdSegment(pointer.runId)
  ) {
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
  options: ObserverServeOptions = {},
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
  const expectedRelativeObserverPath = path.join(
    preparedRunPaths.relativeRunRoot,
    "observer",
    "index.html",
  );
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
  const exposed = options.exposed === true;
  const scopedToRun = exposed || options.scope === "run";
  // Host allowlist for exposed mode (DNS-rebinding defense, identical to the run-library surface).
  // Seeded with the loopback names after bind; addPublicOrigin extends it with the tunnel/public-url
  // host. Never consulted in loopback (non-exposed) mode.
  const hostAllowlist = new Set<string>();
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      // Every response, including run HTML artifacts, must refuse framing. A provider iframe
      // with its own origin intact must not navigate back here and gain the Observer's origin.
      for (const [name, value] of Object.entries(buildServeSecurityHeaders())) {
        response.setHeader(name, value);
      }
      if (exposed) {
        if (!hostAllowed(request.headers.host, hostAllowlist)) {
          writeResponse(response, 421, "Misdirected Request", "text/plain; charset=utf-8");
          return;
        }
      }

      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

      if (url.pathname === "/") {
        response.writeHead(302, { location: "/observer/index.html" });
        response.end();
        return;
      }

      if (url.pathname === "/_humanish/history.json") {
        const history = await buildHistoryIndex(proofRoot);
        // Exposed watch and selected-run viewers cannot enumerate other runs. Full-library
        // loopback viewers retain the complete project index.
        if (scopedToRun) {
          const attachedRuns = history.runs.filter((entry) => entry.runId === result.run);
          writeResponse(
            response,
            200,
            JSON.stringify(
              { latestRunId: attachedRuns.length > 0 ? result.run : null, runs: attachedRuns },
              null,
              2,
            ),
            "application/json; charset=utf-8",
          );
          return;
        }
        writeResponse(
          response,
          200,
          JSON.stringify(history, null, 2),
          "application/json; charset=utf-8",
        );
        return;
      }

      if (url.pathname.startsWith("/_humanish/runs/")) {
        const runRoute = matchRunRoute(url.pathname);
        if (!runRoute) {
          writeResponse(response, 404, "Run not found", "text/plain; charset=utf-8");
          return;
        }
        // Scoped viewers cannot distinguish another run from a nonexistent one.
        if (scopedToRun && runRoute.runId !== result.run) {
          writeResponse(response, 404, "Run not found", "text/plain; charset=utf-8");
          return;
        }
        const targetRoot = await pinDirectChildDirectory(proofRoot, runRoute.runId);
        if (!targetRoot) {
          writeResponse(response, 404, "Run not found", "text/plain; charset=utf-8");
          return;
        }
        await serveRunPath(
          targetRoot,
          runRoute.relativePath || "observer/index.html",
          response,
          runRoute.runId === result.run ? runtimeStreamUrls() : [],
          request,
        );
        return;
      }

      await serveRunPath(
        runRoot,
        decodeURIComponent(url.pathname.slice(1)),
        response,
        runtimeStreamUrls(),
        request,
      );
    } catch {
      writeResponse(response, 500, "Observer request failed", "text/plain; charset=utf-8");
    }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  const port = await listenOnLoopback(server, options.port ?? 0);
  if (exposed) {
    hostAllowlist.add(`127.0.0.1:${port}`);
    hostAllowlist.add(`localhost:${port}`);
    hostAllowlist.add(`[::1]:${port}`);
  }
  const url = `http://127.0.0.1:${port}/observer/index.html`;
  const openResult = options.open === true ? openTarget(url) : { opened: false };

  return {
    url,
    port,
    opened: openResult.opened,
    ...(openResult.command ? { openCommand: openResult.command } : {}),
    ...(openResult.warning ? { warning: openResult.warning } : {}),
    // A tunnel's public origin is only known after it starts (post bind). Declaring it here extends
    // the Host allowlist so the authenticated edge is admitted; a no-op in loopback mode (the
    // allowlist is never consulted) and for an unparseable origin.
    addPublicOrigin(origin: string): void {
      if (!exposed) {
        return;
      }
      const parsed = parsePublicOrigin(origin);
      if (parsed) {
        hostAllowlist.add(parsed.host);
      }
    },
    close: () => closeServer(server),
  };
}

// ---- The Observer: a prebuilt self-contained single-file app (observer/ workspace) ----
// carrying one JSON slot; rendering a run = injecting its snapshot (observer/scripts/inject.ts
// is the reference implementation this mirrors). The seam lives here because every surface
// (observe, watch and the run call sites) funnels through renderObserverHtml. The
// legacy string-concat renderer was deleted at cutover (2026-08-16); rollback is a version pin.

/** The host facts that decide whether a desktop browser can open a target. */
export interface DesktopOpenerHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Whether an executable with this name is on the host's `PATH`. */
  onPath(name: string): boolean;
}

/**
 * The command that opens a target in the desktop browser, or why this host has none. Linux needs
 * a display and xdg-open; without them the opener would exit quietly and nothing would appear.
 */
export function desktopOpener(
  target: string,
  host: DesktopOpenerHost,
): { command: string; args: string[] } | { reason: string } {
  if (host.platform === "darwin") return { command: "open", args: [target] };
  if (host.platform === "win32") return { command: "cmd", args: ["/c", "start", "", target] };
  if (!host.env.DISPLAY && !host.env.WAYLAND_DISPLAY)
    return { reason: "no display is available (`DISPLAY` and `WAYLAND_DISPLAY` are unset)" };
  if (!host.onPath("xdg-open")) return { reason: "xdg-open is not installed" };
  return { command: "xdg-open", args: [target] };
}

function onProcessPath(name: string): boolean {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => {
      try {
        accessSync(path.join(directory, name), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

export function openTarget(
  target: string,
  host: DesktopOpenerHost = { platform: process.platform, env: process.env, onPath: onProcessPath },
): {
  opened: boolean;
  command?: string;
  warning?: string;
} {
  const opener = desktopOpener(target, host);
  if ("reason" in opener)
    return {
      opened: false,
      warning: `Could not open observer automatically: ${opener.reason}. Open ${target} in a browser.`,
    };
  const { command, args } = opener;
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    // An opener that disappears after the `PATH` check still fails asynchronously (ENOENT). The
    // served URL remains usable; an opener must never crash its server.
    child.on("error", () => {});
    child.unref();
    return { opened: true, command: [command, ...args].join(" ") };
  } catch (error) {
    return {
      opened: false,
      command: [command, ...args].join(" "),
      warning: `Could not open observer automatically: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
