import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CuaExecutor, CuaProvider } from "../../src/actors/computer-use/loop.js";
import type { AdapterScorerModule } from "../../src/lab/adapter-scorer-loader.js";
import { parseLabConfig } from "../../src/lab/config.js";
import { runLab, type RunLabOptions } from "../../src/lab/engine.js";
import { routeOf } from "../../src/lab/plan.js";
import { normalizeRunLabOptions, type LabEvent } from "../../src/lab/run-lab-options.js";
import type { LabConfig } from "../../src/lab/types.js";
import type { CuaLanePlan, CuaLaneSpec } from "../../src/routes/computer-use/types.js";
import type { E2BDesktopSandbox } from "../../src/substrates/e2b/desktop-launch.js";
import { lab, type BaseName, type Patch } from "../admission/fixtures.js";

function config(base: BaseName, patch?: Patch): LabConfig {
  const parsed = parseLabConfig(lab(base, patch));
  if (!parsed.ok) throw new Error(`${base}: ${parsed.error.message}`);
  return parsed.config;
}

const localVm = (): LabConfig => config("cuAppUrl", { execution: { target: "local" } });
const provider = {} as CuaProvider;
const executor = {} as CuaExecutor;
const createProvider = async (): Promise<CuaProvider> => provider;
const inProcess = { executor: async (): Promise<CuaExecutor> => executor };
const scorer: AdapterScorerModule = {
  score: () => ({
    schema: "humanish.adapter-score.v1",
    namespace: "example",
    status: "pass",
    score: 1,
    summary: "ok",
  }),
};
const prepareDesktop = async (): Promise<void> => undefined;
const desktop = {} as E2BDesktopSandbox;

function normalize(labConfig: LabConfig, options: Partial<RunLabOptions>) {
  return normalizeRunLabOptions(labConfig, routeOf(labConfig), {
    cwd: "/tmp/unused",
    ...options,
  } as RunLabOptions);
}

function normalized(labConfig: LabConfig, options: Partial<RunLabOptions>): RunLabOptions {
  const result = normalize(labConfig, options);
  if (!result.ok) throw new Error(result.message);
  return result.options;
}

describe("an option the route cannot honor is refused before anything runs", () => {
  const cases: [string, () => LabConfig, Partial<RunLabOptions>, string | undefined][] = [
    ["preview scorer", () => config("preview"), { scorer }, "scorer"],
    ["preview createProvider", () => config("preview"), { createProvider }, "createProvider"],
    ["preview inProcess", () => config("preview"), { inProcess, createProvider }, "createProvider"],
    ["preview prepareDesktop", () => config("preview"), { prepareDesktop }, "prepareDesktop"],
    ["preview onStream", () => config("preview"), { onStream: () => undefined }, undefined],
    ["computer use scorer", () => config("cuAppUrl"), { scorer }, undefined],
    ["computer use createProvider", () => config("cuAppUrl"), { createProvider }, undefined],
    ["computer use inProcess", () => config("cuAppUrl"), { inProcess, createProvider }, undefined],
    [
      "computer use inProcess on two participants",
      () => config("cuAppUrl", { actors: [{ type: "openai-computer-use", count: 2 }] }),
      { inProcess, createProvider },
      "inProcess",
    ],
    [
      "computer use inProcess on a clone",
      () => config("cuClone"),
      { inProcess, createProvider },
      "inProcess",
    ],
    ["computer use prepareDesktop", () => config("cuAppUrl"), { prepareDesktop }, undefined],
    ["local VM prepareDesktop", localVm, { prepareDesktop }, "prepareDesktop"],
    ["local VM createProvider", localVm, { createProvider }, undefined],
    ["local-app inProcess", () => config("cuLocalApp"), { inProcess, createProvider }, undefined],
    [
      "local-app prepareDesktop",
      () => config("cuLocalApp"),
      { inProcess, createProvider, prepareDesktop },
      "prepareDesktop",
    ],
    ["shared world scorer", () => config("sharedProvisioned"), { scorer }, undefined],
    [
      "shared world prepareDesktop",
      () => config("sharedProvisioned"),
      { prepareDesktop },
      undefined,
    ],
    [
      "external-public prepareDesktop",
      () => config("sharedExternal"),
      { prepareDesktop },
      undefined,
    ],
    [
      "shared world createProvider",
      () => config("sharedProvisioned"),
      { createProvider },
      "createProvider",
    ],
    [
      "shared world inProcess",
      () => config("sharedExternal"),
      { inProcess, createProvider },
      "createProvider",
    ],
    ["terminal scorer", () => config("terminal"), { scorer }, undefined],
    ["terminal createProvider", () => config("terminal"), { createProvider }, "createProvider"],
    ["terminal prepareDesktop", () => config("terminal"), { prepareDesktop }, "prepareDesktop"],
    ["terminal onStream", () => config("terminal"), { onStream: () => undefined }, undefined],
    ["scripted scorer", () => config("scriptedAppUrl"), { scorer }, "scorer"],
    [
      "scripted createProvider",
      () => config("scriptedAppUrl"),
      { createProvider },
      "createProvider",
    ],
    [
      "scripted loopback prepareDesktop",
      () => config("scriptedAppUrl"),
      { prepareDesktop },
      "prepareDesktop",
    ],
    ["scripted clone prepareDesktop", () => config("scriptedClone"), { prepareDesktop }, undefined],
    ["inProcess without createProvider", () => config("cuAppUrl"), { inProcess }, "inProcess"],
  ];

  it.each(cases)("%s", (_name, build, options, refusedOption) => {
    const labConfig = build();
    const result = normalize(labConfig, options);
    if (refusedOption === undefined) {
      expect(result.ok).toBe(true);
      return;
    }
    expect(result).toMatchObject({ ok: false, code: "HUMANISH_LAB_OPTION_UNSUPPORTED" });
    if (result.ok) return;
    expect(result.message).toContain(`RunLabOptions.${refusedOption}`);
    expect(result.message).toContain(`the ${routeOf(labConfig)} route`);
  });
});

