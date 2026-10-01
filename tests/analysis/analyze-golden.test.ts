// Characterization golden for analyzeStudy and runStudyAnalysis. Each scenario runs the real
// service against a fixture run with a fake provider boundary and records what a caller and the
// run directory see: the result, each provider request, the progress events and the files the
// attempt wrote. The golden was generated before those two functions were split into steps.
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAutomaticAnalysis } from "../../src/analysis/automatic-config.js";
import { codexAnalysisIdentity } from "../../src/analysis/codex-config.js";
import {
  runStudyAnalysis,
  type StudyAnalysisProgress,
} from "../../src/analysis/run-study-analysis.js";
import { captureStudyEvidence } from "../../src/analysis/evidence.js";
import type {
  AnalysisFetch,
  StudyAnalysisProvider,
  StudyAnalysisProviderRequest,
} from "../../src/analysis/provider.js";
import { analyzeStudy, type AnalyzeDeps, type AnalyzeOptions } from "../../src/analysis/service.js";
import type { StudyAnalysisConfig, StudyAnalysisInput } from "../../src/analysis/study-analysis.js";
import { digestStudyAnalysisInput } from "../../src/analysis/validation.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { syntheticInput, syntheticResult } from "./fixtures.js";

const RUN = "analysis-golden";
const openai = {
  model: "gpt-5.6-sol",
  question: null,
  maxCostUsd: 5,
  timeoutMs: 1000,
  maxOutputTokens: 8192,
} satisfies StudyAnalysisConfig;
// Real captured wire envelope; only the synthetic analysis answer is replaced.
// Provenance: fixtures/openai-closing-report/README.md.
const wirePath = new URL(
  "../fixtures/openai-closing-report/typed-closing-report.json",
  import.meta.url,
);

function codex(): StudyAnalysisConfig {
  const selected = resolveAutomaticAnalysis({ provider: "codex", timeoutMs: 1000 });
  if (!selected.ok || selected.config?.provider !== "codex")
    throw new Error("Synthetic configuration failed");
  // A fixed release, so the golden does not follow the host's default Codex CLI.
  return {
    ...selected.config,
    identity: codexAnalysisIdentity(selected.config.model, "0.157.1"),
  };
}

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A finished live run with one completed stream, as the service test builds it. */
async function finishedRun(live = true): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-analyze-golden-"));
  roots.push(cwd);
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  await runDryRun({ cwd, dryRun: true, runId: RUN });
  if (!live) return cwd;
  const runRoot = path.join(cwd, ".humanish", "runs", RUN);
  const bundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as RunBundle;
  bundle.mode = "live";
  bundle.streams[0]!.status = "complete";
  await writeFile(path.join(runRoot, "run.json"), JSON.stringify(bundle, null, 2) + "\n");
  await rm(path.join(runRoot, "status.json"), { force: true });
  return cwd;
}

/** The evidence the service will capture, so a fake answer can cite it. */
async function capturedInput(cwd: string): Promise<StudyAnalysisInput> {
  const prepared = await resolveRunPath(cwd, RUN);
  const bytes = await readFile(path.join(cwd, ".humanish", "runs", RUN, "run.json"));
  return captureStudyEvidence(prepared!, bytes);
}

/**
 * Replace what differs between two runs of the same scenario: the temp project path, timestamps,
 * UUIDs, and the source digests, which cover run.json bytes that carry both.
 */
function normalizer(cwd: string, source?: StudyAnalysisInput): (value: unknown) => unknown {
  const literals: Array<[string, string]> = [[cwd, "[cwd]"]];
  if (source) {
    literals.push(
      [source.sourceRunSha256, "[source-sha256]"],
      [source.inputDigest, "[input-digest]"],
    );
  }
  return (value) => {
    let text = JSON.stringify(value ?? null);
    for (const [from, to] of literals) text = text.split(from).join(to);
    return JSON.parse(
      text
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "[ts]")
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "[uuid]"),
    );
  };
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** A request body is pinned by the digest of its normalized JSON. */
const hashBodies = (requests: unknown[]): unknown[] =>
  requests.map((request) => {
    const { body, ...rest } = request as { body?: unknown };
    return body === undefined ? rest : { ...rest, bodySha256: digest(JSON.stringify(body)) };
  });

