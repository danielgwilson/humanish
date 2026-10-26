import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import {
  runComputerUseLoop,
  type CuaAction,
  type CuaExecutor,
  type CuaLoopOptions,
  type CuaProvider,
  type CuaTurn,
  type CuaTurnRequest,
} from "../../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";

// What a participant read from the desktop is evidence: the image a zoom or a screenshot within its
// batch showed it and the position a pointer read returned are recorded on the action's trace item,
// so a decision made on them can be checked against the bundle.

const turn = (patch: Partial<CuaTurn>): CuaTurn => ({
  actions: [],
  pendingSafetyChecks: [],
  done: false,
  ...patch,
});

function scripted(turns: CuaTurn[], patch: Partial<CuaProvider> = {}) {
  const requests: CuaTurnRequest[] = [];
  const provider: CuaProvider = {
    ...patch,
    id: "fixture",
    version: "1",
    capabilities: {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: true,
      byoModel: true,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "open",
    },
    nextTurn: async (request) => {
      requests.push(structuredClone(request));
      return turns.shift() ?? turn({ done: true, message: "Read the reference." });
    },
  };
  return { provider, requests };
}

/** A PNG of `width` x `height` with a pattern from `seed`, so a blur changes its pixels. */
function png(width: number, height: number, seed: number): Buffer {
  const image = new PNG({ width, height });
  for (let i = 0; i < image.data.length; i++) image.data[i] = (i * seed) % 251;
  return PNG.sync.write(image);
}

/** The image a provider's acknowledgement carried, as bytes (requests are cloned). */
function ackedFrame(request: CuaTurnRequest | undefined): Buffer | undefined {
  const result = request?.previousExecution?.actions[0]?.result;
  return result?.kind === "frame" ? Buffer.from(result.screenshot) : undefined;
}

const screen = png(320, 200, 7);
const crop = png(60, 12, 13);
const midBatch = png(320, 200, 17);
const zoom: CuaAction = { kind: "zoom", region: { x: 100, y: 150, width: 60, height: 12 } };
const click: CuaAction = { kind: "click", x: 10, y: 20 };
const screenshot: CuaAction = { kind: "screenshot" };

function readingDesktop(sent: CuaAction["kind"][] = []): CuaExecutor {
  let changes = 0;
  return {
    observe: async () => ({ screenshot: screen, stateSignature: `frame-${changes}` }),
    execute: async (action: CuaAction) => {
      changes += 1;
      sent.push(action.kind);
      if (action.kind === "read_pointer") return { kind: "pointer" as const, x: 41, y: 77 };
      if (action.kind === "zoom") return { kind: "frame" as const, screenshot: crop };
      if (action.kind === "screenshot") return { kind: "frame" as const, screenshot: midBatch };
      return undefined;
    },
  };
}

function run(provider: CuaProvider, options: Partial<CuaLoopOptions> = {}) {
  const written = new Map<string, Buffer>();
  const sent: CuaAction["kind"][] = [];
  const result = runComputerUseLoop({
    instructions: "Read the reference in the fine print.",
    provider,
    executor: readingDesktop(sent),
    persona: { id: "fixture", traitsApplied: [], promptDigest: "fixture" },
    redaction: defaultRedactionHooks,
    now: Date.now,
    timeoutMs: 60_000,
    writeScreenshot: async (name, bytes) => {
      written.set(`screenshots/${name}`, bytes);
      return `screenshots/${name}`;
    },
    ...options,
  });
  return { result, written, sent };
}

