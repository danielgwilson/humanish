import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAutomaticAnalysis } from "../../src/analysis/automatic-config.js";
import { analysisEffort } from "../../src/analysis/models.js";
import { captureEvidence } from "../../src/analysis/evidence.js";
import type { AnalysisFetch } from "../../src/analysis/provider.js";
import { analyzeRun, showAnalysis } from "../../src/analysis/service.js";
import type { AnalysisConfig, AnalysisInput } from "../../src/analysis/types.js";
import { hashAnalysisValue } from "../../src/analysis/validation.js";
import { createProgram } from "../../src/cli/program.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { syntheticResult } from "./fixtures.js";

// `humanish analyze` sends through undici's fetch. The replacement keeps each request body and
// answers 401, so the CLI test reads what the command would have sent and nothing leaves the box.
const undiciBodies = vi.hoisted(() => [] as string[]);
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: async (_url: string, init: { body: string }) => {
    undiciBodies.push(init.body);
    return { ok: false, status: 401, body: null };
  },
}));

describe("a study's declared analysis reasoning effort", () => {
  it.each([
    [{ maxCostUsd: 2, model: "gpt-6-luna", reasoningEffort: "medium" }, "medium"],
    [{ maxCostUsd: 2, model: "gpt-6-luna", reasoningEffort: "none" }, "none"],
    [{ maxCostUsd: 2, model: "gpt-6-astra", reasoningEffort: "max" }, "max"],
    [{ provider: "gemini", maxCostUsd: 2, reasoningEffort: "low" }, "low"],
  ])("keeps an effort the model takes in the configuration: %j", (raw, effort) => {
    expect(resolveAutomaticAnalysis(raw)).toMatchObject({
      ok: true,
      config: { reasoningEffort: effort },
    });
  });

  it.each([
    // gpt-6-astra and gpt-6.1-sol list low through max; gpt-5.5 stops at xhigh.
    [
      { maxCostUsd: 2, model: "gpt-6-astra", reasoningEffort: "none" },
      "low, medium, high, xhigh or max",
    ],
    [
      { maxCostUsd: 2, model: "gpt-6.1-sol", reasoningEffort: "minimal" },
      "low, medium, high, xhigh or max",
    ],
    [
      { maxCostUsd: 2, model: "gpt-5.5", reasoningEffort: "max" },
      "none, low, medium, high or xhigh",
    ],
    // gemini-3.8-flash answers minimal with an error.
    [{ provider: "gemini", maxCostUsd: 2, reasoningEffort: "minimal" }, "low, medium or high"],
    [{ provider: "gemini", maxCostUsd: 2, reasoningEffort: "xhigh" }, "low, medium or high"],
    [{ maxCostUsd: 2, reasoningEffort: "extreme" }, "low, medium, high, xhigh or max"],
  ])("refuses an effort the model does not take, naming the ones it does: %j", (raw, levels) => {
    const resolved = resolveAutomaticAnalysis(raw);
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.message).toContain(levels);
  });

  it("refuses a declared effort for Codex account analysis", () => {
    const resolved = resolveAutomaticAnalysis({ provider: "codex", reasoningEffort: "low" });
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.message).toMatch(/Codex account analysis.*fixed low/);
  });

  it.each([undefined, { maxCostUsd: 10 }, { provider: "openai", maxCostUsd: 10 }])(
    "resolves an OpenAI analysis that names no model to gpt-6.1-sol at medium, written into the configuration: %j",
    (raw) => {
      const resolved = resolveAutomaticAnalysis(raw);
      expect(resolved).toMatchObject({
        ok: true,
        config: { model: "gpt-6.1-sol", reasoningEffort: "medium" },
      });
    },
  );

  it("gives the default model a declared effort in place of medium", () => {
    expect(resolveAutomaticAnalysis({ maxCostUsd: 10, reasoningEffort: "high" })).toMatchObject({
      ok: true,
      config: { model: "gpt-6.1-sol", reasoningEffort: "high" },
    });
  });

  it("runs a named model without an effort at high, under the hash it had before the default changed", () => {
    // Hashes of these resolved configurations at 6699b428a, before gpt-6.1-sol became the default.
    const pinned = [
      [
        { maxCostUsd: 10, model: "gpt-6-astra" },
        "d4a11fc68c8d476c7187dcaa5fb65626bf3a25502aac154ff545a688e33c282d",
      ],
      [
        { provider: "openai", maxCostUsd: 10, model: "gpt-6-astra" },
        "77a70e555b194fb2c9408606366a98c3fb325467a99d8330804c041698cd30e6",
      ],
      [
        { maxCostUsd: 10, model: "gpt-6.1-sol" },
        "245158feb029048d2b94453fcc215b1e8ee98c143248ead96079ad113de78ad7",
      ],
      [
        { provider: "gemini", maxCostUsd: 2 },
        "94a10839e7fac39e11cf25acc5a444142d521e92495710a787ea649fd35246b0",
      ],
    ] as const;
    for (const [raw, hash] of pinned) {
      const resolved = resolveAutomaticAnalysis(raw);
      if (!resolved.ok || !resolved.config)
        throw new Error(`${JSON.stringify(raw)} did not resolve`);
      expect(hashAnalysisValue(resolved.config)).toBe(hash);
      expect(analysisEffort(resolved.config)).toBe("high");
    }
  });

  it("gives a declared effort its own configuration hash", () => {
    const omitted = resolveAutomaticAnalysis({ maxCostUsd: 10, model: "gpt-6-astra" });
    const high = resolveAutomaticAnalysis({
      maxCostUsd: 10,
      model: "gpt-6-astra",
      reasoningEffort: "high",
    });
    expect(high.ok && hashAnalysisValue(high.config)).not.toBe(
      omitted.ok && hashAnalysisValue(omitted.config),
    );
  });
});

