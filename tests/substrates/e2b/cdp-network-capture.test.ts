// The holder's network capture, run the way a sandbox runs it: the real python3 holder against a
// real headless Chrome. One synthetic site produces every case the host reduces, with a sentinel in
// each place a secret travels (cookie, POST body, Authorization header, query string), and the
// events file the holder writes must carry each case and none of the sentinels.
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reduceBrowserNetwork } from "../../../src/evidence/browser-network.js";
import { redactText } from "../../../src/evidence/redaction.js";
import { traceRedaction } from "../../../src/evidence/trace-page.js";
import { NETWORK_CAPTURE_PY } from "../../../src/substrates/e2b/cdp-network-capture.js";
import { parseChromeCdpProbeOutput } from "../../../src/substrates/e2b/cdp-probe.js";
import { applyMobileEmulation } from "../../../src/substrates/e2b/desktop-cdp.js";
import type { E2BDesktopSandbox } from "../../../src/substrates/e2b/sdk.js";
import { spawnHolder, type SpawnedHolder } from "../../helpers/cdp-holder.js";
import { freePort } from "../../helpers/free-port.js";
import {
  findChrome,
  hasPython3,
  launchReadableChrome,
  stopChrome,
} from "../../helpers/readable-chrome.js";

const COOKIE = "COOKIEVALUE123";
const BODY = "BODYVALUE000";
const AUTH = "AUTHVALUE789";
const QUERY = "QUERYVALUE321";

/** A synthetic app on 127.0.0.1 and what reached it. */
interface FixtureSite {
  origin: string;
  /** Answers the same server under a second origin. */
  otherOrigin: string;
  /** A port nothing listens on: bound, read and closed again. */
  closedPort: number;
  /** Paths requested so far, in order. */
  seen: string[];
  /** Each request's line, headers and body, to prove each sentinel went over the wire. */
  wire: string[];
  close(): Promise<void>;
}

function page(body: string): string {
  return `<html><head><title>shop</title></head><body>${body}</body></html>`;
}

// The page under capture. It fetches every case, waits for each body so each request finishes,
// follows a link, and is restored from the back-forward cache by /next's history.back(). The
// restore then opens one request the server never answers.
function flowPage(otherOrigin: string, closedPort: number): string {
  return page(`<img src="/img.png"><a id="next" href="/next">next</a><script>
    window.addEventListener("pageshow", (event) => { if (event.persisted) fetch("/hang"); });
    const read = (input, init) => fetch(input, init).then((response) => response.text());
    Promise.allSettled([
      read("/ok"),
      read("/err"),
      read("/slow"),
      read("/redirect"),
      read("/submit", { method: "POST", body: "${BODY}", headers: { Authorization: "Bearer ${AUTH}" } }),
      read("/drop"),
      read("${otherOrigin}/second"),
      read("http://127.0.0.1:${closedPort}/closed"),
    ]).then(() => {
      if (sessionStorage.getItem("went")) return;
      sessionStorage.setItem("went", "1");
      document.getElementById("next").click();
    });
  </script>`);
}

function route(site: FixtureSite, request: IncomingMessage, response: ServerResponse): void {
  const pathname = new URL(request.url ?? "/", site.origin).pathname;
  const html = (body: string) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(body);
  };
  switch (pathname) {
    case "/start":
      return html(page("start"));
    case "/flow":
      response.setHeader("set-cookie", `s=${COOKIE}; Path=/`);
      return html(flowPage(site.otherOrigin, site.closedPort));
    case "/next":
      return html(
        page(`<img src="/img.png">next<script>setTimeout(() => history.back(), 500);</script>`),
      );
    case "/later-tab":
      return html(page(`later<script>setTimeout(() => fetch("/from-later-tab"), 500);</script>`));
    case "/img.png":
      response.setHeader("content-type", "image/gif");
      response.setHeader("cache-control", "max-age=3600");
      return void response.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
    case "/err":
      response.statusCode = 500;
      return void response.end("err");
    case "/slow":
      return void setTimeout(() => response.end("slow"), 300);
    case "/redirect":
      response.statusCode = 302;
      response.setHeader("location", `/ok?q=${QUERY}`);
      return void response.end();
    case "/drop":
      return void request.socket.destroy();
    case "/hang":
      return;
    case "/second":
      response.setHeader("access-control-allow-origin", "*");
      return void response.end("second");
    default:
      response.end("ok");
  }
}

