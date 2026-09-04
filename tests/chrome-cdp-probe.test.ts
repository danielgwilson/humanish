// The in-sandbox DevTools probe, run the way a sandbox runs it: the real python3, against a real
// headless Chrome. The #514 root cause was an interpreter that was not there, so the contract is
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
  type ChromeCdpProbeResult
} from "../src/chrome-cdp-probe.js";
import { makeChromeBrowserStateObserver, makeChromeDesktopGeometryObserver } from "../src/cua-actor-lab.js";
import type { E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";

const execFileAsync = promisify(execFile);

async function runProbe(args: ChromeCdpProbeArgs): Promise<ChromeCdpProbeResult> {
  const { stdout } = await execFileAsync("python3", ["-c", CHROME_CDP_PROBE_PY, JSON.stringify(args)]);
  return parseChromeCdpProbeOutput(stdout);
}

function findChrome(): string | undefined {
  const fromEnv = [process.env.HUMANISH_TEST_CHROME, process.env.CHROME_BIN, process.env.PUPPETEER_EXECUTABLE_PATH];
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

  it.skipIf(!python3)("cached launch-time port wins even when the marker file disagrees", async () => {
    await writeFile(path.join(profileDir, "DevToolsActivePort"), "39321\n/devtools/browser/abc\n", "utf8");
    expect((await runProbe({ mode: "port", cdpPort: 41234, profileDir, targetUrl: "http://127.0.0.1:3000/" })).cdpPort).toBe(41234);
  });

  it.skipIf(!python3)("no cached port: re-reads the profile's DevToolsActivePort at observe time (slow cold start)", async () => {
    await writeFile(path.join(profileDir, "DevToolsActivePort"), "39321\n/devtools/browser/abc\n", "utf8");
    expect((await runProbe({ mode: "port", profileDir, targetUrl: "http://127.0.0.1:3000/" })).cdpPort).toBe(39321);
  });

  it.skipIf(!python3)("no cached port + no marker: falls back to the legacy fixed 9222", async () => {
    await rm(path.join(profileDir, "DevToolsActivePort"), { force: true });
    expect((await runProbe({ mode: "port", profileDir, targetUrl: "http://127.0.0.1:3000/" })).cdpPort).toBe(9222);
  });

  it.skipIf(!python3)("garbled marker degrades to the legacy fallback instead of a bogus port", async () => {
    await writeFile(path.join(profileDir, "DevToolsActivePort"), "not-a-port\n", "utf8");
    expect((await runProbe({ mode: "port", profileDir, targetUrl: "http://127.0.0.1:3000/" })).cdpPort).toBe(9222);
  });

  it.skipIf(!python3)("a dead endpoint is reported as unavailable WITH the reason, not as an empty success", async () => {
    // Nothing listens on this port; the probe must say so instead of printing {}.
    const result = await runProbe({ mode: "state", cdpPort: 1, targetUrl: "http://127.0.0.1:3000/" });
    expect(result.unavailable).toMatch(/127\.0\.0\.1:1\/json unreachable/);
    expect(result.url).toBeUndefined();
  });
});

