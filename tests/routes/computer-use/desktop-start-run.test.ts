// How a hosted computer-use participant's desktop gets from created to its first screenshot, on
// fake hosted desktops ($0). Chrome starts as soon as what it is launched with is in place, beside
// the steps it does not need, and the first screenshot waits until the launch page has loaded and
// painted. A desktop that cannot report the page load keeps the fixed 8 s wait.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCuaActorSession } from "../../../src/actors/computer-use/actor.js";
import { DESKTOP_SETTLE_MS } from "../../../src/substrates/e2b/desktop-browser.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import { lab } from "../../admission/fixtures.js";
import {
  makeFanoutModule,
  scriptedParticipant,
  TWO_TURN_SESSION,
  type FanoutModuleOptions,
} from "../../helpers/fanout-desktop.js";
import { makeTestTempDir } from "../../helpers/temp-dir.js";

const ENV = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };

interface RunEvent {
  type: string;
  level: string;
  message: string;
}

/** Runs a one-participant app-url study from a study file on fake hosted desktops. */
async function runOne(patch: Record<string, unknown>, fakes: FanoutModuleOptions) {
  const cwd = await makeTestTempDir("humanish-desktop-start-");
  await mkdir(path.join(cwd, "studies", "fixtures"), { recursive: true });
  await writeFile(path.join(cwd, "studies", "desktop-start.yaml"), "# the study file\n");
  await writeFile(path.join(cwd, "studies", "fixtures", "photo.png"), "synthetic photo");
  const parsed = parseStudy(
    lab("cuAppUrl", { mode: "live", review: { analysis: false }, ...patch }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  const handle = makeFanoutModule(fakes);
  const outcome = await runStudyWith(
    parsed.config,
    {
      cwd,
      env: ENV,
      open: false,
      study: { id: parsed.config.id, path: "studies/desktop-start.yaml", origin: "explicit" },
    },
    {
      desktopModule: async () => handle.module,
      subjectPhaseSink: () => undefined,
      runSession: async (session) =>
        runCuaActorSession({
          ...session,
          participant: scriptedParticipant(TWO_TURN_SESSION),
        }),
    },
  );
  if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
  const bundle = JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
  ) as { events: RunEvent[] };
  return { result: outcome.result, events: bundle.events, handle };
}

/** The probe's answer once the launch page has loaded, or has not by the deadline. */
function pageLoad(loaded: boolean, waitedMs: number): { stdout: string } {
  const seen = loaded
    ? "document.readyState complete, visible, first contentful paint recorded"
    : "document.readyState interactive, visible, first contentful paint recorded";
  return { stdout: `${JSON.stringify({ load: { loaded, waitedMs, seen }, now: 1 })}\n` };
}

const isLoadProbe = (command: string): boolean => command.includes('"mode":"load"');
const isBrowserLaunch = (command: string): boolean => /^target_url=/m.test(command);
const pageEvents = (events: RunEvent[]) =>
  events.filter((event) => event.type === "cua-lab.browser.page.completed");

describe("a hosted participant's first screenshot waits for its page", () => {
  it("starts as soon as the page has loaded and painted, without the fixed 8 s wait", async () => {
    const waits: number[] = [];
    const { result, events } = await runOne(
      {},
      {
        measuredChrome: true,
        commandHandler: (_index, command) =>
          isLoadProbe(command) ? pageLoad(true, 420) : undefined,
        onWait: (_index, ms) => waits.push(ms),
      },
    );
    expect(result.ok).toBe(true);
    expect(waits).not.toContain(DESKTOP_SETTLE_MS);
    expect(pageEvents(events)).toEqual([
      expect.objectContaining({ level: "info", message: expect.stringMatching(/\(420ms\)$/) }),
    ]);
  });

  it("starts at the deadline with a warning event when the page has not finished loading", async () => {
    const waits: number[] = [];
    const { result, events } = await runOne(
      {},
      {
        measuredChrome: true,
        commandHandler: (_index, command) =>
          isLoadProbe(command) ? pageLoad(false, DESKTOP_SETTLE_MS) : undefined,
        onWait: (_index, ms) => waits.push(ms),
      },
    );
    expect(result.ok).toBe(true);
    // The wait already lasted the whole bound; nothing sleeps after it.
    expect(waits).not.toContain(DESKTOP_SETTLE_MS);
    const [event] = pageEvents(events);
    expect(event?.level).toBe("warn");
    expect(event?.message).toMatch(/document\.readyState interactive/);
  });

  it("keeps the fixed 8 s wait when the page load cannot be read", async () => {
    const waits: number[] = [];
    const { result, events } = await runOne(
      {},
      {
        measuredChrome: true,
        commandHandler: (_index, command) =>
          isLoadProbe(command)
            ? { stdout: "", exitCode: 127, stderr: "python3: not found" }
            : undefined,
        onWait: (_index, ms) => waits.push(ms),
      },
    );
    expect(result.ok).toBe(true);
    expect(waits).toContain(DESKTOP_SETTLE_MS);
    expect(pageEvents(events)).toEqual([]);
  });

  it("keeps the fixed 8 s wait when Chrome's DevTools never answered", async () => {
    const waits: number[] = [];
    const probes: string[] = [];
    const { result } = await runOne(
      {},
      {
        commandHandler: (_index, command) => {
          if (isLoadProbe(command)) probes.push(command);
          return undefined;
        },
        onWait: (_index, ms) => waits.push(ms),
      },
    );
    expect(result.ok).toBe(true);
    expect(probes).toEqual([]);
    expect(waits).toContain(DESKTOP_SETTLE_MS);
  });
});

describe("a hosted participant's desktop starts Chrome beside the steps Chrome does not need", () => {
  it("launches the browser while the screen check, the file copy and a silent recording are still running", async () => {
    const steps: string[] = [];
    let launched: () => void = () => undefined;
    const browserLaunched = new Promise<void>((resolve) => {
      launched = resolve;
    });
    // Each held step waits for the browser launch, or gives up after 3 s so a serial order shows
    // as an assertion failure.
    const held = async (step: string): Promise<void> => {
      steps.push(`${step} started`);
      await Promise.race([browserLaunched, new Promise((resolve) => setTimeout(resolve, 3_000))]);
      steps.push(`${step} done`);
    };
    const { result, handle } = await runOne(
      {
        participants: [
          { id: "applicant", files: [{ from: "fixtures/photo.png", as: "Downloads/photo.png" }] },
        ],
        execution: { desktop: { recording: { audio: false } } },
      },
      {
        measuredChrome: true,
        readFile: () => undefined,
        commandHandler: async (_index, command) => {
          if (isLoadProbe(command)) return pageLoad(true, 300);
          if (isBrowserLaunch(command)) {
            steps.push("browser");
            launched();
            return undefined;
          }
          if (command.includes("xdpyinfo")) await held("screen check");
          if (command.includes("humanish-desktop-recording.pid") && !command.startsWith("cat "))
            await held("recording");
          return undefined;
        },
        onFileWrite: () => held("file copy"),
      },
    );
    // The fake desktop has no recorder process, so the recording is a warning and the run goes on.
    expect(result.ok).toBe(true);
    for (const step of ["screen check", "file copy", "recording"]) {
      expect(steps).toContain(`${step} started`);
      expect(steps.indexOf("browser"), step).toBeLessThan(steps.indexOf(`${step} done`));
    }
    expect([...(handle.files.get("fake-sandbox-01")?.keys() ?? [])]).toEqual([
      "Downloads/photo.png",
    ]);
  });

  it("starts an audible recording's sound server before the browser opens", async () => {
    const steps: string[] = [];
    const { result } = await runOne(
      { execution: { desktop: { recording: { audio: true } } } },
      {
        measuredChrome: true,
        readFile: () => undefined,
        commandHandler: (_index, command) => {
          if (isLoadProbe(command)) return pageLoad(true, 300);
          if (isBrowserLaunch(command)) steps.push("browser");
          if (command.includes("pulseaudio --daemonize")) steps.push("sound server");
          return undefined;
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(steps).toEqual(["sound server", "browser"]);
  });

  it("names the screen mismatch when the screen check fails while the browser starts", async () => {
    const { result } = await runOne(
      {},
      {
        measuredChrome: true,
        geometryOverride: () => [800, 600],
        commandHandler: (_index, command) =>
          isLoadProbe(command) ? pageLoad(true, 300) : undefined,
      },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/HUMANISH_COMPUTER_USE_DEVICE_GEOMETRY/);
  });
});
