import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { get } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readAutomaticAnalysis, runAutomaticAnalysis } from "../../src/analysis/automatic.js";
import {
  keepRejectedAnalysisOutput,
  MAX_ANALYSIS_DIAGNOSTICS,
} from "../../src/analysis/diagnostics.js";
import { captureEvidence } from "../../src/analysis/evidence.js";
import type { AnalysisFetch } from "../../src/analysis/provider.js";
import { analyzeRun } from "../../src/analysis/service.js";
import type { AnalysisConfig, AnalysisInput } from "../../src/analysis/types.js";
import { createProgram } from "../../src/cli/program.js";
import { writeResult } from "../../src/cli/io.js";
import { exportRun } from "../../src/feedback/export.js";
import { exportRedactedBundle } from "../../src/feedback/export-bundle.js";
import { renderObserver, serveObserver } from "../../src/observer/render.js";
import { serveObserverLibrary } from "../../src/observer/serve.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import {
  registerTransientCommsSecrets,
  withTransientCommsSecrets,
} from "../../src/run/transient-comms-secrets.js";
import { verifyRun } from "../../src/verify/verify.js";
import { syntheticResult } from "./fixtures.js";

const config: AnalysisConfig = {
  model: "gpt-5.6-sol",
  question: null,
  maxCostUsd: 5,
  timeoutMs: 1000,
  maxOutputTokens: 8192,
};
// Real captured wire envelope; only the synthetic analysis answer is replaced.
// Provenance: fixtures/openai-closing-report/README.md.
const wirePath = new URL(
  "../fixtures/openai-closing-report/typed-closing-report.json",
  import.meta.url,
);
const RUN = "analysis-flow";
const canary = "diagnostic-canary-7f3a";
const marker = "sk-" + "syntheticvalue1234567890abcdef";

/** Every file under root whose bytes or path mention the canary or the diagnostics directory. */
async function leaks(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (file.includes("analysis-diagnostics")) found.push(file);
    if (entry.isFile() && (await readFile(file, "utf8")).includes(canary)) found.push(file);
  }
  return found;
}

/** GET a raw request path, so dot segments reach the server unnormalized. */
function rawGet(base: string, rawPath: string): Promise<string> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    get({ host: url.hostname, port: url.port, path: rawPath }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve(`${response.statusCode} ${body}`));
    }).on("error", reject);
  });
}

function traversals(base: string, target: string): string[] {
  const directory = new URL(".", base).pathname;
  return [1, 2, 3, 4, 5].flatMap((depth) => [
    `${directory}${"../".repeat(depth)}${target}`,
    `${directory}${"%2e%2e/".repeat(depth)}${target}`,
    `${directory}${"..%2f".repeat(depth)}${target}`,
  ]);
}

