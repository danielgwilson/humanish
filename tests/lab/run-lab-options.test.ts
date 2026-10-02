import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CuaExecutor, CuaProvider } from "../../src/actors/computer-use/loop.js";
import type { AdapterScorerModule } from "../../src/lab/adapter-scorer-loader.js";
import { parseLabConfig } from "../../src/lab/config.js";
import { runLab, type InternalRunLabOptions } from "../../src/run-lab.js";
import { routeOf } from "../../src/lab/plan.js";
import {
  participantOf,
  phaseEvent,
  planEvent,
  type LabEvent,
} from "../../src/lab/run-lab-events.js";
import { normalizeRunLabOptions, type StreamEvent } from "../../src/lab/run-lab-options.js";
import type { LabConfig } from "../../src/lab/types.js";
import type { CuaParticipantPlan } from "../../src/routes/computer-use/types.js";
import { trackRuntimeStreams } from "../../src/routes/computer-use/live-flush.js";
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
/** A fresh plan event with no participants: a poisoning test redefines its fields. */
const emptyPlan = (): LabEvent => ({ type: "plan", route: "computer-use", participants: [] });

function normalize(labConfig: LabConfig, options: Partial<InternalRunLabOptions>) {
  return normalizeRunLabOptions(labConfig, routeOf(labConfig), {
    cwd: "/tmp/unused",
    ...options,
  } as InternalRunLabOptions);
}

function normalized(
  labConfig: LabConfig,
  options: Partial<InternalRunLabOptions>,
): InternalRunLabOptions {
  const result = normalize(labConfig, options);
  if (!result.ok) throw new Error(result.message);
  return result.options;
}

