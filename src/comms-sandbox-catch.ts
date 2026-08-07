// Deploy the vendor-neutral email catch INSIDE the subject E2B sandbox and bridge captured sends back
// to the host bus (#297 config-block core). The host `startEmailCatchServer` binds the HOST's loopback,
// which a sandboxed app cannot reach — `127.0.0.1:PORT` from the app is the SANDBOX's loopback. So the
// listener must live in the sandbox: we write a tiny self-contained capture server (no deps, no host
// import) into the sandbox, launch it detached (the same substrate that serves the subject app), and
// each poll `cat` its append-only NDJSON of captured sends back to the host, where the real profiles
// parse them and route into the CommsChannel. A FIXED loopback port is chosen up front so the app's
// injected base-URL env (`http://127.0.0.1:<port>`) is known before the sandbox is created.

import type { CommsAddress, CommsChannel, CommsMessage } from "./comms-types.js";
import { FakeInbox } from "./comms-fake-inbox.js";
import { buildCommsThreadArtifact, type CommsThreadArtifact } from "./comms-evidence.js";
import { buildInboxSurface, type InboxRenderOptions } from "./comms-inbox.js";
import { DEFAULT_EMAIL_PROFILES, type EmailSendProfile } from "./comms-email-catch.js";
import { startDetachedProcess, type DetachedTimers } from "./e2b-detached.js";
import type { E2BDesktopSandbox } from "./e2b-desktop-launch.js";

/** The default in-sandbox loopback port for the catch. Fixed (not ephemeral) so the injected base-URL
 *  env is known before `createDesktopSandbox`. 8025 is the conventional local-mail-UI port and is
 *  unlikely to collide with a subject app; override via config if it does. */
export const DEFAULT_SANDBOX_CATCH_PORT = 8025;
const DEFAULT_CATCH_DIR = "/tmp/humanish-comms";

/** Single-quote for safe shell interpolation. */
function shq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The self-contained in-sandbox capture server — a plain **python3** script (stdlib only), because the
 * stock E2B desktop template ships python3 but NOT node, and the co-located catcher must run in a
 * runtime the sandbox guarantees (the precedented choice: LocalStack is a python catcher the app points
 * at; you pick the runtime the environment has). It runs on the sandbox's own python3, imports nothing
 * from humanish. DELIBERATELY dumb: it records each POST verbatim as an NDJSON line `{t, path, body}`
 * and returns a plausible provider success — all normalization/profile parsing happens host-side on the
 * drained lines, so the typed, tested profiles stay in one place. It also serves the host-rendered inbox
 * surface statically at /inbox + /api/inbox (with a script-forbidding CSP). argv: <port> <deliveriesFile>
 * <servedDir> [inboxPort]. The capture listener binds 127.0.0.1 (loopback) — the app under test reaches
 * it in-sandbox, nothing on the internet can inject a fake send. When an [inboxPort] is given (the
 * shared-world route, where the persona lives in a DIFFERENT sandbox), it ALSO starts a READ-ONLY inbox
 * listener on 0.0.0.0:<inboxPort> so getHost can proxy the persona's inbox reads to it; that listener
 * serves GET only (POST → 405). The CUA same-sandbox route omits it and stays loopback-only.
 */
