import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { defaultRedactionHooks } from "../src/redaction.js";
import type { ActorCapabilities } from "../src/actor-contract.js";
import type { CuaExecutor, CuaProvider, CuaTurn } from "../src/computer-use.js";
import { runComputerUseLoop } from "../src/computer-use.js";
import { parseLabConfig } from "../src/lab-config.js";
import { readLabSummary } from "../src/lab-summary.js";
import {
  DEFAULT_OPENAI_CU_REASONING_EFFORT,
  buildInitialRequest,
  createOpenAiResponsesProvider,
  type OpenAiCuContext
} from "../src/openai-responses-cu.js";
import { REASONING_EFFORTS, isReasoningEffort, type ReasoningEffort } from "../src/reasoning-effort.js";

function lab(actor: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "humanish.lab.v2",
    id: "effort-lab",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actors: [{ type: "openai-computer-use", mission: "do the thing", ...actor }],
    execution: { target: "e2b-desktop" },
    scenario: { mode: "dry-run" }
  };
}

describe("reasoning effort is a declarable study variable (#497)", () => {
  it("accepts every documented level on the actor", () => {
    for (const effort of REASONING_EFFORTS) {
      const parsed = parseLabConfig(lab({ reasoningEffort: effort }));
      expect(parsed.ok, `${effort} should parse`).toBe(true);
      if (parsed.ok) expect(parsed.config.actors[0]?.reasoningEffort).toBe(effort);
    }
  });

  it("refuses a level that is not in the vocabulary, and names the vocabulary", () => {
    const parsed = parseLabConfig(lab({ reasoningEffort: "maximum" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain("reasoningEffort");
      expect(parsed.error.message).toContain("xhigh");
      // The refusal must say WHY it is not silently corrected: a downgraded effort would make the
      // trace claim an effort the run did not use.
      expect(parsed.error.message).toContain("model-dependent");
    }
  });

  it("lets a lane override the actor default — the single-run control", () => {
    const parsed = parseLabConfig(
      lab({
        reasoningEffort: "medium",
        lanes: [{ id: "steady", persona: "p" }, { id: "harder", persona: "p", reasoningEffort: "high" }]
      })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.actors[0]?.lanes?.[0]?.reasoningEffort).toBeUndefined();
      expect(parsed.config.actors[0]?.lanes?.[1]?.reasoningEffort).toBe("high");
    }
  });

  it("refuses an unknown level on a lane too", () => {
    const parsed = parseLabConfig(lab({ lanes: [{ id: "a", reasoningEffort: "turbo" }] }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain("lanes[0].reasoningEffort");
  });

  it("puts the declared effort on the wire", () => {
    const ctx: OpenAiCuContext = {
      model: "gpt-5.6-sol",
      instructions: "go",
      reasoningEffort: "xhigh"
    };
    const body = buildInitialRequest(ctx) as { reasoning?: { effort?: string } };
    expect(body.reasoning?.effort).toBe("xhigh");
  });

  it("reports the effort the request WILL carry, including the default nobody declared", () => {
    // The whole defect this closes: the default was real and invisible. A provider that does not
    // report its resolved effort leaves the trace unable to say what produced it.
    const asked = createOpenAiResponsesProvider({ apiKey: "k", reasoningEffort: "low" });
    expect(asked.modelSettings?.reasoningEffort).toBe("low");

    const silent = createOpenAiResponsesProvider({ apiKey: "k" });
    expect(silent.modelSettings?.reasoningEffort).toBe(DEFAULT_OPENAI_CU_REASONING_EFFORT);
  });

  it("guards the vocabulary", () => {
    expect(isReasoningEffort("high")).toBe(true);
    expect(isReasoningEffort("HIGH")).toBe(false);
    expect(isReasoningEffort(undefined)).toBe(false);
  });
});

// --- the trace side: what ran has to be recoverable from the evidence, not from the config ---

const CAPS: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open"
};

/** A provider that reports settings, or (with none) one that reports nothing at all. */
function settingsProvider(reasoningEffort?: ReasoningEffort): CuaProvider {
  return {
    id: "fake-cua",
    version: "fake-model",
    capabilities: CAPS,
    ...(reasoningEffort === undefined ? {} : { modelSettings: { reasoningEffort } }),
    async nextTurn(): Promise<CuaTurn> {
      return { actions: [], pendingSafetyChecks: [], done: true, message: "done" };
    }
  };
}

const STILL_EXECUTOR: CuaExecutor = {
  async observe() {
    return { stateSignature: "s" };
  },
  async execute() {}
};

async function traceFrom(provider: CuaProvider): Promise<Record<string, unknown>> {
  let t = 0;
  const result = await runComputerUseLoop({
    instructions: "go",
    provider,
    executor: STILL_EXECUTOR,
    persona: { id: "p", traitsApplied: [], promptDigest: "d" },
    redaction: defaultRedactionHooks,
    timeoutMs: 10_000,
    now: () => (t += 1000)
  });
  return result.trace as unknown as Record<string, unknown>;
}

describe("the trace records how the model was asked to run", () => {
  it("carries the provider's resolved effort", async () => {
    const trace = await traceFrom(settingsProvider("high"));
    expect(trace.modelSettings).toEqual({ reasoningEffort: "high" });
    expect((trace.ids as { model?: string }).model).toBe("fake-model");
  });

  it("records nothing when the provider declares nothing — absence stays absence", async () => {
    const trace = await traceFrom(settingsProvider());
    expect(trace.modelSettings).toBeUndefined();
    expect("modelSettings" in trace).toBe(false);
  });
});

// --- the surface side: a knob nobody can see is how this one stayed pinned for every run ---

async function summaryFor(actorYaml: string): Promise<{ reasoningEffort?: string } | null> {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-effort-"));
  try {
    await mkdir(path.join(cwd, ".humanish", "labs"), { recursive: true });
    await writeFile(
      path.join(cwd, ".humanish", "labs", "effort.yaml"),
      `schema: humanish.lab.v2\nid: effort\nsubject:\n  source: app-url\n  appUrl: http://127.0.0.1:3000/\nactors:\n${actorYaml}execution:\n  target: e2b-desktop\nscenario:\n  mode: dry-run\n`,
      "utf8"
    );
    return await readLabSummary(cwd, "effort");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("the lab surface says what effort will actually run", () => {
  it("reports the provider default when the lab declares none", async () => {
    const summary = await summaryFor("  - type: openai-computer-use\n    mission: m\n");
    expect(summary?.reasoningEffort).toBe(DEFAULT_OPENAI_CU_REASONING_EFFORT);
  });

  it("reports a declared effort", async () => {
    const summary = await summaryFor("  - type: openai-computer-use\n    mission: m\n    reasoningEffort: xhigh\n");
    expect(summary?.reasoningEffort).toBe("xhigh");
  });

  it("says per-lane rather than picking one lane's answer for all of them", async () => {
    const summary = await summaryFor(
      "  - type: openai-computer-use\n    mission: m\n    reasoningEffort: low\n    lanes:\n      - id: steady\n      - id: harder\n        reasoningEffort: high\n"
    );
    expect(summary?.reasoningEffort).toBe("per-lane");
  });
});
