import { PNG } from "pngjs";

import type { ActorCapabilities, ActorTraceItem } from "../../src/actors/contract.js";
import {
  runComputerUseLoopWithTaps,
  type CuaAction,
  type CuaExecutor,
  type CuaLoopResult,
  type CuaObservation,
  type CuaTurn,
  type CuaTurnRequest,
} from "../../src/actors/computer-use/loop.js";
import type { LoopRunOptions } from "../../src/actors/computer-use/loop/types.js";
import { defaultRedactionHooks } from "../../src/evidence/redaction.js";
import { perceptualSignature } from "../../src/evidence/frame-signature.js";

// One participant whose turns may only wait, on a fake desktop whose screen is a function of the
// injected clock. The clock moves only when the loop sleeps, so request and look times are exact.

const CAPS: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open",
};

const SECOND = 1_000;
export const MINUTE = 60 * SECOND;

type Box = { x: number; y: number; width: number; height: number };

/** A 160 x 160 light frame (100 tiles of 16 px, grey 240) with boxes of grey `shade` on it. */
export function frame(boxes: readonly Box[], shade = 20): Buffer {
  const image = new PNG({ width: 160, height: 160 });
  image.data.fill(240);
  for (const box of boxes)
    for (let y = box.y; y < box.y + box.height; y += 1)
      for (let x = box.x; x < box.x + box.width; x += 1)
        image.data.fill(shade, (y * 160 + x) * 4, (y * 160 + x) * 4 + 3);
  return PNG.sync.write(image);
}

export const QUIET = frame([]);
/** Where a new row appears: 10 x 3 = 30 tiles, a large change. */
export const ROW = { x: 0, y: 64, width: 160, height: 48 };
export const NEW_ROW = frame([ROW]);

export const WAIT: CuaAction = { kind: "wait" };
export const turnOf = (actions: CuaAction[]): CuaTurn => ({
  actions,
  pendingSafetyChecks: [],
  done: false,
});
export const DONE: CuaTurn = { actions: [], pendingSafetyChecks: [], done: true, message: "Done." };

interface Request {
  readonly at: number;
  readonly hint: string | undefined;
  readonly observation: CuaObservation;
}

export interface WatchRun {
  readonly result: CuaLoopResult;
  readonly requests: Request[];
  /** The clock time of every observe the desktop was asked for. */
  readonly observes: number[];
  readonly executed: CuaAction[];
}

/**
 * Run the loop. `turn` answers request n (from 1). `observe` adds fields to the observation at a
 * time, or returns "hang" for an observe that never answers. The screen is read when an observe
 * starts.
 */
export async function runWatching(options: {
  screen: (atMs: number) => Buffer;
  turn: (request: CuaTurnRequest, n: number) => CuaTurn;
  observe?: (atMs: number) => Partial<CuaObservation> | "hang";
  executor?: Pick<CuaExecutor, "speechEnabled" | "stallRecovery">;
  /** How far each observe moves the clock; 0 by default. */
  observeMs?: number;
  loop?: Partial<LoopRunOptions>;
}): Promise<WatchRun> {
  let t = 0;
  const requests: Request[] = [];
  const observes: number[] = [];
  const executed: CuaAction[] = [];
  const result = await runComputerUseLoopWithTaps({
    instructions: "Wait for the queue to change, then say what changed.",
    provider: {
      id: "watching-participant",
      capabilities: CAPS,
      async nextTurn(request) {
        requests.push({ at: t, hint: request.contextHint, observation: request.observation });
        return structuredClone(options.turn(request, requests.length));
      },
      async debrief() {
        return { ...DONE, closingReport: { summary: "Nothing came.", frictionReports: [] } };
      },
    },
    executor: {
      ...options.executor,
      async observe() {
        observes.push(t);
        const extra = options.observe?.(t);
        if (extra === "hang") return new Promise<CuaObservation>(() => {});
        const screenshot = options.screen(t);
        t += options.observeMs ?? 0;
        return { screenshot, stateSignature: perceptualSignature(screenshot), ...extra };
      },
      async execute(action) {
        executed.push(action);
      },
    },
    persona: { id: "synthetic", traitsApplied: [], promptDigest: "synthetic" },
    redaction: defaultRedactionHooks,
    timeoutMs: 2 * 60 * MINUTE,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ...options.loop,
  });
  return { result, requests, observes, executed };
}

export type Watch = NonNullable<ActorTraceItem["watch"]>;

export const waitItems = (result: CuaLoopResult): ActorTraceItem[] =>
  result.trace.items.filter((item) => item.kind === "ui_action" && item.title.startsWith("wait"));

export const watchesOf = (result: CuaLoopResult): Watch[] =>
  waitItems(result).flatMap((item) => (item.watch === undefined ? [] : [item.watch]));
