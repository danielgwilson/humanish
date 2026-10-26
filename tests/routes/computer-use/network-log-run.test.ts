// A hosted computer-use participant's network log, on fake hosted desktops ($0). With
// execution.network set, the participant's desktop starts the in-sandbox DevTools holder in
// capture mode, pairs each checkpoint screenshot with the sandbox time of the browser-state read
// before it, and at teardown reads the holder's events file, reduces it and writes
// network/<participant id>.ndjson, indexed on the stream as `network` and registered as a log. A
// capture that fails is a warning and an index that says why; the participant runs as it would.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCuaActorSession } from "../../../src/actors/computer-use/actor.js";
import { runStudyWith } from "../../../src/run-study.js";
import { loadRunBundle } from "../../../src/run/locate.js";
import { parseStudy } from "../../../src/study/config.js";
import { verifyRun } from "../../../src/verify/verify.js";
import { lab } from "../../admission/fixtures.js";
import {
  makeFanoutModule,
  scriptedParticipant,
  TWO_TURN_SESSION,
  type FanoutModuleOptions,
} from "../../helpers/fanout-desktop.js";
import { makeTestTempDir } from "../../helpers/temp-dir.js";

const ENV = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };
const SITE = "http://127.0.0.1:3000";
const API = "https://api.example.com";
const EVENTS_PATH = "/tmp/humanish-network/events.ndjson";
/** The sandbox clock at the first browser-state read; each later read is 10 s on. */
const T = 1_792_116_000;

const line = (value: object): string => `${JSON.stringify(value)}\n`;

/**
 * What the holder wrote: capture starting before the first read, a page load at the first read's
 * exact time, an add to cart and a refused API call between the two reads, a list call after the
 * last read that never finished, and one request to an origin outside the allowed list.
 */
const EVENTS = [
  { e: "start", wallTime: T - 5 },
  {
    e: "request",
    id: "0:1",
    wallTime: T,
    timestamp: 50,
    url: `${SITE}/`,
    method: "GET",
    type: "Document",
  },
  { e: "response", id: "0:1", timestamp: 50.04, status: 200 },
  { e: "finished", id: "0:1", timestamp: 50.05 },
  { e: "request", id: "0:2", wallTime: T + 1, timestamp: 51 },
  {
    e: "request",
    id: "0:3",
    wallTime: T + 5,
    timestamp: 55,
    url: `${SITE}/api/cart`,
    method: "POST",
    type: "Fetch",
  },
  { e: "response", id: "0:3", timestamp: 55.08, status: 500 },
  { e: "finished", id: "0:3", timestamp: 55.09 },
  {
    e: "request",
    id: "0:4",
    wallTime: T + 6,
    timestamp: 56,
    url: `${API}/v1/items`,
    method: "GET",
    type: "Fetch",
  },
  { e: "failed", id: "0:4", timestamp: 56.01, errorText: "net::ERR_CONNECTION_REFUSED" },
  {
    e: "request",
    id: "0:5",
    wallTime: T + 15,
    timestamp: 65,
    url: `${SITE}/api/list`,
    method: "GET",
    type: "XHR",
  },
]
  .map(line)
  .join("");

const announce = (network: object): string =>
  line({ applied: [], held: true, targetId: "page-1", network });

/** A phone page's own report under mobile emulation, as the fidelity read-back prints it. */
const PHONE_READ = line({
  fidelity: {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1",
    devicePixelRatio: 3,
    innerWidth: 414,
    innerHeight: 896,
    maxTouchPoints: 5,
    coarsePointer: true,
  },
  targetId: "page-1",
});

/**
 * A fake desktop whose holder announces `holderLog` (nothing when undefined), whose state reads
 * carry the sandbox clock, and whose events file holds `events` (missing when undefined). With
 * `mobile`, the announce is the emulation holder's and the page reports the phone viewport.
 */
