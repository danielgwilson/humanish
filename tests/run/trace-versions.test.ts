// One live run on fake desktops ($0), kept twice: as this release writes it (run.json v2 with each
// trace in its file) and as 0.122.0 wrote it (run.json v1 with every trace inline). verify,
// analysis evidence capture and bundle export read both through the trace loader and must agree.

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../src/actors/computer-use/actor.js";
import { captureEvidence } from "../../src/analysis/evidence.js";
import { exportRun } from "../../src/feedback/export.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { runStudyWith } from "../../src/run-study.js";
import { parseStudy } from "../../src/study/config.js";
import { verifyRun, type VerifyResult } from "../../src/verify/verify.js";
import { lab } from "../admission/fixtures.js";
import { makeFanoutModule, scriptedFetch, TWO_TURN_SESSION } from "../helpers/fanout-desktop.js";
import { readRunWithTraces } from "../helpers/run-traces.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };

/** The parts of a verify result that do not name the project folder or the declared schema. */
function graded(result: VerifyResult) {
  return {
    ok: result.ok,
    checks: result.checks.map((check) =>
      check.name === "run schema" ? { name: check.name, ok: check.ok } : check,
    ),
    shareSafety: result.shareSafety,
    warnings: result.warnings,
  };
}

describe("a run kept as run.json v1 and as v2", () => {
  let v2Project: string;
  let v1Project: string;
  let runId: string;

  beforeAll(async () => {
    v2Project = await mkdtemp(path.join(tmpdir(), "humanish-trace-v2-"));
    v1Project = await mkdtemp(path.join(tmpdir(), "humanish-trace-v1-"));
    const parsed = parseStudy(
      lab("cuAppUrl", { mode: "live", participants: [{ id: "first" }, { id: "second" }] }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      parsed.config,
      { cwd: v2Project, env: KEYS },
      {
        desktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          }),
        analysis: { run: vi.fn() },
      },
    );
    if (outcome.route !== "computer-use" || !outcome.result.ok) throw new Error("run failed");
    runId = outcome.result.runId!;
    const v2Dir = path.join(v2Project, ".humanish", "runs", runId);
    const v1Dir = path.join(v1Project, ".humanish", "runs", runId);
    await cp(path.join(v2Project, ".humanish"), path.join(v1Project, ".humanish"), {
      recursive: true,
    });
    // run.json as 0.122.0 wrote it: every stream's items and screenshot entries inline, no index.
    const loaded = await readRunWithTraces(v2Dir);
    const v1: RunBundle = { ...loaded, schema: "humanish.run-bundle.v1" };
    await writeFile(path.join(v1Dir, "run.json"), `${JSON.stringify(v1, null, 2)}\n`);
  });
  afterAll(async () => {
    await rm(v2Project, { recursive: true, force: true });
    await rm(v1Project, { recursive: true, force: true });
  });

  it("is graded the same by verify", async () => {
    const v2 = await verifyRun(v2Project, runId);
    expect(v2.ok).toBe(true);
    expect(graded(await verifyRun(v1Project, runId))).toEqual(graded(v2));
  });

  it("gives analysis the same evidence", async () => {
    const capture = async (project: string) => {
      const prepared = (await resolveRunPath(project, runId))!;
      const bytes = await readFile(path.join(prepared.physicalRunRoot, "run.json"));
      const {
        sourceRunSha256: _source,
        inputDigest: _digest,
        ...input
      } = await captureEvidence(prepared, bytes);
      return input;
    };
    const v2 = await capture(v2Project);
    expect(v2.evidence.length).toBeGreaterThan(0);
    expect(v2.images.length).toBeGreaterThan(0);
    expect(await capture(v1Project)).toEqual(v2);
  });

  it("exports the same derivative, written as v2", async () => {
    const exported = async (project: string) => {
      const result = await exportRun(project, runId, {
        format: "bundle",
        redactScreenshots: true,
        out: "shared",
      });
      if (!result.ok) throw new Error(result.error.message);
      const shared = path.join(project, "shared");
      const derivative = (await resolveRunPath(shared, runId))!;
      const stored = JSON.parse(
        await readFile(path.join(derivative.physicalRunRoot, "run.json"), "utf8"),
      ) as RunBundle;
      return {
        schema: stored.schema,
        indexed: stored.streams.map((stream) => ({
          index: stream.trace?.path,
          inline: stream.actor !== undefined && "items" in stream.actor,
        })),
        streams: (await readRunWithTraces(derivative.physicalRunRoot)).streams,
        shareSafety: (await verifyRun(shared, runId)).shareSafety,
        embeddedImages: (result as { embeddedImages?: number }).embeddedImages,
      };
    };
    const v2 = await exported(v2Project);
    expect(v2.schema).toBe("humanish.run-bundle.v2");
    expect(v2.indexed).toEqual(
      v2.streams.map((stream) => ({ index: `actors/${stream.id}.json`, inline: false })),
    );
    expect(v2.shareSafety.status).toBe("share_ready");
    expect(
      v2.streams[0]!.artifacts.find((artifact) => artifact.kind === "screenshot")?.label,
    ).toMatch(/blurred at export/);
    expect(await exported(v1Project)).toEqual(v2);
  });
});
