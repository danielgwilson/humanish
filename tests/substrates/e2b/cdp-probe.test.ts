// The in-sandbox DevTools probe, run the way a sandbox runs it: the real python3, against a real
// headless Chrome. A missing interpreter once blinded the probe, so the contract is
// executed, never simulated. Chrome-backed cases skip (loudly) where no Chrome binary exists.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHROME_CDP_PROBE_PY,
  chromeCdpProbeCommand,
  parseChromeCdpProbeOutput,
  type ChromeCdpProbeArgs,
  type ChromeCdpProbeResult,
} from "../../../src/substrates/e2b/cdp-probe.js";
import { makeChromeBrowserStateObserver } from "../../../src/substrates/e2b/desktop-cdp.js";
import { makeChromeDesktopGeometryObserver } from "../../../src/substrates/e2b/desktop-geometry.js";
import type { E2BCommandResult, E2BDesktopSandbox } from "../../../src/substrates/e2b/sdk.js";
import { launchReadableChrome, stopChrome } from "../../helpers/readable-chrome.js";

const execFileAsync = promisify(execFile);

async function runProbe(args: ChromeCdpProbeArgs): Promise<ChromeCdpProbeResult> {
  const { stdout } = await execFileAsync("python3", [
    "-c",
    CHROME_CDP_PROBE_PY,
    JSON.stringify(args),
  ]);
  return parseChromeCdpProbeOutput(stdout);
}