describe("rejected analysis output", () => {
  let cwd: string;
  let input: AnalysisInput;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-rejected-output-"));
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runDryRun({ cwd, dryRun: true, runId: RUN });
    const runRoot = path.join(cwd, ".humanish/runs", RUN);
    const bundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as RunBundle;
    // This is an explicitly synthetic completed legacy stream, not a live-provider claim.
    bundle.mode = "live";
    bundle.streams[0]!.status = "complete";
    await writeFile(path.join(runRoot, "run.json"), JSON.stringify(bundle, null, 2) + "\n");
    await rm(path.join(runRoot, "status.json"), { force: true });
    const original = await readFile(path.join(runRoot, "run.json"));
    input = await captureEvidence((await resolveRunPath(cwd, RUN))!, original);
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  /** A response whose one feedback quote is not in the evidence. */
  async function badQuoteTransport() {
    const result = syntheticResult(input);
    const participant = result.participants[0]!;
    participant.feedback = [
      { evidenceId: participant.evidenceIds[0]!, text: `Quoted ${canary} with ${marker}` },
    ];
    const wire = JSON.parse(await readFile(wirePath, "utf8"));
    wire.output[0].content[0].text = JSON.stringify(result);
    return vi.fn<AnalysisFetch>(async () => new Response(JSON.stringify(wire)));
  }

  it("keeps a rejected response scrubbed, outside the run directory, and names it", async () => {
    const fetch = await badQuoteTransport();
    const result = await analyzeRun(cwd, RUN, { config }, { apiKey: "synthetic-key", fetch });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "analysis_validation_failed_quote_invalid" },
      rejectedOutputPath: `.humanish/analysis-diagnostics/${RUN}/${result.analysisId}.json`,
    });
    const kept = JSON.parse(await readFile(path.join(cwd, result.rejectedOutputPath!), "utf8"));
    expect(kept).toMatchObject({
      schema: "humanish.analysis-rejected-output.v1",
      runId: RUN,
      analysisId: result.analysisId,
      error: "analysis_validation_failed_quote_invalid",
      errors: ["ANALYSIS_QUOTE_INVALID"],
    });
    expect(kept.output.participants[0].feedback[0].text).toBe(
      `Quoted ${canary} with [REDACTED_SECRET]`,
    );
    expect(await leaks(path.join(cwd, ".humanish/runs"))).toEqual([]);
  });

  it("names the kept output on an automatic analysis without putting it in the job", async () => {
    const fetch = await badQuoteTransport();
    const outcome = await runAutomaticAnalysis(cwd, RUN, config, {
      apiKey: "synthetic-key",
      fetch,
    });
    expect(outcome).toMatchObject({ state: "failed" });
    const kept = outcome.result?.rejectedOutputPath;
    expect(kept).toMatch(/^\.humanish\/analysis-diagnostics\//);
    expect(await readAutomaticAnalysis(cwd, RUN)).toMatchObject({ state: "failed" });
    const out: string[] = [];
    const io = {
      writeOut: (text: string) => out.push(text),
      writeErr: () => {},
      setExitCode: () => {},
    };
    const command = createProgram(io).command("probe-rejected-output");
    writeResult(command, io, { runId: RUN, ok: true, automaticAnalysis: outcome }, () => "");
    expect(out.join("")).toContain(kept!);
    expect(await leaks(path.join(cwd, ".humanish/runs"))).toEqual([]);
  });

  it("is never read by verify, export or the Observer", async () => {
    const fetch = await badQuoteTransport();
    const result = await analyzeRun(cwd, RUN, { config }, { apiKey: "synthetic-key", fetch });
    const target = result.rejectedOutputPath!.replace(/^\.humanish\//, "");

    const verified = await verifyRun(cwd, RUN);
    expect(verified.ok).toBe(true);
    expect(JSON.stringify(verified)).not.toContain(canary);
    expect(JSON.stringify(verified)).not.toContain("analysis-diagnostics");

    const html = await exportRun(cwd, RUN);
    expect(html.ok).toBe(true);
    const bundle = await exportRedactedBundle(cwd, RUN, {
      format: "bundle",
      redactScreenshots: true,
      out: "shared",
    });
    expect(bundle.ok).toBe(true);
    expect(await leaks(path.join(cwd, ".humanish/exports"))).toEqual([]);
    expect(await leaks(path.join(cwd, "shared"))).toEqual([]);

    const rendered = await renderObserver(cwd, RUN);
    const single = await serveObserver(rendered, { open: false, port: 0 });
    const library = await serveObserverLibrary(cwd, {
      port: 0,
      safe: false,
      expose: false,
      edgeAuthed: false,
    });
    if (!library.ok) throw new Error(library.error.message);
    try {
      for (const base of [single.url, library.server.url]) {
        for (const request of [new URL(base).pathname, ...traversals(base, target)]) {
          expect(await rawGet(base, request)).not.toContain(canary);
        }
      }
    } finally {
      await single.close();
      await library.server.close();
    }
    expect(await leaks(path.join(cwd, ".humanish/runs"))).toEqual([]);
  });
});

