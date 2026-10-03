// Deploy the vendor-neutral email catch inside the subject E2B sandbox and bridge captured sends back
// to the host bus. The host `startEmailCatchServer` binds the host's loopback,
// which a sandboxed app cannot reach: `127.0.0.1:PORT` from the app is the sandbox's loopback. So the
// listener must live in the sandbox: we write a tiny self-contained capture server (no deps, no host
// import) into the sandbox, launch it detached (the same substrate that serves the subject app), and
// each poll `cat` its append-only NDJSON of captured sends back to the host, where the real profiles
// parse them and route into the CommsChannel. A fixed loopback port is chosen up front so the app's
// injected base-URL env (`http://127.0.0.1:<port>`) is known before the sandbox is created.

import type { CommsAddress, CommsChannel, CommsMessage } from "./types.js";
import { FakeInbox } from "./fake-inbox.js";
import { buildCommsThreadArtifact, type CommsThreadArtifact } from "./thread-evidence.js";
import { SANDBOX_CATCH_SCRIPT } from "./sandbox-catch-script.js";
import { buildInboxSurface, type InboxRenderOptions } from "./capture-surface.js";
import { DEFAULT_EMAIL_PROFILES, type EmailSendProfile } from "./email-catch.js";
import { startDetachedProcess, type DetachedTimers } from "../substrates/detached.js";
import { runOrThrow, shellQuote, type Shell } from "../substrates/shell.js";

/** The default in-sandbox loopback port for the catch. Fixed (not ephemeral) so the injected base-URL
 *  env is known before the sandbox is created. 8025 is the conventional local-mail-UI port and is
 *  unlikely to collide with a subject app; override via config if it does. */
export const DEFAULT_SANDBOX_CATCH_PORT = 8025;
const DEFAULT_CATCH_DIR = "/tmp/humanish-comms";

export interface DeployCommsCatchOptions {
  /** Fixed loopback port the catch listens on (default 8025). Must be free inside the sandbox. */
  port?: number;
  /** Optional second fixed port for a read-only inbox listener bound to 0.0.0.0, so a persona in a
   *  different sandbox can reach the inbox surface via getHost (the shared-world route). Omit on the
   *  CUA same-sandbox route (loopback is enough). Must differ from `port` and be free in the sandbox. */
  inboxPort?: number;
  /** In-sandbox working dir for the script + NDJSON (default /tmp/humanish-comms). */
  dir?: string;
  /** Detached-process name ([a-z0-9-]); default "comms-catch". */
  name?: string;
  /** Optional loopback SMTP port. Most self-hostable apps send mail over SMTP rather than a
   *  provider's HTTP API, and an HTTP-only catch cannot study those at all. Captured messages are
   *  normalized onto the same NDJSON the HTTP path writes, so nothing downstream changes. */
  smtpPort?: number;
  /** Readiness-probe budget (ms) for the catch's /health (default 15000). */
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  timers?: DetachedTimers;
}

export interface DeployedCommsCatch {
  port: number;
  /** Inject this as the app's email-API base URL (e.g. RESEND_API_URL): the sandbox's own loopback. */
  baseUrl: string;
  deliveriesPath: string;
  /** In-sandbox dir the host renders the persona-facing inbox-surface files into (via writeInboxSurface);
   *  the catch serves them at /inbox and /api/inbox. */
  surfaceDir: string;
  /** The 0.0.0.0 read-only inbox port, when one was requested; getHost-expose this to give a
   *  different-sandbox persona a reachable inbox URL. Absent on the loopback-only (CUA) route. */
  inboxPort?: number;
  /** The loopback SMTP port, when one was requested. Point the app's SMTP host/port env at
   *  127.0.0.1 and this port. */
  smtpPort?: number;
  /** Whether the catch's /health returned humanish's service marker within the readiness budget. Callers must
   *  treat `ready === false` as fatal (do not inject baseUrl into a dead catch: the app's sends would
   *  silently fail with nothing captured). */
  ready: boolean;
}

/** Readiness probe that asserts humanish's service marker in the /health body (a bare 2xx is not enough), so a
 *  process squatting on the fixed port cannot produce a false "ready" while the app's sends bypass us. */
