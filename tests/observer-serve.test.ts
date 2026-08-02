import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ACTOR_TRACE_SCHEMA, type ActorTrace } from "../src/actor-contract.js";
import type { CuaLoopResult } from "../src/computer-use.js";
import { buildCuaBundle } from "../src/cua-actor-lab.js";
import { SERVE_COOKIE_NAME } from "../src/observer-auth.js";
import type { LibraryHistory } from "../src/observer-library.js";
import { serveObserverLibrary } from "../src/observer-serve.js";
import type { ServeLibraryOptions, ServeLibraryServer } from "../src/observer-serve.js";
import { buildRunSource, runDryRun, verifyRun } from "../src/run.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lp9J1wAAAABJRU5ErkJggg==",
  "base64"
);

// Concatenated so this test file itself never contains a secret-shaped literal
// (same convention as tests/run.test.ts and the public-surface scan).
const SYNTHETIC_SECRET = "sk-" + "testsecretvalue1234567890abcd";
const SECRET_EVENT_LINE = `{"message":"synthetic ${SYNTHETIC_SECRET}"}\n`;

const UNAUTHORIZED_BODY = "humanish serve: capability link required";
const CONTROL_PLANE_DISABLED_BODY = `${JSON.stringify(
  {
    error: {
      code: "HUMANISH_SERVE_CONTROL_PLANE_DISABLED",
      message: "control plane not enabled in this version"
    }
  },
  null,
  2
)}\n`;

const tempRoots: string[] = [];
const openServers: ServeLibraryServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

afterAll(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function createProjectFixture(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-serve-fixture-"));
  tempRoots.push(tempRoot);
  const app = path.join(tempRoot, "minimal-app");
  await cp(path.resolve("fixtures/minimal-app"), app, { recursive: true });
  return app;
}

async function startLibrary(cwd: string, overrides: Partial<ServeLibraryOptions> = {}): Promise<ServeLibraryServer> {
  const options: ServeLibraryOptions = {
    port: 0,
    safe: false,
    expose: false,
    authMode: "none",
    ttlMinutes: 720,
    ...overrides
  };
  const started = await serveObserverLibrary(cwd, options);
  if (!started.ok) {
    throw new Error(`serveObserverLibrary failed: ${started.error.code}: ${started.error.message}`);
  }
  openServers.push(started.server);
  return started.server;
}

function capabilityOptions(overrides: Partial<ServeLibraryOptions> = {}): Partial<ServeLibraryOptions> {
  return {
    expose: true,
    authMode: "link",
    publicOrigin: "https://observer.example.dev",
    ttlMinutes: 30,
    ...overrides
  };
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  bodyBytes: Buffer;
}

// node:http instead of fetch wherever the request must carry a raw path (fetch
// normalizes dot segments client-side) or an overridden Host header (undici's
// fetch silently drops a `host` entry in the headers init).
function rawRequest(
  port: number,
  requestPath: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: options.method ?? "GET",
        headers: options.headers ?? {}
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const bodyBytes = Buffer.concat(chunks);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: bodyBytes.toString("utf8"),
            bodyBytes
          });
        });
      }
    );
    request.on("error", reject);
    request.end();
  });
}

async function mintSession(
  port: number,
  token: string,
  headers: Record<string, string> = {}
): Promise<{ response: RawResponse; cookie: string; setCookie: string }> {
  const response = await rawRequest(port, `/_humanish/auth/${token}`, { headers });
  const setCookieHeaders = response.headers["set-cookie"] ?? [];
  const setCookie = setCookieHeaders[0] ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  return { response, cookie, setCookie };
}

function requireToken(server: ServeLibraryServer): string {
  if (!server.capabilityToken) {
    throw new Error("expected a capability token on this server");
  }
  return server.capabilityToken;
}

function extractLibraryData(html: string): LibraryHistory {
  const match = html.match(/<script type="application\/json" id="library-data">(.*?)<\/script>/s);
  if (!match?.[1]) {
    throw new Error("library-data script not found in library HTML");
  }
  return JSON.parse(match[1]) as LibraryHistory;
}

function expectServeSecurityHeaders(headers: http.IncomingHttpHeaders): void {
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-robots-tag"]).toBe("noindex, nofollow");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["cache-control"]).toBe("no-store");
}