function capturingDesktop(options: {
  holderLog?: string;
  events?: string;
  launched?: string;
  geometry?: () => never;
  mobile?: boolean;
  /** The holder's process had exited by teardown: its wrapper wrote an exit status. */
  exited?: boolean;
}): FanoutModuleOptions {
  let reads = 0;
  const holder = options.mobile === true ? "/mobile-emulation-" : "/network-capture-";
  return {
    measuredChrome: true,
    commandHandler: (_laneIndex, command) => {
      if (options.mobile === true && command.includes('"mode":"fidelity"'))
        return { stdout: PHONE_READ };
      if (command.includes('"mode":"state"'))
        return {
          stdout: line({
            url: `${SITE}/`,
            title: "app",
            text: "",
            scrollY: 0,
            targetId: "page-1",
            now: T + 10 * reads++,
          }),
        };
      if (options.geometry !== undefined && command.includes('"mode":"geometry"'))
        options.geometry();
      if (command.includes("tail -c 8192") && command.includes(holder))
        return { stdout: options.holderLog ?? "" };
      if (options.exited === true && command.includes("/status") && command.includes(holder))
        return { stdout: "exited\n" };
      if (options.launched !== undefined && command.includes("browser_preference="))
        return { stdout: options.launched };
      return undefined;
    },
    readFile: (_laneIndex, file) => (file === EVENTS_PATH ? options.events : undefined),
  };
}

/**
 * Runs an app-url study with `execution.network` on fake desktops built with `fakes`: one
 * participant unless `participants` lists them, its desktop set up by `desktop`, and capture as
 * `network` sets it.
 */
