// One live run on fake desktops ($0), kept four times: as this release writes it (run.json v4,
// with each trace and its per-request lists in its file), as 0.125.0 and 0.126.0 wrote it (run.json
// v3, whose summaries also hold the lists), as 0.123.0 and 0.124.0 wrote it (the same files with
// run.json v2, since a finished v3 bundle differs from v2 only in its schema name) and as 0.122.0
// wrote it (run.json v1 with every trace inline). verify, analysis evidence capture and bundle
// export read all four through the trace loader and must agree. One participant's prompt stays
// flat for seven turns, so verify's flat-context warning reads its usage rows in every version.

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../src/actors/computer-use/actor.js";
import type { ActorExecutionProfile } from "../../src/actors/contract.js";
import { captureEvidence } from "../../src/analysis/evidence.js";
import { exportRun } from "../../src/feedback/export.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { runStudyWith } from "../../src/run-study.js";
import { parseStudy } from "../../src/study/config.js";
import { loadRunBundle, verifyRun, type VerifyResult } from "../../src/index.js";
import { lab } from "../admission/fixtures.js";
import {
  makeFanoutModule,
  scriptedParticipant,
  TWO_TURN_SESSION,
} from "../helpers/fanout-desktop.js";
import { readRunWithTraces, writeRunBundle } from "../helpers/run-traces.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };
const VERSIONS = ["v4", "v3", "v2", "v1"] as const;
type Version = (typeof VERSIONS)[number];
const PROFILE: ActorExecutionProfile = {
  schema: "humanish.actor-execution-profile.v1",
  transport: "codex-app-server",
  authentication: "chatgpt-account",
  billing: "account-unknown",
  requestedModel: "gpt-5.6-sol",
  reasoningEffort: "low",
  cliVersion: "0.160.0",
  toolPolicy: "codex-ui-tools-v1",
  participantSchema: "humanish.codex-ui-tool.v1",
  memoryPolicy: "continuing-thread-v1",
};

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

const projects: string[] = [];

/**
 * `bundle`, a run with every trace inline, kept in four projects beside the files of the run in
 * `source`: v4 as the run writer writes it, v3 and v2 with each summary as those writers kept it
 * (every field of its trace file but the items and screenshot entries), and v1 as `bundle` is.
 */
async function keepFourVersions(
  source: string,
  runId: string,
  bundle: RunBundle,
): Promise<Record<Version, string>> {
  const kept = {} as Record<Version, string>;
  const dir = (version: Version) => path.join(kept[version], ".humanish", "runs", runId);
  kept.v4 = await mkdtemp(path.join(tmpdir(), "humanish-trace-v4-"));
  projects.push(kept.v4);
  await cp(path.join(source, ".humanish"), path.join(kept.v4, ".humanish"), { recursive: true });
  const v4 = await writeRunBundle(dir("v4"), bundle);
  expect(v4.schema).toBe("humanish.run-bundle.v4");
  for (const version of ["v3", "v2", "v1"] as const) {
    kept[version] = await mkdtemp(path.join(tmpdir(), `humanish-trace-${version}-`));
    projects.push(kept[version]);
    await cp(path.join(kept.v4, ".humanish"), path.join(kept[version], ".humanish"), {
      recursive: true,
    });
  }
  const streams = await Promise.all(
    v4.streams.map(async (stream) => {
      if (stream.trace === undefined) return stream;
      const file = await readFile(path.join(dir("v4"), stream.trace.path), "utf8");
      const { items: _items, artifacts: _artifacts, ...actor } = JSON.parse(file);
      return { ...stream, actor };
    }),
  );
  const write = (version: Version, value: unknown) =>
    writeFile(path.join(dir(version), "run.json"), `${JSON.stringify(value, null, 2)}\n`);
  for (const version of ["v3", "v2"] as const)
    await write(version, { ...v4, schema: `humanish.run-bundle.${version}`, streams });
  await write("v1", { ...bundle, schema: "humanish.run-bundle.v1" });
  return kept;
}

/**
 * The fake-desktop run, with its first participant's prompt flat for seven turns, kept four times
 * as `clean`; and kept four times again as `faulted`, with its second participant an account
 * participant whose one receipt has ordinal 2, where receipts count from 1.
 */
