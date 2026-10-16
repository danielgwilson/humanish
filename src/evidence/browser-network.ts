import { createHash } from "node:crypto";

import { assertSafeOutputPathSegment } from "../run/contained-output.js";
import { scrubSandboxIds } from "../run/sandbox-ids.js";
import { isNonNegativeSafeInteger, isRecord } from "../run/type-guards.js";
import { pageProblem } from "../verify/pages.js";
import { tracePage } from "./trace-page.js";

// A participant's browser network log: the requests its browser made, one record per request hop,
// each tagged with the turn it happened in. The in-sandbox holder appends a short line per
// DevTools event (src/substrates/e2b/cdp-network-capture.ts). This module joins those lines into
// records, redacts each address as a trace page is redacted, and binds the file it writes to the
// stream index run.json carries. verify reads the file with networkRecordProblem, the check the
// writer applies before it writes a record.

export const BROWSER_NETWORK_SCHEMA = "humanish.browser-network.v1";

/** Why records are missing from a participant's network log. */
type BrowserNetworkGap = "no-capture" | "holder-stopped" | "capped" | "not-collected";

/** A stream's `network` field in run.json. */
export interface BrowserNetworkIndex {
  schema: typeof BROWSER_NETWORK_SCHEMA;
  /**
   * network/<participant id>.ndjson, with the file's record count, byte count and sha256, and how
   * many of its records failed and are pending. All six are absent when no file was written
   * (`no-capture`, `not-collected`).
   */
  path?: string;
  records?: number;
  /** Records with `failed`: requests that got no response or broke off. */
  failed?: number;
  /** Records with `pending`: requests still open when the file was read. */
  pending?: number;
  bytes?: number;
  sha256?: string;
  /** When the launch page's Network domain answered, on the desktop's clock. */
  startedAt?: string;
  /** The origins whose requests are written, redacted as a trace page's origin is. */
  origins: string[];
  complete: boolean;
  /** Present when `complete` is false. */
  reason?: BrowserNetworkGap;
  omitted: {
    /** Requests to an origin outside `origins`. */
    otherOrigin: number;
    /** Records past the caps. */
    overCap: number;
    /** Records that failed the record check. */
    invalid: number;
  };
}

/**
 * A checkpoint screenshot's browser-state read: `wallTime` is the read's clock in seconds since the
 * epoch on the desktop, the clock the holder's request times use, and `turn` the screenshot's N.
 */
export interface TurnMark {
  wallTime: number;
  turn: number;
}

export interface BrowserNetworkCapture {
  /** The participant's id, which names the file. */
  participantId: string;
  /** The origins whose requests are kept, as `new URL(url).origin` writes them. */
  origins: readonly string[];
  /**
   * The holder's events file as the host read it, whole lines and possibly a last partial one, or
   * why nothing was read.
   */
  events: string | { missing: "no-capture" | "not-collected" };
  /** The participant's checkpoint marks, in the order they were taken. */
  marks: readonly TurnMark[];
  /** The trace redaction the participant's pages went through (traceRedaction). */
  redact: (text: string) => string;
  /**
   * The participant's own sandbox id. Run.finish rewrites a journaled id in every run file after
   * run.json indexes them, so the writer replaces it first, with the same label.
   */
  sandboxId?: string;
}

export interface BrowserNetworkLog {
  index: BrowserNetworkIndex;
  /** The file's text, for `index.path`; absent when the index has no path. */
  text?: string;
  /** What a reader of the run should know about the log, such as records with no turn. */
  warnings: string[];
}

