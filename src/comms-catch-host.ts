// `humanish comms catch` (#328): run the email catch on the OPERATOR's own host.
//
// Why this exists. The in-sandbox catch only works when humanish provisions the subject itself —
// it clones the app into a sandbox, injects the email-API base URL at boot, and hosts the catch
// alongside it. An adopter whose study runs against their OWN deployed environment (an app-url or
// operator-provisioned plane) hands humanish a URL instead, so humanish never boots the app and
// has nowhere to put a catch. Before this, a `comms:` block on that route was warned inert and the
// personas simply stalled at the verification screen.
//
// The fix is to let the adopter host the same catch and declare it (`comms.email.external`).
// Shipping it as a COMMAND rather than a spec matters: the adopter runs the identical
// implementation humanish deploys in-sandbox, so the capture shape, the inbox surface, and the
// drain contract cannot drift between the two planes. Point the app's email-API base URL at this
// server and point the lab's `catchBaseUrl` at it too.
//
// Runtime: the catch is a python3 stdlib server with no dependencies (that was the 0.29.0 lesson —
// a co-located catcher must use a runtime the environment guarantees). This command writes the
// same script and runs it in the foreground until interrupted.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  SANDBOX_CATCH_SCRIPT,
  capturedRecipientAddresses,
  inboxMessagesFrom,
  parseDeliveriesNdjson,
  type InboxSurfaceRecipient
} from "./comms-sandbox-catch.js";
import { buildInboxSurface } from "./comms-inbox.js";

/** The CLI writer surface this command needs (structurally compatible with program.ts CliIo). */
interface CatchHostIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
  setExitCode(code: number): void;
}

export interface CommsCatchHostOptions {
  port: number;
  dir: string;
  /** Bearer token required on GET /deliveries. Strongly recommended when the host is reachable. */
  token?: string;
  /** SECOND port for the READ-ONLY inbox listener bound to 0.0.0.0, so a persona on another machine
   *  (or in a per-lane desktop) can reach the inbox. Omit to stay loopback-only. */
  inboxPort?: number;
  /** Restrict the rendered inbox to these addresses. Omit to render whatever the app actually mailed
   *  — a standalone catch has no lab roster to read recipients from, and an operator who forgets to
   *  name one should not get a healthy catch that renders an empty inbox forever (#380). */
  recipients?: string[];
  /** Inbox re-render cadence in ms (test seam). */
  renderIntervalMs?: number;
}

/** How often the host re-renders the inbox surface from the deliveries file. */
const DEFAULT_RENDER_INTERVAL_MS = 3_000;

/**
 * Render the persona-facing inbox surface from the catch's own deliveries file into `surfaceDir`.
 *
 * This is the half that was missing on an adopter-hosted plane (#380). The catch serves /inbox and
 * /api/inbox as STATIC FILES; in-sandbox, humanish-as-host renders those files on a cadence. On a
 * plane humanish does not provision there is no such host, so nothing wrote them and every persona
 * that reached /inbox got `message not found` against a catch whose /health was green — the funnel
 * dead-ended at a technically-healthy service.
 *
 * Rebuilding from scratch each pass is deliberate and matches refreshInboxSurface: a fresh channel per
 * pass means a send is never routed twice, so the persona never sees duplicates, and a failed write
 * simply retries next tick.
 */
export async function renderInboxSurfaceLocally(args: {
  deliveriesPath: string;
  surfaceDir: string;
  recipients?: string[] | undefined;
}): Promise<{ sends: number; messages: number; files: number }> {
  let text = "";
  try {
    text = await readFile(args.deliveriesPath, "utf8");
  } catch {
    text = ""; // no mail captured yet — still render, so /inbox answers "No messages yet."
  }
  const sends = parseDeliveriesNdjson(text);
  const addresses = args.recipients && args.recipients.length > 0 ? args.recipients : capturedRecipientAddresses(sends);
  const recipients: InboxSurfaceRecipient[] = addresses.map((address, index) => ({
    lane: `catch-${String(index + 1).padStart(2, "0")}`,
    address
  }));
  const messages = await inboxMessagesFrom(sends, recipients);
  const files = buildInboxSurface(messages);
  const dirs = new Set<string>([args.surfaceDir]);
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    if (slash > 0) dirs.add(path.join(args.surfaceDir, file.path.slice(0, slash)));
  }
  for (const dir of dirs) await mkdir(dir, { recursive: true });
  for (const file of files) await writeFile(path.join(args.surfaceDir, file.path), file.body, "utf8");
  return { sends: sends.length, messages: messages.length, files: files.length };
}

