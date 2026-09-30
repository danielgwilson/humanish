import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { parseLabConfig } from "../../src/lab/config.js";
import { routeOf } from "../../src/lab/plan.js";
import { normalizeRunLabOptions } from "../../src/lab/run-lab-options.js";
import type { LabConfig } from "../../src/lab/types.js";
import { lab } from "../admission/fixtures.js";

// Each old field with a new home warns once per process. This file runs in its own worker, so the
// once-per-process record starts empty here.

function config(): LabConfig {
  const parsed = parseLabConfig(lab("cuAppUrl"));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

type WarningSpy = { mock: { calls: unknown[][] } };

const deprecations = (spy: WarningSpy): string[] =>
  spy.mock.calls
    .filter(([, options]) => {
      const code = (options as { code?: unknown } | undefined)?.code;
      return code === "HUMANISH_RUN_LAB_OPTION_DEPRECATED";
    })
    .map(([message]) => String(message));

describe("an old RunLabOptions field", () => {
  let emitWarning: WarningSpy & { mockRestore: () => void };
  beforeEach(() => {
    emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  });
  afterEach(() => {
    emitWarning.mockRestore();
  });

  it("warns once per process, naming its home", () => {
    const score = () => ({
      schema: "humanish.adapter-score.v1" as const,
      namespace: "example",
      status: "pass" as const,
      score: 1,
      summary: "ok",
    });
    const labConfig = config();
    for (let i = 0; i < 2; i += 1)
      normalizeRunLabOptions(labConfig, routeOf(labConfig), { cwd: "/tmp/x", cuaHooks: { score } });
    expect(deprecations(emitWarning)).toEqual([
      "RunLabOptions.cuaHooks.score is deprecated and is removed in the next minor. Use RunLabOptions.scorer.",
    ]);
  });

  it("does not warn for a test seam with no new home, or for a refused call", () => {
    const labConfig = config();
    normalizeRunLabOptions(labConfig, routeOf(labConfig), {
      cwd: "/tmp/x",
      cuaHooks: { loadDesktopModule: async () => ({}) as never },
    });
    normalizeRunLabOptions(labConfig, routeOf(labConfig), {
      cwd: "/tmp/x",
      env: {},
      terminalHooks: { env: {} },
    });
    expect(deprecations(emitWarning)).toEqual([]);
  });
});

describe("the CLI uses only the new homes", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-lab-deprecation-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("a scored lab run emits no deprecation warning", async () => {
    await cp(path.resolve("humanish"), path.join(cwd, "humanish"), { recursive: true });
    await mkdir(path.join(cwd, "scorers"), { recursive: true });
    await writeFile(
      path.join(cwd, "scorers", "score.mjs"),
      `export function score() {
  return { schema: "humanish.adapter-score.v1", namespace: "cli", status: "pass", score: 1, summary: "ok" };
}
`,
    );
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    let out = "";
    try {
      const program = createProgram({
        writeOut: (text) => {
          out += text;
        },
        writeErr: () => undefined,
        setExitCode: () => undefined,
      });
      await program.parseAsync(
        [
          "node",
          "humanish",
          "lab",
          "run",
          "fanout-demo",
          "--dry-run",
          "--scorer",
          "scorers/score.mjs",
          "--cwd",
          cwd,
          "--json",
        ],
        { from: "node" },
      );
      expect(deprecations(emitWarning)).toEqual([]);
    } finally {
      emitWarning.mockRestore();
    }
    expect(JSON.parse(out).ok).toBe(true);
  });
});
