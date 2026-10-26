import type { ActorCapabilities } from "../contract.js";
import { redactText } from "../../evidence/redaction.js";
import {
  prepareContainedOutputFile,
  prepareSelectedOutputDirectory,
  type PreparedSelectedOutputDirectory,
  writeContainedOutputFile,
} from "../../run/contained-output.js";

// What every API-keyed computer-use provider shares, whatever its vendor: its capabilities, the
// fetch seam tests replace, the retry delay a provider's Retry-After hint sets, and response wire
// capture.
//
// A parser and a hand-written fixture that share a wrong idea of the wire pass together while
// every live reply is misread, so provider fixtures come from captured responses. Setting HUMANISH_CUA_WIRE_CAPTURE_DIR makes a provider write each
// successful response body into that directory as pretty-printed JSON, one file per provider
// call in call order (wire-001.json, wire-002.json, ...). Capture is:
//  - Opt-in: unset (or empty) means zero behavior change, and nothing is written;
//  - Response-side only: request bodies carry base64 screenshots and the persona instructions
//    and are never captured; non-ok response bodies can echo the request and are never captured;
//  - Redacted: every string (keys and values) passes through redactText before writing, so a
//    secret-shaped echo in a response cannot persist to disk.
// Point it at a gitignored path (under .humanish/): raw captures are never committed, and the
// fixtures derived from them are minimal, hand-reviewed excerpts.

/** What an API-keyed computer-use provider can do: drive a desktop from screenshots. */
export const API_COMPUTER_USE_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: false,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "proprietary",
};

/**
 * The minimal slice of the fetch contract a provider depends on. Injecting it keeps the providers
 * dependency-free and lets tests run with a fake that never touches the network.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  /** Optional so a scripted fake need not carry headers; the real fetch Response does. */
  headers?: { get(name: string): string | null };
}>;

/** The fetch a provider uses when none is injected. */
export function defaultFetch(): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init);
    return {
      ok: res.ok,
      status: res.status,
      text: () => res.text(),
      json: () => res.json() as Promise<unknown>,
    };
  };
}

/** A pause that never holds the process open. */
export function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** The longest wait a provider's Retry-After hint can impose on one retry. */
export const RETRY_AFTER_CAP_MS = 60_000;

/**
 * Parse a Retry-After header (delay-seconds or an HTTP-date) into milliseconds from `now`;
 * undefined when absent or unreadable. A fixed 200/400/800 ms backoff against a 20 s hint burns
 * every retry inside the hint and ends the participant's session for nothing.
 */
export function retryAfterMs(value: string | null | undefined, now: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/**
 * How long to wait before retry `attempt` (from 0) of a request the provider answered with a
 * transient status: exponential backoff from 200 ms, or the provider's longer Retry-After hint,
 * up to RETRY_AFTER_CAP_MS.
 */
export function retryDelayMs(
  attempt: number,
  headers: { get(name: string): string | null } | undefined,
): number {
  const backoff = 2 ** attempt * 200;
  const hinted = retryAfterMs(headers?.get("retry-after"), Date.now());
  return hinted === undefined ? backoff : Math.min(Math.max(backoff, hinted), RETRY_AFTER_CAP_MS);
}

/** The opt-in gate for response wire capture: a directory path, or unset for off. */
export const WIRE_CAPTURE_ENV = "HUMANISH_CUA_WIRE_CAPTURE_DIR";

/**
 * Deep-copy a captured wire value with every string (object keys included) passed through the
 * shared redactText. Pure; non-string primitives pass through unchanged.
 */
export function redactWireJson(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactWireJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        redactText(key),
        redactWireJson(entry),
      ]),
    );
  }
  return value;
}

/** Deterministic ordered capture file name for the 1-based nth provider call. */
export function wireCaptureFileName(callNumber: number): string {
  return `wire-${String(callNumber).padStart(3, "0")}.json`;
}

/** Response wire capture for one provider: prepares each file before dispatch, then writes it. */
export interface WireCapture {
  /** Preflight the next capture file; undefined when capture is off. */
  prepareNext(): Promise<PreparedSelectedOutputDirectory | undefined>;
  /** Persist one successful response body, redacted and pretty-printed. */
  record(raw: unknown): Promise<void>;
}

/**
 * Response wire capture into `captureDir`; undefined means off and zero behavior change. The
 * counter is per provider, so file order is call order. A provider calls prepareNext before any
 * network side effect, so a hostile path fails with no provider call.
 */
export function createWireCapture(captureDir: string | undefined): WireCapture {
  let captureCount = 0;
  let preparedCaptureRoot: Promise<PreparedSelectedOutputDirectory> | undefined;
  const prepareNext = async (): Promise<PreparedSelectedOutputDirectory | undefined> => {
    if (captureDir === undefined) return undefined;
    preparedCaptureRoot ??= prepareSelectedOutputDirectory(process.cwd(), captureDir);
    const captureRoot = await preparedCaptureRoot;
    await prepareContainedOutputFile(captureRoot, wireCaptureFileName(captureCount + 1));
    return captureRoot;
  };
  return {
    prepareNext,
    // Fails loud: a silent capture failure would leave turns missing from a fixture refresh.
    record: async (raw) => {
      if (captureDir === undefined) return;
      const captureRoot = await prepareNext();
      if (!captureRoot) return;
      captureCount += 1;
      await writeContainedOutputFile(
        captureRoot,
        wireCaptureFileName(captureCount),
        `${JSON.stringify(redactWireJson(raw), null, 2)}\n`,
        "utf8",
      );
    },
  };
}

/** The capture directory `env` names, or undefined when capture is off. */
export function wireCaptureDir(env: Record<string, string | undefined>): string | undefined {
  const dir = env[WIRE_CAPTURE_ENV]?.trim();
  return dir === undefined || dir === "" ? undefined : dir;
}