async function catchHealthy(
  shell: Shell,
  port: number,
  options: { timeoutMs: number; requestTimeoutMs: number } & DetachedTimers,
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const result = await shell
      .run(`curl -s --max-time 5 http://127.0.0.1:${port}/health 2>/dev/null || true`, {
        requestTimeoutMs: options.requestTimeoutMs,
      })
      .catch(() => ({ stdout: "" }));
    if (result.stdout.includes("humanish-comms-catch")) return true;
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
 * Write + launch the in-sandbox catch (detached), then probe it ready. Call after the subject sandbox
 * is created and before the subject app's serve.start, so the base URL resolves at the app's boot.
 */
export async function deployCommsCatch(
  shell: Shell,
  options: DeployCommsCatchOptions = {},
): Promise<DeployedCommsCatch> {
  // Validate the port to an integer before it reaches the shell command (defense-in-depth: a future
  // caller might cast a config value; the value is typed `number` but this makes injection impossible).
  const port = Math.trunc(Number(options.port ?? DEFAULT_SANDBOX_CATCH_PORT));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`deployCommsCatch: invalid port ${JSON.stringify(options.port)}`);
  }
  const inboxPort =
    options.inboxPort === undefined ? undefined : Math.trunc(Number(options.inboxPort));
  if (
    inboxPort !== undefined &&
    (!Number.isInteger(inboxPort) || inboxPort <= 0 || inboxPort > 65_535 || inboxPort === port)
  ) {
    throw new Error(`deployCommsCatch: invalid inboxPort ${JSON.stringify(options.inboxPort)}`);
  }
  const smtpPort =
    options.smtpPort === undefined ? undefined : Math.trunc(Number(options.smtpPort));
  if (
    smtpPort !== undefined &&
    (!Number.isInteger(smtpPort) ||
      smtpPort <= 0 ||
      smtpPort > 65_535 ||
      smtpPort === port ||
      smtpPort === inboxPort)
  ) {
    throw new Error(`deployCommsCatch: invalid smtpPort ${JSON.stringify(options.smtpPort)}`);
  }
  const dir = options.dir ?? DEFAULT_CATCH_DIR;
  const name = options.name ?? "comms-catch";
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const scriptPath = `${dir}/catch.py`;
  const deliveriesPath = `${dir}/deliveries.ndjson`;
  const surfaceDir = `${dir}/surface`;

  await runOrThrow(shell, `mkdir -p ${shellQuote(dir)} ${shellQuote(surfaceDir)}`, {
    requestTimeoutMs,
  });
  await shell.writeFile(scriptPath, SANDBOX_CATCH_SCRIPT);
  await startDetachedProcess(shell, {
    name,
    command: [
      "python3",
      shellQuote(scriptPath),
      String(port),
      shellQuote(deliveriesPath),
      shellQuote(surfaceDir),
      ...(inboxPort === undefined && smtpPort === undefined ? [] : [String(inboxPort ?? 0)]),
      // The token slot is positional: an SMTP port cannot be reached without filling it. In-sandbox
      // the capture listener is loopback-only, so an empty token is the same posture as before.
      ...(smtpPort === undefined ? [] : ['""', String(smtpPort)]),
    ].join(" "),
    requestTimeoutMs,
  });
  const probe = {
    timeoutMs: options.readyTimeoutMs ?? 15_000,
    requestTimeoutMs,
    ...options.timers,
  };
  const ready = await catchHealthy(shell, port, probe);
  // Confirm the read-only inbox listener bound too (loopback-reachable at its own port), when requested.
  // Without it a getHost-exposed inbox would 502. Fail closed by folding it into `ready`.
  const inboxReady = inboxPort === undefined ? true : await catchHealthy(shell, inboxPort, probe);
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    deliveriesPath,
    surfaceDir,
    ...(inboxPort === undefined ? {} : { inboxPort }),
    ...(smtpPort === undefined ? {} : { smtpPort }),
    ready: ready && inboxReady,
  };
}

/**
 * Drain new captured sends from the in-sandbox NDJSON since `cursor` (a line count). Returns the fresh
 * sends and the new cursor. Cheap `cat` over commands.run; NDJSON is small for a run.
 */
