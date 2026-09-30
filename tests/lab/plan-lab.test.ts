// planLab builds the plan a lab would run under, without running anything. These tests pin the
// plan of every committed lab, compare the plan's derived numbers and key requirements with what
// the routes and `lab doctor` compute today, and check each gap: a combination the plan types
// cannot hold, which a route refuses today.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseLabConfig } from "../../src/lab/config.js";
import { listLabManifests, resolveLabManifest } from "../../src/lab/discover.js";
import { labKeyRequirements } from "../../src/lab/doctor.js";
import { selectLabBackend } from "../../src/lab/engine.js";
import { planLab } from "../../src/lab/plan.js";
import type { LabPlan, PlanResult, Requirement } from "../../src/lab/plan-types.js";
import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../src/lab/types.js";
import { resolveCuaLanePlan } from "../../src/routes/computer-use/lane-plan.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

async function committedLabs(): Promise<[string, LabConfig][]> {
  const labs: [string, LabConfig][] = [];
  for (const lab of (await listLabManifests(ROOT)).labs.filter(
    (lab) => lab.origin === "committed",
  )) {
    const resolved = await resolveLabManifest(ROOT, lab.id);
    if (!resolved.ok) throw new Error(`${lab.id}: ${resolved.error.message}`);
    labs.push([lab.id, resolved.config]);
  }
  return labs;
}

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
    for (const [id, config] of await committedLabs()) {
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
      ...(await committedLabs())
        .filter(([, config]) => selectLabBackend(config) === "cua")
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
      const lanes = resolveCuaLanePlan(config, {
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

  it("asks for the keys lab doctor asks for on a live run", async () => {
    for (const [id, config] of await committedLabs()) {
      const result = planLab(config, { cwd: ROOT, dryRun: false });
      if (!result.ok) continue;
      const requirements = result.planned.plan.requirements;
      const doctor = labKeyRequirements(config, selectLabBackend(config), false, () => false);
      const keys = (name: string) =>
        requirements.some(
          (requirement: Requirement) =>
            (requirement.kind === "key" && requirement.name === name) ||
            (requirement.kind === "key-one-of" && requirement.names.some((key) => key === name)),
        );
      expect(keys("E2B_API_KEY"), id).toBe(doctor.desktop);
      expect(keys("OPENAI_API_KEY"), id).toBe(doctor.keys.includes("OPENAI_API_KEY"));
    }
  });

  it("names the gap for each combination the plan types cannot hold", () => {
    const executor = async () => {
      throw new Error("not called");
    };
    const provider = async () => {
      throw new Error("not called");
    };
    const gap = (config: LabConfig, options: Parameters<typeof planLab>[1]) => {
      const result = planLab(config, options);
      if (result.ok) return "planned";
      const { refusal } = result;
      return `${refusal.route} ${"gap" in refusal ? refusal.gap : refusal.code}`;
    };
    const local = parsed({
      ...cuApp,
      subject: { source: "local-app", appUrl: "http://127.0.0.1:3000/" },
      execution: { target: "local", timeoutMs: 60_000 },
    });
    expect(gap(parsed(cuApp), { cwd: ROOT, cuaHooks: { buildExecutor: executor } })).toBe(
      "computer-use executor-without-provider",
    );
    expect(gap(local, { cwd: ROOT })).toBe("computer-use local-app-without-executor");
    expect(
      gap(local, { cwd: ROOT, cuaHooks: { buildExecutor: executor, buildProvider: provider } }),
    ).toBe("planned");
    expect(
      gap(parsed(cuApp), {
        cwd: ROOT,
        count: 2,
        cuaHooks: { buildExecutor: executor, buildProvider: provider },
      }),
    ).toBe("computer-use in-process-fan-out");
    expect(gap(parsed(cuApp), { cwd: ROOT, count: 17 })).toBe("computer-use participant-cap");
    expect(
      gap(parsed({ subject: { source: "this-repo" }, actors: [{ type: "synthetic-persona" }] }), {
        cwd: ROOT,
        dryRun: false,
      }),
    ).toBe("planned");
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
    expect(
      gap(pricedTerminal, {
        cwd: ROOT,
        dryRun: false,
        terminalHooks: { costProbe: () => ({}) },
      }),
    ).toBe("planned");
    const publicScripted = {
      ...parsed(scriptedApp),
      subject: { source: "app-url", appUrl: "https://example.com/" },
    } as LabConfig;
    expect(gap(publicScripted, { cwd: ROOT })).toBe(
      "scripted HUMANISH_SCRIPTED_LAB_SUBJECT_UNSAFE",
    );
    const unknownActor = { ...parsed(cuApp), actors: [{ type: "not-an-actor" }] } as LabConfig;
    expect(gap(unknownActor, { cwd: ROOT })).toBe("computer-use unsupported-composition");
    const badAnalysis = { ...parsed(cuApp), review: { analysis: "yes" } } as unknown as LabConfig;
    expect(gap(badAnalysis, { cwd: ROOT })).toBe("computer-use analysis-invalid");
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
    const requirements = (config: LabConfig, options: Partial<Parameters<typeof planLab>[1]>) =>
      planOf(planLab(config, { cwd: ROOT, dryRun: false, ...options })).requirements;
    expect(requirements(parsed(scriptedApp), {})).toEqual([{ kind: "host-browser" }]);
    expect(requirements(clone, {})).toEqual([
      { kind: "key", name: "E2B_API_KEY" },
      { kind: "subject-env", names: ["DATABASE_URL"] },
      { kind: "host-browser" },
    ]);
    expect(requirements(clone, { scriptedHooks: { browserCommand: "/usr/bin/chromium" } })).toEqual(
      [
        { kind: "key", name: "E2B_API_KEY" },
        { kind: "subject-env", names: ["DATABASE_URL"] },
      ],
    );
  });

  it("keeps the caller's hooks with the plan and freezes the residual config", () => {
    const cuaHooks = {
      buildProvider: async () => {
        throw new Error("not called");
      },
    };
    const result = planLab(
      parsed({
        ...cuApp,
        comms: { email: { kind: "fake", external: { catchBaseUrl: "http://127.0.0.1:9/" } } },
      }),
      { cwd: ROOT, cuaHooks },
    );
    if (!result.ok) throw new Error(`refused on ${result.refusal.route}`);
    expect(result.planned.bindings.cuaHooks).toBe(cuaHooks);
    const plan = result.planned.plan;
    expect(plan.route === "computer-use" && plan.runner.brain).toEqual({ kind: "caller" });
    expect(Object.isFrozen(plan.residual)).toBe(true);
    expect(Object.isFrozen(plan.residual.comms?.email)).toBe(true);
  });
});
