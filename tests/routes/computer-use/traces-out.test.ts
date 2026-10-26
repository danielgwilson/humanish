// A live computer-use run on fake desktops ($0) writes run.json v2: each participant's trace items
// and screenshot entries are in its actors/<stream>.json, and run.json indexes that file.

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type { RunBundle } from "../../../src/run/bundle.js";
import { resolveRunPath } from "../../../src/run/locate.js";
import { loadStreamTrace } from "../../../src/run/stream-trace.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import { lab } from "../../admission/fixtures.js";
import {
  makeFanoutModule,
  scriptedParticipant,
  TWO_TURN_SESSION,
} from "../../helpers/fanout-desktop.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };

describe("the run writer", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-traces-out-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("writes each participant's trace once, in the file run.json indexes", async () => {
    const parsed = parseStudy(
      lab("cuAppUrl", { mode: "live", participants: [{ id: "first" }, { id: "second" }] }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      parsed.config,
      { cwd, env: KEYS },
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
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(outcome.result.ok).toBe(true);

    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId!);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    expect(bundle.schema).toBe("humanish.run-bundle.v4");

    const runPaths = (await resolveRunPath(cwd, outcome.result.runId!))!;
    expect(bundle.streams).toHaveLength(2);
    for (const stream of bundle.streams) {
      expect(stream.actor?.status).toBe("passed");
      expect(stream.actor).not.toHaveProperty("items");
      expect(stream.artifacts.map((artifact) => artifact.kind)).not.toContain("screenshot");
      const bytes = await readFile(path.join(runDir, stream.trace!.path));
      expect(stream.trace).toEqual({
        path: `actors/${stream.id}.json`,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        items: expect.any(Number),
        screenshots: 2,
      });
      const loaded = await loadStreamTrace(runPaths, stream);
      expect(loaded.actor!.items.length).toBe(stream.trace!.items);
      expect(loaded.actor!.items.map((item) => item.kind)).toContain("screenshot");
      expect(loaded.artifacts.filter((artifact) => artifact.kind === "screenshot")).toHaveLength(2);
    }
  });
});