describe("chrome-cdp-probe: against a real headless Chrome", () => {
  let server: Server | undefined;
  let pageUrl = "";
  let profileDir = "";
  let browser: ChildProcess | undefined;
  let cdpPort = 0;
  // Set once the page is readable through the socket. A runner where Chrome never comes up in
  // time is not a defect in the probe, so those cases SKIP with a note instead of failing (the
  // node-22 main leg on 2026-09-03 waited 20 s for DevToolsActivePort and failed five cases).
  let chromeUp = false;

  beforeAll(async () => {
    if (!python3 || chrome === undefined) return;
    server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      // A viewport meta, as real apps carry: without it a mobile-emulated page lays out at 980 px,
      // which is what a phone does with a desktop-only page.
      response.end("<html><head><title>probe page</title><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body><h1>hello probe text</h1><p>second line</p></body></html>");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/index.html`;
    profileDir = await mkdtemp(path.join(tmpdir(), "humanish-cdp-chrome-"));
    browser = spawn(
      chrome,
      ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, pageUrl],
      { stdio: "ignore" }
    );
    // Same seam the sandbox uses: the marker file appears once DevTools is listening.
    const markerPath = path.join(profileDir, "DevToolsActivePort");
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const marker = await readFile(markerPath, "utf8").catch(() => "");
      const parsed = Number.parseInt(marker.split("\n")[0] ?? "", 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        cdpPort = parsed;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Let the tab finish navigating so the "active" read is the page, not the launch blank.
    for (let attempt = 0; attempt < 80 && cdpPort > 0; attempt += 1) {
      const state = await runProbe({ mode: "state", prefer: "active", cdpPort, targetUrl: pageUrl });
      if (state.url === pageUrl && state.text !== undefined) {
        chromeUp = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!chromeUp) {
      console.warn(`chrome-cdp-probe: headless Chrome at ${chrome} did not become readable (cdpPort=${cdpPort}); Chrome-backed cases will skip`);
    }
  }, 120_000);

  afterAll(async () => {
    if (browser !== undefined && browser.exitCode === null) {
      // Let Chrome shut its helpers down before the profile dir goes; a SIGKILL followed by an
      // immediate rm raced Chrome's own writers (ENOTEMPTY on Default/) in the full suite.
      const exited = new Promise<void>((resolve) => browser!.once("exit", () => resolve()));
      browser.kill("SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
      if (browser.exitCode === null) {
        browser.kill("SIGKILL");
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
      }
    }
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (profileDir) await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, 20_000);

  const live = python3 && chrome !== undefined;

  it.skipIf(!live)("state mode reads url, title, innerText and scrollY through the page socket", async (ctx) => {
    if (!chromeUp) return ctx.skip("headless Chrome did not become readable on this runner");
    const state = await runProbe({ mode: "state", prefer: "active", profileDir, targetUrl: pageUrl });
    expect(state.url).toBe(pageUrl);
    expect(state.title).toBe("probe page");
    expect(state.text).toContain("hello probe text");
    expect(state.text).toContain("second line");
    expect(state.scrollY).toBe(0);
    expect(state.targetId).toMatch(/^[0-9A-F]+$/i);
  });

  it.skipIf(!live)("pinned mode attributes the page by the lane's target URL when no target id is known", async (ctx) => {
    if (!chromeUp) return ctx.skip("headless Chrome did not become readable on this runner");
    const state = await runProbe({ mode: "state", prefer: "pinned", cdpPort, targetUrl: pageUrl });
    expect(state.url).toBe(pageUrl);
  });

  it.skipIf(!live)("geometry mode reads outer window bounds, the CSS viewport and the page target id", async (ctx) => {
    if (!chromeUp) return ctx.skip("headless Chrome did not become readable on this runner");
    const geometry = await runProbe({ mode: "geometry", cdpPort, targetUrl: pageUrl });
    expect(geometry.unavailable).toBeUndefined();
    expect(geometry.viewport?.width).toBeGreaterThan(0);
    expect(geometry.viewport?.height).toBeGreaterThan(0);
    expect(geometry.browserWindow?.width).toBeGreaterThan(0);
    expect(geometry.targetId).toMatch(/^[0-9A-F]+$/i);
    // The pinned id then selects the same page even when the target URL is wrong.
    const pinned = await runProbe({ mode: "state", prefer: "pinned", cdpPort, targetUrl: "http://example.invalid/", targetId: geometry.targetId! });
    expect(pinned.url).toBe(pageUrl);
  });

  it.skipIf(!live)("a target URL that matches no page (pinned, several tabs would be ambiguous) still reads the single page", async (ctx) => {
    if (!chromeUp) return ctx.skip("headless Chrome did not become readable on this runner");
    // One http page: the single-page fallback applies, as it did in the node probe.
    const state = await runProbe({ mode: "state", prefer: "pinned", cdpPort, targetUrl: "http://example.invalid/" });
    expect(state.url).toBe(pageUrl);
  });

  // The launch page reloads under an earlier case's holder and can be mid-navigation (no http
  // target for a moment) when the next case starts: wait until it reads at its URL again, so a
  // loaded runner does not turn that moment into "no http page among N CDP targets".
  const settleLaunchPage = async (): Promise<void> => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = await runProbe({ mode: "state", prefer: "pinned", cdpPort, targetUrl: pageUrl });
      if (state.url === pageUrl && state.text !== undefined) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  it.skipIf(!live)("emulate mode applies mobile metrics, touch and a mobile UA; fidelity mode reads them back from the page (#221)", async (ctx) => {
    if (!chromeUp) return ctx.skip("headless Chrome did not become readable on this runner");
    await settleLaunchPage();
    const emulation = {
      width: 414,
      height: 896,
      deviceScaleFactor: 3,
      touch: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    };
    // One-shot apply: the session-scoped overrides (UA, touch, DPR) lapse when the socket closes,
    // which is why the lane uses "hold". The one-shot still reports what it applied. On a loaded
    // runner /json can list no http page for an instant (a reload in flight); that answer is
    // transient, so it is retried the way the lane's observer retries on its next turn.
    let applied = await runProbe({ mode: "emulate", prefer: "pinned", cdpPort, targetUrl: pageUrl, emulation });
    for (let attempt = 0; attempt < 20 && applied.unavailable?.includes("no http page"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      applied = await runProbe({ mode: "emulate", prefer: "pinned", cdpPort, targetUrl: pageUrl, emulation });
    }
    expect(applied.unavailable).toBeUndefined();
    expect(applied.applied).toEqual([
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setEmitTouchEventsForMouse",
      "Emulation.setUserAgentOverride",
      "Page.reload"
    ]);

    // "hold": the applier stays attached; while it lives the page reports the emulated device.
    const holder = spawn("python3", ["-c", CHROME_CDP_PROBE_PY, JSON.stringify({ mode: "hold", prefer: "pinned", cdpPort, targetUrl: pageUrl, emulation })], { stdio: ["ignore", "pipe", "pipe"] });
    let announced = "";
    let holderErrors = "";
    holder.stdout.on("data", (chunk: Buffer) => { announced += chunk.toString("utf8"); });
    holder.stderr.on("data", (chunk: Buffer) => { holderErrors += chunk.toString("utf8"); });
    try {
      // The holder announces once its socket is up; on a slow runner that can take a while, and a
      // holder that never comes up is the runner's Chrome, not the probe (same posture as chromeUp).
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
        console.warn(`chrome-cdp-probe: the hold-mode applier never announced (exit ${holder.exitCode}); stderr: ${holderErrors.slice(-300)}`);
        return ctx.skip("the hold-mode applier did not come up on this runner");
      }
      // Name the announce on failure: "Target cannot be null" said nothing on the node-22 runner.
      const announcedResult = parseChromeCdpProbeOutput(line);
      expect(announcedResult.unavailable, line).toBeUndefined();
      expect(announcedResult.applied, line).toHaveLength(5);
      let read = await runProbe({ mode: "fidelity", prefer: "pinned", cdpPort, targetUrl: pageUrl });
      for (let attempt = 0; attempt < 40 && !(read.fidelity?.innerWidth === 414 && read.fidelity.userAgent.includes("iPhone")); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        read = await runProbe({ mode: "fidelity", prefer: "pinned", cdpPort, targetUrl: pageUrl });
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
    let after = await runProbe({ mode: "fidelity", prefer: "pinned", cdpPort, targetUrl: pageUrl });
    for (let attempt = 0; attempt < 40 && after.fidelity?.userAgent.includes("iPhone"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      after = await runProbe({ mode: "fidelity", prefer: "pinned", cdpPort, targetUrl: pageUrl });
    }
    expect(after.fidelity?.userAgent).not.toContain("iPhone");
  }, 45_000);

  it.skipIf(!live)("hold mode emulates a page target opened AFTER it attached, without pausing it (#623)", async (ctx) => {
    if (!chromeUp) return ctx.skip("headless Chrome did not become readable on this runner");
    await settleLaunchPage();
    const emulation = {
      width: 414,
      height: 896,
      deviceScaleFactor: 3,
      touch: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    };
    const holder = spawn("python3", ["-c", CHROME_CDP_PROBE_PY, JSON.stringify({ mode: "hold", prefer: "pinned", cdpPort, targetUrl: pageUrl, emulation })], { stdio: ["ignore", "pipe", "pipe"] });
    let announced = "";
    let holderErrors = "";
    holder.stdout.on("data", (chunk: Buffer) => { announced += chunk.toString("utf8"); });
    holder.stderr.on("data", (chunk: Buffer) => { holderErrors += chunk.toString("utf8"); });
    const lines = () => announced.split("\n").filter((candidate) => candidate.startsWith("{"));
    try {
      for (let attempt = 0; attempt < 80 && lines().length === 0 && holder.exitCode === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const announce = lines()[0];
      if (announce === undefined) {
        console.warn(`chrome-cdp-probe: the hold-mode applier never announced (exit ${holder.exitCode}); stderr: ${holderErrors.slice(-300)}`);
        return ctx.skip("the hold-mode applier did not come up on this runner");
      }
      expect(parseChromeCdpProbeOutput(announce).unavailable, announce).toBeUndefined();
      // A second tab, opened the way a target=_blank link opens one, AFTER the holder attached.
      // Chrome's legacy endpoint needs PUT; the reply is the new target's /json entry.
      const created = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?${pageUrl}?second`, { method: "PUT" })).json()) as { id?: string };
      expect(typeof created.id, JSON.stringify(created)).toBe("string");
      const secondId = created.id as string;
      // The page's own read-back on THAT target: the phone viewport, DPR and touch, never inherited
      // from the window (the launch page is emulated by its own session).
      let read = await runProbe({ mode: "fidelity", prefer: "pinned", cdpPort, targetUrl: pageUrl, targetId: secondId });
      for (let attempt = 0; attempt < 40 && !(read.fidelity?.innerWidth === 414 && read.fidelity.userAgent.includes("iPhone")); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        read = await runProbe({ mode: "fidelity", prefer: "pinned", cdpPort, targetUrl: pageUrl, targetId: secondId });
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
      const attached = JSON.parse(attachLine as string) as { attached: string; sent: string[]; reloadAfterNavigation?: boolean; url?: string };
      expect(attached.sent.slice(0, 4)).toEqual([
        "Emulation.setDeviceMetricsOverride",
        "Emulation.setTouchEmulationEnabled",
        "Emulation.setEmitTouchEventsForMouse",
        "Emulation.setUserAgentOverride"
      ]);
      // Either the tab had already committed at attach time (reloaded at once) or it owed one
      // reload after its first navigation; either way exactly one reload line or reload send.
      const reloadedLine = lines().find((line) => line.includes('"reloaded"') && line.includes(secondId));
      expect(attached.sent.includes("Page.reload") || reloadedLine !== undefined, announced).toBe(true);
      expect(lines().filter((line) => line.includes("replyError"))).toEqual([]);
      await fetch(`http://127.0.0.1:${cdpPort}/json/close/${secondId}`).catch(() => undefined);
    } finally {
      holder.kill("SIGKILL");
    }
  }, 45_000);

  it.skipIf(!live)("the shipped command (python3 -c ... '<json>') runs end to end through a shell", async (ctx) => {
    if (!chromeUp) return ctx.skip("headless Chrome did not become readable on this runner");
    await settleLaunchPage();
    const command = chromeCdpProbeCommand({ mode: "state", prefer: "active", cdpPort, targetUrl: pageUrl });
    expect(command.startsWith("python3 -c '")).toBe(true);
    const { stdout } = await execFileAsync("sh", ["-c", command]);
    expect(parseChromeCdpProbeOutput(stdout).url).toBe(pageUrl);
  });
});