export const SANDBOX_CATCH_SCRIPT = `import json
import os
import random
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8025
OUT_FILE = sys.argv[2] if len(sys.argv) > 2 else "/tmp/humanish-comms/deliveries.ndjson"
SERVED_DIR = sys.argv[3] if len(sys.argv) > 3 else (os.path.dirname(OUT_FILE) + "/surface")
INBOX_PORT = int(sys.argv[4]) if len(sys.argv) > 4 else 0
# Optional shared token guarding GET /deliveries (the drain read). Empty = unguarded, which is the
# in-sandbox default: the capture listener binds loopback there, so nothing external can reach it.
# An ADOPTER-HOSTED catch is reachable over the network, so it should pass one.
DELIVERIES_TOKEN = sys.argv[5] if len(sys.argv) > 5 else ""
try:
    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
except Exception:
    pass
MAX_BODY = 5 * 1024 * 1024
CSP = "default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src * data:"


def message_id():
    return "humanish-catch-" + format(int(time.time() * 1000), "x") + format(random.randrange(16 ** 8), "08x")


class BaseHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        return

    def _json(self, status, obj, extra_headers=None):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/" or path == "/health":
            self._json(200, {"ok": True, "service": "humanish-comms-catch"})
            return
        if path == "/deliveries":
            # The drain read. In-sandbox humanish reads the NDJSON file directly; an adopter-hosted
            # catch is on another machine, so the same bytes are served over HTTP. Capture bodies
            # can contain a verification link, so this is the one route worth guarding.
            if DELIVERIES_TOKEN:
                supplied = self.headers.get("authorization", "")
                if supplied != ("Bearer " + DELIVERIES_TOKEN):
                    self._json(401, {"error": "unauthorized"})
                    return
            try:
                with open(OUT_FILE, "rb") as handle:
                    body = handle.read()
            except Exception:
                body = b""
            self.send_response(200)
            self.send_header("content-type", "application/x-ndjson; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/inbox" or path.startswith("/inbox/") or path == "/api/inbox" or path.startswith("/api/inbox/"):
            rel = unquote(path)
            if ".." in rel or chr(0) in rel:
                self.send_response(400)
                self.end_headers()
                return
            data = None
            for candidate in (SERVED_DIR + rel, SERVED_DIR + rel + "/index"):
                try:
                    with open(candidate, "rb") as handle:
                        data = handle.read()
                    break
                except Exception:
                    data = None
            if data is None:
                self.send_response(404)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(b"<p>message not found</p>")
                return
            is_api = rel.startswith("/api/")
            self.send_response(200)
            self.send_header("content-type", "application/json; charset=utf-8" if is_api else "text/html; charset=utf-8")
            if not is_api:
                self.send_header("content-security-policy", CSP)
            self.end_headers()
            self.wfile.write(data)
            return
        self._json(404, {"error": "not found"})


class CaptureHandler(BaseHandler):
    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            length = int(self.headers.get("content-length") or 0)
        except Exception:
            length = 0
        if length > MAX_BODY:
            self.send_response(413)
            self.end_headers()
            return
        body = self.rfile.read(length).decode("utf-8", "replace") if length > 0 else ""
        try:
            with open(OUT_FILE, "a", encoding="utf-8") as handle:
                print(json.dumps({"t": int(time.time() * 1000), "path": path, "body": body}), file=handle)
        except Exception:
            pass
        mid = message_id()
        if path == "/v3/mail/send":
            self.send_response(202)
            self.send_header("x-message-id", mid)
            self.end_headers()
        elif path.endswith("/batch"):
            self._json(200, {"data": [{"id": mid}]})
        else:
            self._json(200, {"id": mid})


class ReadOnlyHandler(BaseHandler):
    def do_POST(self):
        self.send_response(405)
        self.end_headers()


# Optional read-only inbox listener on 0.0.0.0 (getHost-reachable from a DIFFERENT sandbox on the
# shared-world route). Serves GET /inbox + /api/inbox + /health only; POST capture stays on the
# 127.0.0.1 listener so nothing on the internet can inject a fake captured send. Started only when a
# distinct inbox port is provided (the CUA same-sandbox route omits it and stays loopback-only).
if INBOX_PORT and INBOX_PORT != PORT:
    threading.Thread(target=lambda: ThreadingHTTPServer(("0.0.0.0", INBOX_PORT), ReadOnlyHandler).serve_forever(), daemon=True).start()

ThreadingHTTPServer(("127.0.0.1", PORT), CaptureHandler).serve_forever()
`;

export interface DeployCommsCatchOptions {
  /** Fixed loopback port the catch listens on (default 8025). Must be free inside the sandbox. */
  port?: number;
  /** Optional SECOND fixed port for a READ-ONLY inbox listener bound to 0.0.0.0, so a persona in a
   *  DIFFERENT sandbox can reach the inbox surface via getHost (the shared-world route). Omit on the
   *  CUA same-sandbox route (loopback is enough). Must differ from `port` and be free in the sandbox. */
  inboxPort?: number;
  /** In-sandbox working dir for the script + NDJSON (default /tmp/humanish-comms). */
  dir?: string;
  /** Detached-process name ([a-z0-9-]); default "comms-catch". */
  name?: string;
  /** Readiness-probe budget (ms) for the catch's /health (default 15000). */
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  timers?: DetachedTimers;
}