async function startFixtureSite(): Promise<FixtureSite> {
  let server: Server | undefined;
  const site: FixtureSite = {
    origin: "",
    otherOrigin: "",
    closedPort: await freePort(),
    seen: [],
    wire: [],
    close: () =>
      new Promise<void>((resolve) => {
        if (server === undefined) return resolve();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  server = createServer((request, response) => {
    site.seen.push(new URL(request.url ?? "/", "http://site").pathname);
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () =>
      site.wire.push(`${request.method} ${request.url} ${JSON.stringify(request.headers)} ${body}`),
    );
    route(site, request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  site.origin = `http://127.0.0.1:${port}`;
  site.otherOrigin = `http://localhost:${port}`;
  return site;
}

/** Navigate a page target over its own DevTools socket, as a second client beside the holder. */
async function navigate(cdpPort: number, targetId: string, url: string): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${cdpPort}/devtools/page/${targetId}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const replied = new Promise<void>((resolve) =>
    socket.addEventListener("message", (event) => {
      if ((JSON.parse(String(event.data)) as { id?: number }).id === 1) resolve();
    }),
  );
  socket.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url } }));
  await replied;
  socket.close();
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${what} did not happen within 30 s`);
}

type CaptureLine = Record<string, unknown> & { e: string };

/** The last 4 KiB of a file as text, without reading the 32 MiB before it. */
async function tailLines(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 4096);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

const readLines = async (file: string): Promise<CaptureLine[]> =>
  (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CaptureLine);

// The keys the holder may write, per the capture contract. A header, cookie, body or initiator
// field showing up here is a leak.
const CAPTURE_KEYS = new Set([
  "e",
  "id",
  "wallTime",
  "timestamp",
  "method",
  "type",
  "url",
  "redirectResponse",
  "status",
  "fromDiskCache",
  "fromPrefetchCache",
  "fromServiceWorker",
  "errorText",
  "reason",
  "faults",
]);

function expectRequestCases(lines: CaptureLine[], origin: string, closedPort: number): void {
  const requests = (url: string) => lines.filter((l) => l.e === "request" && l.url === url);
  const ofId = (id: unknown, e: string) => lines.filter((l) => l.id === id && l.e === e);
  const only = (url: string): CaptureLine => {
    const found = requests(url);
    expect(found.map((l) => l.url)).toEqual([url]);
    return found[0]!;
  };
  const flow = only(`${origin}/flow`);
  expect(flow).toMatchObject({ method: "GET", type: "Document" });
  expect(ofId(flow.id, "response")[0]).toMatchObject({ status: 200 });
  expect(ofId(only(`${origin}/err`).id, "response")[0]).toMatchObject({ status: 500 });
  const slow = only(`${origin}/slow`);
  const slowEnd = ofId(slow.id, "finished")[0]!;
  expect((slowEnd.timestamp as number) - (slow.timestamp as number)).toBeGreaterThanOrEqual(0.3);
  // A redirect is a second request line on the same id, carrying the 3xx it followed.
  const hop = only(`${origin}/redirect`);
  const followed = ofId(hop.id, "request").find((l) => l.url === `${origin}/ok`);
  expect(followed).toMatchObject({ redirectResponse: { status: 302 }, method: "GET" });
  expect(ofId(hop.id, "response")[0]).toMatchObject({ status: 200 });
  const submit = only(`${origin}/submit`);
  expect(submit).toMatchObject({ method: "POST", type: "Fetch" });
  expect(ofId(submit.id, "response")[0]).toMatchObject({ status: 200 });
  // The second load of the image comes from a cache.
  const images = requests(`${origin}/img.png`);
  expect(images).toHaveLength(2);
  const second = images[1]!;
  expect(
    ofId(second.id, "servedFromCache").length > 0 ||
      ofId(second.id, "response")[0]?.fromDiskCache === true,
    JSON.stringify(ofId(second.id, "response")),
  ).toBe(true);
  // A dropped connection and a refused port fail with no response.
  const drop = only(`${origin}/drop`);
  expect(ofId(drop.id, "failed")[0]?.errorText).toMatch(/^net::ERR_[A-Z_]+$/);
  expect(ofId(drop.id, "response")).toEqual([]);
  const refused = only(`http://127.0.0.1:${closedPort}/closed`);
  expect(ofId(refused.id, "failed")[0]).toMatchObject({ errorText: "net::ERR_CONNECTION_REFUSED" });
  expect(ofId(refused.id, "response")).toEqual([]);
  // A request still open when the holder stopped has only its request line.
  const hang = only(`${origin}/hang`);
  expect(lines.filter((l) => l.id === hang.id).map((l) => l.e)).toEqual(["request"]);
}