describe("makeChromeBrowserStateObserver / makeChromeDesktopGeometryObserver: the unavailable seam (#514)", () => {
  function fakeDesktop(reply: { exitCode?: number; stdout?: string; stderr?: string }): E2BDesktopSandbox {
    return { commands: { run: async () => reply } } as unknown as E2BDesktopSandbox;
  }

  it("reports a dark channel once, with the probe's reason, and still degrades to {} for the loop", async () => {
    const reasons: string[] = [];
    const observe = makeChromeBrowserStateObserver(
      fakeDesktop({ exitCode: 0, stdout: JSON.stringify({ unavailable: "no http page among 0 CDP targets on 127.0.0.1:9222" }) }),
      1_000,
      { targetUrl: "http://127.0.0.1:3000/" },
      undefined,
      (reason) => reasons.push(reason)
    );
    expect(await observe()).toEqual({});
    expect(await observe()).toEqual({});
    expect(reasons).toEqual(["no http page among 0 CDP targets on 127.0.0.1:9222"]);
  });

  it("an interpreter that is not there (exit 127) is reported with the exit code, which is the #514 root cause", async () => {
    const reasons: string[] = [];
    const observe = makeChromeBrowserStateObserver(
      fakeDesktop({ exitCode: 127, stdout: "", stderr: "sh: 1: python3: not found\n" }),
      1_000,
      { targetUrl: "http://127.0.0.1:3000/" },
      undefined,
      (reason) => reasons.push(reason)
    );
    expect(await observe()).toEqual({});
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("probe exited 127");
    expect(reasons[0]).toContain("python3: not found");
  });

  it("a healthy probe reports nothing and passes url/title/text/scrollY through", async () => {
    const reasons: string[] = [];
    const observe = makeChromeBrowserStateObserver(
      fakeDesktop({ exitCode: 0, stdout: JSON.stringify({ url: "http://127.0.0.1:3000/pricing", title: "Pricing", text: "per seat", scrollY: 12 }) }),
      1_000,
      { targetUrl: "http://127.0.0.1:3000/" },
      undefined,
      (reason) => reasons.push(reason)
    );
    expect(await observe()).toEqual({ url: "http://127.0.0.1:3000/pricing", title: "Pricing", text: "per seat", scrollY: 12 });
    expect(reasons).toEqual([]);
  });

  it("the geometry observer hands the reason to its caller so the viewport warning can name the cause", async () => {
    const reasons: string[] = [];
    const observe = makeChromeDesktopGeometryObserver(
      fakeDesktop({ exitCode: 0, stdout: JSON.stringify({ unavailable: "CDP endpoint 127.0.0.1:9222/json unreachable (URLError)" }) }),
      1_000,
      { targetUrl: "http://127.0.0.1:3000/" },
      undefined,
      (reason) => reasons.push(reason)
    );
    expect(await observe()).toBeUndefined();
    expect(reasons).toEqual(["CDP endpoint 127.0.0.1:9222/json unreachable (URLError)"]);
  });

  // A fake desktop whose "state" probe reports the launch tab first and OTHER-TAB afterwards, and
  // whose "fidelity" probe on that tab answers with the given read-back (or exits non-zero).
  function driftingDesktop(fidelityStdout: string | undefined): { desktop: E2BDesktopSandbox; commands: () => string[] } {
    let stateCalls = 0;
    const commands: string[] = [];
    const desktop = {
      commands: {
        run: async (command: string) => {
          commands.push(command);
          if (command.includes('"mode":"fidelity"')) {
            return fidelityStdout === undefined ? { exitCode: 1, stdout: "", stderr: "boom" } : { exitCode: 0, stdout: fidelityStdout };
          }
          stateCalls += 1;
          const targetId = stateCalls === 1 ? "EMULATED" : "OTHER-TAB";
          return { exitCode: 0, stdout: JSON.stringify({ url: "http://127.0.0.1:3000/", title: "t", text: "hello", scrollY: 0, targetId }) };
        }
      }
    } as unknown as E2BDesktopSandbox;
    return { desktop, commands: () => commands };
  }
  const phoneReadBack = JSON.stringify({ fidelity: { userAgent: "iPhone", devicePixelRatio: 3, innerWidth: 414, innerHeight: 896, maxTouchPoints: 5, coarsePointer: true }, targetId: "OTHER-TAB" });
  const desktopReadBack = JSON.stringify({ fidelity: { userAgent: "iPhone", devicePixelRatio: 1, innerWidth: 500, innerHeight: 700, maxTouchPoints: 5, coarsePointer: true }, targetId: "OTHER-TAB" });

  it("a later tab whose own read-back reports the requested width is recorded as covered, never as drift (#623)", async () => {
    const { desktop, commands } = driftingDesktop(phoneReadBack);
    const drifts: string[] = [];
    const covered: [string, { innerWidth: number; devicePixelRatio: number; maxTouchPoints: number }][] = [];
    const observe = makeChromeBrowserStateObserver(desktop, 1_000, { targetUrl: "http://127.0.0.1:3000/" }, undefined, undefined, {
      emulatedTargetId: "EMULATED",
      expectedWidth: 414,
      expectTouch: true,
      onDrift: (reason) => drifts.push(reason),
      onCovered: (targetId, read) => covered.push([targetId, read])
    });
    expect((await observe()).url).toBe("http://127.0.0.1:3000/");
    await observe();
    await observe();
    expect(drifts).toEqual([]);
    expect(covered).toEqual([["OTHER-TAB", { innerWidth: 414, devicePixelRatio: 3, maxTouchPoints: 5 }]]);
    // The read-back was taken ONCE for the new target, pinned to its id, not on every observation.
    const fidelityReads = commands().filter((command) => command.includes('"mode":"fidelity"'));
    expect(fidelityReads).toHaveLength(1);
    expect(fidelityReads[0]).toContain('"targetId":"OTHER-TAB"');
  });

  it("a later tab at the phone width but with no touch points is covered AND a touch warning (#623)", async () => {
    const noTouch = JSON.stringify({ fidelity: { userAgent: "iPhone", devicePixelRatio: 3, innerWidth: 414, innerHeight: 896, maxTouchPoints: 0, coarsePointer: false }, targetId: "OTHER-TAB" });
    const { desktop } = driftingDesktop(noTouch);
    const drifts: string[] = [];
    const covered: string[] = [];
    const observe = makeChromeBrowserStateObserver(desktop, 1_000, { targetUrl: "http://127.0.0.1:3000/" }, undefined, undefined, {
      emulatedTargetId: "EMULATED",
      expectedWidth: 414,
      expectTouch: true,
      onDrift: (reason) => drifts.push(reason),
      onCovered: (targetId) => covered.push(targetId)
    });
    await observe();
    await observe();
    expect(covered).toEqual(["OTHER-TAB"]);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toContain("maxTouchPoints 0");
  });

  it("a later tab that reports the window width is drift, once, with the number the page gave (#623)", async () => {
    const { desktop } = driftingDesktop(desktopReadBack);
    const drifts: string[] = [];
    const observe = makeChromeBrowserStateObserver(desktop, 1_000, { targetUrl: "http://127.0.0.1:3000/" }, undefined, undefined, {
      emulatedTargetId: "EMULATED",
      expectedWidth: 414,
      onDrift: (reason) => drifts.push(reason)
    });
    await observe();
    await observe();
    await observe();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toContain("reports a 500 px viewport where 414 px was requested");
  });

  it("a later tab whose read-back cannot be taken is drift with the uncertainty named (#623)", async () => {
    const { desktop } = driftingDesktop(undefined);
    const drifts: string[] = [];
    const observe = makeChromeBrowserStateObserver(desktop, 1_000, { targetUrl: "http://127.0.0.1:3000/" }, undefined, undefined, {
      emulatedTargetId: "EMULATED",
      expectedWidth: 414,
      onDrift: (reason) => drifts.push(reason)
    });
    await observe();
    await observe();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toContain("read-back could not be taken");
  });

  it("parseChromeCdpProbeOutput never turns garbage into an empty success", () => {
    expect(parseChromeCdpProbeOutput("")).toEqual({ unavailable: "probe printed nothing" });
    expect(parseChromeCdpProbeOutput("Traceback (most recent call last)")).toEqual({ unavailable: "probe output was not JSON" });
    expect(parseChromeCdpProbeOutput("[]")).toEqual({});
    expect(parseChromeCdpProbeOutput(JSON.stringify({ url: "", title: "", text: "", scrollY: null }))).toEqual({});
  });
});