export interface DeployedCommsCatch {
  port: number;
  /** Inject THIS as the app's email-API base URL (e.g. RESEND_API_URL) — the sandbox's own loopback. */
  baseUrl: string;
  deliveriesPath: string;
  /** In-sandbox dir the HOST renders the persona-facing inbox-surface files into (via writeInboxSurface);
   *  the catch serves them at /inbox and /api/inbox. */
  surfaceDir: string;
  /** The 0.0.0.0 read-only inbox port, when one was requested — getHost-expose THIS to give a
   *  different-sandbox persona a reachable inbox URL. Absent on the loopback-only (CUA) route. */
  inboxPort?: number;
  /** Whether the catch's /health returned OUR service marker within the readiness budget. Callers MUST
   *  treat `ready === false` as fatal (do not inject baseUrl into a dead catch — the app's sends would
   *  silently fail with nothing captured). */
  ready: boolean;
}

/** Readiness probe that asserts OUR service marker in the /health body (not merely any 2xx) — so a
 *  process squatting on the fixed port cannot produce a false "ready" while the app's sends bypass us. */
async function catchHealthy(
  desktop: E2BDesktopSandbox,
  port: number,
  options: { timeoutMs: number; requestTimeoutMs: number } & DetachedTimers
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const result = await desktop.commands
      .run(`curl -s --max-time 5 http://127.0.0.1:${port}/health 2>/dev/null || true`, { requestTimeoutMs: options.requestTimeoutMs })
      .catch(() => ({ stdout: "" }));
    if ((result.stdout ?? "").includes("humanish-comms-catch")) return true;
    if (now() >= deadline) return false;
    await sleep(1000);
  }
}

/** A raw send the in-sandbox catch captured (host-side parsing happens in routeCapturedSends). */
export interface RawCapturedSend {
  path: string;
  body: string;
  t: number;
}

/**
 * Write + launch the in-sandbox catch (detached), then probe it ready. Call AFTER the subject sandbox
 * is created and BEFORE the subject app's serve.start, so the base URL resolves at the app's boot.
 */
export async function deployCommsCatch(
  desktop: E2BDesktopSandbox,
  options: DeployCommsCatchOptions = {}
): Promise<DeployedCommsCatch> {
  // Validate the port to an integer before it reaches the shell command (defense-in-depth: a future
  // caller might cast a config value; the value is typed `number` but this makes injection impossible).
  const port = Math.trunc(Number(options.port ?? DEFAULT_SANDBOX_CATCH_PORT));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`deployCommsCatch: invalid port ${JSON.stringify(options.port)}`);
  }
  const inboxPort = options.inboxPort === undefined ? undefined : Math.trunc(Number(options.inboxPort));
  if (inboxPort !== undefined && (!Number.isInteger(inboxPort) || inboxPort <= 0 || inboxPort > 65_535 || inboxPort === port)) {
    throw new Error(`deployCommsCatch: invalid inboxPort ${JSON.stringify(options.inboxPort)}`);
  }
  const dir = options.dir ?? DEFAULT_CATCH_DIR;
  const name = options.name ?? "comms-catch";
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const scriptPath = `${dir}/catch.py`;
  const deliveriesPath = `${dir}/deliveries.ndjson`;
  const surfaceDir = `${dir}/surface`;

  await desktop.commands.run(`mkdir -p ${shq(dir)} ${shq(surfaceDir)}`, { requestTimeoutMs });
  await desktop.files.write(scriptPath, SANDBOX_CATCH_SCRIPT);
  await startDetachedProcess(desktop, {
    name,
    command: `python3 ${shq(scriptPath)} ${port} ${shq(deliveriesPath)} ${shq(surfaceDir)}${inboxPort === undefined ? "" : ` ${inboxPort}`}`,
    requestTimeoutMs
  });
  const probe = { timeoutMs: options.readyTimeoutMs ?? 15_000, requestTimeoutMs, ...(options.timers ?? {}) };
  const ready = await catchHealthy(desktop, port, probe);
  // Confirm the read-only inbox listener bound too (loopback-reachable at its own port), when requested —
  // else a getHost-exposed inbox would 502. Fail closed by folding it into `ready`.
  const inboxReady = inboxPort === undefined ? true : await catchHealthy(desktop, inboxPort, probe);
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    deliveriesPath,
    surfaceDir,
    ...(inboxPort === undefined ? {} : { inboxPort }),
    ready: ready && inboxReady
  };
}

/**
 * Drain new captured sends from the in-sandbox NDJSON since `cursor` (a line count). Returns the fresh
 * sends and the new cursor. Cheap `cat` over commands.run; NDJSON is small for a run.
 */
