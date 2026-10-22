import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAutomaticAnalysis } from "../../src/analysis/automatic.js";
import { resolveAutomaticAnalysis } from "../../src/analysis/automatic-config.js";
import { createProgram } from "../../src/cli/program.js";
import { captureEvidence } from "../../src/analysis/evidence.js";
import type { AnalysisFetch } from "../../src/analysis/provider.js";
import { analyzeRun, showAnalysis } from "../../src/analysis/service.js";
import { listAnalysisExecutions } from "../../src/analysis/store-executions.js";
import type { AnalysisConfig, AnalysisInput } from "../../src/analysis/types.js";
import { hashAnalysisValue } from "../../src/analysis/validation.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { syntheticResult } from "./fixtures.js";

const config: AnalysisConfig = {
  provider: "gemini",
  model: "gemini-3.8-flash",
  question: null,
  maxCostUsd: 5,
  timeoutMs: 1000,
  maxOutputTokens: 8192,
};
// A captured generateContent response; see the fixture's readme.
const wirePath = new URL(
  "../fixtures/gemini-generate-content/structured-answer.json",
  import.meta.url,
);

/** A completed synthetic run in a fresh project, with no analysis key in the environment. */
function useRun() {
  const run = { cwd: "", input: undefined as unknown as AnalysisInput };
  beforeEach(async () => {
    vi.unstubAllEnvs();
    for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY"])
      vi.stubEnv(name, undefined);
    // The rates in effect before gemini-3.8-flash's published change on 2027-01-01.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T12:00:00Z") });
    const cwd = (run.cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-gemini-analysis-")));
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runDryRun({ cwd, dryRun: true, runId: "gemini-flow" });
    const runRoot = path.join(cwd, ".humanish/runs/gemini-flow");
    const bundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as RunBundle;
    // An explicitly synthetic completed stream, not a live-provider claim.
    bundle.mode = "live";
    bundle.streams[0]!.status = "complete";
    await writeFile(path.join(runRoot, "run.json"), JSON.stringify(bundle, null, 2) + "\n");
    await rm(path.join(runRoot, "status.json"), { force: true });
    const prepared = (await resolveRunPath(cwd, "gemini-flow"))!;
    run.input = await captureEvidence(prepared, await readFile(path.join(runRoot, "run.json")));
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(run.cwd, { recursive: true, force: true });
  });
  return run;
}

/** A fetch that answers with the captured Gemini response carrying a valid report of `input`. */
async function geminiTransport(input: AnalysisInput) {
  const wire = JSON.parse(await readFile(wirePath, "utf8"));
  wire.candidates[0].content.parts[0].text = JSON.stringify(syntheticResult(input));
  return vi.fn<AnalysisFetch>(async () => new Response(JSON.stringify(wire)));
}

describe("study analysis on Gemini", () => {
  const run = useRun();
  const transport = () => geminiTransport(run.input);
  it("sends the run to Gemini with GEMINI_API_KEY and keeps a priced, valid analysis", async () => {
    vi.stubEnv("GEMINI_API_KEY", "synthetic-gemini-key");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-key");
    const fetch = await transport();
    const result = await analyzeRun(run.cwd, "gemini-flow", { config }, { fetch });
    expect(result).toMatchObject({ ok: true, status: "partial" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    );
    expect(init.headers["x-goog-api-key"]).toBe("synthetic-gemini-key");
    const saved = await showAnalysis(run.cwd, "gemini-flow");
    expect(saved.state).toBe("ready");
    expect(saved.analysis).toMatchObject({
      provider: "gemini",
      config: { provider: "gemini", model: "gemini-3.8-flash" },
      // 1,124 input tokens at $0.75 and 183 output at $3.75 per 1M.
      usage: { inputTokens: 1124, outputTokens: 183, estimatedCostUsd: 0.001529 },
    });
    expect(saved.analysis?.usage.ratesAsOf).toBe("2026-10-21");
    const executions = await listAnalysisExecutions(
      (await resolveRunPath(run.cwd, "gemini-flow"))!,
    );
    expect(executions.receipts).toMatchObject([{ provider: "gemini" }]);
  });

  it("reads GEMINI_API_KEY ahead of GOOGLE_API_KEY", async () => {
    vi.stubEnv("GEMINI_API_KEY", "synthetic-gemini-key");
    vi.stubEnv("GOOGLE_API_KEY", "synthetic-google-key");
    const fetch = await transport();
    await analyzeRun(run.cwd, "gemini-flow", { config }, { fetch });
    expect(fetch.mock.calls[0]?.[1].headers["x-goog-api-key"]).toBe("synthetic-gemini-key");
  });

  it("sends GOOGLE_API_KEY when it is the only Gemini key", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "synthetic-google-key");
    const fetch = await transport();
    await analyzeRun(run.cwd, "gemini-flow", { config }, { fetch });
    expect(fetch.mock.calls[0]?.[1].headers["x-goog-api-key"]).toBe("synthetic-google-key");
  });

  it("never falls back to the OpenAI key: without a Gemini key nothing is sent", async () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-key");
    const fetch = await transport();
    const result = await analyzeRun(run.cwd, "gemini-flow", { config }, { fetch });
    expect(result).toMatchObject({ ok: false, error: { code: "ANALYSIS_API_KEY_MISSING" } });
    expect(result.error?.message).toMatch(/humanish keys set gemini/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says which HTTP status Gemini answered, never its error text", async () => {
    vi.stubEnv("GEMINI_API_KEY", "synthetic-gemini-key");
    const fetch = vi.fn<AnalysisFetch>(
      async () =>
        new Response(JSON.stringify({ error: { code: 503, message: "synthetic-private" } }), {
          status: 503,
        }),
    );
    const result = await analyzeRun(run.cwd, "gemini-flow", { config }, { fetch });
    expect(result.error?.code).toBe("analysis_provider_http_error");
    expect(result.warnings).toEqual([expect.stringMatching(/^The Gemini API answered HTTP 503/)]);
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
  });
});

