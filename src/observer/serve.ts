import { listenOnLoopback, PortInUseError } from "./listen.js";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";

import { pinDirectChildDirectory, pinDirectory } from "./pinned-files.js";
import { buildHistoryIndex, matchRunRoute, serveRunPath } from "./run-routes.js";
import type { PinnedDirectory } from "./pinned-files.js";
import {
  hashRunInventory,
  inventoryRoot,
  readRunInventory,
  type AdmittedRun,
  type RunInventory,
} from "./run-inventory.js";
import { renderLibraryHtml } from "./library.js";
import type { LibraryHistory } from "./library.js";
import {
  buildServeSecurityHeaders,
  hostAllowed,
  parsePublicOrigin,
  type ServeMode,
} from "./http.js";
import type { ExposureErrorCode } from "./exposure.js";
import { isSafeRunIdSegment } from "../run/paths.js";
import { listRuns } from "../run/stored-runs.js";
import { verifyRun } from "../verify/verify.js";

export const SERVE_SCHEMA = "humanish.serve-result.v1";

export type ServeErrorCode =
  | "HUMANISH_INVALID_PORT"
  | "HUMANISH_SERVE_PORT_IN_USE"
  | "HUMANISH_SERVE_TUNNEL_NOT_FOUND"
  | "HUMANISH_SERVE_TUNNEL_START_FAILED"
  | "HUMANISH_RUN_NOT_FOUND"
  | "HUMANISH_SERVE_RUN_NOT_SHAREABLE"
  | ExposureErrorCode;

export interface ServeResult {
  schema: typeof SERVE_SCHEMA;
  ok: boolean;
  cwd: string;
  mode: ServeMode;
  safe: boolean;
  host: "127.0.0.1";
  port?: number;
  url?: string;
  publicUrl?: string;
  tunnel?: { provider: "ngrok"; url: string };
  // Edge OAuth echo (no secrets): the operator-supplied allow rules, echoed to the operator's own
  // stdout only. Never persisted into any run bundle; scrubbed through the redaction path to be safe.
  oauth?: { provider: "google"; allowEmails: string[]; allowDomains: string[] };
  runsListed: number;
  shareReadyCount?: number;
  /** With --safe: the runs left out, grouped by grade and reasons. */
  hiddenRuns?: HiddenRunGroup[];
  entryRunId?: string;
  opened?: boolean;
  openCommand?: string;
  warnings: string[];
  error?: { code: ServeErrorCode; message: string };
}

// v2 seam: declared, never implemented in v1. When provided, the reserved
// /_humanish/api/* namespace would dispatch into it; v1 always passes undefined
// and the namespace answers 501.
interface ServeControlPlane {
  startRun?(request: {
    labId: string;
    dryRun: boolean;
  }): Promise<{ accepted: boolean; runId?: string }>;
}

/** Why verify kept a run out of a share-safe library: its grade and reason codes. */
interface ShareRefusal {
  status: string;
  reasons: string[];
}

/** Runs a share-safe library left out for the same grade and reasons. */
export interface HiddenRunGroup {
  status: string;
  reasons: string[];
  runs: number;
}

export interface ShareSafetyAdmission {
  /** The files verify found share_ready, or null when the run is not admitted. */
  admit(runId: string): Promise<AdmittedRun | null>;
  /** Why verify refused the run, after admit returned null for it; undefined otherwise. */
  refusal(runId: string): ShareRefusal | undefined;
}

