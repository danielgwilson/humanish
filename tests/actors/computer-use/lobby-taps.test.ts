import { expect, it } from "vitest";

import {
  runComputerUseLoop,
  type CuaExecutor,
  type CuaProvider,
  type CuaTurn,
} from "../../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";

// onObservedUrl, onMessage and onScreenshot are deprecated. Their @deprecated tags tell a caller to
// wrap the executor's observe and the provider's nextTurn instead. This run passes both, and
// checks that the wrappers see what the taps report.

const turns: CuaTurn[] = [
  {
    actions: [{ kind: "click", x: 10, y: 10, button: "left" }],
    pendingSafetyChecks: [],
    done: false,
    reasoning: "The lobby code is ABC123.",
    usage: { input: 10, output: 5 },
  },
  {
    actions: [{ kind: "keypress", keys: ["ENTER"] }],
    pendingSafetyChecks: [],
    done: false,
    reasoning: "Joining the lobby.",
    message: "Entered the code.",
    usage: { input: 10, output: 5 },
  },
  {
    actions: [],
    pendingSafetyChecks: [],
    done: true,
    message: "In the lobby.",
    usage: { input: 10, output: 5 },
  },
];

it("wrapping observe and nextTurn sees what the deprecated taps report", async () => {
  let observed = 0;
  const executor: CuaExecutor = {
    observe: async () => {
      observed++;
      return {
        stateSignature: `page-${observed}`,
        url: `https://lobby.example.test/${observed}`,
        screenshot: Buffer.from(`frame-${observed}`),
      };
    },
    execute: async () => undefined,
  };
  let next = 0;
  const provider: CuaProvider = {
    id: "lobby-taps-fixture",
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
    nextTurn: async () => turns[next++]!,
  };

  const taps = { urls: [] as unknown[], frames: [] as string[], messages: [] as string[] };
  const wrapped = { urls: [] as unknown[], frames: [] as string[], messages: [] as string[] };
  const wrappedExecutor: CuaExecutor = {
    ...executor,
    observe: async () => {
      const observation = await executor.observe();
      wrapped.urls.push(observation.url);
      if (observation.screenshot) wrapped.frames.push(observation.screenshot.toString());
      return observation;
    },
  };
  const wrappedProvider: CuaProvider = {
    ...provider,
    nextTurn: async (request, signal, spend) => {
      const turn = await provider.nextTurn(request, signal, spend);
      wrapped.messages.push([turn.reasoning, turn.message].filter(Boolean).join("\n"));
      return turn;
    },
  };

  let time = 0;
  const result = await runComputerUseLoop({
    instructions: "Join the lobby.",
    provider: wrappedProvider,
    executor: wrappedExecutor,
    persona: { id: "synthetic", traitsApplied: [], promptDigest: "fixture" },
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    timeoutMs: 60_000,
    redaction: defaultRedactionHooks,
    onObservedUrl: (url) => taps.urls.push(url),
    onScreenshot: (frame) => taps.frames.push(frame.toString()),
    onMessage: (text) => taps.messages.push(text),
  });

  expect(result.trace.stopCause).toBeUndefined();
  expect(taps.urls.length).toBeGreaterThan(1);
  expect(taps.frames).toHaveLength(taps.urls.length);
  expect(taps.messages).toEqual([
    "The lobby code is ABC123.",
    "Joining the lobby.\nEntered the code.",
    "In the lobby.",
  ]);
  expect(wrapped.urls).toEqual(taps.urls);
  expect(wrapped.frames).toEqual(taps.frames);
  expect(wrapped.messages).toEqual(taps.messages);
});