export async function drainCommsCatch(
  shell: Shell,
  deployed: Pick<DeployedCommsCatch, "deliveriesPath">,
  cursor = 0,
  requestTimeoutMs = 30_000,
): Promise<{ sends: RawCapturedSend[]; cursor: number }> {
  const result = await runOrThrow(
    shell,
    `cat ${shellQuote(deployed.deliveriesPath)} 2>/dev/null || true`,
    { requestTimeoutMs },
  );
  const stdout = result.stdout;
  let lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  // If the file doesn't end in a newline, the last line may be a partial append (the host `cat` raced
  // an in-sandbox append of a large body). Drop it and don't advance the cursor past it; it re-reads
  // complete on the next poll, so a captured send is never lost to the race (the script only ever emits
  // valid JSON, so an incomplete line is the only cause of a parse miss).
  if (!stdout.endsWith("\n") && lines.length > 0) lines = lines.slice(0, -1);
  const sends: RawCapturedSend[] = [];
  for (const line of lines.slice(cursor)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.path === "string" && typeof parsed.body === "string") {
        sends.push({
          path: parsed.path,
          body: parsed.body,
          t: typeof parsed.t === "number" ? parsed.t : 0,
        });
      }
    } catch {
      // skip a malformed line
    }
  }
  return { sends, cursor: lines.length };
}

/**
 * Parse an append-only deliveries NDJSON blob into raw sends. Split out of drainCommsCatch so
 * the same parsing serves a sandbox we own (read over the E2B command channel) and a catch running on
 * a plane we do not own (read from the local filesystem by `humanish comms catch`).
 *
 * A file that does not end in a newline may have a partial last line when a reader races an append of a
 * large body. Dropping it is never lossy: the script only ever emits valid JSON lines, so an incomplete
 * line re-reads complete on the next pass.
 */
export function parseDeliveriesNdjson(text: string): RawCapturedSend[] {
  let lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (!text.endsWith("\n") && lines.length > 0) lines = lines.slice(0, -1);
  const sends: RawCapturedSend[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.path === "string" && typeof parsed.body === "string") {
        sends.push({
          path: parsed.path,
          body: parsed.body,
          t: typeof parsed.t === "number" ? parsed.t : 0,
        });
      }
    } catch {
      // skip a malformed line
    }
  }
  return sends;
}

/**
 * The distinct `to` addresses the captured mail was actually sent to, parsed with the same profiles
 * that route it. A run knows its recipients from the declared roster; a standalone catch does not,
 * so it discovers them from the mail itself. Otherwise an operator who forgot to name an address gets
 * a technically-healthy catch rendering an empty inbox forever: a false green.
 */
export function capturedRecipientAddresses(
  sends: readonly RawCapturedSend[],
  profiles: EmailSendProfile[] = DEFAULT_EMAIL_PROFILES,
): string[] {
  const addresses = new Set<string>();
  for (const send of sends) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(send.body.length > 0 ? send.body : "{}");
    } catch {
      continue;
    }
    const profile =
      profiles.find((candidate) => candidate.sendPaths.includes(send.path)) ?? profiles[0];
    if (profile === undefined) continue;
    for (const normalized of profile.parse(send.path, parsed)) {
      for (const address of normalized.to) {
        if (address.trim().length > 0) addresses.add(address);
      }
    }
  }
  return [...addresses];
}

/**
 * Route raw sends into a fresh FakeInbox and return the deduped, delivery-ordered messages. Split out
 * of refreshInboxSurface so the rendering pipeline is shared by every transport; the freshness
 * is what makes a full rebuild idempotent (a send is never routed twice, so no duplicate emails).
 */
export async function inboxMessagesFrom(
  sends: readonly RawCapturedSend[],
  recipients: readonly InboxSurfaceRecipient[],
): Promise<CommsMessage[]> {
  const channel = new FakeInbox();
  const inboxes: CommsAddress[] = [];
  for (const recipient of recipients)
    inboxes.push(await channel.provisionAddress(recipient.participantId, recipient.address));
  await routeCapturedSends([...sends], channel);
  const seen = new Set<string>();
  const messages: CommsMessage[] = [];
  for (const inbox of inboxes) {
    for (const message of await channel.poll(inbox, 0)) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push(message);
    }
  }
  messages.sort((a, b) => a.deliveredAt - b.deliveredAt || a.id.localeCompare(b.id));
  return messages;
}

/**
 * Parse drained raw sends with the host profiles and route them into the CommsChannel (the host-side
 * FakeInbox). Returns the number of inbox deliveries made. Same profiles as the host catch, so the
 * in-sandbox and in-process routes normalize identically.
 */