export function createShareSafetyAdmission(
  cwd: string,
  options: { verifyImpl?: typeof verifyRun } = {},
): ShareSafetyAdmission {
  const verifyImpl = options.verifyImpl ?? verifyRun;
  const runsRoot = path.join(cwd, ".humanish", "runs");
  // Keyed on a walk of every file in the run, taken on each call: a file added, removed or
  // rewritten since the last verify changes the walk, and the run is verified again before
  // anything in it is served. A change that leaves every stat field alone is caught by the
  // content hash at read time, which drops the entry.
  const cache = new Map<string, CachedAdmission>();

  const shareReady = (verified: Awaited<ReturnType<typeof verifyRun>>): boolean =>
    verified.ok === true && verified.shareSafety.status === "share_ready";
  const verifyAdmission = async (
    runId: string,
    runDirectory: string,
    before: RunInventory,
    entry: CachedAdmission,
    forget: () => void,
  ): Promise<AdmittedRun | null> => {
    // A run verify refuses is never served, so its bytes are never hashed. Hashing reads every
    // byte, and one large file in a refused run would otherwise cost startup time for nothing.
    const verified = await verifyImpl(cwd, runId);
    if (!shareReady(verified)) {
      entry.refusal = {
        status:
          verified.shareSafety.status === "share_ready" ? "blocked" : verified.shareSafety.status,
        reasons: verified.shareSafety.reasons.map((reason) => reason.code),
      };
      return null;
    }
    // Admitted: hash, verify again, and hash after, so the served bytes are the ones verify scanned.
    const hashesBefore = await hashRunInventory(runDirectory, before);
    if (!hashesBefore) return null;
    if (!shareReady(await verifyImpl(cwd, runId))) return null;
    // A file that changed while verify read the run may not be the version it scanned. A changed
    // stat shows in the next request's walk; changed bytes alone do not, so they drop the entry.
    const after = await readRunInventory(runDirectory);
    if (after?.signature !== before.signature) return null;
    const hashes = await hashRunInventory(runDirectory, after);
    if (!hashes || !sameHashes(hashesBefore, hashes)) {
      forget();
      return null;
    }
    return { inventory: before, hashes, forget };
  };

  return {
    async admit(runId: string): Promise<AdmittedRun | null> {
      const runDirectory = path.join(runsRoot, runId);
      const before = isSafeRunIdSegment(runId) ? await readRunInventory(runDirectory) : null;
      if (!before) {
        cache.delete(runId);
        return null;
      }

      const cached = cache.get(runId);
      if (cached?.signature === before.signature) {
        return cached.admitted;
      }

      const entry: CachedAdmission = {
        signature: before.signature,
        admitted: Promise.resolve(null),
      };
      const forget = (): void => {
        if (cache.get(runId) === entry) cache.delete(runId);
      };
      entry.admitted = verifyAdmission(runId, runDirectory, before, entry, forget).catch(() => {
        entry.refusal = { status: "unverifiable", reasons: ["VERIFY_FAILED"] };
        return null;
      });
      cache.set(runId, entry);
      return entry.admitted;
    },
    refusal(runId: string): ShareRefusal | undefined {
      return cache.get(runId)?.refusal;
    },
  };
}

interface CachedAdmission {
  signature: string;
  admitted: Promise<AdmittedRun | null>;
  refusal?: ShareRefusal;
}

/** The refused runs grouped by grade and reasons, the largest group first. */
function hiddenRunGroups(refusals: readonly ShareRefusal[]): HiddenRunGroup[] {
  const groups = new Map<string, HiddenRunGroup>();
  for (const refusal of refusals) {
    const key = `${refusal.status}\0${refusal.reasons.join(",")}`;
    const group = groups.get(key);
    if (group) group.runs += 1;
    else groups.set(key, { ...refusal, runs: 1 });
  }
  return [...groups.values()].sort((left, right) => right.runs - left.runs);
}

function sameHashes(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  return left.size === right.size && [...left].every(([key, hash]) => right.get(key) === hash);
}

export interface ServeRequestHandlerOptions {
  proofRoot: PinnedDirectory;
  safe: boolean;
  // Required even when safe is false: a fail-open path where safe===true but
  // admit is absent would silently serve every run. serveObserverLibrary always
  // wires it; the type keeps future callers from omitting it.
  admit: (runId: string) => Promise<AdmittedRun | null>;
  hostAllowlist: ReadonlySet<string>;
  entryRunId?: string;
  renderLibrary: (history: LibraryHistory) => string;
  controlPlane?: ServeControlPlane;
}