async function readRunBundle(cwd: string, runId: string): Promise<{
  createdAt: string;
  mode: string;
  review: { verdict: string };
  streams: Array<{
    id: string;
    transport: string;
    artifacts: Array<{ label: string; path: string; kind: string }>;
    embed?: { kind: string; url?: string; title?: string };
    ui?: Record<string, string>;
  }>;
}> {
  const text = await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8");
  return JSON.parse(text) as Awaited<ReturnType<typeof readRunBundle>>;
}

async function writeBlockedRun(cwd: string, runId: string): Promise<{ originalEvents: string }> {
  const run = await runDryRun({ cwd, dryRun: true, runId });
  expect(run.ok).toBe(true);
  const eventsPath = path.join(cwd, ".humanish", "runs", runId, "events.ndjson");
  const originalEvents = await readFile(eventsPath, "utf8");
  await appendFile(eventsPath, SECRET_EVENT_LINE, "utf8");
  return { originalEvents };
}

function rawScreenshotActorTrace(): ActorTrace {
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "openai-responses-cu",
    protocol: "cua-loop",
    lane: "computer-use",
    persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "digest" },
    redaction: {
      status: "passed",
      screenshots: "raw",
      notes: "synthetic public-safe test trace"
    },
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    durationMs: 5_000,
    status: "passed",
    completionReason: "goal_satisfied",
    reason: "model reported a natural endpoint with no further action",
    ids: { model: "computer-use-preview" },
    counts: { turns: 2, actions: 1, screenshots: 0, reasonings: 0, messages: 1, idleTurns: 0, noProgressTurns: 0 },
    items: [
      { id: "action-001", kind: "ui_action", lifecycle: "completed", title: "click (11, 22)" },
      { id: "message-001", kind: "message", lifecycle: "completed", title: "message", text: "Done." }
    ],
    capabilities: {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: true,
      byoModel: false,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "proprietary"
    }
  };
}