describe("what a participant read from the desktop", () => {
  it("keeps the image a zoom showed as a frame on the zoom's trace item", async () => {
    const { provider, requests } = scripted([turn({ actions: [zoom] })]);
    const { result, written } = run(provider);
    const { trace } = await result;
    const item = trace.items.find((entry) => entry.title.startsWith("zoom "));
    expect(item).toMatchObject({
      kind: "ui_action",
      title: "zoom 60x12 at (100, 150)",
      region: { x: 100, y: 150, width: 60, height: 12 },
      screenshotRef: { redaction: "none" },
    });
    expect(written.get(item!.screenshotRef!.path)?.equals(crop)).toBe(true);
    // The provider is handed the same crop the bundle keeps.
    expect(ackedFrame(requests[1])?.equals(crop)).toBe(true);
  });

  it("names each zoom frame apart from the turn screenshots", async () => {
    const { provider } = scripted([turn({ actions: [zoom, zoom] }), turn({ actions: [zoom] })]);
    const { result, written } = run(provider);
    const { trace } = await result;
    const zoomPaths = trace.items
      .filter((entry) => entry.region !== undefined)
      .map((entry) => entry.screenshotRef?.path);
    expect(zoomPaths).toEqual([
      "screenshots/zoom-001.png",
      "screenshots/zoom-002.png",
      "screenshots/zoom-003.png",
    ]);
    expect([...written.keys()].filter((path) => path.includes("turn-"))).toHaveLength(3);
  });

  it("blurs a zoom frame when the study blurs its screenshots", async () => {
    const { provider, requests } = scripted([turn({ actions: [zoom] })]);
    const { result, written } = run(provider, { redactScreenshots: true });
    const { trace } = await result;
    const item = trace.items.find((entry) => entry.region !== undefined);
    expect(item?.screenshotRef?.redaction).toBe("blurred");
    const kept = written.get(item!.screenshotRef!.path)!;
    expect(kept.equals(crop)).toBe(false);
    expect(PNG.sync.read(kept).width).toBeLessThanOrEqual(128);
    // The participant still saw the crop itself.
    expect(ackedFrame(requests[1])?.equals(crop)).toBe(true);
  });

  it("records the position a pointer read returned", async () => {
    const { provider } = scripted([turn({ actions: [{ kind: "read_pointer" }] })]);
    const { result } = run(provider);
    const { trace } = await result;
    const item = trace.items.find((entry) => entry.title === "read pointer");
    expect(item).toMatchObject({ kind: "ui_action", pointer: { x: 41, y: 77 } });
    expect(item).not.toHaveProperty("screenshotRef");
  });
});

describe("a screenshot within a batch", () => {
  const shows = { batchScreenshots: "frame" } as const;

  it("captures the screen where it stands in the batch and keeps that frame", async () => {
    const { provider, requests } = scripted(
      [turn({ actions: [click, screenshot, click, screenshot] })],
      shows,
    );
    const { result, written, sent } = run(provider);
    const { trace } = await result;
    // The last screenshot is the loop's own observation after the batch, so only one is sent.
    expect(sent).toEqual(["click", "screenshot", "click"]);
    const item = trace.items.find((entry) => entry.title === "screenshot");
    expect(item).toMatchObject({
      kind: "ui_action",
      screenshotRef: { path: "screenshots/screenshot-001.png", redaction: "none" },
    });
    expect(item).not.toHaveProperty("region");
    expect(written.get("screenshots/screenshot-001.png")?.equals(midBatch)).toBe(true);
    const acks = requests[1]?.previousExecution?.actions ?? [];
    const frame = acks[1]?.result;
    expect(frame?.kind === "frame" && Buffer.from(frame.screenshot).equals(midBatch)).toBe(true);
    expect(acks[3]).toEqual({ index: 3, status: "completed" });
  });

  it("is followed by a screen observed after it when the turn's waits were watched", async () => {
    // The watch runs before the batch, so its last look is older than the frame captured within
    // the batch. The participant must next see a screen observed after that frame.
    const later = png(320, 200, 23);
    const wait: CuaAction = { kind: "wait", ms: 2_000 };
    const { provider, requests } = scripted(
      [turn({ actions: [screenshot, wait, screenshot] })],
      shows,
    );
    let captured = false;
    let t = 0;
    const { result } = run(provider, {
      executor: {
        observe: async () => ({
          screenshot: captured ? later : screen,
          stateSignature: captured ? "later" : "before",
        }),
        execute: async (action: CuaAction) => {
          if (action.kind !== "screenshot") return undefined;
          captured = true;
          return { kind: "frame" as const, screenshot: midBatch };
        },
      },
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    await result;
    const frame = requests[1]?.previousExecution?.actions[0]?.result;
    expect(frame?.kind === "frame" && Buffer.from(frame.screenshot).equals(midBatch)).toBe(true);
    expect(Buffer.from(requests[1]!.observation.screenshot!).equals(later)).toBe(true);
  });

  it("is not sent to the desktop for a provider that shows only the screen after the batch", async () => {
    const { provider, requests } = scripted([turn({ actions: [screenshot, click, screenshot] })]);
    const { result, written, sent } = run(provider);
    const { trace } = await result;
    expect(sent).toEqual(["click"]);
    expect(requests[1]?.previousExecution?.actions).toEqual([
      { index: 0, status: "completed" },
      { index: 1, status: "completed" },
      { index: 2, status: "completed" },
    ]);
    expect(trace.items.filter((entry) => entry.title === "screenshot")).toHaveLength(2);
    expect([...written.keys()].some((path) => path.includes("screenshot-"))).toBe(false);
  });
});