describe("rejected analysis records", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-rejected-records-"));
    await mkdir(path.join(cwd, ".humanish/runs", RUN), { recursive: true });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("keeps only the newest rejected outputs across runs", async () => {
    const rejected = { error: "analysis_validation_failed_quote_invalid", errors: [], output: {} };
    const kept: string[] = [];
    for (let index = 0; index < MAX_ANALYSIS_DIAGNOSTICS + 2; index += 1) {
      const runId = index < 2 ? "older-run" : RUN;
      const relative = await keepRejectedAnalysisOutput(
        cwd,
        { runId, analysisId: `analysis-${index}`, model: config.model, promptVersion: "p" },
        rejected,
      );
      const when = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
      await utimes(path.join(cwd, relative), when, when);
      kept.push(relative);
    }
    // The last write pruned with the two oldest files dated first, so one more write settles it.
    await keepRejectedAnalysisOutput(
      cwd,
      { runId: RUN, analysisId: "analysis-last", model: config.model, promptVersion: "p" },
      rejected,
    );
    const root = path.join(cwd, ".humanish/analysis-diagnostics");
    expect(await readdir(root)).toEqual([RUN]);
    const files = await readdir(path.join(root, RUN));
    expect(files).toHaveLength(MAX_ANALYSIS_DIAGNOSTICS);
    expect(files).toContain("analysis-last.json");
    expect(files).not.toContain("analysis-2.json");
    await expect(stat(path.join(cwd, kept[0]!))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("scrubs a known value in encoded forms, keys and scalars, and keeps other spellings", async () => {
    const secret = "654321";
    const output = {
      // Percent-encoded and base64 forms of the value, then the value as a number.
      "%36%35%34%33%32%31": "NjU0MzIx",
      plain: `code ${secret}`,
      numeric: 654321,
      flag: true,
      quote: "Printed a\\nb and a%20b",
    };
    const relative = await withTransientCommsSecrets(async () => {
      registerTransientCommsSecrets([secret]);
      return keepRejectedAnalysisOutput(
        cwd,
        { runId: RUN, analysisId: "analysis-encoded", model: config.model, promptVersion: "p" },
        { error: "analysis_validation_failed_schema_invalid", errors: [], output },
      );
    });
    const kept = JSON.parse(await readFile(path.join(cwd, relative), "utf8"));
    expect(kept.output).toEqual({
      "[REDACTED_SECRET]": "[REDACTED_SECRET]",
      plain: "code [REDACTED_SECRET]",
      numeric: "[REDACTED_SECRET]",
      flag: true,
      quote: "Printed a\\nb and a%20b",
    });
  });

  it("refuses to prune through a run directory swapped for a symlink after listing", async () => {
    const victim = path.join(cwd, ".humanish/runs", RUN, "analysis-0.json");
    await writeFile(victim, "victim\n");
    const diagnostics = path.join(cwd, ".humanish/analysis-diagnostics");
    const rejected = { error: "analysis_validation_failed_quote_invalid", errors: [], output: {} };
    const keep = (analysisId: string, hooks = {}) =>
      keepRejectedAnalysisOutput(
        cwd,
        { runId: "old", analysisId, model: config.model, promptVersion: "p" },
        rejected,
        hooks,
      );
    for (let index = 0; index < MAX_ANALYSIS_DIAGNOSTICS; index += 1) {
      const relative = await keep(`analysis-${index}`);
      const when = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
      await utimes(path.join(cwd, relative), when, when);
    }
    // The next write lists 21 records, oldest analysis-0.json, then the directory is swapped.
    await keep("analysis-new", {
      beforeRemove: async () => {
        await rename(path.join(diagnostics, "old"), path.join(diagnostics, "old-moved"));
        await symlink(path.join(cwd, ".humanish/runs", RUN), path.join(diagnostics, "old"), "dir");
      },
    });
    expect(await readFile(victim, "utf8")).toBe("victim\n");
    expect(await readdir(path.join(diagnostics, "old-moved"))).toContain("analysis-0.json");
  });
});