describe("an option the route cannot honor is refused before anything runs", () => {
  const cases: [string, () => LabConfig, Partial<InternalRunLabOptions>, string | undefined][] = [
    ["preview scorer", () => config("preview"), { scorer }, "scorer"],
    ["preview createProvider", () => config("preview"), { createProvider }, "createProvider"],
    ["preview inProcess", () => config("preview"), { inProcess, createProvider }, "createProvider"],
    ["preview prepareDesktop", () => config("preview"), { prepareDesktop }, "prepareDesktop"],
    ["preview onStream", () => config("preview"), { onStream: () => undefined }, undefined],
    ["computer use scorer", () => config("cuAppUrl"), { scorer }, undefined],
    ["computer use createProvider", () => config("cuAppUrl"), { createProvider }, undefined],
    ["computer use inProcess", () => config("cuAppUrl"), { inProcess, createProvider }, undefined],
    [
      "computer use inProcess on two participants (the planner refuses it)",
      () => config("cuAppUrl", { actors: [{ type: "openai-computer-use", count: 2 }] }),
      { inProcess, createProvider },
      undefined,
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

describe("rerun.laneIds set beside rerun.participantIds is refused", () => {
  it("names both fields", () => {
    const result = normalize(config("cuAppUrl"), {
      rerun: { sourceRunId: "r", participantIds: ["a"], laneIds: ["a"] },
    });
    expect(result).toMatchObject({ ok: false, code: "HUMANISH_LAB_OPTION_CONFLICT" });
    if (result.ok) return;
    expect(result.message).toContain("RunLabOptions.rerun.participantIds");
    expect(result.message).toContain("rerun.laneIds");
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
    ["cuClone", "cua", "humanish.cua-lab-result.v2", { inProcess, createProvider }],
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
    const outcome = await runLab(
      config(base),
      { cwd, dryRun: false, runId: "refused", ...options } as InternalRunLabOptions,
      {
        desktopModule: async () => {
          desktopLoads += 1;
          throw new Error("no desktop in this test");
        },
      },
    );

    expect(outcome.backend).toBe(backend);
    expect(outcome.result).toMatchObject({
      schema,
      ok: false,
      error: { code: "HUMANISH_LAB_OPTION_UNSUPPORTED" },
    });
    expect(desktopLoads).toBe(0);
    expect(await readdir(cwd)).toEqual([]);
  });

  it("typed inProcess on two participants gets the planner's fan-out refusal, naming inProcess", async () => {
    let desktopLoads = 0;
    const outcome = await runLab(
      config("cuAppUrl"),
      {
        cwd,
        dryRun: false,
        runId: "refused",
        inProcess,
        createProvider,
        count: 2,
      },
      {
        desktopModule: async () => {
          desktopLoads += 1;
          throw new Error("no desktop in this test");
        },
      },
    );
    expect(outcome.result).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_CUA_LAB_FANOUT_INVALID" },
    });
    expect(outcome.result.error?.message).toContain("RunLabOptions.inProcess");
    expect(desktopLoads).toBe(0);
    expect(await readdir(cwd)).toEqual([]);
  });

  it("a conflict comes back the same way", async () => {
    const outcome = await runLab(config("cuAppUrl"), {
      cwd,
      rerun: { sourceRunId: "r", participantIds: ["a"], laneIds: ["a"] },
    });
    expect(outcome.result.error).toMatchObject({ code: "HUMANISH_LAB_OPTION_CONFLICT" });
    expect(await readdir(cwd)).toEqual([]);
  });
});

describe("each typed option stays on the options the route reads", () => {
  it("scorer stays on the options for every scoring route", () => {
    const module: AdapterScorerModule = {
      score: scorer.score!,
      deriveFeedback: () => [],
      deriveArtifacts: () => [],
    };
    for (const base of ["cuAppUrl", "sharedProvisioned", "terminal"] as const)
      expect(normalized(config(base), { scorer: module }).scorer).toBe(module);
  });

  it.each(["cuAppUrl", "sharedProvisioned", "terminal", "scriptedAppUrl"] as const)(
    "env stays on the options for %s, as a copy",
    (base) => {
      const env = { OPENAI_API_KEY: "k" };
      const options = normalized(config(base), { env });
      expect(options.env).toEqual(env);
      expect(options.env).not.toBe(env);
    },
  );

  it.each(["cuAppUrl", "sharedProvisioned", "scriptedClone"] as const)(
    "prepareDesktop stays on the options for %s",
    (base) => {
      expect(normalized(config(base), { prepareDesktop }).prepareDesktop).toBe(prepareDesktop);
    },
  );

  it("createProvider and inProcess stay on the options for computer use", () => {
    const options = normalized(config("cuLocalApp"), { inProcess, createProvider });
    expect(options.createProvider).toBe(createProvider);
    expect(options.inProcess).toBe(inProcess);
  });
});

describe("stream, rerun and analysis options land where the route reads them", () => {
  it("onStream reaches the route as given", () => {
    const onStream = (): void => undefined;
    for (const labConfig of [config("cuAppUrl"), localVm(), config("sharedProvisioned")])
      expect(normalized(labConfig, { onStream }).onStream).toBe(onStream);
  });

  it("the route awaits onStream before it records the stream, and a rejection reaches the route", async () => {
    const events: StreamEvent[] = [];
    const streams = trackRuntimeStreams(async (event) => {
      events.push(event);
      if (event.type === "ended") throw new Error("ended handler failed");
    });
    const ready: StreamEvent = {
      type: "ready",
      participantId: "lane-01",
      sandboxId: "sbx",
      simId: "sim-001",
      streamId: "stream-001",
      url: "https://stream.invalid/key",
    };
    await streams.onStream(ready);
    const ended: StreamEvent = {
      type: "ended",
      participantId: "lane-01",
      simId: "sim-001",
      streamId: "stream-001",
    };
    await expect(streams.onStream(ended)).rejects.toThrow("ended handler failed");
    expect(events).toEqual([ready, ended]);
  });

  it("rerun.participantIds becomes rerun.laneIds", () => {
    expect(
      normalized(config("cuAppUrl"), { rerun: { sourceRunId: "r", participantIds: ["lane-02"] } })
        .rerun,
    ).toEqual({ sourceRunId: "r", laneIds: ["lane-02"] });
  });

  it("analysisSignal joins the other analysis deps", async () => {
    const signal = AbortSignal.abort();
    const run = async () => {
      throw new Error("unused");
    };
    const options = normalized(config("cuAppUrl"), {
      analysisSignal: signal,
      automaticAnalysis: { run },
    });
    expect(options.automaticAnalysis!.deps).toEqual({ signal });
    await expect((options.automaticAnalysis!.run as () => Promise<unknown>)()).rejects.toThrow(
      "unused",
    );
  });

  it("computer use reads its typed options directly; onEvent and analysisSignal go to analysis", () => {
    const onStream = (): void => undefined;
    const env = {};
    const options = normalized(config("cuAppUrl"), {
      env,
      scorer,
      prepareDesktop,
      onEvent: () => undefined,
      onStream,
      analysisSignal: AbortSignal.abort(),
      createProvider,
    });
    expect(options.scorer).toBe(scorer);
    expect(options.onStream).toBe(onStream);
    expect(options.createProvider).toBe(createProvider);
    expect(options.prepareDesktop).toBe(prepareDesktop);
    expect(options.env).toEqual(env);
    for (const key of ["onEvent", "analysisSignal"]) expect(options).not.toHaveProperty(key);
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
  } as unknown as CuaParticipantPlan;
  const phase = {
    at: "2026-09-30T00:00:00.000Z",
    type: "cua-lab.subject.clone.completed",
    message: "cloned",
    ok: true,
    durationMs: 5,
  };

  it("emits the plan, subject phases and the analysis window, in order", () => {
    const events: LabEvent[] = [];
    const result = normalize(config("cuAppUrl"), { onEvent: (event) => void events.push(event) });
    if (!result.ok) throw new Error(result.message);
    result.emit!(planEvent(plan));
    result.emit!(
      phaseEvent(phase, {
        kind: "participant",
        participant: participantOf({ laneId: "lane-01", laneIndex: 0, laneCount: 1 }),
      }),
    );
    const finish = result.options.automaticAnalysis!.onStart!();
    if (typeof finish === "function") finish();
    result.emit!(phaseEvent(phase, { kind: "subject" }));
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

  it("is left unset without onEvent", () => {
    const result = normalize(config("cuAppUrl"), {});
    if (!result.ok) throw new Error(result.message);
    expect(result.emit).toBeUndefined();
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
    expect(() => result.emit!(planEvent(plan))).not.toThrow();
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
    result.emit!(emptyPlan());
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).not.toContain(password);
    expect(result.warnings[0]).not.toContain(openaiKey);
    expect(result.warnings[0]).toContain("[REDACTED_SECRET]");
  });
});

describe("an onEvent failure never escapes", () => {
  const fallback = "RunLabOptions.onEvent failed on plan: the thrown value has no message";

  it("a thrown value with no string form becomes a warning", () => {
    const result = normalize(config("cuAppUrl"), {
      onEvent: () => {
        throw Object.create(null);
      },
    });
    if (!result.ok) throw new Error(result.message);
    expect(() => result.emit!(emptyPlan())).not.toThrow();
    expect(result.warnings).toEqual([fallback]);
  });

  it("a rejection with no string form is caught and becomes a warning", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const result = normalize(config("cuAppUrl"), {
        onEvent: () => Promise.reject(Object.create(null)),
      });
      if (!result.ok) throw new Error(result.message);
      result.emit!(emptyPlan());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(result.warnings).toEqual([fallback]);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("an in-process run has no desktop to prepare", () => {
  it("refuses prepareDesktop beside inProcess", () => {
    const result = normalize(config("cuAppUrl"), { inProcess, createProvider, prepareDesktop });
    expect(result).toMatchObject({ ok: false, code: "HUMANISH_LAB_OPTION_UNSUPPORTED" });
    if (!result.ok) expect(result.message).toContain("RunLabOptions.prepareDesktop");
  });
});

describe("an onEvent callback that rewrites its event", () => {
  const poison = (event: LabEvent): void => {
    Object.defineProperty(event, "type", {
      get() {
        throw new Error("event.type getter escaped");
      },
    });
  };

  it("cannot make the synchronous report throw", () => {
    const result = normalize(config("cuAppUrl"), {
      onEvent: (event) => {
        poison(event);
        throw new Error("handler failed");
      },
    });
    if (!result.ok) throw new Error(result.message);
    expect(() => result.emit!(emptyPlan())).not.toThrow();
    expect(result.warnings).toEqual(["RunLabOptions.onEvent failed on plan: handler failed"]);
  });

  it("cannot make the asynchronous report reject", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const result = normalize(config("cuAppUrl"), {
        onEvent: (event) => {
          poison(event);
          return Promise.reject(Object.create(null));
        },
      });
      if (!result.ok) throw new Error(result.message);
      result.emit!(emptyPlan());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(result.warnings).toEqual([
        "RunLabOptions.onEvent failed on plan: the thrown value has no message",
      ]);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
describe("the scrub covers every env the run could read", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("scrubs a declared name's value from process.env when env is also given", () => {
    const hostPassword = "synthetic-host-password-5d1e";
    vi.stubEnv("APP_PASSWORD", hostPassword);
    const result = normalize(config("cuClone", { subject: { env: ["APP_PASSWORD"] } }), {
      env: { APP_PASSWORD: "synthetic-route-password-8a2f" },
      onEvent: () => {
        throw new Error(`fell back to ${hostPassword}`);
      },
    });
    if (!result.ok) throw new Error(result.message);
    result.emit!(emptyPlan());
    expect(result.warnings[0]).not.toContain(hostPassword);
  });

  it("scrubs the analysis API key", () => {
    const analysisKey = "synthetic-analysis-key-2c7b";
    const result = normalize(config("cuAppUrl"), {
      automaticAnalysis: { deps: { apiKey: analysisKey } },
      onEvent: () => {
        throw new Error(`analysis rejected ${analysisKey}`);
      },
    });
    if (!result.ok) throw new Error(result.message);
    result.emit!(emptyPlan());
    expect(result.warnings[0]).not.toContain(analysisKey);
  });
});

describe("the scrub covers the env the route received", () => {
  it("scrubs a value the caller changed after normalization", () => {
    const initial = "synthetic-initial-password-42";
    const env: Record<string, string> = { APP_PASSWORD: initial };
    const result = normalize(config("cuClone", { subject: { env: ["APP_PASSWORD"] } }), {
      env,
      onEvent: () => {
        throw new Error(`login as ${initial} failed`);
      },
    });
    if (!result.ok) throw new Error(result.message);
    env.APP_PASSWORD = "synthetic-replaced-password-17";
    expect(result.options.env!.APP_PASSWORD).toBe(initial);
    result.emit!(emptyPlan());
    expect(result.warnings[0]).not.toContain(initial);
  });
});