export async function routeCapturedSends(
  sends: RawCapturedSend[],
  channel: CommsChannel,
  profiles: EmailSendProfile[] = DEFAULT_EMAIL_PROFILES,
): Promise<number> {
  let delivered = 0;
  for (const send of sends) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(send.body.length > 0 ? send.body : "{}");
    } catch {
      continue;
    }
    const profile =
      profiles.find((candidate) => candidate.sendPaths.includes(send.path)) ?? profiles[0];
    if (profile === undefined) continue;
    for (const normalized of profile.parse(send.path, parsed)) {
      const messages = await channel.deliverRaw({
        from: normalized.from,
        to: normalized.to,
        ...(normalized.subject === undefined ? {} : { subject: normalized.subject }),
        body: normalized.body,
        ...(normalized.inlineImages ? { inlineImages: normalized.inlineImages } : {}),
      });
      delivered += messages.length;
    }
  }
  return delivered;
}

/** Outcome of a whole-run comms collect. `artifact` is present only when captured mail matched a
 *  provisioned inbox; `captured > 0 && artifact === undefined` means the app sent mail to an address
 *  no declared recipient covers (captured but unevidenced); the caller should surface that, not drop
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
 * `artifact` is omitted when nothing was captured or nothing matched a provisioned inbox (an empty
 * file would be a false claim of a delivered thread), but `captured`/`matched` are always reported so
 * the caller can warn on captured-but-unevidenced mail rather than lose it silently. Composes the
 * tested drain/route/build pieces so the CUA and shared-world routes collect evidence identically. The
 * full NDJSON is drained from cursor 0 (a whole-run collect), so it is idempotent to call once at
 * teardown.
 */
export async function collectCommsThread(args: {
  shell: Shell;
  deployed: Pick<DeployedCommsCatch, "deliveriesPath">;
  channel: CommsChannel;
  /** The inboxes provisioned for this run (declared recipients). Only mail to these is evidenced. */
  inboxes: CommsAddress[];
  profiles?: EmailSendProfile[];
  requestTimeoutMs?: number;
}): Promise<CommsThreadCollection> {
  const { sends } = await drainCommsCatch(args.shell, args.deployed, 0, args.requestTimeoutMs);
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
  return {
    artifact: buildCommsThreadArtifact(messages),
    captured: sends.length,
    matched: messages.length,
  };
}

/** An adopter-hosted catch: humanish never provisioned it, so it is addressed over HTTP. */
export interface ExternalCommsCatch {
  /** Base URL of the catch the adopter runs (its POST capture endpoint and GET /deliveries). */
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
 * Probe an adopter-hosted catch the way the in-sandbox one is probed: assert humanish's service marker in
 * /health, not merely any 2xx: an adopter's reverse proxy or a captive portal will happily return
 * 200 for anything, and a comms study whose catch is not actually there collects nothing while
 * looking fine. Fail-closed callers treat `false` as a hard stop before spending on a run.
 */
export async function externalCatchHealthy(
  external: ExternalCommsCatch,
  options: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<boolean> {
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const bases = new Set(
      [external.catchBaseUrl, external.inboxBaseUrl ?? external.catchBaseUrl].map(baseOf),
    );
    const health = await Promise.all(
      [...bases].map(async (base) => {
        const response = await fetchFn(`${base}/health`, {
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        });
        if (!response.ok) return false;
        const body: unknown = await response.json();
        if (!body || typeof body !== "object") return false;
        const value = body as Record<string, unknown>;
        return (
          value.ok === true &&
          value.service === "humanish-comms-catch" &&
          Array.isArray(value.capabilities) &&
          value.capabilities.includes("recipient-inbox-v1")
        );
      }),
    );
    return health.every(Boolean);
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
  options: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<{ sends: RawCapturedSend[]; cursor: number }> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(`${baseOf(external.catchBaseUrl)}/deliveries`, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    ...(external.authToken ? { headers: { authorization: `Bearer ${external.authToken}` } } : {}),
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
        sends.push({
          path: parsed.path,
          body: parsed.body,
          t: typeof parsed.t === "number" ? parsed.t : 0,
        });
      }
    } catch {
      // skip a malformed line
    }
  }
  return { sends, cursor: lines.length };
}