/**
 * Write the catch script and run it in the foreground. Resolves when the child exits; the caller's
 * Ctrl-C reaches the child through the shared process group, so the normal way to stop it is the
 * normal way to stop any foreground server.
 */
export async function runCommsCatchHost(options: CommsCatchHostOptions, io: CatchHostIo): Promise<void> {
  const dir = path.resolve(options.dir);
  const scriptPath = path.join(dir, "catch.py");
  const deliveriesPath = path.join(dir, "deliveries.ndjson");
  const surfaceDir = path.join(dir, "surface");

  await mkdir(surfaceDir, { recursive: true });
  await writeFile(scriptPath, SANDBOX_CATCH_SCRIPT, "utf8");

  // Render the EMPTY inbox before the server is announced, so /inbox resolves to the "No messages
  // yet." page from the first request instead of a bare `message not found` (#380) — a persona reads
  // that 404 as a broken product and reports a blocker that is really just an empty mailbox.
  await renderInboxSurfaceLocally({
    deliveriesPath,
    surfaceDir,
    ...(options.recipients === undefined ? {} : { recipients: options.recipients })
  });

  const inboxPort = options.inboxPort;
  const args = [
    scriptPath,
    String(options.port),
    deliveriesPath,
    surfaceDir,
    String(inboxPort ?? 0),
    options.token ?? ""
  ];
  io.writeOut(
    [
      `humanish comms catch listening on http://127.0.0.1:${options.port}`,
      ...(inboxPort === undefined
        ? []
        : [`  read-only inbox listener on http://0.0.0.0:${inboxPort} (GET only; expose THIS to personas)`]),
      `  POST /emails        <- point your app's email-API base URL here`,
      `  GET  /inbox         <- the persona opens this${inboxPort === undefined ? " (loopback only without --inbox-port)" : ""}`,
      `  GET  /deliveries    <- humanish drains this${options.token ? " (bearer token required)" : ""}`,
      `  GET  /health        <- readiness marker humanish probes before a run`,
      ``,
      `Declare it in the lab:`,
      `  comms:`,
      `    email:`,
      `      external:`,
      `        catchBaseUrl: http://<this-host>:${options.port}`,
      ...(inboxPort === undefined ? [] : [`        inboxBaseUrl: http://<this-host>:${inboxPort}`]),
      ...(options.token ? [`        authTokenEnv: HUMANISH_COMMS_TOKEN   # value read at runtime, never persisted`] : []),
      ``,
      `Captured mail is written to ${deliveriesPath}. Raw bodies stay on THIS host: the run bundle`,
      `only ever receives digests (from/to/subject/link) and an OTP count.`,
      ``
    ].join("\n") + "\n"
  );

  await new Promise<void>((resolve) => {
    const child = spawn("python3", args, { stdio: ["ignore", "inherit", "inherit"] });
    // Keep the inbox current while the catch runs. Failures are swallowed on purpose: a transient
    // render error must never take down a server that is still capturing mail correctly, and the
    // next tick rebuilds from scratch anyway.
    const renderTimer = setInterval(() => {
      void renderInboxSurfaceLocally({
        deliveriesPath,
        surfaceDir,
        ...(options.recipients === undefined ? {} : { recipients: options.recipients })
      }).catch(() => {});
    }, options.renderIntervalMs ?? DEFAULT_RENDER_INTERVAL_MS);
    renderTimer.unref?.();
    const stopRendering = (): void => clearInterval(renderTimer);
    child.on("error", (error) => {
      stopRendering();
      io.writeErr(`comms catch failed to start (python3 is required): ${error.message}\n`);
      io.setExitCode(2);
      resolve();
    });
    child.on("exit", (code) => {
      stopRendering();
      if (code !== 0 && code !== null) {
        io.setExitCode(2);
      }
      resolve();
    });
  });
}