// Mirrors tests/run.test.ts writeCuaRunFixture: a live bundle whose actor trace
// declares raw screenshots, which verify judges local_only (RAW_SCREENSHOTS).
async function writeLocalOnlyRun(cwd: string, runId: string): Promise<void> {
  const trace = rawScreenshotActorTrace();
  const session: CuaLoopResult = {
    status: trace.status,
    completionReason: trace.completionReason,
    reason: trace.reason,
    trace
  };
  const bundle = buildCuaBundle({
    actorId: "openai-computer-use",
    appUrl: "http://127.0.0.1:3000/",
    createdAt: "2026-01-01T00:00:00.000Z",
    dryRun: false,
    labId: "serve-safe-proof",
    mission: "Explore the app and stop.",
    persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "digest" },
    resolution: [1440, 960],
    runId,
    screenshots: [],
    session,
    traceArtifactPath: "actor.json",
    source: await buildRunSource({ cwd, humanishSource: "present", packageName: "humanish" })
  });
  const runDir = path.join(cwd, ".humanish", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "review.json"), `${JSON.stringify(bundle.review, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "review.md"), `# ${bundle.scenario.title}\n\n- verdict: ${bundle.review.verdict}\n`, "utf8");
  await writeFile(
    path.join(runDir, "events.ndjson"),
    `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8"
  );
  await writeFile(path.join(runDir, "actor.json"), `${JSON.stringify(trace, null, 2)}\n`, "utf8");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("serve: loopback mode", () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await createProjectFixture();
    expect((await runDryRun({ cwd, dryRun: true, runId: "run-alpha" })).ok).toBe(true);
    expect((await runDryRun({ cwd, dryRun: true, runId: "run-beta" })).ok).toBe(true);
    // A marker outside the pinned proof root (.humanish/runs) that traversal
    // must never reach.
    await writeFile(path.join(cwd, ".humanish", "outside.txt"), "outside-proof-root marker\n", "utf8");
  });

  it("(6) GET / serves the library HTML listing fixture runs with the latest highlighted", async () => {
    const server = await startLibrary(cwd);
    expect(server.mode).toBe("loopback");
    expect(server.runsListed).toBe(2);

    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const html = await response.text();
    const data = extractLibraryData(html);
    expect(data.latestRunId).toBe("run-beta");
    expect(data.runs.map((run) => run.runId).sort()).toEqual(["run-alpha", "run-beta"]);
    const byId = new Map(data.runs.map((run) => [run.runId, run]));
    expect(byId.get("run-alpha")?.href).toBe("/_humanish/runs/run-alpha/observer/index.html");
    expect(byId.get("run-beta")?.href).toBe("/_humanish/runs/run-beta/observer/index.html");
    // The latest badge is rendered client-side off latestRunId.
    expect(html).toContain("badge latest");
  });

  it("(7) /_humanish/history.json fields match the on-disk runs", async () => {
    const server = await startLibrary(cwd);
    const response = await fetch(new URL("/_humanish/history.json", server.url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");

    const history = (await response.json()) as LibraryHistory;
    expect(history.latestRunId).toBe("run-beta");
    expect(history.runs.map((run) => run.runId).sort()).toEqual(["run-alpha", "run-beta"]);

    for (const runId of ["run-alpha", "run-beta"]) {
      const entry = history.runs.find((run) => run.runId === runId);
      expect(entry).toBeTruthy();
      const bundle = await readRunBundle(cwd, runId);
      expect(entry?.createdAt).toBe(bundle.createdAt);
      expect(entry?.mode).toBe(bundle.mode);
      expect(entry?.mode).toBe("dry-run");
      expect(entry?.status).toBe(bundle.review.verdict);
      expect(entry?.streamCount).toBe(bundle.streams.length);
      expect(entry?.href).toBe(`/_humanish/runs/${runId}/observer/index.html`);
    }
  });

  it("(8) serves the run page, its observer-data.json, and ../run.json under the run prefix", async () => {
    const server = await startLibrary(cwd);

    const page = await fetch(new URL("/_humanish/runs/run-alpha/observer/index.html", server.url));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toContain('id="observer-data"');

    const data = await fetch(new URL("/_humanish/runs/run-alpha/observer/observer-data.json", server.url));
    expect(data.status).toBe(200);
    expect(data.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const observerData = (await data.json()) as { run: { runId: string } };
    expect(observerData.run.runId).toBe("run-alpha");

    const bundle = await fetch(new URL("/_humanish/runs/run-alpha/run.json", server.url));
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const parsed = (await bundle.json()) as { runId: string };
    expect(parsed.runId).toBe("run-alpha");
  });

  it("(9) refuses traversal attempts without ever leaking content across run roots", async () => {
    const server = await startLibrary(cwd);

    // Encoded traversal survives URL parsing intact and must die at the pinned
    // file layer: 403, no sibling bytes.
    const encoded = await fetch(new URL("/_humanish/runs/run-alpha/..%2frun-beta/run.json", server.url));
    expect(encoded.status).toBe(403);
    const encodedBody = await encoded.text();
    expect(encodedBody).toBe("Forbidden");
    expect(encodedBody).not.toContain("run-beta");

    const dotEncoded = await fetch(new URL("/_humanish/runs/run-alpha/%2e%2e%2frun-beta/run.json", server.url));
    expect([403, 404]).toContain(dotEncoded.status);
    expect(await dotEncoded.text()).not.toContain('"runId"');

    // Raw dot segments escaping the runs namespace entirely: 404, and the
    // marker outside the proof root is never served.
    const outside = await rawRequest(server.port, "/_humanish/runs/run-alpha/../../outside.txt");
    expect(outside.status).toBe(404);
    expect(outside.body).not.toContain("outside-proof-root");

    const projectFile = await rawRequest(server.port, "/_humanish/runs/run-alpha/../../../package.json");
    expect(projectFile.status).toBe(404);
    expect(projectFile.body).not.toContain('"name"');

    // Raw /../ between two run ids: WHATWG URL parsing (client and server
    // alike) resolves dot segments before routing, so this arrives as the
    // ordinary run-beta route -- byte-identical to requesting run-beta
    // directly, and still subject to every route gate (safe-mode admission is
    // pinned in the safe-mode suite below). The traversal path never reaches
    // the file layer.
    const direct = await rawRequest(server.port, "/_humanish/runs/run-beta/run.json");
    const rawSibling = await rawRequest(server.port, "/_humanish/runs/run-alpha/../run-beta/run.json");
    expect(rawSibling.status).toBe(direct.status);
    expect(rawSibling.bodyBytes.equals(direct.bodyBytes)).toBe(true);

    // The server survives all of the above.
    const after = await fetch(server.url);
    expect(after.status).toBe(200);
  });

  it("(10) rejects non-GET/HEAD methods with 405", async () => {
    const server = await startLibrary(cwd);

    const post = await fetch(server.url, { method: "POST" });
    expect(post.status).toBe(405);
    expect(await post.text()).toBe("Method Not Allowed");

    const put = await fetch(new URL("/_humanish/runs/run-alpha/run.json", server.url), { method: "PUT" });
    expect(put.status).toBe(405);
    expect(await put.text()).toBe("Method Not Allowed");
  });

  it("(11) answers the reserved control-plane namespace with the exact 501 body", async () => {
    const server = await startLibrary(cwd);

    const response = await fetch(new URL("/_humanish/api/runs", server.url));
    expect(response.status).toBe(501);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = await response.text();
    expect(body).toBe(CONTROL_PLANE_DISABLED_BODY);
    const parsed = JSON.parse(body) as { error: { code: string } };
    expect(parsed.error.code).toBe("HUMANISH_SERVE_CONTROL_PLANE_DISABLED");
  });

  it("(12) allows loopback Hosts and answers 421 for undeclared Hosts", async () => {
    const server = await startLibrary(cwd);

    const loopback = await rawRequest(server.port, "/", { headers: { host: `127.0.0.1:${server.port}` } });
    expect(loopback.status).toBe(200);

    const localhost = await rawRequest(server.port, "/", { headers: { host: `localhost:${server.port}` } });
    expect(localhost.status).toBe(200);

    const evil = await rawRequest(server.port, "/", { headers: { host: "evil.example" } });
    expect(evil.status).toBe(421);
    expect(evil.body).toBe("Misdirected Request");
  });

  it("(13) sends the full security header set on 200, 302, 404, 405, 421, and 501 responses", async () => {
    const server = await startLibrary(cwd);
    const entryServer = await startLibrary(cwd, { entryRunId: "run-beta" });

    const responses: Array<[number, RawResponse]> = [
      [200, await rawRequest(server.port, "/")],
      [302, await rawRequest(entryServer.port, "/")],
      [404, await rawRequest(server.port, "/_humanish/runs/no-such-run/observer/index.html")],
      [405, await rawRequest(server.port, "/", { method: "POST" })],
      [421, await rawRequest(server.port, "/", { headers: { host: "evil.example" } })],
      [501, await rawRequest(server.port, "/_humanish/api/runs")]
    ];

    for (const [status, response] of responses) {
      expect(response.status).toBe(status);
      expectServeSecurityHeaders(response.headers);
    }
    expect(responses[1]?.[1].headers.location).toBe("/_humanish/runs/run-beta/observer/index.html");
  });
});

describe("serve: stream gate", () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await createProjectFixture();
    expect((await runDryRun({ cwd, dryRun: true, runId: "stream-run" })).ok).toBe(true);

    // Doctor the bundle to declare a stream embed, mirroring what a live
    // producer persists, plus the screenshot evidence file it points at.
    const runDir = path.join(cwd, ".humanish", "runs", "stream-run");
    await mkdir(path.join(runDir, "screenshots"), { recursive: true });
    await writeFile(path.join(runDir, "screenshots", "proof.png"), PNG_1X1);

    const bundlePath = path.join(runDir, "run.json");
    const bundle = await readRunBundle(cwd, "stream-run");
    const stream = bundle.streams[0];
    expect(stream).toBeTruthy();
    stream!.embed = { kind: "screenshot", url: "screenshots/proof.png", title: "Synthetic screenshot evidence" };
    stream!.ui = { ...(stream!.ui ?? {}), screenshotUrl: "screenshots/proof.png" };
    stream!.artifacts.push({ label: "synthetic screenshot evidence", path: "screenshots/proof.png", kind: "screenshot" });
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  });

  it("(14) never rewrites persisted streams with runtime transport or hosted substrate URLs", async () => {
    const server = await startLibrary(cwd);

    const response = await fetch(new URL("/_humanish/runs/stream-run/observer/observer-data.json", server.url));
    expect(response.status).toBe(200);
    const text = await response.text();

    // The serveObserver runtime-stream rewrite marks a stream `transport: sse`
    // and swaps its embed to a hosted iframe URL. The serve surface must never
    // apply it: no sse transport, no injected URL of any kind.
    expect(text).not.toContain('"transport": "sse"');
    expect(text).not.toContain('"transport":"sse"');
    expect(text.toLowerCase()).not.toContain("e2b.dev");
    expect(text.toLowerCase()).not.toContain("e2b.app");
    expect(text).not.toContain("https://");

    const data = JSON.parse(text) as {
      streams: Array<{ transport: string; embed?: { kind: string; url?: string } }>;
    };
    const stream = data.streams[0];
    expect(stream?.embed?.kind).toBe("screenshot");
    expect(stream?.embed?.url).toBe("screenshots/proof.png");
    expect(stream?.transport).not.toBe("sse");

    // The rendered run page carries the same untouched data.
    const page = await fetch(new URL("/_humanish/runs/stream-run/observer/index.html", server.url));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain('"transport":"sse"');
    expect(html.toLowerCase()).not.toContain("e2b.dev");
  });
});

describe("serve: capability-link mode", () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await createProjectFixture();
    expect((await runDryRun({ cwd, dryRun: true, runId: "cap-run" })).ok).toBe(true);
    const runDir = path.join(cwd, ".humanish", "runs", "cap-run");
    await mkdir(path.join(runDir, "screenshots"), { recursive: true });
    await writeFile(path.join(runDir, "screenshots", "proof.png"), PNG_1X1);
  });

  it("(15) answers every cookieless route with a byte-identical 401 body", async () => {
    const server = await startLibrary(cwd, capabilityOptions());
    expect(server.mode).toBe("capability-link");
    expect(server.capabilityToken).toBeTruthy();

    const routes = ["/", "/_humanish/history.json", "/_humanish/runs/cap-run/observer/index.html"];
    const responses = await Promise.all(routes.map((route) => rawRequest(server.port, route)));
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.body).toBe(UNAUTHORIZED_BODY);
      expect(response.bodyBytes.equals(Buffer.from(UNAUTHORIZED_BODY, "utf8"))).toBe(true);
    }
  });

  it("(16) rejects wrong and odd-length token candidates without crashing the server", async () => {
    const server = await startLibrary(cwd, capabilityOptions());

    const wrong = await rawRequest(server.port, "/_humanish/auth/definitely-not-the-token");
    expect(wrong.status).toBe(401);
    expect(wrong.body).toBe(UNAUTHORIZED_BODY);

    // Odd-length candidate: a naive hex-decode comparison would throw inside
    // timingSafeEqual; the digest-first comparison must not.
    const oddLength = await rawRequest(server.port, "/_humanish/auth/abc");
    expect(oddLength.status).toBe(401);

    // Malformed percent-encoding must also be handled, not crash the process.
    const malformed = await rawRequest(server.port, "/_humanish/auth/%zz");
    expect(malformed.status).toBe(401);

    // Server is still up and still mints for the real token.
    const mint = await mintSession(server.port, requireToken(server));
    expect(mint.response.status).toBe(302);
    const authed = await rawRequest(server.port, "/", { headers: { cookie: mint.cookie } });
    expect(authed.status).toBe(200);
  });

  it("(17) mints a session with the exact cookie attributes, Secure only behind https forwarding", async () => {
    const server = await startLibrary(cwd, capabilityOptions());
    const token = requireToken(server);

    const plain = await rawRequest(server.port, `/_humanish/auth/${token}`);
    expect(plain.status).toBe(302);
    expect(plain.headers.location).toBe("/");
    const plainSetCookies = plain.headers["set-cookie"] ?? [];
    expect(plainSetCookies).toHaveLength(1);
    // ttlMinutes 30 -> Max-Age=1800. Secure ABSENT on plain loopback.
    expect(plainSetCookies[0]).toMatch(
      new RegExp(`^${SERVE_COOKIE_NAME}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800$`)
    );

    const forwarded = await rawRequest(server.port, `/_humanish/auth/${token}`, {
      headers: { "x-forwarded-proto": "https" }
    });
    expect(forwarded.status).toBe(302);
    const forwardedSetCookies = forwarded.headers["set-cookie"] ?? [];
    expect(forwardedSetCookies).toHaveLength(1);
    expect(forwardedSetCookies[0]).toMatch(
      new RegExp(`^${SERVE_COOKIE_NAME}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800; Secure$`)
    );

    // fetch with redirect manual sees the same 302 contract.
    const viaFetch = await fetch(new URL(`/_humanish/auth/${token}`, server.url), { redirect: "manual" });
    expect(viaFetch.status).toBe(302);
    expect(viaFetch.headers.get("location")).toBe("/");
  });

  it("(18) root-relative pin: one minted cookie reaches library, history, observer data, and screenshots", async () => {
    const server = await startLibrary(cwd, capabilityOptions());
    const { cookie } = await mintSession(server.port, requireToken(server));

    const library = await fetch(server.url, { headers: { cookie } });
    expect(library.status).toBe(200);
    expect(extractLibraryData(await library.text()).runs.map((run) => run.runId)).toContain("cap-run");

    const history = await fetch(new URL("/_humanish/history.json", server.url), { headers: { cookie } });
    expect(history.status).toBe(200);

    const observerData = await fetch(
      new URL("/_humanish/runs/cap-run/observer/observer-data.json", server.url),
      { headers: { cookie } }
    );
    expect(observerData.status).toBe(200);

    const screenshot = await fetch(
      new URL("/_humanish/runs/cap-run/screenshots/proof.png", server.url),
      { headers: { cookie } }
    );
    expect(screenshot.status).toBe(200);
    expect(screenshot.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await screenshot.arrayBuffer()).equals(PNG_1X1)).toBe(true);
  });

  it("(19) never trusts the loopback peer address as authentication", async () => {
    const server = await startLibrary(cwd, capabilityOptions());

    // This request arrives over the real 127.0.0.1 socket -- exactly where a
    // tunnel agent connects from. A loopback-peer bypass would return 200 here.
    const response = await rawRequest(server.port, "/_humanish/history.json");
    expect(response.status).toBe(401);
    expect(response.body).toBe(UNAUTHORIZED_BODY);
  });

  it("(20) expires sessions by injected clock, while the mint URL stays reusable", async () => {
    let nowMs = Date.parse("2026-01-01T12:00:00.000Z");
    const server = await startLibrary(cwd, capabilityOptions({ ttlMinutes: 10, now: () => nowMs }));
    const token = requireToken(server);

    const first = await mintSession(server.port, token);
    expect(first.response.status).toBe(302);
    expect((await rawRequest(server.port, "/", { headers: { cookie: first.cookie } })).status).toBe(200);

    nowMs += 10 * 60_000; // expiresAt <= now
    const expired = await rawRequest(server.port, "/", { headers: { cookie: first.cookie } });
    expect(expired.status).toBe(401);
    expect(expired.body).toBe(UNAUTHORIZED_BODY);

    // Re-tapping the same capability link mints a fresh session: not single-use.
    const second = await mintSession(server.port, token);
    expect(second.response.status).toBe(302);
    expect((await rawRequest(server.port, "/", { headers: { cookie: second.cookie } })).status).toBe(200);
  });

  it("(21) accepts the declared public Host with a valid cookie and 421s undeclared Hosts regardless", async () => {
    const server = await startLibrary(cwd, capabilityOptions());
    const { cookie } = await mintSession(server.port, requireToken(server));

    const declared = await rawRequest(server.port, "/", {
      headers: { host: "observer.example.dev", cookie }
    });
    expect(declared.status).toBe(200);

    const undeclared = await rawRequest(server.port, "/", {
      headers: { host: "evil.example", cookie }
    });
    expect(undeclared.status).toBe(421);
  });

  it("(22) redirects an authenticated GET / to the entry run's observer page", async () => {
    const server = await startLibrary(cwd, capabilityOptions({ entryRunId: "cap-run" }));
    expect(server.entryRunId).toBe("cap-run");
    const { cookie } = await mintSession(server.port, requireToken(server));

    const root = await rawRequest(server.port, "/", { headers: { cookie } });
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe("/_humanish/runs/cap-run/observer/index.html");

    // Auth still precedes the entry redirect.
    const cookieless = await rawRequest(server.port, "/");
    expect(cookieless.status).toBe(401);
  });

  it("(23) a second mint creates a second concurrently valid session", async () => {
    const server = await startLibrary(cwd, capabilityOptions());
    const token = requireToken(server);

    const first = await mintSession(server.port, token);
    const second = await mintSession(server.port, token);
    expect(first.response.status).toBe(302);
    expect(second.response.status).toBe(302);
    expect(first.cookie).not.toBe(second.cookie);

    expect((await rawRequest(server.port, "/", { headers: { cookie: first.cookie } })).status).toBe(200);
    expect((await rawRequest(server.port, "/", { headers: { cookie: second.cookie } })).status).toBe(200);
    // The first session survives the second mint.
    expect((await rawRequest(server.port, "/", { headers: { cookie: first.cookie } })).status).toBe(200);
  });
});

describe("serve: safe mode", () => {
  let cwd: string;
  let emptyCwd: string;

  beforeAll(async () => {
    cwd = await createProjectFixture();
    expect((await runDryRun({ cwd, dryRun: true, runId: "safe-ready" })).ok).toBe(true);
    // Created second, so latest.json points at the blocked run: the filtered
    // latestRunId fallback is exercised for real.
    await writeBlockedRun(cwd, "safe-blocked");
    await writeLocalOnlyRun(cwd, "safe-raw");

    // Fixture sanity: the three admission verdicts are what this suite claims.
    const ready = await verifyRun(cwd, "safe-ready");
    expect(ready.ok).toBe(true);
    expect(ready.shareSafety.status).toBe("share_ready");
    const blocked = await verifyRun(cwd, "safe-blocked");
    expect(blocked.ok).toBe(false);
    expect(blocked.shareSafety.status).toBe("blocked");
    expect(blocked.shareSafety.reasons.map((reason) => reason.code)).toContain("PUBLIC_SAFETY_FINDINGS");
    const raw = await verifyRun(cwd, "safe-raw");
    expect(raw.ok).toBe(true);
    expect(raw.shareSafety.status).toBe("local_only");
    expect(raw.shareSafety.reasons.map((reason) => reason.code)).toContain("RAW_SCREENSHOTS");

    emptyCwd = await createProjectFixture();
    await writeBlockedRun(emptyCwd, "only-blocked");
  });

  it("(24) lists only share_ready runs; non-admitted URLs 404 byte-identically to nonexistent runs", async () => {
    const server = await startLibrary(cwd, { safe: true });
    expect(server.runsListed).toBe(1);
    expect(server.shareReadyCount).toBe(1);

    const history = (await (await fetch(new URL("/_humanish/history.json", server.url))).json()) as LibraryHistory;
    expect(history.runs.map((run) => run.runId)).toEqual(["safe-ready"]);

    const html = await (await fetch(server.url)).text();
    const data = extractLibraryData(html);
    expect(data.runs.map((run) => run.runId)).toEqual(["safe-ready"]);
    expect(html).not.toContain("safe-blocked");
    expect(html).not.toContain("safe-raw");

    const nonexistent = await rawRequest(server.port, "/_humanish/runs/no-such-run/observer/index.html");
    expect(nonexistent.status).toBe(404);
    for (const runId of ["safe-blocked", "safe-raw"]) {
      const hidden = await rawRequest(server.port, `/_humanish/runs/${runId}/observer/index.html`);
      expect(hidden.status).toBe(404);
      // No existence oracle: byte-identical body and content type.
      expect(hidden.bodyBytes.equals(nonexistent.bodyBytes)).toBe(true);
      expect(hidden.headers["content-type"]).toBe(nonexistent.headers["content-type"]);
      expect((await rawRequest(server.port, `/_humanish/runs/${runId}/run.json`)).status).toBe(404);
    }

    // Raw dot segments cannot route around admission: the URL normalizes to
    // the blocked run's own route, which is 404 in safe mode.
    const traversal = await rawRequest(server.port, "/_humanish/runs/safe-ready/../safe-blocked/run.json");
    expect(traversal.status).toBe(404);
    expect(traversal.bodyBytes.equals(nonexistent.bodyBytes)).toBe(true);

    expect((await fetch(new URL("/_humanish/runs/safe-ready/observer/index.html", server.url))).status).toBe(200);
  });

  it("(27) safe mode composes with the capability link: 401 without a session, 404 for non-admitted runs with one", async () => {
    const server = await startLibrary(cwd, capabilityOptions({ safe: true }));
    expect(server.mode).toBe("capability-link");

    const cookieless = await rawRequest(server.port, "/");
    expect(cookieless.status).toBe(401);
    expect(cookieless.body).toBe(UNAUTHORIZED_BODY);

    const { cookie } = await mintSession(server.port, requireToken(server));
    const blocked = await rawRequest(server.port, "/_humanish/runs/safe-blocked/observer/index.html", {
      headers: { cookie }
    });
    expect(blocked.status).toBe(404);

    const ready = await rawRequest(server.port, "/_humanish/runs/safe-ready/observer/index.html", {
      headers: { cookie }
    });
    expect(ready.status).toBe(200);
  });

  it("(28) serves the safe empty state when zero runs are share_ready", async () => {
    const server = await startLibrary(emptyCwd, { safe: true });
    expect(server.runsListed).toBe(0);

    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("No share_ready runs yet");
    const data = extractLibraryData(html);
    expect(data.runs).toEqual([]);
    expect(data.latestRunId).toBeNull();

    const history = (await (await fetch(new URL("/_humanish/history.json", server.url))).json()) as LibraryHistory;
    expect(history.runs).toEqual([]);
    expect(history.latestRunId).toBeNull();
  });

  it("(29) filtered latestRunId is an admitted run's id or null, never a hidden run", async () => {
    const server = await startLibrary(cwd, { safe: true });
    const history = (await (await fetch(new URL("/_humanish/history.json", server.url))).json()) as LibraryHistory;

    // On-disk latest.json points at safe-blocked (created last); the filtered
    // history must fall back to an admitted run instead of leaking that id.
    expect(history.latestRunId).toBe("safe-ready");
    const admitted = new Set(history.runs.map((run) => run.runId));
    expect(history.latestRunId === null || admitted.has(history.latestRunId)).toBe(true);
  });
});

describe("serve: safe mode resilience", () => {
  it("(25) hides a run with a truncated run.json and keeps serving the rest", async () => {
    const cwd = await createProjectFixture();
    expect((await runDryRun({ cwd, dryRun: true, runId: "intact-run" })).ok).toBe(true);
    expect((await runDryRun({ cwd, dryRun: true, runId: "corrupt-run" })).ok).toBe(true);
    const corruptPath = path.join(cwd, ".humanish", "runs", "corrupt-run", "run.json");
    const original = await readFile(corruptPath, "utf8");
    await writeFile(corruptPath, original.slice(0, Math.floor(original.length / 2)), "utf8");

    const server = await startLibrary(cwd, { safe: true });

    const history = (await (await fetch(new URL("/_humanish/history.json", server.url))).json()) as LibraryHistory;
    expect(history.runs.map((run) => run.runId)).toEqual(["intact-run"]);
    expect(history.latestRunId).toBe("intact-run");

    expect((await fetch(new URL("/_humanish/runs/corrupt-run/observer/index.html", server.url))).status).toBe(404);
    expect((await fetch(new URL("/_humanish/runs/intact-run/observer/index.html", server.url))).status).toBe(200);

    // Server stays up after chewing on the truncated bundle.
    expect((await fetch(server.url)).status).toBe(200);
  });

  it("(26) caches admission per run.json identity and re-verifies when the bundle changes", async () => {
    const cwd = await createProjectFixture();
    expect((await runDryRun({ cwd, dryRun: true, runId: "cache-ready" })).ok).toBe(true);
    const { originalEvents } = await writeBlockedRun(cwd, "cache-blocked");

    const verifySpy = vi.fn(verifyRun);
    const server = await startLibrary(cwd, { safe: true, verifyImpl: verifySpy });

    const callsFor = (runId: string): number =>
      verifySpy.mock.calls.filter((call) => call[1] === runId).length;

    const firstHistory = (await (await fetch(new URL("/_humanish/history.json", server.url))).json()) as LibraryHistory;
    expect(firstHistory.runs.map((run) => run.runId)).toEqual(["cache-ready"]);
    const secondHistory = (await (await fetch(new URL("/_humanish/history.json", server.url))).json()) as LibraryHistory;
    expect(secondHistory.runs.map((run) => run.runId)).toEqual(["cache-ready"]);

    // One verify per run covers startup plus both history requests: the
    // admission cache keys on the run.json stat identity.
    expect(callsFor("cache-ready")).toBe(1);
    expect(callsFor("cache-blocked")).toBe(1);

    // Clean the blocked run (restore the pre-secret event log) and touch
    // run.json so its stat identity changes.
    await writeFile(path.join(cwd, ".humanish", "runs", "cache-blocked", "events.ndjson"), originalEvents, "utf8");
    await sleep(5);
    const bundlePath = path.join(cwd, ".humanish", "runs", "cache-blocked", "run.json");
    await writeFile(bundlePath, await readFile(bundlePath, "utf8"), "utf8");

    const thirdHistory = (await (await fetch(new URL("/_humanish/history.json", server.url))).json()) as LibraryHistory;
    expect(thirdHistory.runs.map((run) => run.runId).sort()).toEqual(["cache-blocked", "cache-ready"]);
    expect(callsFor("cache-blocked")).toBe(2);
    expect(callsFor("cache-ready")).toBe(1);

    expect((await fetch(new URL("/_humanish/runs/cache-blocked/observer/index.html", server.url))).status).toBe(200);
  });
});