/**
 * The adopter-hosted analogue of collectCommsThread: drain over HTTP, route into the host inbox bus,
 * and build the same digest-only humanish.comms-thread.v1 artifact. Evidence shape does not depend
 * on who hosted the catch; only the transport does.
 */
export async function collectExternalCommsThread(args: {
  external: ExternalCommsCatch;
  channel: CommsChannel;
  inboxes: CommsAddress[];
  profiles?: EmailSendProfile[];
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<CommsThreadCollection> {
  const drainOptions = {
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    ...(args.fetchFn ? { fetchFn: args.fetchFn } : {}),
  };
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
  return {
    artifact: buildCommsThreadArtifact(messages),
    captured: sends.length,
    matched: messages.length,
  };
}

/**
 * Render the persona-facing inbox surface (host-side, typed; see capture-surface.ts) and write the files
 * into the sandbox's served dir, so the catch serves a live inbox the persona opens and clicks. Creates
 * the nested route dirs first; overwrites idempotently, so call it whenever the message set changes
 * (e.g. after a mid-run drain). Returns the number of files written. Raw content is written into the
 * sandbox only (runtime-only, served to the in-sandbox browser); nothing here persists to the bundle.
 */
export async function writeInboxSurface(
  shell: Shell,
  surfaceDir: string,
  messages: CommsMessage[],
  options: InboxRenderOptions & { requestTimeoutMs?: number } = {},
): Promise<number> {
  const files = buildInboxSurface(messages, options);
  // Create the union of parent dirs (inbox/<id>/synth etc.) in one mkdir before writing.
  const dirs = new Set<string>([surfaceDir]);
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    if (slash > 0) dirs.add(`${surfaceDir}/${file.path.slice(0, slash)}`);
  }
  await runOrThrow(shell, `mkdir -p ${[...dirs].map(shellQuote).join(" ")}`, {
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
  });
  for (const file of files) {
    await shell.writeFile(`${surfaceDir}/${file.path}`, file.body);
  }
  return files.length;
}

/** A declared inbox recipient the surface renders for: the participant and the literal address the
 *  app sends to. */
export interface InboxSurfaceRecipient {
  participantId: string;
  address: string;
}

/**
 * One mid-run inbox-surface refresh cycle: full rebuild from the append-only NDJSON (drain from cursor 0)
 * into a fresh FakeInbox each call, provisioning the declared `recipients`, then (re)render the surface
 * so the persona sees new mail while the session is live. Returns the total captured-send `count` + whether
 * it rendered.
 *
 * The full rebuild is deliberate because it is idempotent and retry-safe: a transient writeInboxSurface failure
 * propagates (the caller retries next tick without advancing its `sinceCount`), and because each rebuild
 * starts from a clean channel, a send is never routed twice, so the persona never sees duplicate emails.
 * Pass `sinceCount` (the last successfully-rendered send count) to skip the (N-file) render when nothing
 * new has arrived. This is independent of the teardown collectCommsThread drain (its own fresh channel,
 * also cursor 0), so no evidence is lost or altered. The NDJSON is small for a run, so re-reading it is cheap.
 */
export async function refreshInboxSurface(args: {
  shell: Shell;
  deployed: Pick<DeployedCommsCatch, "deliveriesPath" | "surfaceDir">;
  recipients: InboxSurfaceRecipient[];
  sinceCount?: number;
  originMap?: InboxRenderOptions["originMap"];
  requestTimeoutMs?: number;
}): Promise<{ count: number; rendered: boolean }> {
  const { sends } = await drainCommsCatch(args.shell, args.deployed, 0, args.requestTimeoutMs);
  if (sends.length === 0) return { count: 0, rendered: false };
  if (args.sinceCount !== undefined && sends.length <= args.sinceCount)
    return { count: sends.length, rendered: false };
  const messages = await inboxMessagesFrom(sends, args.recipients);
  if (messages.length === 0) return { count: sends.length, rendered: false };
  await writeInboxSurface(args.shell, args.deployed.surfaceDir, messages, {
    recipients: args.recipients.map((recipient) => recipient.address),
    ...(args.originMap === undefined ? {} : { originMap: args.originMap }),
    ...(args.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: args.requestTimeoutMs }),
  });
  return { count: sends.length, rendered: true };
}