describe("a new option set together with the field it replaces is refused", () => {
  const onEvent = (): void => undefined;
  const cases: [string, Partial<RunLabOptions>][] = [
    [
      "onStream / sharedWorldHooks.onRuntimeStreamReady",
      { onStream: () => undefined, sharedWorldHooks: { onRuntimeStreamReady: () => undefined } },
    ],
    ["env / cuaHooks.env", { env: {}, cuaHooks: { env: {} } }],
    ["env / sharedWorldHooks.env", { env: {}, sharedWorldHooks: { env: {} } }],
    ["scorer / cuaHooks.score", { scorer, cuaHooks: { score: scorer.score! } }],
    [
      "scorer / terminalHooks.deriveFeedback",
      { scorer, terminalHooks: { deriveFeedback: () => [] } },
    ],
    [
      "prepareDesktop / scriptedHooks.prepareDesktop",
      { prepareDesktop, scriptedHooks: { prepareDesktop } },
    ],
    ["onEvent / cuaHooks.onPhase", { onEvent, cuaHooks: { onPhase: () => undefined } }],
    [
      "onEvent / automaticAnalysis.onStart",
      { onEvent, automaticAnalysis: { onStart: () => undefined } },
    ],
    [
      "onStream / cuaHooks.onRuntimeStreamEnded",
      { onStream: onEvent, cuaHooks: { onRuntimeStreamEnded: onEvent } },
    ],
    [
      "analysisSignal / automaticAnalysis.deps.signal",
      {
        analysisSignal: AbortSignal.abort(),
        automaticAnalysis: { deps: { signal: AbortSignal.abort() } },
      },
    ],
    [
      "createProvider / cuaHooks.buildProvider",
      { createProvider, cuaHooks: { buildProvider: createProvider } },
    ],
    [
      "inProcess / cuaHooks.buildExecutor",
      { inProcess, createProvider, cuaHooks: { buildExecutor: inProcess.executor } },
    ],
    [
      "rerun.participantIds / rerun.laneIds",
      { rerun: { sourceRunId: "r", participantIds: ["a"], laneIds: ["a"] } },
    ],
  ];

  it.each(cases)("%s", (name, options) => {
    const [home, old] = name.split(" / ");
    const result = normalize(config("cuAppUrl"), options);
    expect(result).toMatchObject({ ok: false, code: "HUMANISH_LAB_OPTION_CONFLICT" });
    if (result.ok) return;
    expect(result.message).toContain(`RunLabOptions.${home}`);
    expect(result.message).toContain(old);
  });
});