async function runWithCapture(
  fakes: FanoutModuleOptions,
  study: {
    desktop?: Record<string, unknown>;
    participants?: unknown[];
    network?: false | { origins: string[] };
  } = {},
) {
  const parsed = parseStudy(
    lab("cuAppUrl", {
      mode: "live",
      execution: {
        target: "e2b-desktop",
        timeoutMs: 60_000,
        network: study.network ?? { origins: [API] },
        ...(study.desktop === undefined ? {} : { desktop: study.desktop }),
      },
      ...(study.participants === undefined ? {} : { participants: study.participants }),
      review: { analysis: false },
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  const handle = makeFanoutModule(fakes);
  const cwd = await makeTestTempDir("humanish-network-log-run-");
  const outcome = await runStudyWith(
    parsed.config,
    { cwd, env: ENV, open: false },
    {
      desktopModule: async () => handle.module,
      subjectPhaseSink: () => undefined,
      runSession: async (session) =>
        runCuaActorSession({
          ...session,
          participant: scriptedParticipant(TWO_TURN_SESSION),
        }),
    },
  );
  if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
  const loaded = await loadRunBundle(cwd, outcome.result.runId);
  if (loaded === null) throw new Error("the run wrote no bundle");
  const [stream] = loaded.bundle.streams;
  if (stream === undefined) throw new Error("the run recorded no participant");
  const commandScripts = [...(handle.files.values().next().value?.entries() ?? [])]
    .filter(([file]) => file.endsWith("/command.sh"))
    .map(([, bytes]) => bytes.toString("utf8"));
  return {
    result: outcome.result,
    stream,
    streams: loaded.bundle.streams,
    runDir: loaded.runDir,
    cwd,
    commandScripts,
  };
}

describe("a hosted participant's network log", () => {
  it("is written, indexed on the stream and registered, each request numbered by the turn it fell in", async () => {
    const { result, stream, runDir, commandScripts } = await runWithCapture(
      capturingDesktop({ holderLog: announce({ startedAt: T - 5 }), events: EVENTS }),
    );
    expect(result.session?.status).toBe("passed");
    // A desktop participant's holder captures only: no emulation request goes with it.
    const holder = commandScripts.find((script) => script.includes('"mode":"hold"'));
    const payload = JSON.parse(holder?.match(/'([^']*)'\s*$/)?.[1] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      mode: "hold",
      network: { eventsPath: EVENTS_PATH, origins: [SITE, API] },
    });
    expect(payload.emulation).toBeUndefined();

    const file = `network/${stream.laneId}.ndjson`;
    expect(stream.network).toMatchObject({
      schema: "humanish.browser-network.v1",
      path: file,
      records: 4,
      failed: 1,
      pending: 1,
      startedAt: "2026-10-16T01:59:55.000Z",
      origins: [SITE, API],
      complete: true,
      omitted: { otherOrigin: 1, overCap: 0, invalid: 0 },
    });
    expect(stream.artifacts).toContainEqual({ label: "network log", path: file, kind: "log" });
    const records = (await readFile(path.join(runDir, file), "utf8"))
      .trimEnd()
      .split("\n")
      .map((text) => JSON.parse(text) as Record<string, unknown>);
    expect(records).toEqual([
      {
        at: "2026-10-16T02:00:00.000Z",
        turn: 0,
        method: "GET",
        origin: SITE,
        path: "/",
        type: "document",
        status: 200,
        ms: 50,
      },
      {
        at: "2026-10-16T02:00:05.000Z",
        turn: 1,
        method: "POST",
        origin: SITE,
        path: "/api/cart",
        type: "fetch",
        status: 500,
        ms: 90,
      },
      {
        at: "2026-10-16T02:00:06.000Z",
        turn: 1,
        method: "GET",
        origin: API,
        path: "/v1/items",
        type: "fetch",
        ms: 10,
        failed: "ERR_CONNECTION_REFUSED",
      },
      {
        at: "2026-10-16T02:00:15.000Z",
        turn: 2,
        method: "GET",
        origin: SITE,
        path: "/api/list",
        type: "xhr",
        pending: true,
      },
    ]);
  });

  it("is captured by a phone participant's emulation holder, which starts no second holder", async () => {
    const { stream, commandScripts } = await runWithCapture(
      capturingDesktop({
        holderLog: line({
          applied: ["Emulation.setDeviceMetricsOverride", "Page.reload"],
          held: true,
          targetId: "page-1",
          network: { startedAt: T - 5 },
        }),
        events: EVENTS,
        mobile: true,
      }),
      { desktop: { device: "mobile", browser: "chrome", fidelity: { mobileEmulation: true } } },
    );
    const holders = commandScripts
      .filter((script) => script.includes('"mode":"hold"'))
      .map((script) => JSON.parse(script.match(/'([^']*)'\s*$/)?.[1] ?? "{}") as object);
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatchObject({
      emulation: { width: 414 },
      network: { eventsPath: EVENTS_PATH, origins: [SITE, API] },
    });
    expect(stream.network).toMatchObject({ records: 4, failed: 1, pending: 1, complete: true });
  });

  it("gives each participant of a fan-out its own file, registered on its own stream", async () => {
    const { streams, runDir } = await runWithCapture(
      capturingDesktop({ holderLog: announce({ startedAt: T - 5 }), events: EVENTS }),
      { participants: [{ id: "first" }, { id: "second" }] },
    );
    expect(streams.map((participant) => [participant.laneId, participant.network?.path])).toEqual([
      ["first", "network/first.ndjson"],
      ["second", "network/second.ndjson"],
    ]);
    for (const participant of streams)
      expect(participant.artifacts).toContainEqual({
        label: `participant ${participant.laneId} network log`,
        path: `network/${participant.laneId}.ndjson`,
        kind: "log",
      });
    expect((await readdir(path.join(runDir, "network"))).sort()).toEqual([
      "first.ndjson",
      "second.ndjson",
    ]);
  });

  it("still collects the file when the final geometry capture throws", async () => {
    const { stream, runDir } = await runWithCapture(
      capturingDesktop({
        holderLog: announce({ startedAt: T - 5 }),
        events: EVENTS,
        geometry: () => {
          throw new Error("synthetic geometry failure");
        },
      }),
    );
    expect(stream.network).toMatchObject({ records: 4, complete: true });
    expect(await readdir(path.join(runDir, "network"))).toEqual([`${stream.laneId}.ndjson`]);
  });
});

describe("a hosted participant whose capture kept no request", () => {
  it("writes no file, and the run keeps the grade of the same run without capture", async () => {
    // Capture started, then the only request went to an origin outside the list.
    const events = [
      { e: "start", wallTime: T - 5 },
      { e: "request", id: "0:1", wallTime: T + 1, timestamp: 51 },
    ]
      .map(line)
      .join("");
    const fakes = (): FanoutModuleOptions =>
      capturingDesktop({ holderLog: announce({ startedAt: T - 5 }), events });
    const grade = async (run: { cwd: string; result: { runId: string } }) => {
      const verified = await verifyRun(run.cwd, run.result.runId);
      return {
        status: verified.shareSafety.status,
        codes: verified.shareSafety.reasons.map((reason) => reason.code),
      };
    };
    const control = await runWithCapture(fakes(), { network: false });
    const capture = await runWithCapture(fakes());
    expect(capture.result.ok).toBe(control.result.ok);
    expect(await grade(capture)).toEqual(await grade(control));
    expect(capture.stream.network).toEqual({
      schema: "humanish.browser-network.v1",
      startedAt: "2026-10-16T01:59:55.000Z",
      origins: [SITE, API],
      complete: true,
      omitted: { otherOrigin: 1, overCap: 0, invalid: 0 },
    });
    expect(capture.stream.artifacts.map((artifact) => artifact.path)).not.toContain(
      `network/${capture.stream.laneId}.ndjson`,
    );
    await expect(readdir(path.join(capture.runDir, "network"))).rejects.toThrow(/ENOENT/);
  });
});

describe("a hosted participant's network log through the run's sandbox id sweep", () => {
  it("holds no raw sandbox id, so the finished run's file still matches its index", async () => {
    // The fake desktop's sandbox id, in a path the participant's app put it in.
    const events = `${EVENTS}${line({
      e: "request",
      id: "0:6",
      wallTime: T + 16,
      timestamp: 66,
      url: `${SITE}/sandboxes/fake-sandbox-01`,
      method: "GET",
      type: "Fetch",
    })}`;
    const { result, stream, runDir, cwd } = await runWithCapture(
      capturingDesktop({ holderLog: announce({ startedAt: T - 5 }), events }),
    );
    const bytes = await readFile(path.join(runDir, `network/${stream.laneId}.ndjson`));
    expect(bytes.toString("utf8")).not.toContain("fake-sandbox-01");
    expect(stream.network).toMatchObject({
      records: 5,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.checks.find((check) => check.name === "public-safety scan")?.ok).toBe(true);
    expect(verified.shareSafety.reasons.map((reason) => reason.code)).not.toContain(
      "RAW_SANDBOX_ID",
    );
  });
});

describe("a fan-out participant's network log naming another participant's sandbox", () => {
  it("withholds every journaled id, so each finished file still matches its index", async () => {
    // Both fake desktops' ids, in paths each participant's app put them in: one is its own, the
    // other its peer's, which the run journaled when that desktop was created.
    const peers = [1, 2].map((serial, index) =>
      line({
        e: "request",
        id: `0:${6 + index}`,
        wallTime: T + 16 + index,
        timestamp: 66 + index,
        url: `${SITE}/peers/fake-sandbox-0${serial}`,
        method: "GET",
        type: "Fetch",
      }),
    );
    const { streams, runDir, cwd, result } = await runWithCapture(
      capturingDesktop({
        holderLog: announce({ startedAt: T - 5 }),
        events: `${EVENTS}${peers.join("")}`,
      }),
      { participants: [{ id: "first" }, { id: "second" }] },
    );
    for (const participant of streams) {
      const bytes = await readFile(path.join(runDir, `network/${participant.laneId}.ndjson`));
      expect(bytes.toString("utf8")).not.toContain("fake-sandbox-0");
      expect(participant.network).toMatchObject({
        records: 6,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.checks.find((check) => check.name === "public-safety scan")?.ok).toBe(true);
  });
});

describe("a hosted participant whose capture fails", () => {
  it.each([
    ["a holder that never announces", capturingDesktop({ events: EVENTS })],
    [
      "a holder that could not start capture",
      capturingDesktop({
        holderLog: announce({ unavailable: "Network.enable failed" }),
        events: EVENTS,
      }),
    ],
    [
      "a default browser that falls back to Firefox",
      capturingDesktop({
        events: EVENTS,
        launched: "HUMANISH_BROWSER_RESOLVED=firefox\nHUMANISH_BROWSER_PID=4242\n",
      }),
    ],
  ])(
    "records %s as one warning and no capture, and runs the participant",
    async (_label, fakes) => {
      const { result, stream, runDir } = await runWithCapture(fakes);
      expect(result.session?.status).toBe("passed");
      expect(stream.network).toEqual({
        schema: "humanish.browser-network.v1",
        origins: [SITE, API],
        complete: false,
        reason: "no-capture",
        omitted: { otherOrigin: 0, overCap: 0, invalid: 0 },
      });
      expect(result.warnings.filter((warning) => /network log/i.test(warning))).toHaveLength(1);
      expect(stream.artifacts.map((artifact) => artifact.path)).not.toContain(
        `network/${stream.laneId}.ndjson`,
      );
      await expect(readdir(path.join(runDir, "network"))).rejects.toThrow(/ENOENT/);
    },
  );

  it.each([false, true])(
    "records a holder that was killed before teardown as stopped (phone participant: %s)",
    async (mobile) => {
      // A holder killed by a signal writes no exit line, so the file alone reads as complete.
      const { stream } = await runWithCapture(
        capturingDesktop({
          holderLog: mobile
            ? line({ applied: [], held: true, targetId: "page-1", network: { startedAt: T - 5 } })
            : announce({ startedAt: T - 5 }),
          events: EVENTS,
          exited: true,
          mobile,
        }),
        mobile
          ? {
              desktop: { device: "mobile", browser: "chrome", fidelity: { mobileEmulation: true } },
            }
          : {},
      );
      expect(stream.network).toMatchObject({
        records: 4,
        complete: false,
        reason: "holder-stopped",
      });
    },
  );

  it("records an events file it cannot read as not collected, and runs the participant", async () => {
    const { result, stream } = await runWithCapture(
      capturingDesktop({ holderLog: announce({ startedAt: T - 5 }) }),
    );
    expect(result.session?.status).toBe("passed");
    expect(stream.network).toMatchObject({ complete: false, reason: "not-collected" });
    expect(stream.network?.path).toBeUndefined();
    expect(result.warnings.filter((warning) => /network log/i.test(warning))).toHaveLength(1);
  });
});

describe("a hosted participant in a study without execution.network", () => {
  it("starts no capture holder and leaves its stream without a network field", async () => {
    const parsed = parseStudy(lab("cuAppUrl", { mode: "live", review: { analysis: false } }));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const handle = makeFanoutModule(
      capturingDesktop({ holderLog: announce({ startedAt: T - 5 }), events: EVENTS }),
    );
    const cwd = await makeTestTempDir("humanish-network-log-off-");
    const outcome = await runStudyWith(
      parsed.config,
      { cwd, env: ENV, open: false },
      {
        desktopModule: async () => handle.module,
        subjectPhaseSink: () => undefined,
        runSession: async (session) =>
          runCuaActorSession({
            ...session,
            participant: scriptedParticipant(TWO_TURN_SESSION),
          }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    const loaded = await loadRunBundle(cwd, outcome.result.runId);
    expect(loaded?.bundle.streams[0]?.network).toBeUndefined();
    const scripts = [...(handle.files.values().next().value?.values() ?? [])].map((bytes) =>
      bytes.toString("utf8"),
    );
    expect(scripts.some((script) => script.includes('"mode":"hold"'))).toBe(false);
  });
});
