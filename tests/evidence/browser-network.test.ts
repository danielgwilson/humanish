// The host half of a participant's browser network log: the holder's events file and the turn
// marks go in, the records and the stream index come out. The fixture is the events file the
// holder wrote against a synthetic site under headless Chrome (tests/fixtures/browser-network).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  networkIndexWithoutEvents,
  reduceBrowserNetwork,
  type TurnMark,
} from "../../src/evidence/browser-network.js";
import { redactText, scrubLiterals } from "../../src/evidence/redaction.js";
import { traceRedaction } from "../../src/evidence/trace-page.js";

const FIXTURE = path.resolve("tests/fixtures/browser-network/holder-events.ndjson");
const SITE = "http://127.0.0.1:3000";
const CLOSED = "http://127.0.0.1:3999";
const MIB = 1024 * 1024;

/** The run's redaction with a study secret the scrub knows, as a participant's pages get it. */
const redact = traceRedaction(scrubLiterals(["invite-code-7"]), redactText);

/** Events in the holder's line format, after its start line at wallTime 100 unless not `started`. */
function eventsFile(lines: object[], started = true) {
  return [...(started ? [{ e: "start", wallTime: 100 }] : []), ...lines]
    .map((line) => `${JSON.stringify(line)}\n`)
    .join("");
}

/** A request that started at `wallTime` and finished 5 ms later with `status`. */
function answered(id: string, wallTime: number, url: string, status = 200): object[] {
  return [
    { e: "request", id, wallTime, timestamp: wallTime, url, method: "GET", type: "Fetch" },
    { e: "response", id, timestamp: wallTime + 0.004, status },
    { e: "finished", id, timestamp: wallTime + 0.005 },
  ];
}

function failedAt(id: string, wallTime: number, url: string): object[] {
  return [
    { e: "request", id, wallTime, timestamp: wallTime, url, method: "GET", type: "Fetch" },
    { e: "failed", id, timestamp: wallTime + 0.001, errorText: "net::ERR_CONNECTION_RESET" },
  ];
}

const lines = (text: string | undefined): Array<Record<string, unknown>> =>
  (text ?? "")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

function reduce(events: string, marks: TurnMark[] = [], origins = [SITE, CLOSED]) {
  return reduceBrowserNetwork({ participantId: "p1", origins, events, marks, redact });
}