describe("runLab returns an option refusal in the route's own envelope and writes nothing", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-lab-options-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.each([
    ["preview", "synthetic", "humanish.run-result.v1", { scorer }],
    ["cuAppUrl", "cua", "humanish.cua-lab-result.v2", { inProcess, createProvider, count: 2 }],
    ["scriptedAppUrl", "scripted", "humanish.scripted-lab-result.v1", { scorer }],
    ["terminal", "terminal", "humanish.terminal-lab-result.v1", { prepareDesktop }],
    [
      "sharedProvisioned",
      "concurrent-shared-world",
      "humanish.concurrent-shared-world-lab-result.v1",
      { createProvider },
    ],
  ] as const)("%s", async (base, backend, schema, options) => {
    let desktopLoads = 0;
    const outcome = await runLab(config(base), {
      cwd,
      dryRun: false,
      runId: "refused",
      ...options,
      cuaHooks: {
        loadDesktopModule: async () => {
          desktopLoads += 1;
          throw new Error("no desktop in this test");
        },
      },
    } as RunLabOptions);

    expect(outcome.backend).toBe(backend);
    expect(outcome.result).toMatchObject({
      schema,
      ok: false,
      error: { code: "HUMANISH_LAB_OPTION_UNSUPPORTED" },
    });
    expect(desktopLoads).toBe(0);
    expect(await readdir(cwd)).toEqual([]);
  });

  it("a conflict comes back the same way", async () => {
    const outcome = await runLab(config("cuAppUrl"), {
      cwd,
      env: {},
      cuaHooks: { env: {} },
    });
    expect(outcome.result.error).toMatchObject({ code: "HUMANISH_LAB_OPTION_CONFLICT" });
    expect(await readdir(cwd)).toEqual([]);
  });
});

describe("each new option lands in the bag the route reads", () => {
  const lane = { laneId: "lane-02", laneIndex: 1, laneCount: 3 };

  it("scorer goes to the browser bags whole and to the terminal bag without artifacts", () => {
    const module: AdapterScorerModule = {
      score: scorer.score!,
      deriveFeedback: () => [],
      deriveArtifacts: () => [],
    };
    const cua = normalized(config("cuAppUrl"), { scorer: module }).cuaHooks!;
    expect([cua.score, cua.deriveFeedback, cua.deriveArtifacts]).toEqual([
      module.score,
      module.deriveFeedback,
      module.deriveArtifacts,
    ]);
    const shared = normalized(config("sharedProvisioned"), { scorer: module }).sharedWorldHooks!;
    expect([shared.score, shared.deriveFeedback, shared.deriveArtifacts]).toEqual([
      module.score,
      module.deriveFeedback,
      module.deriveArtifacts,
    ]);
    const terminal = normalized(config("terminal"), { scorer: module }).terminalHooks!;
    expect(terminal).toEqual({ score: module.score, deriveFeedback: module.deriveFeedback });
  });

  it("env goes to the route's bag, beside the bag's other fields", () => {
    const loadModule = async () => {
      throw new Error("unused");
    };
    const options = normalized(config("terminal"), {
      env: { OPENAI_API_KEY: "k" },
      terminalHooks: { loadModule },
    });
    expect(options.terminalHooks).toEqual({ env: { OPENAI_API_KEY: "k" }, loadModule });
  });

  it("prepareDesktop gets a participant target on computer use and the subject on scripted", async () => {
    const targets: unknown[] = [];
    const record = async (_desktop: E2BDesktopSandbox, target: unknown): Promise<void> => {
      targets.push(target);
    };
    await normalized(config("cuAppUrl"), { prepareDesktop: record }).cuaHooks!.prepareDesktop!(
      desktop,
      lane,
    );
    await normalized(config("scriptedClone"), { prepareDesktop: record }).scriptedHooks!
      .prepareDesktop!(desktop);
    expect(targets).toEqual([
      { kind: "participant", participant: { id: "lane-02", index: 1, count: 3 } },
      { kind: "subject" },
    ]);
  });

  it("createProvider gets the config, the participant and the executor", async () => {
    const seen: unknown[] = [];
    const labConfig = config("cuAppUrl");
    const hooks = normalized(labConfig, {
      createProvider: async (ctx) => {
        seen.push(ctx);
        return provider;
      },
    }).cuaHooks!;
    const built = await hooks.buildProvider!({
      config: labConfig,
      actor: {} as never,
      lane: { laneId: "lane-02", laneIndex: 1 } as CuaLaneSpec,
      laneCount: 3,
      executor,
    });
    expect(built).toBe(provider);
    expect(seen).toEqual([
      { config: labConfig, participant: { id: "lane-02", index: 1, count: 3 }, executor },
    ]);
  });

  it("inProcess.executor becomes buildExecutor", async () => {
    const labConfig = config("cuLocalApp");
    const hooks = normalized(labConfig, { inProcess, createProvider }).cuaHooks!;
    await expect(
      hooks.buildExecutor!({
        config: labConfig,
        actor: {} as never,
        appUrl: "http://127.0.0.1:3000/",
      }),
    ).resolves.toBe(executor);
  });
});