function expectNavigationAndOriginCases(lines: CaptureLine[], origin: string): void {
  const flow = lines.find((l) => l.e === "request" && l.url === `${origin}/flow`)!;
  expect(lines.find((l) => l.e === "request" && l.url === `${origin}/next`)).toMatchObject({
    type: "Document",
  });
  const restored = lines.filter((l) => l.e === "backForward");
  expect(restored).toEqual([expect.objectContaining({ url: `${origin}/flow` })]);
  // A tab opened after the holder attached is captured on its own session.
  const later = lines.find((l) => l.e === "request" && l.url === `${origin}/from-later-tab`);
  expect(later, "the later tab's fetch").toBeDefined();
  const sessionOf = (line: CaptureLine) => String(line.id).split(":")[0];
  expect(sessionOf(later!)).not.toBe(sessionOf(flow));
  // The second origin is not allowed: its request line has no address, method or type, and
  // nothing else is written for it.
  const offOrigin = lines.filter((l) => l.e === "request" && l.url === undefined);
  expect(offOrigin.length).toBeGreaterThanOrEqual(1);
  for (const line of offOrigin) {
    expect(line.method).toBeUndefined();
    expect(line.type).toBeUndefined();
    expect(lines.filter((l) => l.id === line.id && l.e !== "request")).toEqual([]);
  }
}

function expectNothingSensitive(text: string, lines: CaptureLine[], site: FixtureSite): void {
  // Each sentinel did travel: the server saw all four.
  const wire = site.wire.join("\n");
  for (const sentinel of [COOKIE, BODY, AUTH, QUERY]) {
    expect(wire, `the server never saw ${sentinel}`).toContain(sentinel);
    expect(text).not.toContain(sentinel);
  }
  expect(text).not.toContain(site.otherOrigin);
  for (const name of ["cookie", "authorization", "content-type", "cache-control", "location"])
    expect(text.toLowerCase()).not.toContain(name);
  for (const line of lines) {
    const extra = Object.keys(line).filter((key) => !CAPTURE_KEYS.has(key));
    const nested = Object.keys((line.redirectResponse as object | undefined) ?? {}).filter(
      (key) => !CAPTURE_KEYS.has(key),
    );
    expect([...extra, ...nested], JSON.stringify(line)).toEqual([]);
  }
}

// Rewrites the run's random ports to fixed ones, so the committed copy reads the same each time.
function normalizedFixture(text: string, site: FixtureSite): string {
  return text
    .replaceAll(site.origin, "http://127.0.0.1:3000")
    .replaceAll(`http://127.0.0.1:${site.closedPort}`, "http://127.0.0.1:3999");
}

const python3 = hasPython3();
const chrome = findChrome();
const live = python3 && chrome !== undefined;