describe("the network log of the captured fixture", () => {
  it("writes one record per request hop, sorted by start, with each case the holder saw", async () => {
    const events = await readFile(FIXTURE, "utf8");
    // Turn 0's screenshot read came after the first page load, turn 1's after the link, turn 2's
    // after the back press; the later tab's requests came after the last read.
    const marks = [
      { wallTime: 1792116685.6, turn: 0 },
      { wallTime: 1792116686.0, turn: 1 },
      { wallTime: 1792116686.4, turn: 2 },
    ];
    const log = await reduce(events, marks);
    const page = (at: string, turn: number, pathname: string, origin = SITE) => ({
      at: `2026-10-16T02:11:${at}Z`,
      turn,
      origin,
      path: pathname,
    });
    expect(lines(log.text)).toEqual([
      { ...page("25.530", 0, "/flow"), method: "GET", type: "document", status: 200, ms: 2 },
      { ...page("25.536", 0, "/img.png"), method: "GET", type: "image", status: 200, ms: 2 },
      { ...page("25.538", 0, "/ok"), method: "GET", type: "fetch", status: 200, ms: 4 },
      { ...page("25.538", 0, "/err"), method: "GET", type: "fetch", status: 500, ms: 5 },
      { ...page("25.538", 0, "/slow"), method: "GET", type: "fetch", status: 200, ms: 307 },
      // The 302 is its own hop, closed when the next one started on the same request id.
      { ...page("25.538", 0, "/redirect"), method: "GET", type: "fetch", status: 302, ms: 7 },
      { ...page("25.539", 0, "/submit"), method: "POST", type: "fetch", status: 200, ms: 8 },
      {
        ...page("25.539", 0, "/drop"),
        method: "GET",
        type: "fetch",
        failed: "ERR_EMPTY_RESPONSE",
        ms: 6,
      },
      {
        ...page("25.539", 0, "/closed", CLOSED),
        method: "GET",
        type: "fetch",
        failed: "ERR_CONNECTION_REFUSED",
        ms: 4,
      },
      {
        ...page("25.545", 0, "/ok"),
        method: "GET",
        type: "fetch",
        status: 200,
        ms: 4,
        redirect: true,
      },
      { ...page("25.546", 0, "/favicon.ico"), method: "GET", type: "other", status: 200, ms: 3 },
      { ...page("25.849", 1, "/next"), method: "GET", type: "document", status: 200, ms: 2 },
      {
        ...page("25.854", 1, "/img.png"),
        method: "GET",
        type: "image",
        status: 200,
        ms: 2,
        cache: "disk",
      },
      { ...page("25.860", 1, "/favicon.ico"), method: "GET", type: "other", status: 200, ms: 2 },
      { ...page("26.361", 2, "/hang"), method: "GET", type: "fetch", pending: true },
      { ...page("26.363", 2, "/flow"), type: "document", cache: "back-forward" },
      { ...page("26.363", 2, "/favicon.ico"), method: "GET", type: "other", status: 200, ms: 2 },
      { ...page("26.557", 3, "/favicon.ico"), method: "GET", type: "other", status: 200, ms: 2 },
      { ...page("27.055", 3, "/from-later-tab"), method: "GET", type: "fetch", status: 200, ms: 2 },
    ]);
    // The fetch to http://localhost:<port>, an origin the study did not allow, is one count.
    expect(log.text).not.toContain("localhost");
    expect(log.index).toMatchObject({
      schema: "humanish.browser-network.v1",
      path: "network/p1.ndjson",
      records: 19,
      failed: 2,
      pending: 1,
      startedAt: "2026-10-16T02:11:25.370Z",
      origins: [SITE, CLOSED],
      omitted: { otherOrigin: 1, overCap: 0, invalid: 0 },
    });
    expect(log.warnings).toEqual([]);
  });

  it("binds the file by its byte count, sha256 and record count", async () => {
    const log = await reduce(await readFile(FIXTURE, "utf8"));
    const bytes = Buffer.from(log.text ?? "", "utf8");
    expect(log.index.bytes).toBe(bytes.length);
    expect(log.index.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(log.index.records).toBe(lines(log.text).length);
    expect(log.text?.endsWith("\n")).toBe(true);
  });

  it("reads the holder's exit line as a stopped holder, and a file without one as complete", async () => {
    const events = await readFile(FIXTURE, "utf8");
    expect((await reduce(events)).index).toMatchObject({
      complete: false,
      reason: "holder-stopped",
    });
    const running = events.replace(/^\{"e":"exit".*\n/m, "");
    const index = (await reduce(running)).index;
    expect(index.complete).toBe(true);
    expect(index).not.toHaveProperty("reason");
  });

  it("ignores a last line the read cut off, as a file still being written can end", async () => {
    const events = (await readFile(FIXTURE, "utf8")).replace(/^\{"e":"exit".*\n/m, "");
    const cut = events.slice(0, events.lastIndexOf('"url"'));
    const log = await reduce(cut);
    // The cut line was the later tab's fetch; the lines before it reduce as they did.
    expect(lines(log.text).map((record) => record.path)).not.toContain("/from-later-tab");
    expect(log.index).toMatchObject({ records: 18, omitted: { invalid: 0 } });
  });
});

describe("a record's origin and path", () => {
  it("are the page tracePage keeps, with a segment the run's redaction changes withheld", async () => {
    const log = await reduce(
      eventsFile([
        ...answered("0:1", 101, `${SITE}/invite/invite-code-7`),
        ...answered("0:2", 102, `${SITE}/orders/9f8e7d6c5b4a39281706`),
        ...answered("0:3", 103, `${SITE}/home/someone/notes`),
      ]),
    );
    expect(lines(log.text).map((record) => record.path)).toEqual([
      "/invite/[REDACTED_URL_PART]",
      "/orders/[REDACTED_URL_PART]",
      "[REDACTED_RUNTIME_PATH]",
    ]);
  });

  it("keep each origin for one path on two origins, and the same page for a repeated address", async () => {
    const log = await reduce(
      eventsFile([
        ...answered("0:1", 101, `${SITE}/api/items`),
        ...answered("0:2", 102, `${CLOSED}/api/items`),
        ...answered("0:3", 103, `${SITE}/api/items`),
      ]),
    );
    expect(lines(log.text).map((record) => [record.origin, record.path])).toEqual([
      [SITE, "/api/items"],
      [CLOSED, "/api/items"],
      [SITE, "/api/items"],
    ]);
  });

  it("are checked against the allowed origins again on the host", async () => {
    // A holder that wrote an address for an origin the study did not allow.
    const log = await reduce(
      eventsFile([
        ...answered("0:1", 101, `${SITE}/ok`),
        ...answered("0:2", 102, "http://tracker.example.test/pixel"),
      ]),
    );
    expect(lines(log.text).map((record) => record.path)).toEqual(["/ok"]);
    expect(log.index.omitted).toEqual({ otherOrigin: 1, overCap: 0, invalid: 0 });
  });

  it("withhold a segment naming a sandbox id the run journaled, before any cut", async () => {
    // Ids with no digit are not token-shaped, so only the scrub finds them; about 1 in 700 E2B ids
    // is. The third path is long enough that the 1,024-character cut falls inside the id.
    const own = "qwertyuiopasdfghjklz";
    const other = "zxcvbnmasdfghjklpoiu";
    const log = await reduceBrowserNetwork({
      participantId: "p1",
      origins: [SITE],
      events: eventsFile([
        ...answered("0:1", 101, `${SITE}/sandboxes/${own}`),
        ...answered("0:2", 102, `${SITE}/peers/${other}`),
        ...answered("0:3", 103, `${SITE}${"/a.".repeat(335)}/${own}`),
      ]),
      marks: [],
      redact,
      sandboxIds: [own, other],
    });
    expect(
      lines(log.text)
        .slice(0, 2)
        .map((record) => record.path),
    ).toEqual(["/sandboxes/[REDACTED_URL_PART]", "/peers/[REDACTED_URL_PART]"]);
    for (const id of [own, other]) expect(log.text).not.toContain(id.slice(0, 7));
  });
});

describe("a record's method", () => {
  it("is one of the HTTP methods, or `OTHER` for any other word a page sends", async () => {
    const sent = (id: string, wallTime: number, method: string) => ({
      e: "request",
      id,
      wallTime,
      timestamp: wallTime,
      url: `${SITE}/${id}`,
      method,
      type: "Fetch",
    });
    const log = await reduce(eventsFile([sent("a", 101, "PATCH"), sent("b", 102, "SWORDISH")]));
    expect(lines(log.text).map((record) => record.method)).toEqual(["PATCH", "OTHER"]);
  });
});

describe("the record caps", () => {
  it("keep the first 20,000 records, then up to 5,000 more that failed, are pending or have status 400 or above", async () => {
    const ok = Array.from({ length: 20_001 }, (_, n) =>
      answered(`0:ok${n}`, 101 + n / 1000, `${SITE}/ok`),
    );
    const notable = Array.from({ length: 5_000 }, (_, n) =>
      n % 2 === 0
        ? failedAt(`0:f${n}`, 200 + n / 1000, `${SITE}/fail`)
        : answered(`0:e${n}`, 200 + n / 1000, `${SITE}/missing`, 404),
    );
    const pending = {
      e: "request",
      id: "0:open",
      wallTime: 199,
      timestamp: 199,
      url: `${SITE}/open`,
      method: "GET",
      type: "Fetch",
    };
    const log = await reduce(eventsFile([...ok.flat(), pending, ...notable.flat()]));
    const records = lines(log.text);
    expect(records).toHaveLength(25_000);
    expect(records.filter((record) => record.path === "/ok")).toHaveLength(20_000);
    expect(records.some((record) => record.path === "/open" && record.pending === true)).toBe(true);
    // The pending request takes one of the 5,000, so the last failure is counted with the
    // 20,001st success, not written.
    expect(log.index).toMatchObject({
      records: 25_000,
      complete: false,
      reason: "capped",
      omitted: { otherOrigin: 0, overCap: 2, invalid: 0 },
    });
  });

  it("stop before the file passes 8 MiB when every path is as long as tracePage keeps", async () => {
    // tracePage cuts a path at 1,024 characters, its marker included.
    const long = `/catalog/${"a".repeat(1_100)}`;
    const requests = Array.from({ length: 10_000 }, (_, n) =>
      answered(`0:${n}`, 101 + n / 1000, `${SITE}${long}`),
    );
    const log = await reduce(eventsFile(requests.flat()));
    const bytes = Buffer.byteLength(log.text ?? "", "utf8");
    expect(bytes).toBeLessThanOrEqual(8 * MIB);
    expect(bytes).toBeGreaterThan(8 * MIB - 2_000);
    expect(lines(log.text).length + log.index.omitted.overCap).toBe(10_000);
    expect(log.index).toMatchObject({ bytes, complete: false, reason: "capped" });
  });
});

describe("turns", () => {
  const at = async (wallTimes: number[], marks: TurnMark[]) =>
    lines(
      (
        await reduce(
          eventsFile(
            wallTimes.flatMap((wallTime, n) => answered(`0:${n}`, wallTime, `${SITE}/r${n}`)),
          ),
          marks,
        )
      ).text,
    ).map((record) => record.turn);

  it("give a request the turn of the first mark at or after its start", async () => {
    const marks = [
      { wallTime: 110, turn: 0 },
      { wallTime: 120, turn: 1 },
    ];
    expect(await at([105, 110, 110.001, 120], marks)).toEqual([0, 0, 1, 1]);
  });

  it("put a request during a dwell in the turn the dwell follows, as its mark repeats N", async () => {
    const marks = [
      { wallTime: 110, turn: 1 },
      { wallTime: 125, turn: 1 },
      { wallTime: 140, turn: 2 },
    ];
    expect(await at([115, 130], marks)).toEqual([1, 2]);
  });

  it("give a turn with no mark (held, cut off, or its read timed out) to the next mark", async () => {
    const marks = [
      { wallTime: 110, turn: 1 },
      { wallTime: 130, turn: 3 },
    ];
    expect(await at([120], marks)).toEqual([3]);
  });

  it("give requests after the last mark the last turn plus 1", async () => {
    expect(await at([150, 160], [{ wallTime: 140, turn: 4 }])).toEqual([5, 5]);
  });

  it("leave turn out and warn once when the participant has no marks", async () => {
    const log = await reduce(
      eventsFile([...answered("0:1", 101, `${SITE}/a`), ...answered("0:2", 102, `${SITE}/b`)]),
    );
    expect(lines(log.text).every((record) => !("turn" in record))).toBe(true);
    expect(log.warnings).toHaveLength(1);
  });
});

describe("complete and reason", () => {
  it("name why records are missing, with no file when nothing was collected", async () => {
    const holderCap = await reduce(
      eventsFile([...answered("0:1", 101, `${SITE}/a`), { e: "cap", wallTime: 102 }]),
    );
    expect(holderCap.index).toMatchObject({ complete: false, reason: "capped", records: 1 });

    const neverStarted = await reduce(
      eventsFile([{ e: "exit", reason: "Network.enable failed" }], false),
    );
    expect(neverStarted.index).toMatchObject({ complete: false, reason: "no-capture" });
    expect(neverStarted.index).not.toHaveProperty("path");
    expect(neverStarted.text).toBeUndefined();

    // Capture started and its only request went to another origin: no file, and the index says
    // when capture started, so a reader tells it from capture that never started.
    const nothingKept = await reduce(
      eventsFile([{ e: "request", id: "0:1", wallTime: 101, timestamp: 101 }]),
    );
    expect(nothingKept.index).toEqual({
      schema: "humanish.browser-network.v1",
      startedAt: "1970-01-01T00:01:40.000Z",
      origins: [SITE, CLOSED],
      complete: true,
      omitted: { otherOrigin: 1, overCap: 0, invalid: 0 },
    });
    expect(nothingKept.text).toBeUndefined();

    for (const missing of ["no-capture", "not-collected"] as const)
      expect(networkIndexWithoutEvents({ origins: [SITE], redact }, missing)).toEqual({
        schema: "humanish.browser-network.v1",
        origins: [SITE],
        complete: false,
        reason: missing,
        omitted: { otherOrigin: 0, overCap: 0, invalid: 0 },
      });
  });
});

describe("durations", () => {
  it("leave ms out when a request's events arrived after it finished, as a cross-origin preflight's do", async () => {
    // Chrome sends a preflight's request event after its loadingFinished, with a later timestamp.
    const log = await reduce(
      eventsFile([
        {
          e: "request",
          id: "0:1",
          wallTime: 101,
          timestamp: 50.443,
          url: `${SITE}/api/item`,
          method: "OPTIONS",
          type: "Other",
        },
        { e: "response", id: "0:1", timestamp: 50.442, status: 204 },
        { e: "finished", id: "0:1", timestamp: 50.441 },
      ]),
    );
    const [record] = lines(log.text);
    expect(record).toMatchObject({ method: "OPTIONS", status: 204 });
    expect(record).not.toHaveProperty("ms");
  });
});

describe("the cost of reducing a large events file", () => {
  /** The run's redaction, counting each text it is asked to redact. */
  const counted = () => {
    const calls = { count: 0 };
    return {
      calls,
      redact: (text: string) => {
        calls.count += 1;
        return redact(text);
      },
    };
  };
  const first = Array.from({ length: 20_000 }, (_, n) =>
    answered(`0:ok${n}`, 101 + n / 1000, `${SITE}/ok`),
  ).flat();

  it("never redacts the address of a request past the caps", async () => {
    // 2,000 more requests, each to its own path and none failed, pending or 400 or above.
    const past = Array.from({ length: 2_000 }, (_, n) =>
      answered(`0:past${n}`, 200 + n / 1000, `${SITE}/items/${n}/view`),
    ).flat();
    const within = counted();
    await reduceBrowserNetwork({
      participantId: "p1",
      origins: [SITE],
      events: eventsFile(first),
      marks: [],
      redact: within.redact,
    });
    const over = counted();
    const log = await reduceBrowserNetwork({
      participantId: "p1",
      origins: [SITE],
      events: eventsFile([...first, ...past]),
      marks: [],
      redact: over.redact,
    });
    expect(log.index.omitted.overCap).toBe(2_000);
    expect(over.calls.count).toBe(within.calls.count);
  });

  it("lets other work on the event loop run while it reduces", async () => {
    let ticks = 0;
    let running = true;
    const tick = (): void => {
      ticks += 1;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    const unique = Array.from({ length: 3_000 }, (_, n) =>
      answered(`0:${n}`, 101 + n / 1000, `${SITE}/items/${n}/view`),
    ).flat();
    await reduce(eventsFile(unique));
    running = false;
    expect(ticks).toBeGreaterThan(1);
  });
});