async function keepRun(): Promise<{
  runId: string;
  flatId: string;
  clean: Record<Version, string>;
  faulted: Record<Version, string>;
}> {
  const source = await mkdtemp(path.join(tmpdir(), "humanish-trace-source-"));
  projects.push(source);
  const parsed = parseStudy(
    lab("cuAppUrl", { mode: "live", participants: [{ id: "first" }, { id: "second" }] }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  const handle = makeFanoutModule();
  const outcome = await runStudyWith(
    parsed.config,
    { cwd: source, env: KEYS },
    {
      desktopModule: async () => handle.module,
      runSession: async (options: CuaActorSessionOptions) =>
        runCuaActorSession({
          ...options,
          participant: scriptedParticipant(TWO_TURN_SESSION),
        }),
      analysis: { run: vi.fn() },
    },
  );
  if (outcome.route !== "computer-use" || !outcome.result.ok) throw new Error("run failed");
  const runId = outcome.result.runId!;
  const written = await readRunWithTraces(path.join(source, ".humanish", "runs", runId));
  const [first, second] = written.streams;
  // Seven requests whose prompt stayed near 3,100 tokens.
  const turns = Array.from({ length: 7 }, () => ({ input: 3_100, output: 40 }));
  const flat = {
    ...first!,
    actor: { ...first!.actor!, tokenUsage: { input: 21_700, output: 280, turns } },
  };
  const account = {
    ...second!,
    actor: {
      ...second!.actor!,
      executionProfile: PROFILE,
      historyTurnsOmitted: 0,
      providerRequests: [
        {
          ordinal: 2,
          kind: "interaction" as const,
          dispatched: true,
          usageComplete: true,
          cleanup: "confirmed" as const,
          profileVerified: true,
        },
      ],
      estimatedCost: {
        schema: "humanish.actor-estimated-cost.v1" as const,
        estimatedCostUsd: null,
        ratesAsOf: null,
        reason: "account_billing_unknown" as const,
      },
    },
  };
  return {
    runId,
    flatId: first!.id,
    clean: await keepFourVersions(source, runId, { ...written, streams: [flat, second!] }),
    faulted: await keepFourVersions(source, runId, { ...written, streams: [flat, account] }),
  };
}

describe("a run kept as run.json v4, v3, v2 and v1", () => {
  let clean: Record<Version, string>;
  let faulted: Record<Version, string>;
  let runId: string;
  let flatId: string;

  beforeAll(async () => {
    ({ clean, faulted, runId, flatId } = await keepRun());
  });
  afterAll(async () => {
    for (const project of projects) await rm(project, { recursive: true, force: true });
  });

  it("is graded the same by verify, with the flat-context warning in each", async () => {
    const v4 = await verifyRun(clean.v4, runId);
    expect(v4.ok).toBe(true);
    expect(v4.warnings).toContainEqual(
      expect.stringMatching(new RegExp(`^${flatId}: its context did not grow`)),
    );
    for (const version of ["v3", "v2", "v1"] as const)
      expect(graded(await verifyRun(clean[version], runId))).toEqual(graded(v4));
  });

  it("reports an account participant's malformed receipt in each", async () => {
    const v4 = await verifyRun(faulted.v4, runId);
    const costs = v4.checks.find((check) => check.name === "cost estimate labeling");
    expect(costs?.message).toMatch(/Invalid account participant request receipts/);
    for (const version of ["v3", "v2", "v1"] as const)
      expect(graded(await verifyRun(faulted[version], runId))).toEqual(graded(v4));
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
    const v4 = await capture(clean.v4);
    expect(v4.evidence.length).toBeGreaterThan(0);
    expect(v4.images.length).toBeGreaterThan(0);
    for (const version of ["v3", "v2", "v1"] as const)
      expect(await capture(clean[version])).toEqual(v4);
  });

  it("gives an adopter the same participants, lists included, through the package's loadRunBundle", async () => {
    const participants = async (project: string) => {
      const loaded = await loadRunBundle(project, runId);
      if (loaded === null) throw new Error("the run did not load");
      return loaded.bundle.streams.map((stream) => ({
        id: stream.id,
        items: stream.actor?.items,
        turns: stream.actor?.tokenUsage?.turns,
        requests: stream.actor?.conversation?.requests,
        screenshots: stream.artifacts.filter((artifact) => artifact.kind === "screenshot"),
      }));
    };
    const v4 = await participants(clean.v4);
    expect(v4.every((stream) => (stream.items?.length ?? 0) > 0)).toBe(true);
    expect(v4[0]!.turns).toHaveLength(7);
    expect(v4.every((stream) => (stream.requests?.length ?? 0) > 0)).toBe(true);
    const stored = JSON.parse(
      await readFile(path.join(clean.v4, ".humanish", "runs", runId, "run.json"), "utf8"),
    ) as RunBundle;
    expect(stored.streams.map((stream) => stream.actor?.tokenUsage?.turns)).toEqual([
      undefined,
      undefined,
    ]);
    for (const version of ["v3", "v2", "v1"] as const)
      expect(await participants(clean[version])).toEqual(v4);
  });

  it("exports the same derivative, written as v4", async () => {
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
          turns: stream.actor?.tokenUsage?.turns,
        })),
        streams: (await readRunWithTraces(derivative.physicalRunRoot)).streams,
        shareSafety: (await verifyRun(shared, runId)).shareSafety,
        embeddedImages: (result as { embeddedImages?: number }).embeddedImages,
      };
    };
    const v4 = await exported(clean.v4);
    expect(v4.schema).toBe("humanish.run-bundle.v4");
    expect(v4.indexed).toEqual(
      v4.streams.map((stream) => ({
        index: `actors/${stream.id}.json`,
        inline: false,
        turns: undefined,
      })),
    );
    expect(v4.shareSafety.status).toBe("share_ready");
    expect(v4.streams[0]!.actor?.tokenUsage?.turns).toHaveLength(7);
    expect(
      v4.streams[0]!.artifacts.find((artifact) => artifact.kind === "screenshot")?.label,
    ).toMatch(/blurred at export/);
    for (const version of ["v3", "v2", "v1"] as const)
      expect(await exported(clean[version])).toEqual(v4);
  });
});