export function createServeRequestHandler(
  options: ServeRequestHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      for (const [name, value] of Object.entries(buildServeSecurityHeaders())) {
        response.setHeader(name, value);
      }

      const method = request.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        writeText(response, 405, "Method Not Allowed");
        return;
      }

      if (!hostAllowed(request.headers.host, options.hostAllowlist)) {
        writeText(response, 421, "Misdirected Request");
        return;
      }

      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

      if (url.pathname === "/_humanish/api" || url.pathname.startsWith("/_humanish/api/")) {
        writeText(
          response,
          501,
          `${JSON.stringify(
            {
              error: {
                code: "HUMANISH_SERVE_CONTROL_PLANE_DISABLED",
                message: "control plane not enabled in this version",
              },
            },
            null,
            2,
          )}\n`,
          "application/json; charset=utf-8",
        );
        return;
      }

      if (url.pathname === "/") {
        if (options.entryRunId) {
          response.writeHead(302, {
            location: `/_humanish/runs/${encodeURIComponent(options.entryRunId)}/observer/index.html`,
          });
          response.end();
          return;
        }
        const history = await loadFilteredHistory(options);
        writeText(response, 200, options.renderLibrary(history), "text/html; charset=utf-8");
        return;
      }

      if (url.pathname === "/_humanish/history.json") {
        const history = await loadFilteredHistory(options);
        writeText(
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
          writeText(response, 404, "Run not found");
          return;
        }
        const admitted = options.safe ? await options.admit(runRoute.runId) : null;
        if (options.safe && !admitted) {
          // Byte-identical to the nonexistent-run 404: no existence oracle.
          writeText(response, 404, "Run not found");
          return;
        }
        const pinned = await pinDirectChildDirectory(options.proofRoot, runRoute.runId);
        // Under --safe every read checks the file against the inventory verify covered.
        const targetRoot = pinned && admitted ? inventoryRoot(pinned, admitted) : pinned;
        if (!targetRoot) {
          writeText(response, 404, "Run not found");
          return;
        }
        // The explicit empty runtimeStreamUrls keeps a future refactor from
        // reintroducing auth-keyed stream injection on the serve surface.
        await serveRunPath(
          targetRoot,
          runRoute.relativePath || "observer/index.html",
          response,
          [],
          request,
        );
        return;
      }

      writeText(response, 404, "Not found");
    } catch {
      writeText(response, 500, "Observer request failed");
    }
  };
}

async function loadFilteredHistory(options: ServeRequestHandlerOptions): Promise<LibraryHistory> {
  if (!options.safe) {
    return buildHistoryIndex(options.proofRoot);
  }

  const history = await buildHistoryIndex(options.proofRoot, async (runId, pinned) => {
    const admitted = await options.admit(runId);
    return admitted ? inventoryRoot(pinned, admitted) : null;
  });
  const runs = history.runs;
  const latestRunId = runs.some((run) => run.runId === history.latestRunId)
    ? history.latestRunId
    : (runs[0]?.runId ?? null);
  return { latestRunId, runs };
}

export interface ServeLibraryOptions {
  port: number;
  safe: boolean;
  expose: boolean;
  // Edge auth (ngrok --oauth or an operator --public-url) is decided by the CLI's validateExposure
  // and passed in: it drives the mode label (exposed vs share-safe-open). humanish carries no
  // in-process auth — the gate lives at the tunnel/proxy edge.
  edgeAuthed: boolean;
  publicOrigin?: string;
  entryRunId?: string;
  controlPlane?: ServeControlPlane;
  verifyImpl?: typeof verifyRun;
}

export interface ServeLibraryServer {
  url: string;
  port: number;
  mode: ServeMode;
  runsListed: number;
  shareReadyCount?: number;
  /** With safe: the runs left out, grouped by grade and reasons. */
  hiddenRuns?: HiddenRunGroup[];
  entryRunId?: string;
  addPublicOrigin(origin: string): void;
  close(): Promise<void>;
}

export type ServeLibraryStart =
  | { ok: true; server: ServeLibraryServer }
  | { ok: false; error: { code: ServeErrorCode; message: string } };

