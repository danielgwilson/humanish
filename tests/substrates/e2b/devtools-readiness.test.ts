// Chrome's DevTools readiness wait, run the way the launch command runs it: bash starts a stand-in
// browser in the background, then the real python3 waits on a loopback endpoint. The stand-in is
// a shell process, so these cases need python3 and bash but no Chrome.
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chromeCdpProbeCommand } from "../../../src/substrates/e2b/cdp-probe.js";
import {
  chromeDevToolsReadinessCommand,
  parseChromeDevToolsReadiness,
} from "../../../src/substrates/e2b/desktop-browser.js";

const execFileAsync = promisify(execFile);

function hasPython3(): boolean {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    try {
      accessSync(path.join(dir, "python3"), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}
const python3 = hasPython3();

/** A loopback port nothing listens on yet. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Answers Chrome's DevTools HTTP routes the way an idle browser does. */
function fakeDevTools(): Server {
  return createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(request.url === "/json/version" ? '{"Browser":"Fake/1.0"}' : "[]");
  });
}

/** The launch command's shape: the stand-in goes to the background, then the wait runs. */
function launchScript(browser: string, port: number, deadlineMs: number, logPath: string): string {
  return [
    `${browser} >${JSON.stringify(logPath)} 2>&1 &`,
    "launch_pid=$!",
    chromeDevToolsReadinessCommand({ pid: '"$launch_pid"', port, deadlineMs, logPath }),
    'kill "$launch_pid" 2>/dev/null || true',
  ].join("\n");
}

describe("Chrome DevTools readiness wait under the real python3", () => {
  let dir: string;
  let server: Server | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-devtools-ready-"));
  });
  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!python3)(
    "a DevTools port that opens late: one /json read is refused, the wait answers once it opens",
    async () => {
      const port = await freePort();
      // Today's applier lists targets once. With nothing listening yet it gives up at once.
      const once = await execFileAsync("bash", [
        "-c",
        chromeCdpProbeCommand({
          cdpPort: port,
          targetUrl: "http://127.0.0.1:3000/",
          prefer: "pinned",
          mode: "hold",
          emulation: {
            width: 414,
            height: 896,
            deviceScaleFactor: 3,
            touch: true,
            userAgent: "Mozilla/5.0 (iPhone)",
          },
        }),
      ]);
      expect(once.stdout).toContain(`CDP endpoint 127.0.0.1:${port}/json unreachable`);

      // The wait starts before the port opens and answers after it does.
      const logPath = path.join(dir, "browser.log");
      const waiting = execFileAsync("bash", [
        "-c",
        launchScript("sleep 30", port, 15_000, logPath),
      ]);
      const live = fakeDevTools();
      server = live;
      let listeningAt = 0;
      setTimeout(() => {
        live.listen(port, "127.0.0.1", () => {
          listeningAt = Date.now();
        });
      }, 1_500);
      const { stdout } = await waiting;
      const finishedAt = Date.now();
      const readiness = parseChromeDevToolsReadiness(stdout);
      expect(readiness?.state).toBe("ready");
      expect(readiness!.waitedMs).toBeGreaterThan(0);
      expect(listeningAt).toBeGreaterThan(0);
      expect(finishedAt).toBeGreaterThanOrEqual(listeningAt);
    },
    30_000,
  );

  it.skipIf(!python3)(
    "a browser that exits before its port answers: reports exited with the log's last line",
    async () => {
      const port = await freePort();
      const logPath = path.join(dir, "browser.log");
      const started = Date.now();
      const { stdout } = await execFileAsync("bash", [
        "-c",
        launchScript(
          `sh -c 'echo "starting" >&2; echo "[1:1:ERROR] Missing X server or display" >&2; exit 1'`,
          port,
          15_000,
          logPath,
        ),
      ]);
      const readiness = parseChromeDevToolsReadiness(stdout);
      expect(readiness).toMatchObject({
        state: "exited",
        logTail: "[1:1:ERROR] Missing X server or display",
      });
      // Exit is noticed on the next poll, long before the deadline.
      expect(Date.now() - started).toBeLessThan(10_000);
    },
    30_000,
  );

  it.skipIf(!python3)(
    "a browser that stays up but never listens: reports timeout at the deadline",
    async () => {
      const port = await freePort();
      const logPath = path.join(dir, "browser.log");
      const { stdout } = await execFileAsync("bash", [
        "-c",
        launchScript("sleep 30", port, 1_200, logPath),
      ]);
      const readiness = parseChromeDevToolsReadiness(stdout);
      expect(readiness).toMatchObject({ state: "timeout", logTail: "" });
      expect(readiness!.waitedMs).toBeGreaterThanOrEqual(1_200);
    },
    30_000,
  );

  it("reads no readiness from a launch that printed no markers (a browser without DevTools)", () => {
    expect(parseChromeDevToolsReadiness("HUMANISH_BROWSER_RESOLVED=firefox\n")).toBeUndefined();
    expect(
      parseChromeDevToolsReadiness(
        "HUMANISH_BROWSER_CDP_NOT_READY=timeout\nHUMANISH_BROWSER_CDP_WAITED_MS=30004\nHUMANISH_BROWSER_LOG_TAIL=\n",
      ),
    ).toEqual({ state: "timeout", waitedMs: 30_004, logTail: "" });
  });
});
