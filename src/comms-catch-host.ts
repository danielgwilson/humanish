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
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { SANDBOX_CATCH_SCRIPT } from "./comms-sandbox-catch.js";

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

  const args = [scriptPath, String(options.port), deliveriesPath, surfaceDir, "0", options.token ?? ""];
  io.writeOut(
    [
      `humanish comms catch listening on http://127.0.0.1:${options.port}`,
      `  POST /emails        <- point your app's email-API base URL here`,
      `  GET  /inbox         <- the persona opens this`,
      `  GET  /deliveries    <- humanish drains this${options.token ? " (bearer token required)" : ""}`,
      `  GET  /health        <- readiness marker humanish probes before a run`,
      ``,
      `Declare it in the lab:`,
      `  comms:`,
      `    email:`,
      `      external:`,
      `        catchBaseUrl: http://<this-host>:${options.port}`,
      ...(options.token ? [`        authTokenEnv: HUMANISH_COMMS_TOKEN   # value read at runtime, never persisted`] : []),
      ``,
      `Captured mail is written to ${deliveriesPath}. Raw bodies stay on THIS host: the run bundle`,
      `only ever receives digests (from/to/subject/link) and an OTP count.`,
      ``
    ].join("\n") + "\n"
  );

  await new Promise<void>((resolve) => {
    const child = spawn("python3", args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (error) => {
      io.writeErr(`comms catch failed to start (python3 is required): ${error.message}\n`);
      io.setExitCode(2);
      resolve();
    });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        io.setExitCode(2);
      }
      resolve();
    });
  });
}