/** The files an attempt wrote under the run's analysis directories. */
async function analysisFiles(cwd: string): Promise<Record<string, unknown>> {
  const runRoot = path.join(cwd, ".humanish", "runs", RUN);
  const files: Record<string, unknown> = {};
  for (const directory of ["analysis", "analysis-attempts"]) {
    const entries = await readdir(path.join(runRoot, directory), {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries.filter((e) => e.isFile())) {
      const file = path.relative(runRoot, path.join(entry.parentPath, entry.name));
      const text = await readFile(path.join(runRoot, file), "utf8");
      files[file] = file.endsWith(".json") ? JSON.parse(text) : `sha256:${digest(text)}`;
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

async function wireFetch(
  input: StudyAnalysisInput,
  requests: unknown[] = [],
  answer: unknown = syntheticResult(input),
  edit: (wire: { usage: Record<string, unknown> }) => void = () => {},
): Promise<AnalysisFetch> {
  const wire = JSON.parse(await readFile(wirePath, "utf8")) as {
    output: Array<{ content: Array<{ text: string }> }>;
    usage: Record<string, unknown>;
  };
  wire.output[0]!.content[0]!.text = JSON.stringify(answer);
  edit(wire);
  return vi.fn<AnalysisFetch>(async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({
      url: String(url),
      model: body.model,
      maxOutputTokens: body.max_output_tokens,
      body,
    });
    return new Response(JSON.stringify(wire));
  });
}

interface Recorded {
  result?: unknown;
  thrown?: string;
  requests: unknown[];
  progress: StudyAnalysisProgress[];
  files?: Record<string, unknown>;
}

async function analyze(
  cwd: string,
  options: AnalyzeOptions,
  deps: AnalyzeDeps & { requests?: unknown[] } = {},
): Promise<Recorded> {
  const progress: StudyAnalysisProgress[] = [];
  const { requests = [], ...rest } = deps;
  const source = await capturedInput(cwd).catch(() => undefined);
  const result = await analyzeStudy(cwd, RUN, options, {
    analysisId: "analysis-golden-1",
    onProgress: (event) => progress.push(event),
    ...rest,
  });
  const normalize = normalizer(cwd, source);
  return {
    result: normalize(result),
    requests: hashBodies(normalize(requests) as unknown[]),
    progress: normalize(progress) as StudyAnalysisProgress[],
    files: normalize(await analysisFiles(cwd)) as Record<string, unknown>,
  };
}

function codexProvider(
  input: StudyAnalysisInput,
  requests: unknown[],
  response: Partial<Awaited<ReturnType<StudyAnalysisProvider>>> = {},
): StudyAnalysisProvider {
  return vi.fn<StudyAnalysisProvider>(async (request: StudyAnalysisProviderRequest) => {
    requests.push({
      model: request.model,
      maxOutputTokens: request.maxOutputTokens,
      images: request.images.length,
      body: { instructions: request.instructions, evidence: request.evidence },
    });
    return {
      status: "completed",
      output: syntheticResult(input),
      usage: { input: 400, output: 80, cachedInput: 20 },
      usageComplete: true,
      dispatched: true,
      errorCode: null,
      ...response,
    };
  });
}

/** Refusals and admission-only paths, then a completed attempt, its reuse and a rerun. */
async function admissionAndReuseScenarios(scenarios: Record<string, Recorded>): Promise<void> {
  const unsafe = "Review " + "sk-" + "syntheticvalue1234567890abcdef";
  // Refusals and admission-only paths share one run: none of them writes an attempt.
  let cwd = await finishedRun();
  scenarios["config invalid"] = await analyze(cwd, { config: { ...openai, maxCostUsd: 0 } });
  scenarios["question unsafe"] = await analyze(cwd, { config: { ...openai, question: unsafe } });
  scenarios["run not found"] = {
    result: normalizer(cwd)(await analyzeStudy(cwd, "no-such-run", { config: openai })),
    requests: [],
    progress: [],
  };
  scenarios["admission over budget"] = await analyze(cwd, {
    config: { ...openai, maxCostUsd: 0.000001 },
  });
  scenarios["dry run (openai)"] = await analyze(cwd, { config: openai, dryRun: true });
  // The preference applies only to the default output limit.
  scenarios["dry run with a preferred larger output"] = await analyze(cwd, {
    config: { ...openai, maxOutputTokens: 16_384 },
    dryRun: true,
    preferLargerOutput: true,
  });
  scenarios["dry run (codex)"] = await analyze(cwd, { config: codex(), dryRun: true });
  scenarios["api key missing"] = await analyze(cwd, { config: openai });
  const aborted = new AbortController();
  aborted.abort();
  scenarios["aborted before start"] = await analyze(
    cwd,
    { config: openai },
    { apiKey: "sk-test", signal: aborted.signal },
  );

  // A completed attempt, its reuse, and a forced rerun, in one run directory.
  let input = await capturedInput(cwd);
  const requests: unknown[] = [];
  scenarios["completed (openai)"] = await analyze(
    cwd,
    { config: openai },
    { apiKey: "sk-test", fetch: await wireFetch(input, requests), requests },
  );
  const reuseRequests: unknown[] = [];
  scenarios["reused"] = await analyze(
    cwd,
    { config: openai },
    {
      apiKey: "sk-test",
      fetch: await wireFetch(input, reuseRequests),
      analysisId: "analysis-golden-2",
      requests: reuseRequests,
    },
  );
  const rerunRequests: unknown[] = [];
  scenarios["rerun"] = await analyze(
    cwd,
    { config: openai, rerun: true },
    {
      apiKey: "sk-test",
      fetch: await wireFetch(input, rerunRequests),
      analysisId: "analysis-golden-3",
      requests: rerunRequests,
    },
  );
}

/** Provider failures and the dispatch guard, each on a fresh run. */
async function providerFailureScenarios(scenarios: Record<string, Recorded>): Promise<void> {
  let cwd: string;
  let input: StudyAnalysisInput;
  cwd = await finishedRun();
  scenarios["provider HTTP 503"] = await analyze(
    cwd,
    { config: openai },
    {
      apiKey: "sk-test",
      fetch: vi.fn<AnalysisFetch>(async () => new Response("", { status: 503 })),
    },
  );
  cwd = await finishedRun();
  input = await capturedInput(cwd);
  scenarios["provider output fails validation"] = await analyze(
    cwd,
    { config: openai },
    { apiKey: "sk-test", fetch: await wireFetch(input, [], { invalid: true }) },
  );
  cwd = await finishedRun();
  input = await capturedInput(cwd);
  scenarios["output over the admitted limit"] = await analyze(
    cwd,
    { config: { ...openai, maxOutputTokens: 1024 } },
    {
      apiKey: "sk-test",
      fetch: await wireFetch(input, [], syntheticResult(input), (wire) => {
        wire.usage.output_tokens = 4096;
      }),
    },
  );
  cwd = await finishedRun();
  input = await capturedInput(cwd);
  scenarios["dispatch guard throws"] = await analyze(
    cwd,
    { config: openai },
    {
      apiKey: "sk-test",
      fetch: await wireFetch(input),
      beforeDispatch: async () => {
        throw new Error("Synthetic durable claim failure");
      },
    },
  );
  cwd = await finishedRun();
  input = await capturedInput(cwd);
  const cancelDuringGuard = new AbortController();
  scenarios["cancelled during the dispatch guard"] = await analyze(
    cwd,
    { config: openai },
    {
      apiKey: "sk-test",
      fetch: await wireFetch(input),
      signal: cancelDuringGuard.signal,
      beforeDispatch: async () => cancelDuringGuard.abort(),
    },
  );
}

/** Storage obstacles during the request, the Codex provider, and a dry-run bundle. */
async function storageAndCodexScenarios(scenarios: Record<string, Recorded>): Promise<void> {
  let cwd: string;
  let input: StudyAnalysisInput;
  // Storage obstacles placed while the request is in flight, after the pre-dispatch checks.
  const obstacles: ReadonlyArray<readonly [string, (runRoot: string) => Promise<void>]> = [
    [
      "report publication fails",
      (runRoot) => writeFile(path.join(runRoot, "analysis"), "obstacle\n"),
    ],
    [
      "receipt publication fails",
      async (runRoot) => {
        const attempt = path.join(runRoot, "analysis-attempts", "analysis-golden-1");
        await rm(attempt, { recursive: true, force: true });
        await writeFile(attempt, "obstacle\n");
      },
    ],
    [
      "Observer refresh fails",
      async (runRoot) => {
        await rm(path.join(runRoot, "observer"), { recursive: true, force: true });
        await writeFile(path.join(runRoot, "observer"), "obstacle\n");
      },
    ],
  ];
  for (const [name, obstruct] of obstacles) {
    cwd = await finishedRun();
    input = await capturedInput(cwd);
    const runRoot = path.join(cwd, ".humanish", "runs", RUN);
    const inner = await wireFetch(input);
    scenarios[name] = await analyze(
      cwd,
      { config: openai },
      {
        apiKey: "sk-test",
        fetch: async (url, init) => {
          await obstruct(runRoot);
          return inner(url, init);
        },
      },
    );
  }

  cwd = await finishedRun();
  input = await capturedInput(cwd);
  const codexRequests: unknown[] = [];
  scenarios["completed (codex)"] = await analyze(
    cwd,
    { config: codex() },
    {
      codexProvider: codexProvider(input, codexRequests),
      codexCliVersionBound: true,
      requests: codexRequests,
    },
  );
  cwd = await finishedRun();
  input = await capturedInput(cwd);
  scenarios["codex provider fails"] = await analyze(
    cwd,
    { config: codex() },
    {
      codexProvider: codexProvider(input, [], {
        status: "failed",
        output: null,
        usage: null,
        usageComplete: false,
        errorCode: "codex_process_failed",
      }),
      codexCliVersionBound: true,
    },
  );
  cwd = await finishedRun(false);
  scenarios["dry-run bundle"] = await analyze(cwd, { config: openai });
}

describe("analyzeStudy characterization golden", () => {
  // Every scenario runs analyzeStudy end to end in one test, so its time scales with machine load.
  // Measured from 4 s to 20 s on a 16-core machine as load rose; 20 s is the default test timeout.
  // 60 s keeps the golden from failing on a busy machine without hiding a hang.
  it(
    "pins the result, provider requests, progress and files for each scenario",
    { timeout: 60_000 },
    async () => {
      const scenarios: Record<string, Recorded> = {};
      vi.stubEnv("OPENAI_API_KEY", "");
      await admissionAndReuseScenarios(scenarios);
      await providerFailureScenarios(scenarios);
      await storageAndCodexScenarios(scenarios);

      await expect(`${JSON.stringify(scenarios, null, 2)}\n`).toMatchFileSnapshot(
        "../golden/analysis/analyze-study.json",
      );
    },
  );
});

describe("runStudyAnalysis characterization golden", () => {
  it("pins the artifact or the thrown code for direct callers", async () => {
    const scenarios: Record<string, Recorded> = {};
    // The Codex tests' packet: evidence without captures, digest recomputed.
    const input = syntheticInput();
    input.evidence = input.evidence.filter((e) => e.capture === null);
    input.coverage.captureCount = 0;
    input.coverage.evidenceCount = input.evidence.length;
    input.inputDigest = digestStudyAnalysisInput(input);
    const direct = async (
      name: string,
      config: StudyAnalysisConfig,
      options: Parameters<typeof runStudyAnalysis>[2],
      requests: unknown[] = [],
    ) => {
      const progress: StudyAnalysisProgress[] = [];
      try {
        const artifact = await runStudyAnalysis(input, config, {
          ...options,
          onProgress: (event) => progress.push(event),
        });
        scenarios[name] = {
          result: normalizer("\0")(artifact),
          requests: hashBodies(requests),
          progress,
        };
      } catch (error) {
        scenarios[name] = { thrown: (error as Error).message, requests, progress };
      }
    };
    const unsafe = "Review " + "sk-" + "syntheticvalue1234567890abcdef";
    await direct("invalid analysis id", openai, { apiKey: "sk-test", analysisId: "../escape" });
    await direct("sensitive question", { ...openai, question: unsafe }, { apiKey: "sk-test" });
    await direct("api key missing", openai, { analysisId: "analysis-golden-1" });
    const openaiRequests: unknown[] = [];
    await direct(
      "openai completes with priced usage",
      openai,
      {
        apiKey: "sk-test",
        analysisId: "analysis-golden-1",
        fetch: await wireFetch(input, openaiRequests),
      },
      openaiRequests,
    );
    const aborted = new AbortController();
    aborted.abort();
    await direct("aborted before dispatch", openai, {
      apiKey: "sk-test",
      analysisId: "analysis-golden-1",
      signal: aborted.signal,
    });
    const requests: unknown[] = [];
    await direct(
      "codex completes with cached usage",
      codex(),
      { analysisId: "analysis-golden-1", codexProvider: codexProvider(input, requests) },
      requests,
    );
    await direct("codex returns no usage", codex(), {
      analysisId: "analysis-golden-1",
      codexProvider: codexProvider(input, [], { usage: null, usageComplete: false }),
    });
    await direct("codex is cancelled", codex(), {
      analysisId: "analysis-golden-1",
      codexProvider: codexProvider(input, [], {
        status: "cancelled",
        output: null,
        errorCode: "cancelled",
      }),
    });

    await expect(`${JSON.stringify(scenarios, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/analysis/run-study-analysis.json",
    );
  });
});