describe("stream, rerun and analysis options land where the route reads them", () => {
  it("onStream receives both stream events, and the route awaits its promise", async () => {
    const events: unknown[] = [];
    const hooks = normalized(config("cuAppUrl"), {
      onStream: async (event) => {
        events.push(event);
        if (event.type === "ended") throw new Error("ended handler failed");
      },
    }).cuaHooks!;
    await hooks.onRuntimeStreamReady!({
      laneId: "lane-01",
      sandboxId: "sbx",
      simId: "sim-001",
      streamId: "stream-001",
      url: "https://stream.invalid/key",
    });
    await expect(
      hooks.onRuntimeStreamEnded!({ laneId: "lane-01", simId: "sim-001", streamId: "stream-001" }),
    ).rejects.toThrow("ended handler failed");
    expect(events).toEqual([
      {
        type: "ready",
        participantId: "lane-01",
        sandboxId: "sbx",
        simId: "sim-001",
        streamId: "stream-001",
        url: "https://stream.invalid/key",
      },
      { type: "ended", participantId: "lane-01", simId: "sim-001", streamId: "stream-001" },
    ]);
  });

  it("onStream is left unset where no E2B stream starts", () => {
    const onStream = (): void => undefined;
    expect(normalized(localVm(), { onStream }).cuaHooks!.onRuntimeStreamReady).toBeUndefined();
    const inProcessHooks = normalized(config("cuLocalApp"), {
      onStream,
      inProcess,
      createProvider,
    });
    expect(inProcessHooks.cuaHooks!.onRuntimeStreamReady).toBeUndefined();
  });

  it("rerun.participantIds becomes rerun.laneIds", () => {
    expect(
      normalized(config("cuAppUrl"), { rerun: { sourceRunId: "r", participantIds: ["lane-02"] } })
        .rerun,
    ).toEqual({ sourceRunId: "r", laneIds: ["lane-02"] });
  });

  it("analysisSignal joins the other analysis deps", () => {
    const signal = AbortSignal.abort();
    const run = async () => {
      throw new Error("unused");
    };
    const options = normalized(config("cuAppUrl"), {
      analysisSignal: signal,
      automaticAnalysis: { run },
    });
    expect(options.automaticAnalysis).toEqual({ run, deps: { signal } });
  });

  it("the new fields are gone from what the route receives", () => {
    const options = normalized(config("cuAppUrl"), {
      env: {},
      scorer,
      prepareDesktop,
      onEvent: () => undefined,
      onStream: () => undefined,
      analysisSignal: AbortSignal.abort(),
      createProvider,
    });
    for (const key of [
      "env",
      "scorer",
      "prepareDesktop",
      "onEvent",
      "onStream",
      "analysisSignal",
      "createProvider",
      "inProcess",
    ])
      expect(options).not.toHaveProperty(key);
  });
});

