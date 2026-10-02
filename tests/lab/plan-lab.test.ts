// planLab builds the plan a lab would run under, without running anything. These tests pin the
// plan of every committed lab, compare the plan's derived numbers with what the routes compute
// today, and check that each combination the plan types cannot hold is refused with its route's
// own code. `lab doctor` reads its keys from this plan (tests/lab/doctor.test.ts).

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseLabConfig } from "../../src/lab/config.js";
import { routeOf } from "../../src/lab/plan.js";
import { planLab, type LabRoute } from "../../src/lab/plan.js";
import type { LabPlan, PlanResult } from "../../src/lab/plan-types.js";
import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../src/lab/types.js";
import { resolveCuaParticipantPlan } from "../../src/routes/computer-use/participant-runs.js";
import { committedLabs } from "../helpers/committed-labs.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function planOf(result: PlanResult): LabPlan {
  if (!result.ok) throw new Error(`refused on ${result.refusal.route}`);
  return result.planned.plan;
}

function parsed(raw: Record<string, unknown>): LabConfig {
  const result = parseLabConfig({ schema: LAB_CONFIG_SCHEMA, id: "plan-lab", ...raw });
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

const cuApp = {
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  actors: [{ type: "openai-computer-use" }],
  execution: { target: "e2b-desktop", timeoutMs: 60_000 },
};

const scriptedApp = {
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000" },
  actors: [{ type: "scripted-browser" }],
  scenario: { ref: "scripted-first-run" },
};

describe("planLab", () => {
  it("pins the dry and live plan of every committed lab", async () => {
    const plans: Record<string, unknown> = {};
    for (const [id, config] of await committedLabs(ROOT)) {
      const dry = planLab(config, { cwd: ROOT, dryRun: true });
      const live = planLab(config, { cwd: ROOT, dryRun: false });
      plans[id] = {
        dry: dry.ok ? dry.planned.plan : { refusal: dry.refusal },
        live: live.ok
          ? { requirements: live.planned.plan.requirements }
          : { refusal: live.refusal },
      };
    }
    await expect(`${JSON.stringify(plans, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/plans/committed.json",
    );
  });

  it("derives computer-use concurrency, session budget and sandbox time as the lane plan does", async () => {
    const configs: [string, LabConfig, number | undefined][] = [
      ...(await committedLabs(ROOT))
        .filter(([, config]) => routeOf(config) === "computer-use")
        .map(([id, config]) => [id, config, undefined] as [string, LabConfig, undefined]),
      [
        "declared concurrency",
        parsed({
          ...cuApp,
          actors: [{ type: "openai-computer-use", count: 4 }],
          execution: { ...cuApp.execution, concurrency: 2 },
        }),
        undefined,
      ],
      [
        "count override",
        parsed({ ...cuApp, actors: [{ type: "openai-computer-use", count: 2 }] }),
        5,
      ],
    ];
    for (const [name, config, count] of configs) {
      const plan = planOf(
        planLab(config, { cwd: ROOT, dryRun: true, ...(count === undefined ? {} : { count }) }),
      );
      if (plan.route !== "computer-use") throw new Error(`${name} planned ${plan.route}`);
      const lanes = resolveCuaParticipantPlan(config, {
        env: {},
        ...(count === undefined ? {} : { countOverride: count }),
      });
      expect(
        {
          participants: plan.runner.participants.length,
          concurrency: plan.concurrency,
          sessionBudgetMs: plan.sessionBudgetMs,
          sandboxMinutes: Math.round((plan.runner.participants.length * plan.sandboxMs) / 60_000),
        },
        name,
      ).toEqual({
        participants: lanes.laneCount,
        concurrency: lanes.concurrency,
        sessionBudgetMs: lanes.perLaneSessionBudgetMs,
        sandboxMinutes: lanes.worstCaseSandboxMinutes,
      });
    }
  });

  it("refuses each combination the plan types cannot hold", () => {
    const executor = async () => {
      throw new Error("not called");
    };
    const provider = async () => {
      throw new Error("not called");
    };
    const gap = (
      config: LabConfig,
      options: Parameters<typeof planLab>[1],
      deps?: Parameters<typeof planLab>[2],
    ) => {
      const result = planLab(config, options, deps);
      if (result.ok) return "planned";
      const { refusal } = result;
      return `${refusal.route} ${refusal.code}`;
    };
    const local = parsed({
      ...cuApp,
      subject: { source: "local-app", appUrl: "http://127.0.0.1:3000/" },
      execution: { target: "local", timeoutMs: 60_000 },
    });
    // The type pairs inProcess with createProvider; a JavaScript caller can still omit it.
    const executorOnly = { cwd: ROOT, inProcess: { executor } } as unknown as Parameters<
      typeof planLab
    >[1];
    expect(gap(parsed(cuApp), executorOnly)).toBe(
      "computer-use HUMANISH_CUA_LAB_EXECUTOR_NO_PROVIDER",
    );
    expect(gap(local, { cwd: ROOT })).toBe("computer-use HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR");
    expect(gap(local, { cwd: ROOT, inProcess: { executor }, createProvider: provider })).toBe(
      "planned",
    );
    expect(
      gap(parsed(cuApp), {
        cwd: ROOT,
        count: 2,
        inProcess: { executor },
        createProvider: provider,
      }),
    ).toBe("computer-use HUMANISH_CUA_LAB_FANOUT_INVALID");
    expect(gap(parsed(cuApp), { cwd: ROOT, count: 17 })).toBe(
      "computer-use HUMANISH_CUA_LAB_FANOUT_INVALID",
    );
    // A preview plan holds only a dry run.
    expect(
      gap(parsed({ subject: { source: "this-repo" }, actors: [{ type: "synthetic-persona" }] }), {
        cwd: ROOT,
        dryRun: false,
      }),
    ).toBe("preview HUMANISH_LIVE_RUN_UNIMPLEMENTED");
    const terminal = parsed({
      subject: {
        source: "terminal-product",
        product: { name: "w", publicSurfaces: ["https://example.com/"] },
      },
      actors: [{ type: "codex-exec" }],
    });
    expect(gap(terminal, { cwd: ROOT, dryRun: false })).toBe(
      "terminal HUMANISH_TERMINAL_LAB_CAPS_MISSING",
    );
    expect(gap(terminal, { cwd: ROOT, dryRun: true })).toBe("planned");
    // The terminal route refuses real receiving before it reads the analysis config.
    const receivingTerminal = {
      ...terminal,
      comms: { email: { kind: "real", connection: "team-inbox" } },
      review: { analysis: "yes" },
    } as unknown as LabConfig;
    expect(gap(receivingTerminal, { cwd: ROOT })).toBe(
      "terminal HUMANISH_TERMINAL_LAB_SUBJECT_INVALID",
    );
    // A positive maxUsd can trip only when the caller's costProbe measures spend.
    const pricedTerminal = { ...terminal, scenario: { caps: { maxUsd: 1, maxMinutes: 5 } } };
    expect(gap(pricedTerminal, { cwd: ROOT, dryRun: false })).toBe(
      "terminal HUMANISH_TERMINAL_LAB_UNPRICED_CAP",
    );
    expect(gap(pricedTerminal, { cwd: ROOT, dryRun: false }, { costProbe: () => ({}) })).toBe(
      "planned",
    );
    const publicScripted = {
      ...parsed(scriptedApp),
      subject: { source: "app-url", appUrl: "https://example.com/" },
    } as LabConfig;
    expect(gap(publicScripted, { cwd: ROOT })).toBe(
      "scripted HUMANISH_SCRIPTED_LAB_SUBJECT_UNSAFE",
    );
    const unknownActor = { ...parsed(cuApp), actors: [{ type: "not-an-actor" }] } as LabConfig;
    expect(gap(unknownActor, { cwd: ROOT })).toBe(
      "computer-use HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED",
    );
    const badAnalysis = { ...parsed(cuApp), review: { analysis: "yes" } } as unknown as LabConfig;
    expect(gap(badAnalysis, { cwd: ROOT })).toBe("computer-use HUMANISH_LAB_ANALYSIS_INVALID");
  });

  it("asks a live scripted run for a host browser unless the caller injects one", () => {
    const clone = parsed({
      subject: {
        source: "clone",
        exposure: "synthetic",
        repos: ["example-org/example-app"],
        env: ["DATABASE_URL"],
        serve: { install: "pnpm i", start: "pnpm start -H 0.0.0.0", url: "http://127.0.0.1:3000/" },
        state: { seed: [{ name: "seed", command: "pnpm db:seed" }] },
      },
      actors: [{ type: "scripted-browser" }],
      scenario: { ref: "scripted-first-run" },
      execution: { target: "e2b-desktop" },
    });
    const requirements = (config: LabConfig, deps: Parameters<typeof planLab>[2]) =>
      planOf(planLab(config, { cwd: ROOT, dryRun: false }, deps)).requirements;
    expect(requirements(parsed(scriptedApp), {})).toEqual([{ kind: "host-browser" }]);
    expect(requirements(clone, {})).toEqual([
      { kind: "key", name: "E2B_API_KEY" },
      { kind: "subject-env", names: ["DATABASE_URL"] },
      { kind: "host-browser" },
    ]);
    expect(requirements(clone, { browserCommand: "/usr/bin/chromium" })).toEqual([
      { kind: "key", name: "E2B_API_KEY" },
      { kind: "subject-env", names: ["DATABASE_URL"] },
    ]);
  });

  it("plans a caller-provided brain from createProvider and freezes the residual config", () => {
    const createProvider = async (): Promise<never> => {
      throw new Error("not called");
    };
    const result = planLab(
      parsed({
        ...cuApp,
        comms: { email: { kind: "fake", external: { catchBaseUrl: "http://127.0.0.1:9/" } } },
      }),
      { cwd: ROOT, createProvider },
    );
    if (!result.ok) throw new Error(`refused on ${result.refusal.route}`);
    const plan = result.planned.plan;
    expect(plan.route === "computer-use" && plan.runner.brain).toEqual({ kind: "caller" });
    expect(Object.isFrozen(plan.residual)).toBe(true);
    expect(Object.isFrozen(plan.residual.comms?.email)).toBe(true);
  });
});

describe("planLab on the preview route", () => {
  const thisRepo = parsed({
    subject: { source: "this-repo" },
    actors: [{ type: "synthetic-persona" }],
  });

  it("plans a dry run with the checked count", () => {
    const plan = planOf(planLab(thisRepo, { cwd: ROOT, dryRun: true, count: 3 }));
    expect(plan).toMatchObject({ route: "preview", dryRun: true, participantCount: 3 });
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses a count of %s before the run starts", (count) => {
    const result = planLab(thisRepo, { cwd: ROOT, dryRun: true, count });
    expect(result).toEqual({
      ok: false,
      refusal: {
        route: "preview",
        code: "HUMANISH_INVALID_SIM_COUNT",
        message: "count must be a positive integer.",
      },
    });
  });

  it("refuses a live request with the parser's this-repo message", () => {
    const result = planLab(thisRepo, { cwd: ROOT, dryRun: false });
    expect(result).toEqual({
      ok: false,
      refusal: {
        route: "preview",
        code: "HUMANISH_LIVE_RUN_UNIMPLEMENTED",
        message: "this-repo labs are dry-run only; use a clone or app-url subject for a live run.",
      },
    });
  });

  it("refuses a bad count before a live request, as runDryRun ordered them", () => {
    const result = planLab(thisRepo, { cwd: ROOT, dryRun: false, count: 0 });
    expect(result.ok ? undefined : result.refusal.code).toBe("HUMANISH_INVALID_SIM_COUNT");
  });
});

// ARCHITECTURE.md's invariant "Goldens pin route output": every route has a dry-run run-directory
// golden from runDirSnapshot (tests/helpers/run-golden.ts). The record fails typecheck when a route
// is added to LabRoute without an entry here, and the test fails when the golden file is missing.
describe("route goldens", () => {
  const dryRunGoldens = {
    preview: ["preview-dry-run.json"],
    "computer-use": ["computer-use-dry-run.json", "computer-use-fanout-dry-run.json"],
    scripted: ["scripted-dry-run.json"],
    terminal: ["terminal-dry-run.json"],
    "shared-world": [
      "shared-world-concurrent-dry-run.json",
      "shared-world-external-public-dry-run.json",
    ],
  } satisfies Record<LabRoute, readonly string[]>;

  it.each(Object.entries(dryRunGoldens))(
    "%s has a dry-run run-directory golden",
    (_route, files) => {
      for (const file of files) {
        expect(existsSync(path.join(ROOT, "tests", "golden", "routes", file)), file).toBe(true);
      }
    },
  );
});