/** The first records a log keeps, then the failed, pending and 400-or-above records past them. */
const FIRST_RECORDS = 20_000;
const NOTABLE_RECORDS = 5_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** The lowercase CDP ResourceType names; any other type is written as `other`. */
const RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "document",
  "stylesheet",
  "image",
  "media",
  "font",
  "script",
  "texttrack",
  "xhr",
  "fetch",
  "prefetch",
  "eventsource",
  "websocket",
  "manifest",
  "signedexchange",
  "ping",
  "cspviolationreport",
  "preflight",
  "fedcm",
  "other",
]);
const CACHES: ReadonlySet<string> = new Set([
  "memory",
  "disk",
  "prefetch",
  "service-worker",
  "back-forward",
]);
const RECORD_KEYS: ReadonlySet<string> = new Set([
  "at",
  "turn",
  "method",
  "origin",
  "path",
  "type",
  "status",
  "ms",
  "redirect",
  "cache",
  "failed",
  "pending",
]);
const METHOD = /^[A-Z]{1,16}$/;
const FAILED = /^ERR_[A-Z0-9_]{1,64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Cache = "memory" | "disk" | "prefetch" | "service-worker" | "back-forward";

/** One record as the log writes it; `at` is undefined only when the hop had no start time. */
interface NetworkRecord {
  at: string | undefined;
  turn?: number;
  method?: string;
  origin: string;
  path: string;
  type: string;
  status?: number;
  ms?: number;
  redirect?: true;
  cache?: Cache;
  failed?: string;
  pending?: true;
}

/** One request hop on the way to a record: what the holder's lines said about it. */
interface Hop {
  wallTime: number | undefined;
  timestamp: number | undefined;
  page: { origin: string; path: string };
  method: string | undefined;
  type: string;
  redirect: boolean;
  status?: number;
  cache?: Cache;
  /** The monotonic time the hop finished, failed or redirected. */
  end?: number;
  failed?: string;
  done: boolean;
}

/** Whether `value` is an ISO time as `Date.prototype.toISOString` writes one. */
export function isIsoTime(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIME.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** The run-relative path of a participant's network log. */
export function networkLogPath(participantId: string): string {
  return `network/${participantId}.ndjson`;
}

const optional = (value: unknown, valid: (present: unknown) => boolean): boolean =>
  value === undefined || valid(value);

/**
 * What is wrong with one network log record, or undefined when it holds only the schema's keys and
 * values. The writer leaves out a record this names; verify reports one as a finding. Never says
 * what the record holds.
 */
export function networkRecordProblem(record: unknown): string | undefined {
  if (!isRecord(record)) return "is not a JSON object";
  if (Object.keys(record).some((key) => !RECORD_KEYS.has(key)))
    return "has a key outside the schema";
  if (!isIsoTime(record.at)) return "has a start time that is not an ISO time";
  if (!optional(record.turn, isNonNegativeSafeInteger))
    return "has a turn that is not a whole number from 0";
  if (!optional(record.method, (method) => typeof method === "string" && METHOD.test(method)))
    return "has a method that is not 1 to 16 capital letters";
  const page = pageProblem({ origin: record.origin, path: record.path });
  if (page !== undefined) return page;
  if (typeof record.type !== "string" || !RESOURCE_TYPES.has(record.type))
    return "has a resource type outside the list";
  if (
    !optional(
      record.status,
      (status) => Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599,
    )
  )
    return "has a status outside 100 to 599";
  if (!optional(record.ms, isNonNegativeSafeInteger))
    return "has a duration that is not a whole number of milliseconds from 0";
  if (!optional(record.cache, (cache) => typeof cache === "string" && CACHES.has(cache)))
    return "has a cache value outside the list";
  if (!optional(record.failed, (failed) => typeof failed === "string" && FAILED.test(failed)))
    return "has error text that is not ERR_ then capital letters, digits or underscores";
  if (!optional(record.redirect, (flag) => flag === true))
    return "has a redirect flag other than true";
  if (!optional(record.pending, (flag) => flag === true))
    return "has a pending flag other than true";
  return undefined;
}

/**
 * The network log of one participant: the records the holder's events give, joined by request id
 * into one per hop, redacted, tagged with turns, checked and capped, then the index that binds
 * them. A redirect gives the 3xx hop's record, then one with `redirect: true`. A request's turn is
 * the N of the first mark at or after its start, or the last mark's N plus 1 after every mark.
 * Throws only for a participant id that is not one path segment.
 */
export function reduceBrowserNetwork(capture: BrowserNetworkCapture): BrowserNetworkLog {
  const { participantId, redact, sandboxId } = capture;
  assertSafeOutputPathSegment(participantId, "Network log participant");
  const scrub =
    sandboxId === undefined || sandboxId === ""
      ? (text: string) => text
      : (text: string) => scrubSandboxIds(text, [sandboxId]);
  const origins = [
    ...new Set(
      capture.origins.flatMap((origin) => {
        const page = tracePage(origin, redact);
        return page === undefined ? [] : [scrub(page.origin)];
      }),
    ),
  ];
  const omitted = { otherOrigin: 0, overCap: 0, invalid: 0 };
  const { events } = capture;
  if (typeof events !== "string")
    return {
      index: {
        schema: BROWSER_NETWORK_SCHEMA,
        origins,
        complete: false,
        reason: events.missing,
        omitted,
      },
      warnings: [],
    };

  const pageOf = cachedPages(capture.origins, redact, scrub);
  const read = joinHops(events, pageOf);
  omitted.otherOrigin = read.otherOrigin;
  if (read.startedAt === undefined)
    return {
      index: {
        schema: BROWSER_NETWORK_SCHEMA,
        origins,
        complete: false,
        reason: "no-capture",
        omitted,
      },
      warnings: [],
    };

  const turnOf = turnRule(capture.marks);
  const lines: string[] = [];
  const kept = { failed: 0, pending: 0 };
  const room = {
    first: FIRST_RECORDS,
    notable: NOTABLE_RECORDS,
    bytes: MAX_FILE_BYTES,
    full: false,
  };
  for (const hop of read.hops) {
    const record = recordOf(hop, turnOf);
    if (networkRecordProblem(record) !== undefined) {
      omitted.invalid += 1;
      continue;
    }
    const line = `${JSON.stringify(record)}\n`;
    if (!fits(record, Buffer.byteLength(line, "utf8"), room)) {
      omitted.overCap += 1;
      continue;
    }
    lines.push(line);
    if (record.failed !== undefined) kept.failed += 1;
    if (record.pending === true) kept.pending += 1;
  }

  const text = lines.join("");
  const bytes = Buffer.from(text, "utf8");
  const reason: BrowserNetworkGap | undefined =
    read.capped || omitted.overCap > 0 ? "capped" : read.stopped ? "holder-stopped" : undefined;
  return {
    index: {
      schema: BROWSER_NETWORK_SCHEMA,
      path: networkLogPath(participantId),
      records: lines.length,
      ...kept,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      startedAt: read.startedAt,
      origins,
      complete: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
      omitted,
    },
    text,
    warnings:
      capture.marks.length === 0 && lines.length > 0
        ? [
            `Participant ${participantId}'s network log has no turn numbers: no checkpoint screenshot recorded a browser-state read, so its requests could not be matched to turns. Each record's time (at) still places it.`,
          ]
        : [],
  };
}

/**
 * The page a request address is written as, or undefined for an origin outside `origins` or an
 * address the URL parser rejects. tracePage runs once per address the holder wrote, which is a raw
 * origin and path: a page polling one endpoint repeats the same address thousands of times, and an
 * uncached call costs a few hundred microseconds.
 */
function cachedPages(
  allowedOrigins: readonly string[],
  redact: (text: string) => string,
  scrub: (text: string) => string,
): (url: unknown) => Hop["page"] | undefined {
  const allowed = new Set(allowedOrigins.flatMap((origin) => URL.parse(origin)?.origin ?? []));
  const pages = new Map<string, Hop["page"] | null>();
  return (url) => {
    if (typeof url !== "string") return undefined;
    let page = pages.get(url);
    if (page === undefined) {
      const parsed = URL.parse(url);
      // The holder writes only allowed addresses; the host decides what is written.
      const traced =
        parsed !== null && allowed.has(parsed.origin) ? tracePage(url, redact) : undefined;
      page =
        traced === undefined ? null : { origin: scrub(traced.origin), path: scrub(traced.path) };
      pages.set(url, page);
    }
    return page ?? undefined;
  };
}

/** What the events file says: the hops by start time, and the holder's own lines. */
interface JoinedEvents {
  hops: Hop[];
  startedAt: string | undefined;
  otherOrigin: number;
  capped: boolean;
  stopped: boolean;
}

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The holder's lines joined by request id. A last line with no line end is still being written. */
function joinHops(events: string, pageOf: (url: unknown) => Hop["page"] | undefined): JoinedEvents {
  const joined: JoinedEvents = {
    hops: [],
    startedAt: undefined,
    otherOrigin: 0,
    capped: false,
    stopped: false,
  };
  const open = new Map<string, Hop>();
  const whole = events.slice(0, events.lastIndexOf("\n") + 1);
  for (const text of whole.split("\n")) {
    if (text === "") continue;
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(line)) continue;
    const id = typeof line.id === "string" ? line.id : "";
    const hop = open.get(id);
    switch (line.e) {
      case "start":
        joined.startedAt ??= isoOf(finite(line.wallTime));
        break;
      case "cap":
        joined.capped = true;
        break;
      case "exit":
        joined.stopped = true;
        break;
      case "request": {
        const redirected = isRecord(line.redirectResponse);
        if (hop !== undefined && redirected) {
          answer(hop, line.redirectResponse);
          close(hop, line.timestamp);
        }
        open.delete(id);
        const page = pageOf(line.url);
        if (page === undefined) {
          joined.otherOrigin += 1;
          break;
        }
        const next: Hop = {
          wallTime: finite(line.wallTime),
          timestamp: finite(line.timestamp),
          page,
          method: typeof line.method === "string" ? line.method : undefined,
          type: typeof line.type === "string" ? line.type : "",
          redirect: redirected,
          done: false,
        };
        joined.hops.push(next);
        open.set(id, next);
        break;
      }
      case "response":
        if (hop !== undefined) answer(hop, line);
        break;
      case "servedFromCache":
        if (hop !== undefined) hop.cache = "memory";
        break;
      case "finished":
      case "failed":
        if (hop === undefined) break;
        if (line.e === "failed") hop.failed = failedOf(line.errorText);
        close(hop, line.timestamp);
        open.delete(id);
        break;
      case "backForward": {
        // A restore from the back-forward cache sends no request.
        const page = pageOf(line.url);
        if (page === undefined) joined.otherOrigin += 1;
        else
          joined.hops.push({
            wallTime: finite(line.wallTime),
            timestamp: undefined,
            page,
            method: undefined,
            type: "document",
            redirect: false,
            cache: "back-forward",
            done: true,
          });
        break;
      }
      default:
        break;
    }
  }
  // Sorted by start; a hop with no start time sorts last and fails the record check.
  joined.hops.sort(
    (left, right) =>
      (left.wallTime ?? Number.POSITIVE_INFINITY) - (right.wallTime ?? Number.POSITIVE_INFINITY),
  );
  return joined;
}

/** A response's status and cache flags onto its hop. A memory-cache serve outranks the flags. */
function answer(hop: Hop, response: unknown): void {
  if (!isRecord(response)) return;
  const status = response.status;
  if (Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599)
    hop.status = Number(status);
  if (hop.cache === "memory") return;
  if (response.fromDiskCache === true) hop.cache = "disk";
  else if (response.fromPrefetchCache === true) hop.cache = "prefetch";
  else if (response.fromServiceWorker === true) hop.cache = "service-worker";
}

function close(hop: Hop, timestamp: unknown): void {
  const end = finite(timestamp);
  if (end !== undefined) hop.end = end;
  hop.done = true;
}

/** `loadingFailed.errorText` without its `net::` prefix, or ERR_OTHER for any other text. */
function failedOf(errorText: unknown): string {
  const text = typeof errorText === "string" ? errorText.replace(/^net::/, "") : "";
  return FAILED.test(text) ? text : "ERR_OTHER";
}

function isoOf(wallTime: number | undefined): string | undefined {
  if (wallTime === undefined) return undefined;
  const date = new Date(wallTime * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * The turn rule over `marks`: the N of the first mark at or after a start time, the last mark's N
 * plus 1 after every mark, and no turn when there are no marks.
 */
function turnRule(
  marks: readonly TurnMark[],
): (wallTime: number | undefined) => number | undefined {
  const sorted = marks
    .filter((mark) => Number.isFinite(mark.wallTime) && isNonNegativeSafeInteger(mark.turn))
    .toSorted((left, right) => left.wallTime - right.wallTime);
  const last = sorted.at(-1);
  if (last === undefined) return () => undefined;
  return (wallTime) => {
    if (wallTime === undefined) return undefined;
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sorted[middle]!.wallTime < wallTime) low = middle + 1;
      else high = middle;
    }
    return low < sorted.length ? sorted[low]!.turn : last.turn + 1;
  };
}

function recordOf(
  hop: Hop,
  turnOf: (wallTime: number | undefined) => number | undefined,
): NetworkRecord {
  const turn = turnOf(hop.wallTime);
  const type = hop.type.toLowerCase();
  const ms =
    hop.end !== undefined && hop.timestamp !== undefined
      ? Math.max(0, Math.round((hop.end - hop.timestamp) * 1000))
      : undefined;
  return {
    at: isoOf(hop.wallTime),
    ...(turn === undefined ? {} : { turn }),
    ...(hop.cache === "back-forward"
      ? {}
      : { method: hop.method !== undefined && METHOD.test(hop.method) ? hop.method : "OTHER" }),
    origin: hop.page.origin,
    path: hop.page.path,
    type: RESOURCE_TYPES.has(type) ? type : "other",
    ...(hop.status === undefined ? {} : { status: hop.status }),
    ...(ms === undefined ? {} : { ms }),
    ...(hop.redirect ? { redirect: true as const } : {}),
    ...(hop.cache === undefined ? {} : { cache: hop.cache }),
    ...(hop.failed === undefined ? {} : { failed: hop.failed }),
    ...(hop.done ? {} : { pending: true as const }),
  };
}

/**
 * Whether a record of `size` bytes still fits: one of the first records, or a failed, pending or
 * 400-or-above one past them, and never past the byte cap. After the first line that would pass
 * the byte cap, no later line is written, so a reader knows the file ends where the cap fell.
 */
function fits(
  record: NetworkRecord,
  size: number,
  room: { first: number; notable: number; bytes: number; full: boolean },
): boolean {
  const notable =
    record.failed !== undefined || record.pending === true || (record.status ?? 0) >= 400;
  const slot = room.first > 0 ? "first" : notable && room.notable > 0 ? "notable" : undefined;
  if (slot === undefined || room.full) return false;
  if (size > room.bytes) {
    room.full = true;
    return false;
  }
  room.bytes -= size;
  room[slot] -= 1;
  return true;
}