// Captured response envelopes; see each fixture's readme. Only the synthetic report is replaced.
const OPENAI_WIRE = new URL(
  "../fixtures/openai-closing-report/typed-closing-report.json",
  import.meta.url,
);
const GEMINI_WIRE = new URL(
  "../fixtures/gemini-generate-content/structured-answer.json",
  import.meta.url,
);
const RUN_ID = "effort-flow";

/** Stubs the keys and the date, and makes a synthetic completed live run to analyze. */
function useSyntheticRun(): { cwd: string; input: AnalysisInput } {
  const run = { cwd: "", input: {} as AnalysisInput };
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-key");
    vi.stubEnv("GEMINI_API_KEY", "synthetic-gemini-key");
    vi.stubEnv("GOOGLE_API_KEY", undefined);
    // The rates in effect before gemini-3.8-flash's published change on 2027-01-01.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T12:00:00Z") });
    const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-analysis-effort-"));
    run.cwd = cwd;
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runDryRun({ cwd, dryRun: true, runId: RUN_ID });
    const runRoot = path.join(cwd, ".humanish/runs", RUN_ID);
    const bundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as RunBundle;
    // An explicitly synthetic completed stream, not a live-provider claim.
    bundle.mode = "live";
    bundle.streams[0]!.status = "complete";
    await writeFile(path.join(runRoot, "run.json"), JSON.stringify(bundle, null, 2) + "\n");
    await rm(path.join(runRoot, "status.json"), { force: true });
    run.input = await captureEvidence(
      (await resolveRunPath(cwd, RUN_ID))!,
      await readFile(path.join(runRoot, "run.json")),
    );
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(run.cwd, { recursive: true, force: true });
  });
  return run;
}

