import { expect } from "vitest";

import type { ActorCapabilities, ActorTokenUsage } from "../../src/actors/contract.js";
import {
  runComputerUseLoop,
  type CuaAction,
  type CuaExecutor,
  type CuaLoopOptions,
  type CuaObservation,
  type CuaProvider,
  type CuaTurn,
  type CuaTurnRequest,
} from "../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../src/evidence/redaction.js";

// Characterization harness for runComputerUseLoop. A scenario records every port call the loop
// makes, in order, next to the full CuaLoopResult, so a golden diff shows what the loop did as
// well as what it returned. The clock is injected, so recorded timestamps are deterministic and
// stay unmasked; only Buffers are reduced to their length.

export const CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open",
};

export const FRAME = Buffer.from("synthetic-frame");

export type LogEntry = readonly [string, ...unknown[]];

export class Probe {
  readonly log: unknown[] = [];
  /** Copies the entry now: the loop passes live references it keeps mutating. */
  push(...entry: LogEntry): void {
    this.log.push(plain(entry));
  }
}

/** A clock that advances `step` ms on every read. */
function steppingClock(step = 1000): () => number {
  let t = 0;
  return () => (t += step);
}

export function turn(patch: Partial<CuaTurn> = {}): CuaTurn {
  return { actions: [], pendingSafetyChecks: [], done: false, ...patch };
}

export const done = (message: string, patch: Partial<CuaTurn> = {}): CuaTurn =>
  turn({ done: true, message, ...patch });

export const click = (x: number, y: number): CuaAction => ({ kind: "click", x, y });

/** A provider that replays `turns` in order, then reports done. Requests are logged. */
export function scriptedProvider(
  probe: Probe,
  turns: ReadonlyArray<CuaTurn | ((request: CuaTurnRequest) => CuaTurn | Promise<CuaTurn>)>,
  extra: Partial<Omit<CuaProvider, "nextTurn">> = {},
): CuaProvider {
  let index = 0;
  return {
    id: "golden-cua",
    version: "golden-1",
    capabilities: CAPABILITIES,
    ...extra,
    async nextTurn(request) {
      probe.push("provider.nextTurn", request);
      const next = turns[index];
      index += 1;
      if (next === undefined) return done("done (exhausted)");
      return typeof next === "function" ? next(request) : structuredClone(next);
    },
  };
}

/** An executor that serves `observations` in order (the last repeats) and logs every call. */
export function sequenceExecutor(
  probe: Probe,
  observations: ReadonlyArray<CuaObservation | (() => CuaObservation | Promise<CuaObservation>)>,
  execute: (action: CuaAction) => void | Promise<void> = () => undefined,
  extra: Partial<Pick<CuaExecutor, "stallRecovery" | "speechEnabled">> = {},
): CuaExecutor {
  let index = 0;
  return {
    ...extra,
    async observe() {
      const next = observations[Math.min(index, observations.length - 1)];
      probe.push("executor.observe", index);
      index += 1;
      if (next === undefined) throw new Error("scenario has no observations");
      return typeof next === "function" ? next() : next;
    },
    async execute(action) {
      probe.push("executor.execute", action);
      await execute(action);
    },
  };
}

/** Observations with a frame and the given signatures. */
export const framed = (...signatures: string[]): CuaObservation[] =>
  signatures.map((stateSignature) => ({ screenshot: FRAME, stateSignature }));

export function baseOptions(
  probe: Probe,
  provider: CuaProvider,
  executor: CuaExecutor,
  overrides: Partial<CuaLoopOptions> = {},
): CuaLoopOptions {
  return {
    instructions: "Act as the synthetic persona and finish the task.",
    provider,
    executor,
    persona: { id: "golden", traitsApplied: ["friction-tolerance:low"], promptDigest: "golden" },
    redaction: defaultRedactionHooks,
    timeoutMs: 10_000_000,
    now: steppingClock(),
    writeScreenshot: async (name, bytes) => {
      probe.push("writeScreenshot", name, bytes.length);
      return `screenshots/${name}`;
    },
    onTrace: (items, usage, metadata) =>
      probe.push("onTrace", items.length, usage, metadata ?? null),
    onMessage: (text) => probe.push("onMessage", text),
    onObservedUrl: (url) => probe.push("onObservedUrl", url ?? null),
    onScreenshot: (bytes) => probe.push("onScreenshot", bytes.length),
    ...overrides,
  };
}

/** Wrap a spend estimator so each call lands in the log with the usage it priced. */
export function loggedEstimator(
  probe: Probe,
  estimate: (usage: ActorTokenUsage) => number | null,
): (usage: ActorTokenUsage) => number | null {
  return (usage) => {
    const value = estimate(usage);
    probe.push("estimateTurnCostUsd", structuredClone(usage), value);
    return value;
  };
}

export function loggedBudget(
  probe: Probe,
  decide: (call: number) => string | null,
): (usage: ActorTokenUsage) => string | null {
  let call = 0;
  return (usage) => {
    call += 1;
    const value = decide(call);
    probe.push("overRunBudget", structuredClone(usage), value);
    return value;
  };
}

function plain(value: unknown): unknown {
  if (value instanceof Uint8Array) return `[buffer ${value.length} bytes]`;
  if (value instanceof AbortSignal) return "[AbortSignal]";
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) =>
        entry === undefined ? [] : [[key, plain(entry)]],
      ),
    );
  }
  return value;
}

export async function outcome(probe: Probe, options: CuaLoopOptions) {
  try {
    const result = await runComputerUseLoop(options);
    return plain({ result, log: probe.log });
  } catch (error) {
    const thrown =
      error instanceof Error ? { ...error, name: error.name, message: error.message } : error;
    return plain({ thrown, log: probe.log });
  }
}

export async function expectGolden(name: string, value: unknown): Promise<void> {
  await expect(`${JSON.stringify(value, null, 2)}\n`).toMatchFileSnapshot(
    `../../golden/loop/${name}.json`,
  );
}
