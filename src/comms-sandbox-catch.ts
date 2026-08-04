// Deploy the vendor-neutral email catch INSIDE the subject E2B sandbox and bridge captured sends back
// to the host bus (#297 config-block core). The host `startEmailCatchServer` binds the HOST's loopback,
// which a sandboxed app cannot reach — `127.0.0.1:PORT` from the app is the SANDBOX's loopback. So the
// listener must live in the sandbox: we write a tiny self-contained capture server (no deps, no host
// import) into the sandbox, launch it detached (the same substrate that serves the subject app), and
// each poll `cat` its append-only NDJSON of captured sends back to the host, where the real profiles
// parse them and route into the CommsChannel. A FIXED loopback port is chosen up front so the app's
// injected base-URL env (`http://127.0.0.1:<port>`) is known before the sandbox is created.

import type { CommsChannel } from "./comms-types.js";
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
 * The self-contained in-sandbox capture server (a plain node ESM string — runs on the sandbox's own
 * node, imports nothing from humanish). It is DELIBERATELY dumb: it records each POST verbatim as an
 * NDJSON line `{t, path, body}` and returns a plausible provider success — all normalization/profile
 * parsing happens host-side on the drained lines, so the typed, tested profiles stay in one place.
 * argv: <port> <deliveriesFile>.
 */
export const SANDBOX_CATCH_SCRIPT = [
  'import { createServer } from "node:http";',
  'import { appendFileSync, mkdirSync } from "node:fs";',
  'import { dirname } from "node:path";',
  'const port = Number(process.argv[2] || 8025);',
  'const outFile = process.argv[3] || "/tmp/humanish-comms/deliveries.ndjson";',
  'try { mkdirSync(dirname(outFile), { recursive: true }); } catch {}',
  'const MAX = 5 * 1024 * 1024;',
  'createServer((req, res) => {',
  '  const path = (req.url || "/").split("?")[0];',
  '  if (req.method === "GET" && (path === "/" || path === "/health")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, service: "humanish-comms-catch" })); return; }',
  '  if (req.method !== "POST") { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }',
  '  let size = 0; const chunks = [];',
  '  req.on("data", (c) => { size += c.length; if (size > MAX) { req.destroy(); } else { chunks.push(c); } });',
  '  req.on("end", () => {',
  '    const body = Buffer.concat(chunks).toString("utf8");',
  '    try { appendFileSync(outFile, JSON.stringify({ t: Date.now(), path, body }) + "\\n"); } catch {}',
  '    const id = "humanish-catch-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);',
  '    if (path === "/v3/mail/send") { res.writeHead(202, { "x-message-id": id }); res.end(); }',
  '    else if (path.endsWith("/batch")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id }] })); }',
  '    else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id })); }',
  '  });',
  '  req.on("error", () => { try { res.writeHead(400); res.end(); } catch {} });',
  '}).listen(port, "127.0.0.1");'
].join("\n");

export interface DeployCommsCatchOptions {
  /** Fixed loopback port the catch listens on (default 8025). Must be free inside the sandbox. */
  port?: number;
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
  const dir = options.dir ?? DEFAULT_CATCH_DIR;
  const name = options.name ?? "comms-catch";
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const scriptPath = `${dir}/catch.mjs`;
  const deliveriesPath = `${dir}/deliveries.ndjson`;

  await desktop.commands.run(`mkdir -p ${shq(dir)}`, { requestTimeoutMs });
  await desktop.files.write(scriptPath, SANDBOX_CATCH_SCRIPT);
  await startDetachedProcess(desktop, {
    name,
    command: `node ${shq(scriptPath)} ${port} ${shq(deliveriesPath)}`,
    requestTimeoutMs
  });
  const ready = await catchHealthy(desktop, port, {
    timeoutMs: options.readyTimeoutMs ?? 15_000,
    requestTimeoutMs,
    ...(options.timers ?? {})
  });
  return { port, baseUrl: `http://127.0.0.1:${port}`, deliveriesPath, ready };
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