describe("an analysis's reasoning effort on the wire and in its record", () => {
  const run = useSyntheticRun();

  async function transport(vendor: "openai" | "gemini") {
    const wire = JSON.parse(
      await readFile(vendor === "openai" ? OPENAI_WIRE : GEMINI_WIRE, "utf8"),
    );
    const report = JSON.stringify(syntheticResult(run.input));
    if (vendor === "openai") wire.output[0].content[0].text = report;
    else wire.candidates[0].content.parts[0].text = report;
    return vi.fn<AnalysisFetch>(async () => new Response(JSON.stringify(wire)));
  }
  const sent = (fetch: ReturnType<typeof vi.fn<AnalysisFetch>>) =>
    JSON.parse(String(fetch.mock.calls[0]?.[1].body));
  const resolved = (raw: Record<string, unknown>): AnalysisConfig => {
    const result = resolveAutomaticAnalysis({ maxCostUsd: 5, timeoutMs: 1000, ...raw });
    if (!result.ok || !result.config) throw new Error("the test configuration did not resolve");
    return result.config;
  };

  it("sends a declared OpenAI effort as reasoning.effort and keeps it in the saved analysis", async () => {
    const fetch = await transport("openai");
    const config = resolved({ model: "gpt-6-luna", reasoningEffort: "medium" });
    expect(await analyzeRun(run.cwd, RUN_ID, { config }, { fetch })).toMatchObject({ ok: true });
    expect(sent(fetch).reasoning).toEqual({ effort: "medium" });
    const saved = await showAnalysis(run.cwd, RUN_ID);
    expect(saved.state).toBe("ready");
    expect(saved.analysis?.config).toMatchObject({
      model: "gpt-6-luna",
      reasoningEffort: "medium",
    });
  });

  it("sends the default analyst as gpt-6.1-sol at medium and keeps medium in the saved analysis", async () => {
    const fetch = await transport("openai");
    expect(await analyzeRun(run.cwd, RUN_ID, { config: resolved({}) }, { fetch })).toMatchObject({
      ok: true,
    });
    expect(sent(fetch)).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: "medium" } });
    expect((await showAnalysis(run.cwd, RUN_ID)).analysis?.config).toMatchObject({
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
    });
  });

  it("sends a declared Gemini effort as its thinking level", async () => {
    const fetch = await transport("gemini");
    const config = resolved({ provider: "gemini", reasoningEffort: "low" });
    expect(await analyzeRun(run.cwd, RUN_ID, { config }, { fetch })).toMatchObject({ ok: true });
    expect(sent(fetch).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    expect((await showAnalysis(run.cwd, RUN_ID)).analysis?.config).toMatchObject({
      provider: "gemini",
      reasoningEffort: "low",
    });
  });

  it.each([
    ["openai", (body: Record<string, any>) => body.reasoning.effort, "high"],
    [
      "gemini",
      (body: Record<string, any>) => body.generationConfig.thinkingConfig.thinkingLevel,
      "HIGH",
    ],
  ] as const)(
    "runs an undeclared %s effort at high and records no effort",
    async (vendor, effortOf, wire) => {
      const fetch = await transport(vendor);
      const config = resolved(
        vendor === "gemini" ? { provider: "gemini" } : { model: "gpt-6-luna" },
      );
      expect(await analyzeRun(run.cwd, RUN_ID, { config }, { fetch })).toMatchObject({ ok: true });
      expect(effortOf(sent(fetch))).toBe(wire);
      const saved = await showAnalysis(run.cwd, RUN_ID);
      expect(saved.state).toBe("ready");
      expect(Object.keys(saved.analysis!.config)).not.toContain("reasoningEffort");
    },
  );

  it("refuses, before any request, a direct configuration whose effort its model does not take", async () => {
    const fetch = await transport("openai");
    const config: AnalysisConfig = {
      model: "gpt-6-astra",
      question: null,
      maxCostUsd: 5,
      timeoutMs: 1000,
      maxOutputTokens: 16384,
      reasoningEffort: "none",
    };
    expect(await analyzeRun(run.cwd, RUN_ID, { config }, { fetch })).toMatchObject({
      ok: false,
      error: { code: "analysis_config_invalid" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the analyze command's reasoning effort", () => {
  const run = useSyntheticRun();

  async function cli(...flags: string[]) {
    const output: string[] = [];
    let exit: number | undefined;
    const program = createProgram({
      writeOut: (text) => output.push(text),
      writeErr: () => {},
      setExitCode: (code) => {
        exit = code;
      },
      keyDiscovery: async () => [],
    });
    await program.parseAsync(["analyze", "--cwd", run.cwd, "--run", RUN_ID, "--json", ...flags], {
      from: "user",
    });
    return { exit, result: JSON.parse(output.join("")) };
  }

  it("analyze --reasoning-effort admits an effort the model takes and refuses others", async () => {
    expect(
      await cli(
        "--model",
        "gpt-6-luna",
        "--reasoning-effort",
        "medium",
        "--max-cost",
        "2",
        "--dry-run",
      ),
    ).toMatchObject({ exit: 0, result: { ok: true, admission: { allowed: true } } });
    const refused = await cli(
      "--model",
      "gpt-6-astra",
      "--reasoning-effort",
      "none",
      "--max-cost",
      "2",
    );
    expect(refused).toMatchObject({
      exit: 2,
      result: { error: { code: "ANALYSIS_CONFIG_INVALID" } },
    });
    expect(refused.result.error.message).toContain("low, medium, high, xhigh or max");
    expect(
      await cli("--provider", "codex", "--reasoning-effort", "low", "--dry-run"),
    ).toMatchObject({ exit: 2, result: { error: { code: "ANALYSIS_CONFIG_INVALID" } } });
  });

  it("analyze without --model sends gpt-6.1-sol at medium, and --model without an effort sends high", async () => {
    undiciBodies.length = 0;
    await cli("--max-cost", "2");
    await cli("--model", "gpt-6-astra", "--max-cost", "2");
    expect(
      undiciBodies.map((body) => {
        const sentBody = JSON.parse(body);
        return [sentBody.model, sentBody.reasoning.effort];
      }),
    ).toEqual([
      ["gpt-6.1-sol", "medium"],
      ["gpt-6-astra", "high"],
    ]);
  });
});