describe("holder network capture against a real headless Chrome", () => {
  let site: FixtureSite | undefined;
  let browser: Parameters<typeof stopChrome>[0];
  let profileDir = "";
  let cdpPort = 0;
  let workDir = "";
  let holder: SpawnedHolder | undefined;
  // A holder without capture announced on this runner, so one with capture that does not is a
  // fault in the capture code, not the runner's Chrome.
  let holderComesUp = false;

  beforeAll(async () => {
    if (!live) return;
    workDir = await mkdtemp(path.join(tmpdir(), "humanish-network-capture-"));
    site = await startFixtureSite();
    const launch = await launchReadableChrome(chrome, `${site.origin}/start`, 60_000);
    if (!launch.chrome)
      throw new Error(`headless Chrome never read back: ${launch.failures.join("; ")}`);
    ({ browser, profileDir, cdpPort } = launch.chrome);
    const control = spawnHolder({ prefer: "pinned", cdpPort, targetUrl: `${site.origin}/start` });
    holderComesUp = (await control.announce()) !== undefined;
    control.kill();
  }, 120_000);

  /**
   * The holder's announce, or undefined when no holder comes up on this runner. A capture holder
   * that prints none where a holder without capture did fails the case with its stderr.
   */
  const announceOf = async (spawned: SpawnedHolder): Promise<string | undefined> => {
    const line = await spawned.announce();
    if (line === undefined && holderComesUp)
      throw new Error(
        `the holder printed no announce where one without capture did: ${spawned.stderrTail()}`,
      );
    return line;
  };

  afterAll(async () => {
    holder?.kill();
    await stopChrome(browser, profileDir);
    await site?.close();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }, 20_000);

  it.skipIf(!live)(
    "a holder with only network capture sends no Emulation command and never reloads the page",
    async (ctx) => {
      const fixture = site!;
      const loadsBefore = fixture.seen.filter((seen) => seen === "/start").length;
      const captureOnly = spawnHolder({
        prefer: "pinned",
        cdpPort,
        targetUrl: `${fixture.origin}/start`,
        network: {
          eventsPath: path.join(workDir, "capture-only.ndjson"),
          origins: [fixture.origin],
        },
      });
      try {
        const announce = await announceOf(captureOnly);
        if (announce === undefined)
          return ctx.skip(`the holder did not come up on this runner: ${captureOnly.stderrTail()}`);
        expect(JSON.parse(announce), announce).toMatchObject({ applied: [], held: true });
        // A reload reaches the server within a few hundred ms; this waits well past that.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(fixture.seen.filter((seen) => seen === "/start")).toHaveLength(loadsBefore);
        expect(captureOnly.lines().filter((line) => line.includes("Emulation."))).toEqual([]);
      } finally {
        captureOnly.kill();
      }
    },
    45_000,
  );

  it.skipIf(!live)(
    "stops at 32 MiB with one cap line, appending to what the events file already holds",
    async (ctx) => {
      const fixture = site!;
      const eventsPath = path.join(workDir, "capped.ndjson");
      // Room for the start line and nothing more: the next request reaches the cap.
      const cap = 32 * 1024 * 1024;
      await writeFile(eventsPath, "");
      await truncate(eventsPath, cap - 600);
      const capped = spawnHolder({
        prefer: "pinned",
        cdpPort,
        targetUrl: `${fixture.origin}/start`,
        network: { eventsPath, origins: [fixture.origin] },
      });
      let tab: string | undefined;
      try {
        if ((await announceOf(capped)) === undefined)
          return ctx.skip(`the holder did not come up on this runner: ${capped.stderrTail()}`);
        tab = (
          (await (
            await fetch(`http://127.0.0.1:${cdpPort}/json/new?${fixture.origin}/later-tab`, {
              method: "PUT",
            })
          ).json()) as { id: string }
        ).id;
        await until(
          async () => (await tailLines(eventsPath)).includes('"e":"cap"'),
          "the cap line",
        );
        // The tab keeps loading after the cap; nothing more may be written.
        await until(() => fixture.seen.includes("/from-later-tab"), "the later tab's fetch");
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect((await stat(eventsPath)).size).toBeLessThanOrEqual(cap);
        // The pre-sized part is NUL bytes with no newline, so the first line starts after them.
        const written = (await tailLines(eventsPath))
          .split("\n")
          .map((line) => line.replace(/^\0+/, ""))
          .filter((line) => line.startsWith("{"));
        expect(written.map((line) => (JSON.parse(line) as CaptureLine).e)).toEqual([
          "start",
          "cap",
        ]);
      } finally {
        capped.kill();
        if (tab !== undefined) await fetch(`http://127.0.0.1:${cdpPort}/json/close/${tab}`);
      }
    },
    60_000,
  );

  it.skipIf(!live || !existsSync("/dev/full"))(
    "emulates the page and announces capture as unavailable when the events file cannot be written",
    async (ctx) => {
      const fixture = site!;
      // Opening /dev/full succeeds and every write to it fails with ENOSPC.
      const full = spawnHolder({
        prefer: "pinned",
        cdpPort,
        targetUrl: `${fixture.origin}/start`,
        emulation: { width: 414, height: 896, deviceScaleFactor: 3, touch: true, userAgent: "x" },
        network: { eventsPath: "/dev/full", origins: [fixture.origin] },
      });
      try {
        const announce = await announceOf(full);
        if (announce === undefined)
          return ctx.skip(`the holder did not come up on this runner: ${full.stderrTail()}`);
        const result = parseChromeCdpProbeOutput(announce);
        expect(result.applied, announce).toContain("Emulation.setDeviceMetricsOverride");
        expect(result.unavailable, announce).toBeUndefined();
        expect(result.network, announce).toEqual({ unavailable: expect.any(String) });
      } finally {
        full.kill();
      }
    },
    45_000,
  );

  it.skipIf(!live)(
    "writes each request case, trimmed to ids, clocks, status, cache, failure and allowed addresses",
    async (ctx) => {
      const fixture = site!;
      const eventsPath = path.join(workDir, "network", "events.ndjson");
      const before = Date.now() / 1000;
      holder = spawnHolder({
        prefer: "pinned",
        cdpPort,
        targetUrl: `${fixture.origin}/start`,
        network: {
          eventsPath,
          origins: [fixture.origin, `http://127.0.0.1:${fixture.closedPort}`],
        },
      });
      const announceLine = await announceOf(holder);
      if (announceLine === undefined)
        return ctx.skip(`the holder did not come up on this runner: ${holder.stderrTail()}`);
      const announced = parseChromeCdpProbeOutput(announceLine);
      expect(announced.applied, announceLine).toEqual([]);
      expect(announced.network, announceLine).toEqual({ startedAt: expect.any(Number) });

      await navigate(cdpPort, announced.targetId!, `${fixture.origin}/flow`);
      await until(() => fixture.seen.includes("/hang"), "the back-forward restore");
      await fetch(`http://127.0.0.1:${cdpPort}/json/new?${fixture.origin}/later-tab`, {
        method: "PUT",
      });
      await until(async () => {
        const lines = await readLines(eventsPath);
        const urls = new Set(lines.map((line) => line.url));
        return urls.has(`${fixture.origin}/from-later-tab`) && urls.has(`${fixture.origin}/hang`);
      }, "the later tab's fetch reaching the events file");
      // Chrome going away closes the holder's socket; the holder says so as its last line.
      await stopChrome(browser, profileDir);
      await holder.exited;

      const text = await readFile(eventsPath, "utf8");
      const lines = await readLines(eventsPath);
      expect(lines[0]).toMatchObject({ e: "start" });
      expect(lines[0]!.wallTime).toBeGreaterThanOrEqual(before);
      expect(lines.at(-1)).toMatchObject({ e: "exit", reason: expect.stringMatching(/closed/) });
      expectRequestCases(lines, fixture.origin, fixture.closedPort);
      expectNavigationAndOriginCases(lines, fixture.origin);
      expectNothingSensitive(text, lines, fixture);
      // Set to rewrite the committed wire fixture (tests/fixtures/browser-network/README.md).
      const out = process.env.HUMANISH_NETWORK_FIXTURE_OUT;
      if (out) await writeFile(out, normalizedFixture(text, fixture), "utf8");
    },
    90_000,
  );
});