describe("onEvent is passive", () => {
  const plan = {
    lanes: [
      {
        id: "lane-01",
        index: 1,
        persona: "first-time-visitor",
        device: "desktop",
        resolution: [1440, 950],
        instructionDigest: "abc",
      },
    ],
  } as unknown as CuaLanePlan;
  const phase = {
    at: "2026-09-30T00:00:00.000Z",
    type: "cua-lab.subject.clone.completed",
    message: "cloned",
    ok: true,
    durationMs: 5,
  };

  it("maps the plan, subject phases and the analysis window, in order", () => {
    const events: LabEvent[] = [];
    const options = normalized(config("cuAppUrl"), { onEvent: (event) => void events.push(event) });
    options.cuaHooks!.onPreflight!(plan);
    options.cuaHooks!.onPhase!(phase, { laneId: "lane-01", laneIndex: 0, laneCount: 1 });
    const finish = options.automaticAnalysis!.onStart!();
    if (typeof finish === "function") finish();
    const shared = normalized(config("sharedProvisioned"), {
      onEvent: (event) => void events.push(event),
    });
    shared.sharedWorldHooks!.onPhase!(phase);
    expect(events).toEqual([
      {
        type: "plan",
        route: "computer-use",
        participants: [
          {
            id: "lane-01",
            persona: "first-time-visitor",
            device: "desktop",
            instructionDigest: "abc",
          },
        ],
      },
      {
        type: "subject-phase",
        target: { kind: "participant", participant: { id: "lane-01", index: 0, count: 1 } },
        name: "cua-lab.subject.clone.completed",
        message: "cloned",
        at: "2026-09-30T00:00:00.000Z",
        ok: true,
        durationMs: 5,
      },
      { type: "analysis-started" },
      { type: "analysis-finished" },
      {
        type: "subject-phase",
        target: { kind: "subject" },
        name: "cua-lab.subject.clone.completed",
        message: "cloned",
        at: "2026-09-30T00:00:00.000Z",
        ok: true,
        durationMs: 5,
      },
    ]);
  });

  it("observes subject phases without taking them off stderr", () => {
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const events: LabEvent[] = [];
      const onEvent = (event: LabEvent): void => void events.push(event);
      normalized(config("cuAppUrl"), { onEvent }).cuaHooks!.onPhase!(phase, {
        laneId: "lane-02",
        laneIndex: 1,
        laneCount: 2,
      });
      normalized(config("sharedProvisioned"), { onEvent }).sharedWorldHooks!.onPhase!(phase);
      expect(events).toHaveLength(2);
    } finally {
      write.mockRestore();
    }
    expect(lines).toEqual([
      "humanish cua [lane-02]: cloned (5ms)\n",
      "humanish shared-world (concurrent): cloned (5ms)\n",
    ]);
  });

  it("a throw or a rejected promise becomes a redacted warning", async () => {
    const secret = "sk-" + "syntheticvalue1234567890abcdef";
    const result = normalize(config("cuAppUrl"), {
      onEvent: (event) => {
        if (event.type === "plan") throw new Error(`plan handler failed ${secret}`);
        return Promise.reject(new Error("analysis handler failed"));
      },
    });
    if (!result.ok) throw new Error(result.message);
    expect(() => result.options.cuaHooks!.onPreflight!(plan)).not.toThrow();
    expect(() => result.options.automaticAnalysis!.onStart!()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatch(
      /^RunLabOptions\.onEvent failed on plan: plan handler failed/,
    );
    expect(result.warnings[0]).not.toContain(secret);
    expect(result.warnings[1]).toBe(
      "RunLabOptions.onEvent failed on analysis-started: analysis handler failed",
    );
  });
});

describe("a computer-use dry run through runLab", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-lab-events-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("reports its plan and carries a failed handler's warning on the result", async () => {
    const events: LabEvent[] = [];
    const outcome = await runLab(config("cuAppUrl"), {
      cwd,
      dryRun: true,
      onEvent: (event) => {
        events.push(event);
        throw new Error("observer down");
      },
    });
    expect(outcome.result.ok).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["plan"]);
    expect(outcome.result.warnings).toContain(
      "RunLabOptions.onEvent failed on plan: observer down",
    );
  });
});

describe("an onEvent warning carries no known secret", () => {
  it("scrubs the literal value of a declared subject env var and of the provider keys", () => {
    const password = "synthetic-app-password-7f3a";
    const openaiKey = "synthetic-openai-value-91c2";
    const labConfig = config("cuClone", { subject: { env: ["APP_PASSWORD"] } });
    const result = normalize(labConfig, {
      env: { APP_PASSWORD: password, OPENAI_API_KEY: openaiKey },
      onEvent: () => {
        throw new Error(`login as ${password} with ${openaiKey} failed`);
      },
    });
    if (!result.ok) throw new Error(result.message);
    result.options.cuaHooks!.onPreflight!({ lanes: [] } as unknown as CuaLanePlan);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).not.toContain(password);
    expect(result.warnings[0]).not.toContain(openaiKey);
    expect(result.warnings[0]).toContain("[REDACTED_SECRET]");
  });

  it("reads the values from the route's bag when env is not set", () => {
    const password = "synthetic-app-password-bag-11";
    const labConfig = config("cuClone", { subject: { env: ["APP_PASSWORD"] } });
    const result = normalize(labConfig, {
      cuaHooks: { env: { APP_PASSWORD: password } },
      onEvent: () => {
        throw new Error(`login as ${password} failed`);
      },
    });
    if (!result.ok) throw new Error(result.message);
    result.options.cuaHooks!.onPreflight!({ lanes: [] } as unknown as CuaLanePlan);
    expect(result.warnings[0]).not.toContain(password);
  });
});