describe("automatic and CLI analysis on Gemini", () => {
  const run = useRun();
  const transport = () => geminiTransport(run.input);
  it("runs a study's automatic analysis on Gemini", async () => {
    vi.stubEnv("GEMINI_API_KEY", "synthetic-gemini-key");
    const fetch = await transport();
    const outcome = await runAutomaticAnalysis(run.cwd, "gemini-flow", config, { fetch });
    expect(outcome).toMatchObject({ result: { ok: true } });
    expect(fetch.mock.calls[0]?.[0]).toMatch(/models\/gemini-3\.8-flash:generateContent$/);
    expect((await showAnalysis(run.cwd, "gemini-flow")).analysis?.provider).toBe("gemini");
  });

  it("records a skip that names the Gemini key when the study's analysis has none", async () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-key");
    const fetch = await transport();
    const outcome = await runAutomaticAnalysis(run.cwd, "gemini-flow", config, { fetch });
    expect(outcome).toMatchObject({
      state: "skipped",
      reason: "AUTOMATIC_ANALYSIS_GEMINI_KEY_MISSING",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("analyze --provider gemini admits a dry run and names the Gemini key when one is missing", async () => {
    vi.stubEnv("HUMANISH_STRICT_KEYS", "1");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-key");
    const cli = async (...flags: string[]) => {
      const output: string[] = [];
      let exit: number | undefined;
      const program = createProgram({
        writeOut: (text) => output.push(text),
        writeErr: () => {},
        setExitCode: (code) => {
          exit = code;
        },
      });
      await program.parseAsync(
        ["analyze", "--cwd", run.cwd, "--run", "gemini-flow", "--provider", "gemini", ...flags],
        { from: "user" },
      );
      return { exit, result: JSON.parse(output.join("")) };
    };
    expect(await cli("--max-cost", "2", "--dry-run", "--json")).toMatchObject({
      exit: 0,
      result: { ok: true, admission: { allowed: true, ratesAsOf: "2026-10-21" } },
    });
    expect(await cli("--max-cost", "2", "--json")).toMatchObject({
      exit: 2,
      result: {
        ok: false,
        error: {
          code: "ANALYSIS_API_KEY_MISSING",
          message:
            "Gemini analysis needs GEMINI_API_KEY or GOOGLE_API_KEY: run `humanish keys set gemini`. --dry-run checks admission without a key or provider request.",
        },
      },
    });
    expect(
      await cli("--model", "gemini-3.5-flash-lite", "--max-cost", "2", "--json"),
    ).toMatchObject({
      exit: 2,
      result: { error: { code: "ANALYSIS_CONFIG_INVALID" } },
    });
  });

  it("prices a dry run at Gemini's rates and its fixed image tokens", async () => {
    const result = await analyzeRun(run.cwd, "gemini-flow", { config, dryRun: true }, {});
    expect(result).toMatchObject({
      ok: true,
      admission: { allowed: true, ratesAsOf: "2026-10-21", maxCostUsd: 5 },
    });
    const openai = await analyzeRun(
      run.cwd,
      "gemini-flow",
      { config: { ...config, provider: "openai", model: "gpt-6-astra" }, dryRun: true },
      {},
    );
    // The same packet costs less on Gemini Flash than on gpt-6-astra.
    expect(result.admission!.estimatedCostUsd!).toBeLessThan(
      openai.admission!.estimatedCostUsd! / 5,
    );
  });
});

describe("a study's Gemini analysis setting", () => {
  it("defaults the model and keeps the provider in the configuration", () => {
    expect(resolveAutomaticAnalysis({ provider: "gemini", maxCostUsd: 2 })).toMatchObject({
      ok: true,
      config: { provider: "gemini", model: "gemini-3.8-flash", maxCostUsd: 2 },
    });
  });

  it.each([
    [{ provider: "gemini", model: "gpt-6-astra", maxCostUsd: 2 }],
    [{ model: "gemini-3.8-flash", maxCostUsd: 2 }],
    [{ provider: "openai", model: "gemini-3.8-flash", maxCostUsd: 2 }],
    [{ provider: "gemini", model: "gemini-3.8-flash" }],
    [{ provider: "gemini", model: "gemini-3.5-flash-lite", maxCostUsd: 2 }],
  ])("refuses a model of the other provider or a missing cap: %j", (raw) => {
    expect(resolveAutomaticAnalysis(raw).ok).toBe(false);
  });

  it("leaves an OpenAI configuration and its hash as they were before Gemini", () => {
    // Hashes of these resolved configurations on main before Gemini analysis existed.
    const omitted = resolveAutomaticAnalysis({ maxCostUsd: 10, model: "gpt-6-astra" });
    const named = resolveAutomaticAnalysis({
      provider: "openai",
      maxCostUsd: 10,
      model: "gpt-6-astra",
    });
    expect(omitted.ok && hashAnalysisValue(omitted.config)).toBe(
      "d4a11fc68c8d476c7187dcaa5fb65626bf3a25502aac154ff545a688e33c282d",
    );
    expect(named.ok && hashAnalysisValue(named.config)).toBe(
      "77a70e555b194fb2c9408606366a98c3fb325467a99d8330804c041698cd30e6",
    );
  });
});