describe("the holder's address for a path past 4,096 characters", () => {
  /** The address the shipped holder writes for `url` when `origin` is allowed. */
  const holderAddress = (url: string, origin: string): string =>
    execFileSync(
      "python3",
      [
        "-I",
        "-c",
        `import json, os, re, sys, time\n${NETWORK_CAPTURE_PY}\nprint(allowed_address(sys.argv[1], {sys.argv[2]}))`,
        url,
        origin,
      ],
      { encoding: "utf8" },
    ).trimEnd();

  it.skipIf(!python3)(
    "ends at a whole segment, so the host never sees a token cut below the length it withholds",
    async () => {
      const origin = "https://app.example.test";
      // The reset token starts at character 4,081 of the path and crosses 4,096.
      const reset = "k3j9x8m2q7w4e5r6t1y0u3i8o2p5a7s9";
      const url = `${origin}/img/${"a1b2c3d4".repeat(509).slice(0, 4_069)}/reset/${reset}`;
      const address = holderAddress(url, origin);
      const log = await reduceBrowserNetwork({
        participantId: "p1",
        origins: [origin],
        events: [
          { e: "start", wallTime: 100 },
          { e: "request", id: "0:1", wallTime: 101, timestamp: 1, url: address, type: "Fetch" },
        ]
          .map((line) => `${JSON.stringify(line)}\n`)
          .join(""),
        marks: [],
        redact: traceRedaction((text) => text, redactText),
      });
      expect(log.text).not.toContain(reset.slice(0, 8));
      expect(JSON.parse(log.text ?? "{}")).toMatchObject({
        path: "/img/[REDACTED_URL_PART]/reset/[TRUNCATED]",
      });
    },
  );
});

