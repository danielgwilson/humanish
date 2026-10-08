// Tells a person when a newer humanish is published, as npm, gh and the Vercel CLI do. A command
// only reads a small cache and prints at most one line from it; the registry request runs in a
// detached process that writes the cache for a later command, so the check never delays or fails
// the command that started it.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { disabledByEnvironment } from "./telemetry.js";
import { envFlag, humanishConfigFile } from "./user-config.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTRY_DIST_TAGS = "https://registry.npmjs.org/-/package/humanish/dist-tags";

interface UpdateCache {
  /** When the registry was last asked, as an ISO 8601 timestamp. */
  checkedAt?: string;
  /** The registry's `latest` dist-tag, once a request has succeeded. */
  latest?: string;
  /** When the notice was last printed, as an ISO 8601 timestamp. */
  notifiedAt?: string;
}

export interface UpdateCheckContext {
  /** The running CLI's version. */
  installed: string;
  env: NodeJS.ProcessEnv;
  /** Whether stderr is a terminal. */
  terminal: boolean;
  /** Whether the command prints a JSON document. */
  json: boolean;
  /** Whether this CLI runs from humanish's own source checkout. */
  ownCheckout: boolean;
  /** The clock, in epoch milliseconds. */
  now: number;
  home?: string;
  /** Starts the background registry request that writes the cache. Never awaited. */
  startRefresh: (cachePath: string) => void;
}

function readUpdateCache(cachePath: string): UpdateCache {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
    if (parsed === null || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    const text = (field: string): string | undefined =>
      typeof record[field] === "string" ? record[field] : undefined;
    const cache: UpdateCache = {};
    const checkedAt = text("checkedAt");
    const latest = text("latest");
    const notifiedAt = text("notifiedAt");
    if (checkedAt !== undefined) cache.checkedAt = checkedAt;
    if (latest !== undefined && parseVersion(latest) !== undefined) cache.latest = latest;
    if (notifiedAt !== undefined) cache.notifiedAt = notifiedAt;
    return cache;
  } catch {
    return {};
  }
}

function writeUpdateCache(cachePath: string, cache: UpdateCache): void {
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `candidate` is a higher release than `installed`. */
function isNewer(candidate: string, installed: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(installed);
  if (a === undefined || b === undefined) return false;
  for (let index = 0; index < 3; index += 1)
    if (a[index] !== b[index]) return a[index]! > b[index]!;
  return false;
}

/** True when `timestamp` is missing, unreadable, or at least a day before `now`. */
function dayPassed(timestamp: string | undefined, now: number): boolean {
  const then = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
  return Number.isNaN(then) || now - then >= DAY_MS;
}

/**
 * Only a person at a terminal is told, and only when nothing has switched the check off. A pipe,
 * CI and a JSON document have a program reading them. A study participant runs the version the
 * study chose, and a notice would send it to another. The telemetry switches turn this off too:
 * someone who opted out of telemetry expects no unprompted requests. NO_UPDATE_NOTIFIER is the
 * switch the update-notifier package reads, so someone who set it for the CLIs built on that
 * package gets no notice here either.
 */
function checkAllowed(context: UpdateCheckContext): boolean {
  const env = context.env;
  return (
    context.terminal &&
    !context.json &&
    !context.ownCheckout &&
    !envFlag(env.CI) &&
    !envFlag(env.HUMANISH_NO_UPDATE_CHECK) &&
    !envFlag(env.NO_UPDATE_NOTIFIER) &&
    !envFlag(env.HUMANISH_STUDY_PARTICIPANT) &&
    !disabledByEnvironment(env)
  );
}

/**
 * The one line to print after a command when the cache names a newer humanish, at most once a day.
 * Records that it was shown. Every failure inside is swallowed: an update notice is never a reason
 * for a command to fail.
 */
export function checkForUpdate(context: UpdateCheckContext): string | undefined {
  try {
    if (!checkAllowed(context)) return undefined;
    const cachePath = humanishConfigFile(context.env, "update-check.json", context.home);
    const cache = readUpdateCache(cachePath);
    const stamp = new Date(context.now).toISOString();
    const next: UpdateCache = { ...cache };
    // Stamped before the request starts, so an offline machine asks once a day rather than on
    // every command. The request writes `latest` when it succeeds.
    const refresh = dayPassed(cache.checkedAt, context.now);
    if (refresh) next.checkedAt = stamp;
    const latest = cache.latest;
    const notice =
      latest !== undefined &&
      isNewer(latest, context.installed) &&
      dayPassed(cache.notifiedAt, context.now)
        ? `humanish ${context.installed} is out of date; the latest is ${latest}. Run npx humanish@latest to use it.`
        : undefined;
    if (notice !== undefined) next.notifiedAt = stamp;
    if (refresh || notice !== undefined) writeUpdateCache(cachePath, next);
    if (refresh) context.startRefresh(cachePath);
    return notice;
  } catch {
    return undefined;
  }
}

/**
 * The version the last successful check recorded, compared with `installed`, for `doctor`. Reads the
 * cache only; undefined until a check has succeeded on this machine.
 */
export function recordedVersion(
  installed: string,
  env: NodeJS.ProcessEnv,
  home?: string,
): { newer: boolean; message: string } | undefined {
  const cache = readUpdateCache(humanishConfigFile(env, "update-check.json", home));
  if (cache.latest === undefined) return undefined;
  const checked = cache.checkedAt === undefined ? "" : ` (checked ${cache.checkedAt.slice(0, 10)})`;
  return isNewer(cache.latest, installed)
    ? {
        newer: true,
        message: `${installed} installed; ${cache.latest} is the latest${checked}. Run npx humanish@latest to use it.`,
      }
    : { newer: false, message: `${installed} installed, the latest published${checked}` };
}

/**
 * Ask the npm registry for humanish's `latest` dist-tag and record it in the cache. The detached
 * worker runs this. The request is a GET with an Accept header and nothing else: no machine id,
 * installed version, command or path. A failed or malformed answer leaves the cache as it was.
 */
export async function refreshUpdateCache(args: {
  cachePath: string;
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
}): Promise<void> {
  try {
    const fetchFn = args.fetchFn ?? globalThis.fetch;
    const response = await fetchFn(REGISTRY_DIST_TAGS, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(args.timeoutMs ?? 3_000),
    });
    if (!response.ok) return;
    const body: unknown = await response.json();
    const latest =
      body !== null && typeof body === "object"
        ? (body as Record<string, unknown>).latest
        : undefined;
    if (typeof latest !== "string" || parseVersion(latest) === undefined) return;
    const now = (args.now ?? Date.now)();
    writeUpdateCache(args.cachePath, {
      ...readUpdateCache(args.cachePath),
      checkedAt: new Date(now).toISOString(),
      latest,
    });
  } catch {
    // Offline, slow or refused: the next check is a day away either way.
  }
}

/** What the worker's environment keeps: how this machine reaches the network, and no credentials. */
const WORKER_ENV_NAMES = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SYSTEMROOT",
];

/**
 * Start the worker that runs refreshUpdateCache, detached and unreferenced so this process exits
 * without waiting for it. A source checkout has no built worker, and nothing starts.
 */
export function startRefreshWorker(cachePath: string): void {
  const worker = fileURLToPath(new URL("./update-check-worker.js", import.meta.url));
  if (!existsSync(worker)) return;
  const env = Object.fromEntries(
    WORKER_ENV_NAMES.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const child = spawn(process.execPath, [worker, cachePath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.on("error", () => {});
  child.unref();
}