export async function serveObserverLibrary(
  cwdInput: string,
  options: ServeLibraryOptions,
): Promise<ServeLibraryStart> {
  const cwd = path.resolve(cwdInput);
  const verifyImpl = options.verifyImpl ?? verifyRun;

  let proofRoot: PinnedDirectory;
  try {
    proofRoot = await pinDirectory(path.join(cwd, ".humanish", "runs"));
  } catch {
    return {
      ok: false,
      error: {
        code: "HUMANISH_RUN_NOT_FOUND",
        message:
          "No run library found under .humanish/runs. Run `humanish watch` to create the first run.",
      },
    };
  }

  const admission = createShareSafetyAdmission(cwd, { verifyImpl });
  // Exposure auth is tunnel-edge only. Under --expose, an edge-authed surface (ngrok --oauth or an
  // operator --public-url) serves every run (mode "exposed"); an un-authed surface is admissible
  // only because --safe narrows it to share_ready runs (mode "share-safe-open").
  const mode: ServeMode = options.expose
    ? options.edgeAuthed
      ? "exposed"
      : "share-safe-open"
    : "loopback";

  let entryRunId: string | undefined;
  if (options.entryRunId) {
    const resolved =
      options.entryRunId === "latest" ? ((await listRuns(cwd)).latest ?? null) : options.entryRunId;
    const pinned = resolved ? await pinDirectChildDirectory(proofRoot, resolved) : null;
    if (!resolved || !pinned) {
      return {
        ok: false,
        error: { code: "HUMANISH_RUN_NOT_FOUND", message: `Run not found: ${options.entryRunId}` },
      };
    }
    if (options.safe && (await admission.admit(resolved)) === null) {
      const verified = await verifyImpl(cwd, resolved).catch(() => null);
      const status = verified?.shareSafety.status ?? "unverifiable";
      const reasons =
        verified?.shareSafety.reasons.map((reason) => reason.code).join(", ") || "VERIFY_FAILED";
      return {
        ok: false,
        error: {
          code: "HUMANISH_SERVE_RUN_NOT_SHAREABLE",
          message: `Run ${resolved} is not share_ready (shareSafety: ${status}; reasons: ${reasons}); --safe refuses to serve it.`,
        },
      };
    }
    entryRunId = resolved;
  }

  // Counts are computed over the UNCAPPED run list, not the 80-item history
  // index: an edge-authed surface (non-safe) grants access to every run by direct
  // URL, and share-safe modes admit every share_ready run per request, so a
  // count capped at 80 would understate exactly what the exposure warning
  // claims. runsListed feeds the operator's declared-friction warning.
  const allRuns = (await listRuns(cwd)).runs;
  let runsListed: number;
  let shareReadyCount: number | undefined;
  let hiddenRuns: HiddenRunGroup[] | undefined;
  if (options.safe) {
    const admitted = await Promise.all(allRuns.map((run) => admission.admit(run.runId)));
    shareReadyCount = admitted.filter((run) => run !== null).length;
    runsListed = shareReadyCount;
    // A run refused before verify ran, such as one whose files cannot be listed, is unverifiable.
    hiddenRuns = hiddenRunGroups(
      allRuns
        .filter((_run, index) => admitted[index] === null)
        .map(
          (run) =>
            admission.refusal(run.runId) ?? { status: "unverifiable", reasons: ["VERIFY_FAILED"] },
        ),
    );
  } else {
    runsListed = allRuns.length;
  }

  const declaredOrigin = options.publicOrigin ? parsePublicOrigin(options.publicOrigin) : null;

  const hostAllowlist = new Set<string>();
  const handler = createServeRequestHandler({
    proofRoot,
    safe: options.safe,
    admit: (runId) => admission.admit(runId),
    hostAllowlist,
    ...(entryRunId ? { entryRunId } : {}),
    renderLibrary: (history) =>
      renderLibraryHtml(history, {
        mode,
        safe: options.safe,
        capabilities: { actions: false },
      }),
    ...(options.controlPlane ? { controlPlane: options.controlPlane } : {}),
  });

  const server = createServer((request, response) => {
    void handler(request, response);
  });
  let port: number;
  try {
    port = await listenOnLoopback(server, options.port);
  } catch (error) {
    if (error instanceof PortInUseError) {
      // The most expected failure a serve command has, named instead of HUMANISH_UNEXPECTED (#484).
      return { ok: false, error: { code: "HUMANISH_SERVE_PORT_IN_USE", message: error.message } };
    }
    throw error;
  }
  hostAllowlist.add(`127.0.0.1:${port}`);
  hostAllowlist.add(`localhost:${port}`);
  hostAllowlist.add(`[::1]:${port}`);
  if (declaredOrigin) {
    hostAllowlist.add(declaredOrigin.host);
  }

  return {
    ok: true,
    server: {
      url: `http://127.0.0.1:${port}/`,
      port,
      mode,
      runsListed,
      ...(shareReadyCount !== undefined ? { shareReadyCount } : {}),
      ...(hiddenRuns !== undefined ? { hiddenRuns } : {}),
      ...(entryRunId ? { entryRunId } : {}),
      // A tunnel's public origin is only known after the tunnel starts (post bind); this lets the
      // caller declare it, extending the Host allowlist so the authenticated edge forwarding under
      // that Host is admitted. Never flips any in-process auth flag (there is none).
      addPublicOrigin(origin: string): void {
        const parsed = parsePublicOrigin(origin);
        if (!parsed) {
          return;
        }
        hostAllowlist.add(parsed.host);
      },
      close: async () => {
        const closed = closeServer(server);
        // Keep-alive sockets would otherwise keep close() pending past the point
        // the operator believes Ctrl-C tore the server down.
        server.closeAllConnections?.();
        await closed;
      },
    },
  };
}

function writeText(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
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