describe("the holder after its events file reached the cap", () => {
  it.skipIf(!python3)(
    "tracks no more requests, so its memory stays flat once it writes nothing",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "humanish-network-cap-"));
      const script = [
        "import json, os, re, sys, time",
        NETWORK_CAPTURE_PY,
        'log = NetworkLog({"eventsPath": sys.argv[1], "origins": ["https://app.example.test"]})',
        "log.capped = True",
        "for n in range(1000):",
        '    log.event("Network.requestWillBeSent", {"requestId": str(n), "wallTime": 1.0, "timestamp": 1.0, "request": {"url": "https://app.example.test/x", "method": "GET"}}, None)',
        "print(len(log.open))",
      ].join("\n");
      const open = execFileSync("python3", ["-I", "-c", script, path.join(dir, "events.ndjson")], {
        encoding: "utf8",
      });
      await rm(dir, { recursive: true, force: true });
      expect(open.trim()).toBe("0");
    },
  );
});

describe("applyMobileEmulation with network capture", () => {
  it("hands the capture request to the holder only and returns the holder's capture status", async () => {
    const userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148";
    const announce = {
      applied: ["Emulation.setDeviceMetricsOverride", "Page.reload"],
      held: true,
      targetId: "LAUNCH",
      network: { startedAt: 1792116685.37 },
    };
    const readBack = {
      fidelity: {
        userAgent,
        devicePixelRatio: 3,
        innerWidth: 414,
        innerHeight: 896,
        maxTouchPoints: 5,
        coarsePointer: true,
      },
      targetId: "LAUNCH",
    };
    const files = new Map<string, string>();
    const commands: string[] = [];
    const desktop = {
      commands: {
        run: async (command: string) => {
          commands.push(command);
          const stdout = command.includes("tail -c")
            ? `${JSON.stringify(announce)}\n`
            : command.includes('"mode":"fidelity"')
              ? JSON.stringify(readBack)
              : "";
          return { exitCode: 0, stdout, stderr: "" };
        },
      },
      files: { write: async (file: string, data: string) => void files.set(file, data) },
    } as unknown as E2BDesktopSandbox;
    const network = {
      eventsPath: "/tmp/humanish-network/events.ndjson",
      origins: ["https://shop.example"],
    };
    const result = await applyMobileEmulation(
      desktop,
      1_000,
      { targetUrl: "https://shop.example/" },
      { width: 414, height: 896, deviceScaleFactor: 3, touch: true, userAgent },
      { network },
    );
    const holderScript = [...files].find(([file]) => file.endsWith("/command.sh"))?.[1] ?? "";
    expect(holderScript).toContain('"mode":"hold"');
    expect(holderScript).toContain(`"network":${JSON.stringify(network)}`);
    const reads = commands.filter((command) => command.includes('"mode":"fidelity"'));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((command) => command.includes('"network":{'))).toEqual([]);
    expect(result.network).toEqual({ startedAt: 1792116685.37 });
  });
});