export async function drainCommsCatch(
  desktop: E2BDesktopSandbox,
  deployed: Pick<DeployedCommsCatch, "deliveriesPath">,
  cursor = 0,
  requestTimeoutMs = 30_000
): Promise<{ sends: RawCapturedSend[]; cursor: number }> {
  const result = await desktop.commands.run(`cat ${shq(deployed.deliveriesPath)} 2>/dev/null || true`, { requestTimeoutMs });
  const stdout = result.stdout ?? "";
  let lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  // If the file doesn't end in a newline, the last line may be a PARTIAL append (the host `cat` raced
  // an in-sandbox append of a large body). Drop it and don't advance the cursor past it — it re-reads
  // complete on the next poll, so a captured send is never lost to the race (the script only ever emits
  // valid JSON, so an incomplete line is the only cause of a parse miss).
  if (!stdout.endsWith("\n") && lines.length > 0) lines = lines.slice(0, -1);
  const sends: RawCapturedSend[] = [];
  for (const line of lines.slice(cursor)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.path === "string" && typeof parsed.body === "string") {
        sends.push({ path: parsed.path, body: parsed.body, t: typeof parsed.t === "number" ? parsed.t : 0 });
      }
    } catch {
      // skip a malformed line
    }
  }
  return { sends, cursor: lines.length };
}

/**
 * Parse drained raw sends with the host profiles and route them into the CommsChannel (the host-side
 * FakeInbox). Returns the number of inbox deliveries made. Same profiles as the host catch, so the
 * in-sandbox and in-process routes normalize identically.
 */
export async function routeCapturedSends(
  sends: RawCapturedSend[],
  channel: CommsChannel,
  profiles: EmailSendProfile[] = DEFAULT_EMAIL_PROFILES
): Promise<number> {
  let delivered = 0;
  for (const send of sends) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(send.body.length > 0 ? send.body : "{}");
    } catch {
      continue;
    }
    const profile = profiles.find((candidate) => candidate.sendPaths.includes(send.path)) ?? profiles[0];
    if (profile === undefined) continue;
    for (const normalized of profile.parse(send.path, parsed)) {
      const messages = await channel.deliverRaw({
        from: normalized.from,
        to: normalized.to,
        ...(normalized.subject === undefined ? {} : { subject: normalized.subject }),
        body: normalized.body
      });
      delivered += messages.length;
    }
  }
  return delivered;
}

/** Outcome of a whole-run comms collect. `artifact` is present only when captured mail matched a
 *  provisioned inbox; `captured > 0 && artifact === undefined` means the app sent mail to an address
 *  no declared recipient covers (captured but unevidenced) — the caller should surface that, not drop
 *  it silently. */
export interface CommsThreadCollection {
  artifact?: CommsThreadArtifact;
  /** Raw sends the in-sandbox catch captured this run (all POSTed paths). */
  captured: number;
  /** Distinct messages that matched a provisioned recipient inbox (drives whether an artifact exists). */
  matched: number;
}

/**
 * End of a run's comms funnel: drain everything the in-sandbox catch captured, route it into the
 * host `channel`, poll the provisioned `inboxes`, and build the digest-only thread artifact. The
 * `artifact` is omitted when nothing was captured OR nothing matched a provisioned inbox (an empty
 * file would be a false claim of a delivered thread) — but `captured`/`matched` are always reported so
 * the caller can warn on captured-but-unevidenced mail rather than lose it silently. Composes the
 * tested drain/route/build pieces so the CUA and shared-world routes collect evidence identically. The
 * full NDJSON is drained from cursor 0 (a whole-run collect), so it is idempotent to call once at
 * teardown.
 */
export async function collectCommsThread(args: {
  desktop: E2BDesktopSandbox;
  deployed: Pick<DeployedCommsCatch, "deliveriesPath">;
  channel: CommsChannel;
  /** The inboxes provisioned for this run (declared recipients). Only mail to these is evidenced. */
  inboxes: CommsAddress[];
  profiles?: EmailSendProfile[];
  requestTimeoutMs?: number;
}): Promise<CommsThreadCollection> {
  const { sends } = await drainCommsCatch(args.desktop, args.deployed, 0, args.requestTimeoutMs);
  if (sends.length === 0) return { captured: 0, matched: 0 };
  await routeCapturedSends(sends, args.channel, args.profiles);
  const seen = new Set<string>();
  const messages: CommsMessage[] = [];
  for (const inbox of args.inboxes) {
    for (const message of await args.channel.poll(inbox, 0)) {
      // A single send addressed to several provisioned inboxes must appear once in the thread.
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push(message);
    }
  }
  if (messages.length === 0) return { captured: sends.length, matched: 0 };
  messages.sort((a, b) => a.deliveredAt - b.deliveredAt || a.id.localeCompare(b.id));
  return { artifact: buildCommsThreadArtifact(messages), captured: sends.length, matched: messages.length };
}