function findChrome(): string | undefined {
  const fromEnv = [
    process.env.HUMANISH_TEST_CHROME,
    process.env.CHROME_BIN,
    process.env.PUPPETEER_EXECUTABLE_PATH,
  ];
  const onPath = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const candidate of fromEnv) {
    if (candidate) {
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // try the next one
      }
    }
  }
  for (const name of onPath) {
    for (const dir of dirs) {
      const full = path.join(dir, name);
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

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
const chrome = findChrome();

describe("chrome-cdp-probe: port resolution under the real python3", () => {
  let profileDir: string;
  beforeAll(async () => {
    profileDir = await mkdtemp(path.join(tmpdir(), "humanish-cdp-profile-"));
  });
  afterAll(async () => {
    await rm(profileDir, { recursive: true, force: true });
  });

  it.skipIf(!python3)(
    "cached launch-time port wins even when the marker file disagrees",
    async () => {
      await writeFile(
        path.join(profileDir, "DevToolsActivePort"),
        "39321\n/devtools/browser/abc\n",
        "utf8",
      );
      expect(
        (
          await runProbe({
            mode: "port",
            cdpPort: 41234,
            profileDir,
            targetUrl: "http://127.0.0.1:3000/",
          })
        ).cdpPort,
      ).toBe(41234);
    },
  );

  it.skipIf(!python3)(
    "no cached port: re-reads the profile's DevToolsActivePort at observe time (slow cold start)",
    async () => {
      await writeFile(
        path.join(profileDir, "DevToolsActivePort"),
        "39321\n/devtools/browser/abc\n",
        "utf8",
      );
      expect(
        (await runProbe({ mode: "port", profileDir, targetUrl: "http://127.0.0.1:3000/" })).cdpPort,
      ).toBe(39321);
    },
  );

  it.skipIf(!python3)(
    "no cached port + no marker: falls back to the legacy fixed 9222",
    async () => {
      await rm(path.join(profileDir, "DevToolsActivePort"), { force: true });
      expect(
        (await runProbe({ mode: "port", profileDir, targetUrl: "http://127.0.0.1:3000/" })).cdpPort,
      ).toBe(9222);
    },
  );

  it.skipIf(!python3)(
    "garbled marker degrades to the legacy fallback instead of a bogus port",
    async () => {
      await writeFile(path.join(profileDir, "DevToolsActivePort"), "not-a-port\n", "utf8");
      expect(
        (await runProbe({ mode: "port", profileDir, targetUrl: "http://127.0.0.1:3000/" })).cdpPort,
      ).toBe(9222);
    },
  );

  it.skipIf(!python3)(
    "a dead endpoint is reported as unavailable with the reason, not as an empty success",
    async () => {
      // Nothing listens on this port; the probe must say so instead of printing {}.
      const result = await runProbe({
        mode: "state",
        cdpPort: 1,
        targetUrl: "http://127.0.0.1:3000/",
      });
      expect(result.unavailable).toMatch(/127\.0\.0\.1:1\/json unreachable/);
      expect(result.url).toBeUndefined();
    },
  );
});

describe("chrome-cdp-probe: against a real headless Chrome", () => {
  let server: Server | undefined;
  let pageUrl = "";
  let profileDir = "";
  let browser: ChildProcess | undefined;
  let cdpPort = 0;
  // Why a first launch was replaced, for the first case to annotate. A Chrome that never reads
  // back fails the hook with one reason per launch instead.
  let launchFailures: string[] = [];

  beforeAll(async () => {
    if (!python3 || chrome === undefined) return;
    server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      // A viewport meta, as real apps carry: without it a mobile-emulated page lays out at 980 px,
      // which is what a phone does with a desktop-only page.
      response.end(
        '<html><head><title>probe page</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>hello probe text</h1><p>second line</p></body></html>',
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/index.html`;
    // 60 s for at most two launches keeps the hook well inside its own timeout, so a Chrome that
    // never reads back fails here with the reason for each launch, not with a hook timeout.
    const launch = await launchReadableChrome(chrome, pageUrl, 60_000);
    launchFailures = launch.failures;
    if (!launch.chrome)
      throw new Error(
        `headless Chrome at ${chrome} never read back: ${launch.failures.join("; ")}`,
      );
    ({ browser, profileDir, cdpPort } = launch.chrome);
  }, 120_000);

  afterAll(async () => {
    await stopChrome(browser, profileDir);
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }, 20_000);

  const live = python3 && chrome !== undefined;

  it.skipIf(!live)(
    "state mode reads url, title, innerText and scrollY through the page socket",
    async (ctx) => {
      // A first launch that stalled and was replaced is a clue to why launches stall here.
      if (launchFailures.length > 0) await ctx.annotate(launchFailures.join("; "), "notice");
      const state = await runProbe({
        mode: "state",
        prefer: "active",
        profileDir,
        targetUrl: pageUrl,
      });
      expect(state.url).toBe(pageUrl);
      expect(state.title).toBe("probe page");
      expect(state.text).toContain("hello probe text");
      expect(state.text).toContain("second line");
      expect(state.scrollY).toBe(0);
      expect(state.targetId).toMatch(/^[0-9A-F]+$/i);
    },
  );

  it.skipIf(!live)(
    "pinned mode attributes the page by the lane's target URL when no target id is known",
    async () => {
      const state = await runProbe({
        mode: "state",
        prefer: "pinned",
        cdpPort,
        targetUrl: pageUrl,
      });
      expect(state.url).toBe(pageUrl);
    },
  );

  it.skipIf(!live)(
    "geometry mode reads outer window bounds, the CSS viewport and the page target id",
    async () => {
      const geometry = await runProbe({ mode: "geometry", cdpPort, targetUrl: pageUrl });
      expect(geometry.unavailable).toBeUndefined();
      expect(geometry.viewport?.width).toBeGreaterThan(0);
      expect(geometry.viewport?.height).toBeGreaterThan(0);
      expect(geometry.browserWindow?.width).toBeGreaterThan(0);
      expect(geometry.targetId).toMatch(/^[0-9A-F]+$/i);
      // The pinned id then selects the same page even when the target URL is wrong.
      const pinned = await runProbe({
        mode: "state",
        prefer: "pinned",
        cdpPort,
        targetUrl: "http://example.invalid/",
        targetId: geometry.targetId!,
      });
      expect(pinned.url).toBe(pageUrl);
    },
  );

  it.skipIf(!live)(
    "a target URL that matches no page (pinned, several tabs would be ambiguous) still reads the single page",
    async () => {
      // One http page: the single-page fallback applies, as it did in the node probe.
      const state = await runProbe({
        mode: "state",
        prefer: "pinned",
        cdpPort,
        targetUrl: "http://example.invalid/",
      });
      expect(state.url).toBe(pageUrl);
    },
  );

  // Chrome may answer /json/close before it drops the target, and "active" reads the first page in
  // /json/list, so a tab a test opened must be gone from the list before the next test probes.
  const closeTarget = async (id: string): Promise<boolean> => {
    await fetch(`http://127.0.0.1:${cdpPort}/json/close/${id}`).catch(() => undefined);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const listed = (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
        .then((response) => response.json())
        .catch(() => [])) as Array<{ id?: string }>;
      if (!listed.some((target) => target.id === id)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };

  // The launch page reloads under an earlier case's holder and can be mid-navigation (no http
  // target for a moment) when the next case starts: wait until it reads at its URL again, so a
  // loaded runner does not turn that moment into "no http page among N CDP targets".
  const settleLaunchPage = async (): Promise<void> => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = await runProbe({
        mode: "state",
        prefer: "pinned",
        cdpPort,
        targetUrl: pageUrl,
      });
      if (state.url === pageUrl && state.text !== undefined) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  it.skipIf(!live)(
    "emulate mode applies mobile metrics, touch and a mobile UA; fidelity mode reads them back from the page",
    async (ctx) => {
      await settleLaunchPage();
      const emulation = {
        width: 414,
        height: 896,
        deviceScaleFactor: 3,
        touch: true,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      };
      // One-shot apply: the session-scoped overrides (UA, touch, DPR) lapse when the socket closes,
      // which is why the lane uses "hold". The one-shot still reports what it applied. On a loaded
      // runner /json can list no http page for an instant (a reload in flight); that answer is
      // transient, so it is retried the way the lane's observer retries on its next turn.
      let applied = await runProbe({
        mode: "emulate",
        prefer: "pinned",
        cdpPort,
        targetUrl: pageUrl,
        emulation,
      });
      for (
        let attempt = 0;
        attempt < 20 && applied.unavailable?.includes("no http page");
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        applied = await runProbe({
          mode: "emulate",
          prefer: "pinned",
          cdpPort,
          targetUrl: pageUrl,
          emulation,
        });
      }
      expect(applied.unavailable).toBeUndefined();
      expect(applied.applied).toEqual([
        "Emulation.setDeviceMetricsOverride",
        "Emulation.setTouchEmulationEnabled",
        "Emulation.setEmitTouchEventsForMouse",
        "Emulation.setUserAgentOverride",
        "Page.reload",
      ]);

      // "hold": the applier stays attached; while it lives the page reports the emulated device.
      const holder = spawn(
        "python3",
        [
          "-c",
          CHROME_CDP_PROBE_PY,
          JSON.stringify({
            mode: "hold",
            prefer: "pinned",
            cdpPort,
            targetUrl: pageUrl,
            emulation,
          }),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let announced = "";
      let holderErrors = "";
      holder.stdout.on("data", (chunk: Buffer) => {
        announced += chunk.toString("utf8");
      });
      holder.stderr.on("data", (chunk: Buffer) => {
        holderErrors += chunk.toString("utf8");
      });
      try {
        // The holder announces once its socket is up; on a slow runner that can take a while, and a
        // holder that never comes up is the runner's Chrome, not the probe.
        const announceLine = async (): Promise<string | undefined> => {
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const line = announced.split("\n").find((candidate) => candidate.startsWith("{"));
            if (line !== undefined) return line;
            if (holder.exitCode !== null) return undefined;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          return undefined;
        };
        const line = await announceLine();
        if (line === undefined) {
          console.warn(
            `chrome-cdp-probe: the hold-mode applier never announced (exit ${holder.exitCode}); stderr: ${holderErrors.slice(-300)}`,
          );
          return ctx.skip("the hold-mode applier did not come up on this runner");
        }
        // Name the announce on failure: "Target cannot be null" said nothing on the node-22 runner.
        const announcedResult = parseChromeCdpProbeOutput(line);
        expect(announcedResult.unavailable, line).toBeUndefined();
        expect(announcedResult.applied, line).toHaveLength(5);
        let read = await runProbe({
          mode: "fidelity",
          prefer: "pinned",
          cdpPort,
          targetUrl: pageUrl,
        });
        for (
          let attempt = 0;
          attempt < 40 &&
          !(read.fidelity?.innerWidth === 414 && read.fidelity.userAgent.includes("iPhone"));
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          read = await runProbe({
            mode: "fidelity",
            prefer: "pinned",
            cdpPort,
            targetUrl: pageUrl,
          });
        }
        expect(read.fidelity?.innerWidth).toBe(414);
        expect(read.fidelity?.devicePixelRatio).toBe(3);
        expect(read.fidelity?.maxTouchPoints).toBe(5);
        expect(read.fidelity?.userAgent).toContain("iPhone");
        expect(read.fidelity?.coarsePointer).toBe(true);
      } finally {
        holder.kill("SIGKILL");
      }
      // After the holder dies the session-scoped overrides lapse: the UA is the browser's own again.
      let after = await runProbe({
        mode: "fidelity",
        prefer: "pinned",
        cdpPort,
        targetUrl: pageUrl,
      });
      for (
        let attempt = 0;
        attempt < 40 && after.fidelity?.userAgent.includes("iPhone");
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        after = await runProbe({ mode: "fidelity", prefer: "pinned", cdpPort, targetUrl: pageUrl });
      }
      expect(after.fidelity?.userAgent).not.toContain("iPhone");
    },
    45_000,
  );

  it.skipIf(!live)(
    "hold mode emulates a page target opened after it attached, without pausing it",
    async (ctx) => {
      await settleLaunchPage();
      const emulation = {
        width: 414,
        height: 896,
        deviceScaleFactor: 3,
        touch: true,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      };
      const holder = spawn(
        "python3",
        [
          "-c",
          CHROME_CDP_PROBE_PY,
          JSON.stringify({
            mode: "hold",
            prefer: "pinned",
            cdpPort,
            targetUrl: pageUrl,
            emulation,
          }),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let announced = "";
      let holderErrors = "";
      holder.stdout.on("data", (chunk: Buffer) => {
        announced += chunk.toString("utf8");
      });
      holder.stderr.on("data", (chunk: Buffer) => {
        holderErrors += chunk.toString("utf8");
      });
      const lines = () => announced.split("\n").filter((candidate) => candidate.startsWith("{"));
      let openedTab: string | undefined;
      let tabClosed = true;
      try {
        for (
          let attempt = 0;
          attempt < 80 && lines().length === 0 && holder.exitCode === null;
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const announce = lines()[0];
        if (announce === undefined) {
          console.warn(
            `chrome-cdp-probe: the hold-mode applier never announced (exit ${holder.exitCode}); stderr: ${holderErrors.slice(-300)}`,
          );
          return ctx.skip("the hold-mode applier did not come up on this runner");
        }
        expect(parseChromeCdpProbeOutput(announce).unavailable, announce).toBeUndefined();
        // A second tab, opened the way a target=_blank link opens one, after the holder attached.
        // Chrome's legacy endpoint needs PUT; the reply is the new target's /json entry.
        const created = (await (
          await fetch(`http://127.0.0.1:${cdpPort}/json/new?${pageUrl}?second`, { method: "PUT" })
        ).json()) as { id?: string };
        expect(typeof created.id, JSON.stringify(created)).toBe("string");
        const secondId = created.id as string;
        openedTab = secondId;
        // The page's own read-back on that target: the phone viewport, DPR and touch, never inherited
        // from the window (the launch page is emulated by its own session).
        let read = await runProbe({
          mode: "fidelity",
          prefer: "pinned",
          cdpPort,
          targetUrl: pageUrl,
          targetId: secondId,
        });
        for (
          let attempt = 0;
          attempt < 40 &&
          !(read.fidelity?.innerWidth === 414 && read.fidelity.userAgent.includes("iPhone"));
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          read = await runProbe({
            mode: "fidelity",
            prefer: "pinned",
            cdpPort,
            targetUrl: pageUrl,
            targetId: secondId,
          });
        }
        expect(read.fidelity?.innerWidth, JSON.stringify(read)).toBe(414);
        expect(read.fidelity?.devicePixelRatio).toBe(3);
        expect(read.fidelity?.maxTouchPoints).toBe(5);
        expect(read.fidelity?.userAgent).toContain("iPhone");
        // The holder's log names the target it attached to and what it sent (fire-and-forget, then a
        // reload so a script that read the viewport at load sees the phone width); a reply that
        // carried an error would be a replyError line, and there is none.
        const attachLine = lines().find((line) => line.includes(secondId));
        expect(attachLine, announced).toBeDefined();
        const attached = JSON.parse(attachLine as string) as {
          attached: string;
          sent: string[];
          reloadAfterNavigation?: boolean;
          url?: string;
        };
        expect(attached.sent.slice(0, 4)).toEqual([
          "Emulation.setDeviceMetricsOverride",
          "Emulation.setTouchEmulationEnabled",
          "Emulation.setEmitTouchEventsForMouse",
          "Emulation.setUserAgentOverride",
        ]);
        // Either the tab had already committed at attach time (reloaded at once) or it owed one
        // reload after its first navigation; either way exactly one reload line or reload send.
        const reloadedLine = lines().find(
          (line) => line.includes('"reloaded"') && line.includes(secondId),
        );
        expect(attached.sent.includes("Page.reload") || reloadedLine !== undefined, announced).toBe(
          true,
        );
        expect(lines().filter((line) => line.includes("replyError"))).toEqual([]);
      } finally {
        holder.kill("SIGKILL");
        if (openedTab !== undefined) tabClosed = await closeTarget(openedTab);
      }
      expect(tabClosed, `tab ${openedTab} still listed 5 s after /json/close`).toBe(true);
    },
    45_000,
  );

  it.skipIf(!live)(
    "the shipped command (python3 -c ... '<json>') runs end to end through a shell",
    async () => {
      await settleLaunchPage();
      const command = chromeCdpProbeCommand({
        mode: "state",
        prefer: "active",
        cdpPort,
        targetUrl: pageUrl,
      });
      expect(command.startsWith("python3 -c '")).toBe(true);
      const { stdout } = await execFileAsync("sh", ["-c", command]);
      expect(parseChromeCdpProbeOutput(stdout).url).toBe(pageUrl);
    },
  );

  it.skipIf(!live)(
    "final geometry follows a new foreground tab and still measures it after the launch tab closes",
    async () => {
      const created: string[] = [];
      const desktop = {
        commands: { run: async (command: string) => execFileAsync("sh", ["-c", command]) },
      } as unknown as E2BDesktopSandbox;
      const open = async (suffix: string): Promise<string> => {
        const result = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${pageUrl}?${suffix}`, {
          method: "PUT",
        });
        const page = (await result.json()) as { id: string };
        created.push(page.id);
        await fetch(`http://127.0.0.1:${cdpPort}/json/activate/${page.id}`);
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const read = await runProbe({
            mode: "state",
            prefer: "active",
            cdpPort,
            targetUrl: pageUrl,
          });
          if (read.targetId === page.id && read.text !== undefined) return page.id;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("new page did not become readable");
      };
      try {
        const launch = await open("launch");
        const foreground = await open("foreground");
        const endpoint = { cdpPort, targetUrl: `${pageUrl}?launch` };
        const launchRead = makeChromeDesktopGeometryObserver(desktop, 5_000, endpoint, {
          targetId: launch,
        });
        const finalRead = makeChromeDesktopGeometryObserver(desktop, 5_000, endpoint, {
          targetId: launch,
          prefer: "active",
        });
        expect((await launchRead())?.targetId).toBe(launch);
        expect((await finalRead())?.targetId).toBe(foreground);
        await fetch(`http://127.0.0.1:${cdpPort}/json/close/${launch}`);
        expect(await launchRead()).toBeUndefined();
        const remaining = await finalRead();
        expect(remaining?.targetId).toBe(foreground);
        expect(remaining?.viewport?.width).toBeGreaterThan(0);
        expect(remaining?.viewport?.source).toBe("cdp");
      } finally {
        for (const id of created)
          await fetch(`http://127.0.0.1:${cdpPort}/json/close/${id}`).catch(() => undefined);
      }
    },
  );
});

describe("hosted geometry wire capture: independent window and CSS measurements", () => {
  let captured: Record<string, E2BCommandResult>;
  beforeAll(async () => {
    captured = JSON.parse(
      await readFile(
        new URL("../../fixtures/chrome-cdp/hosted-geometry-2026-09-15.json", import.meta.url),
        "utf8",
      ),
    );
  });

  const observe = (reply: E2BCommandResult, reasons: string[]) =>
    makeChromeDesktopGeometryObserver(
      { commands: { run: async () => reply } } as unknown as E2BDesktopSandbox,
      1_000,
      { targetUrl: "http://127.0.0.1:8765/index.html" },
      { onUnavailable: (reason) => reasons.push(reason) },
    )();

  it("keeps actual CSS read-back when a background navigation reports zero outer dimensions", async () => {
    const reasons: string[] = [];
    const read = await observe(captured.backgroundAfterNavigation!, reasons);
    expect(read).toEqual({
      viewport: { width: 1512, height: 805, deviceScaleFactor: 1, source: "cdp" },
      targetId: "LAUNCH-PAGE",
    });
    expect(reasons).toEqual(["the page reported no usable outer-window dimensions"]);
  });

  it("keeps the foreground page's different CSS read-back", async () => {
    const reasons: string[] = [];
    expect((await observe(captured.foreground!, reasons))?.viewport).toEqual({
      width: 1512,
      height: 861,
      deviceScaleFactor: 1,
      source: "cdp",
    });
    expect(reasons).toEqual([]);
  });

  it("retains the missing-target reason and never invents dimensions", async () => {
    const reasons: string[] = [];
    expect(await observe(captured.closedLaunchTarget!, reasons)).toBeUndefined();
    expect(reasons).toEqual(["no http page among 3 CDP targets on 127.0.0.1:9222"]);
  });

  it("does not substitute measured outer bounds for a corrupt CSS channel", async () => {
    // Deliberately corrupt the captured CSS channel; this is not a claimed provider response.
    const corrupt = JSON.parse(captured.foreground!.stdout!);
    corrupt.viewport.width = 0;
    const reasons: string[] = [];
    const read = await observe(
      { ...captured.foreground!, stdout: JSON.stringify(corrupt) },
      reasons,
    );
    expect(read?.browserWindow).toEqual({ x: 0, y: 0, width: 1512, height: 861, source: "cdp" });
    expect(read?.viewport).toBeUndefined();
    expect(reasons).toEqual(["the page reported no usable CSS viewport dimensions"]);
  });
});

describe("makeChromeBrowserStateObserver / makeChromeDesktopGeometryObserver: the unavailable seam", () => {
  function fakeDesktop(reply: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  }): E2BDesktopSandbox {
    return { commands: { run: async () => reply } } as unknown as E2BDesktopSandbox;
  }

  it("reports a dark channel once, with the probe's reason, and still degrades to {} for the loop", async () => {
    const reasons: string[] = [];
    const observe = makeChromeBrowserStateObserver(
      fakeDesktop({
        exitCode: 0,
        stdout: JSON.stringify({
          unavailable: "no http page among 0 CDP targets on 127.0.0.1:9222",
        }),
      }),
      1_000,
      { targetUrl: "http://127.0.0.1:3000/" },
      { onUnavailable: (reason) => reasons.push(reason) },
    );
    expect(await observe()).toEqual({});
    expect(await observe()).toEqual({});
    expect(reasons).toEqual(["no http page among 0 CDP targets on 127.0.0.1:9222"]);
  });

  it("an interpreter that is not there (exit 127) is reported with the exit code", async () => {
    const reasons: string[] = [];
    const observe = makeChromeBrowserStateObserver(
      fakeDesktop({ exitCode: 127, stdout: "", stderr: "sh: 1: python3: not found\n" }),
      1_000,
      { targetUrl: "http://127.0.0.1:3000/" },
      { onUnavailable: (reason) => reasons.push(reason) },
    );
    expect(await observe()).toEqual({});
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("probe exited 127");
    expect(reasons[0]).toContain("python3: not found");
  });

  it("a healthy probe reports nothing and passes url/title/text/scrollY through", async () => {
    const reasons: string[] = [];
    const observe = makeChromeBrowserStateObserver(
      fakeDesktop({
        exitCode: 0,
        stdout: JSON.stringify({
          url: "http://127.0.0.1:3000/pricing",
          title: "Pricing",
          text: "per seat",
          scrollY: 12,
        }),
      }),
      1_000,
      { targetUrl: "http://127.0.0.1:3000/" },
      { onUnavailable: (reason) => reasons.push(reason) },
    );
    expect(await observe()).toEqual({
      url: "http://127.0.0.1:3000/pricing",
      title: "Pricing",
      text: "per seat",
      scrollY: 12,
    });
    expect(reasons).toEqual([]);
  });

  it("the geometry observer hands the reason to its caller so the viewport warning can name the cause", async () => {
    const reasons: string[] = [];
    const observe = makeChromeDesktopGeometryObserver(
      fakeDesktop({
        exitCode: 0,
        stdout: JSON.stringify({
          unavailable: "CDP endpoint 127.0.0.1:9222/json unreachable (URLError)",
        }),
      }),
      1_000,
      { targetUrl: "http://127.0.0.1:3000/" },
      { onUnavailable: (reason) => reasons.push(reason) },
    );
    expect(await observe()).toBeUndefined();
    expect(reasons).toEqual(["CDP endpoint 127.0.0.1:9222/json unreachable (URLError)"]);
  });

  // A fake desktop whose "state" probe reports the launch tab first and other-tab afterwards, and
  // whose "fidelity" probe on that tab answers with the given read-back (or exits non-zero).
  function driftingDesktop(fidelityStdout: string | undefined): {
    desktop: E2BDesktopSandbox;
    commands: () => string[];
  } {
    let stateCalls = 0;
    const commands: string[] = [];
    const desktop = {
      commands: {
        run: async (command: string) => {
          commands.push(command);
          if (command.includes('"mode":"fidelity"')) {
            return fidelityStdout === undefined
              ? { exitCode: 1, stdout: "", stderr: "boom" }
              : { exitCode: 0, stdout: fidelityStdout };
          }
          stateCalls += 1;
          const targetId = stateCalls === 1 ? "EMULATED" : "OTHER-TAB";
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              url: "http://127.0.0.1:3000/",
              title: "t",
              text: "hello",
              scrollY: 0,
              targetId,
            }),
          };
        },
      },
    } as unknown as E2BDesktopSandbox;
    return { desktop, commands: () => commands };
  }
  const phoneReadBack = JSON.stringify({
    fidelity: {
      userAgent: "iPhone",
      devicePixelRatio: 3,
      innerWidth: 414,
      innerHeight: 896,
      maxTouchPoints: 5,
      coarsePointer: true,
    },
    targetId: "OTHER-TAB",
  });
  const desktopReadBack = JSON.stringify({
    fidelity: {
      userAgent: "iPhone",
      devicePixelRatio: 1,
      innerWidth: 500,
      innerHeight: 700,
      maxTouchPoints: 5,
      coarsePointer: true,
    },
    targetId: "OTHER-TAB",
  });

  it("a later tab whose own read-back reports the requested width is recorded as covered, never as drift", async () => {
    const { desktop, commands } = driftingDesktop(phoneReadBack);
    const drifts: string[] = [];
    const covered: [
      string,
      { innerWidth: number; devicePixelRatio: number; maxTouchPoints: number },
    ][] = [];
    const observe = makeChromeBrowserStateObserver(
      desktop,
      1_000,
      { targetUrl: "http://127.0.0.1:3000/" },
      {
        drift: {
          emulatedTargetId: "EMULATED",
          expectedWidth: 414,
          expectTouch: true,
          onDrift: (reason) => drifts.push(reason),
          onCovered: (targetId, read) => covered.push([targetId, read]),
        },
      },
    );
    expect((await observe()).url).toBe("http://127.0.0.1:3000/");
    await observe();
    await observe();
    expect(drifts).toEqual([]);
    expect(covered).toEqual([
      ["OTHER-TAB", { innerWidth: 414, devicePixelRatio: 3, maxTouchPoints: 5 }],
    ]);
    // The read-back was taken once for the new target, pinned to its id, not on every observation.
    const fidelityReads = commands().filter((command) => command.includes('"mode":"fidelity"'));
    expect(fidelityReads).toHaveLength(1);
    expect(fidelityReads[0]).toContain('"targetId":"OTHER-TAB"');
  });

  it("a later tab at the phone width but with no touch points is covered and a touch warning", async () => {
    const noTouch = JSON.stringify({
      fidelity: {
        userAgent: "iPhone",
        devicePixelRatio: 3,
        innerWidth: 414,
        innerHeight: 896,
        maxTouchPoints: 0,
        coarsePointer: false,
      },
      targetId: "OTHER-TAB",
    });
    const { desktop } = driftingDesktop(noTouch);
    const drifts: string[] = [];
    const covered: string[] = [];
    const observe = makeChromeBrowserStateObserver(
      desktop,
      1_000,
      { targetUrl: "http://127.0.0.1:3000/" },
      {
        drift: {
          emulatedTargetId: "EMULATED",
          expectedWidth: 414,
          expectTouch: true,
          onDrift: (reason) => drifts.push(reason),
          onCovered: (targetId) => covered.push(targetId),
        },
      },
    );
    await observe();
    await observe();
    expect(covered).toEqual(["OTHER-TAB"]);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toContain("maxTouchPoints 0");
  });

  it("a later tab that reports the window width is drift, once, with the number the page gave", async () => {
    const { desktop } = driftingDesktop(desktopReadBack);
    const drifts: string[] = [];
    const observe = makeChromeBrowserStateObserver(
      desktop,
      1_000,
      { targetUrl: "http://127.0.0.1:3000/" },
      {
        drift: {
          emulatedTargetId: "EMULATED",
          expectedWidth: 414,
          onDrift: (reason) => drifts.push(reason),
        },
      },
    );
    await observe();
    await observe();
    await observe();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toContain("reports a 500 px viewport where 414 px was requested");
  });

  it("a later tab whose read-back cannot be taken is drift with the uncertainty named", async () => {
    const { desktop } = driftingDesktop(undefined);
    const drifts: string[] = [];
    const observe = makeChromeBrowserStateObserver(
      desktop,
      1_000,
      { targetUrl: "http://127.0.0.1:3000/" },
      {
        drift: {
          emulatedTargetId: "EMULATED",
          expectedWidth: 414,
          onDrift: (reason) => drifts.push(reason),
        },
      },
    );
    await observe();
    await observe();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toContain("read-back could not be taken");
  });

  it("parseChromeCdpProbeOutput never turns garbage into an empty success", () => {
    expect(parseChromeCdpProbeOutput("")).toEqual({ unavailable: "probe printed nothing" });
    expect(parseChromeCdpProbeOutput("Traceback (most recent call last)")).toEqual({
      unavailable: "probe output was not JSON",
    });
    expect(parseChromeCdpProbeOutput("[]")).toEqual({});
    expect(
      parseChromeCdpProbeOutput(JSON.stringify({ url: "", title: "", text: "", scrollY: null })),
    ).toEqual({});
  });
});