/** An adopter-hosted catch: humanish never provisioned it, so it is addressed over HTTP (#328). */
export interface ExternalCommsCatch {
  /** Base URL of the catch the ADOPTER runs (its POST capture endpoint and GET /deliveries). */
  catchBaseUrl: string;
  /** Base URL the persona opens to read mail. Defaults to catchBaseUrl (same server serves /inbox). */
  inboxBaseUrl?: string;
  /** Bearer token for the drain read, when the adopter guarded it. Value is used, never persisted. */
  authToken?: string;
}

/** Trim one trailing slash so `${base}/deliveries` never becomes a double slash. */
function baseOf(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The URL a persona is told to open to read its mail on an adopter-hosted plane. */
export function externalInboxUrl(external: ExternalCommsCatch): string {
  return `${baseOf(external.inboxBaseUrl ?? external.catchBaseUrl)}/inbox`;
}

/**
 * Probe an adopter-hosted catch the way the in-sandbox one is probed: assert OUR service marker in
 * /health, not merely any 2xx — an adopter's reverse proxy or a captive portal will happily return
 * 200 for anything, and a comms lab whose catch is not actually there collects nothing while
 * looking fine. Fail-closed callers treat `false` as a hard stop before spending on a run.
 */
export async function externalCatchHealthy(
  external: ExternalCommsCatch,
  options: { timeoutMs?: number; fetchFn?: typeof fetch } = {}
): Promise<boolean> {
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const response = await fetchFn(`${baseOf(external.catchBaseUrl)}/health`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000)
    });
    if (!response.ok) return false;
    const body = await response.text();
    return body.includes("humanish-comms-catch");
  } catch {
    return false;
  }
}

/**
 * Drain an adopter-hosted catch over HTTP. Same NDJSON contract and same partial-line discipline as
 * the in-sandbox `cat` drain: a body that does not end in a newline may have a torn final append, so
 * that line is dropped rather than parsed into a half-message.
 */
export async function drainExternalCommsCatch(
  external: ExternalCommsCatch,
  cursor = 0,
  options: { timeoutMs?: number; fetchFn?: typeof fetch } = {}
): Promise<{ sends: RawCapturedSend[]; cursor: number }> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(`${baseOf(external.catchBaseUrl)}/deliveries`, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    ...(external.authToken ? { headers: { authorization: `Bearer ${external.authToken}` } } : {})
  });
  if (!response.ok) {
    throw new Error(`comms catch GET /deliveries returned ${response.status}`);
  }
  const body = await response.text();
  let lines = body.split("\n").filter((line) => line.trim().length > 0);
  if (!body.endsWith("\n") && lines.length > 0) lines = lines.slice(0, -1);
  const sends: RawCapturedSend[] = [];
  for (const line of lines.slice(cursor)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.path === "string" && typeof parsed.body === "string") {
        sends.push({ path: parsed.path, body: parsed.body, t: typeof parsed.t === "number" ? parsed.t : 0 });
      }
    } catch {
      // skip a malformed line
    }
  }
  return { sends, cursor: lines.length };
}

/**
 * The adopter-hosted analogue of collectCommsThread: drain over HTTP, route into the host inbox bus,
 * and build the SAME digest-only humanish.comms-thread.v1 artifact. Evidence shape does not depend
 * on who hosted the catch — only the transport does.
 */
export async function collectExternalCommsThread(args: {
  external: ExternalCommsCatch;
  channel: CommsChannel;
  inboxes: CommsAddress[];
  profiles?: EmailSendProfile[];
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<CommsThreadCollection> {
  const drainOptions = { ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }), ...(args.fetchFn ? { fetchFn: args.fetchFn } : {}) };
  const { sends } = await drainExternalCommsCatch(args.external, 0, drainOptions);
  if (sends.length === 0) return { captured: 0, matched: 0 };
  await routeCapturedSends(sends, args.channel, args.profiles);
  const seen = new Set<string>();
  const messages: CommsMessage[] = [];
  for (const inbox of args.inboxes) {
    for (const message of await args.channel.poll(inbox, 0)) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push(message);
    }
  }
  if (messages.length === 0) return { captured: sends.length, matched: 0 };
  messages.sort((a, b) => a.deliveredAt - b.deliveredAt || a.id.localeCompare(b.id));
  return { artifact: buildCommsThreadArtifact(messages), captured: sends.length, matched: messages.length };
}

/**
 * Render the persona-facing inbox surface (host-side, typed — see comms-inbox.ts) and write the files
 * into the sandbox's served dir, so the catch serves a LIVE inbox the persona opens and clicks. Creates
 * the nested route dirs first; overwrites idempotently, so call it whenever the message set changes
 * (e.g. after a mid-run drain). Returns the number of files written. Raw content is written INTO the
 * sandbox only (runtime-only, served to the in-sandbox browser); nothing here persists to the bundle.
 */
export async function writeInboxSurface(
  desktop: E2BDesktopSandbox,
  surfaceDir: string,
  messages: CommsMessage[],
  options: InboxRenderOptions & { requestTimeoutMs?: number } = {}
): Promise<number> {
  const files = buildInboxSurface(messages, options);
  // Create the union of parent dirs (inbox/<id>/synth etc.) in one mkdir before writing.
  const dirs = new Set<string>([surfaceDir]);
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    if (slash > 0) dirs.add(`${surfaceDir}/${file.path.slice(0, slash)}`);
  }
  await desktop.commands.run(`mkdir -p ${[...dirs].map(shq).join(" ")}`, { requestTimeoutMs: options.requestTimeoutMs ?? 30_000 });
  for (const file of files) {
    await desktop.files.write(`${surfaceDir}/${file.path}`, file.body);
  }
  return files.length;
}

/** A declared inbox recipient the surface renders for (lane + the literal address the app sends to). */
export interface InboxSurfaceRecipient {
  lane: string;
  address: string;
}

/**
 * One mid-run inbox-surface refresh cycle: FULL rebuild from the append-only NDJSON (drain from cursor 0)
 * into a FRESH FakeInbox each call, provisioning the declared `recipients`, then (re)render the surface
 * so the persona sees new mail while the session is live. Returns the total captured-send `count` + whether
 * it rendered.
 *
 * The full rebuild is deliberate — it is IDEMPOTENT and RETRY-SAFE: a transient writeInboxSurface failure
 * PROPAGATES (the caller retries next tick without advancing its `sinceCount`), and because each rebuild
 * starts from a clean channel, a send is never routed twice, so the persona never sees duplicate emails.
 * Pass `sinceCount` (the last SUCCESSFULLY-rendered send count) to skip the (N-file) render when nothing
 * new has arrived. This is independent of the teardown collectCommsThread drain (its own fresh channel,
 * also cursor 0) — no evidence is lost or altered. The NDJSON is small for a run, so re-reading it is cheap.
 */
export async function refreshInboxSurface(args: {
  desktop: E2BDesktopSandbox;
  deployed: Pick<DeployedCommsCatch, "deliveriesPath" | "surfaceDir">;
  recipients: InboxSurfaceRecipient[];
  sinceCount?: number;
  originMap?: InboxRenderOptions["originMap"];
  requestTimeoutMs?: number;
}): Promise<{ count: number; rendered: boolean }> {
  const { sends } = await drainCommsCatch(args.desktop, args.deployed, 0, args.requestTimeoutMs);
  if (sends.length === 0) return { count: 0, rendered: false };
  if (args.sinceCount !== undefined && sends.length <= args.sinceCount) return { count: sends.length, rendered: false };
  const channel = new FakeInbox();
  const inboxes: CommsAddress[] = [];
  for (const recipient of args.recipients) inboxes.push(await channel.provisionAddress(recipient.lane, recipient.address));
  await routeCapturedSends(sends, channel);
  const seen = new Set<string>();
  const messages: CommsMessage[] = [];
  for (const inbox of inboxes) {
    for (const message of await channel.poll(inbox, 0)) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push(message);
    }
  }
  if (messages.length === 0) return { count: sends.length, rendered: false };
  messages.sort((a, b) => a.deliveredAt - b.deliveredAt || a.id.localeCompare(b.id));
  await writeInboxSurface(args.desktop, args.deployed.surfaceDir, messages, {
    ...(args.originMap === undefined ? {} : { originMap: args.originMap }),
    ...(args.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: args.requestTimeoutMs })
  });
  return { count: sends.length, rendered: true };
}
