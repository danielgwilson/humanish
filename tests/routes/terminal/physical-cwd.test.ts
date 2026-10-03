import { symlinkSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCommittedPersona } from "../../../src/study/persona-resolve.js";
import { parseLabConfig } from "../../../src/study/config.js";
import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../../src/study/types.js";
import { runTerminalProductLab } from "../../../src/routes/terminal/route.js";

// The dry run takes no hook between resolving the project and starting the run, so the alias is
// retargeted from inside the persona lookup, the last step before the run starts.
vi.mock("../../../src/study/persona-resolve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/study/persona-resolve.js")>();
  return { ...actual, resolveCommittedPersona: vi.fn(actual.resolveCommittedPersona) };
});

function dryConfig(): LabConfig {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "terminal-physical-cwd",
    title: "Terminal physical cwd",
    subject: {
      source: "terminal-product",
      product: { name: "widgetsmith-cli", publicSurfaces: ["https://example.com/widgetsmith"] },
    },
    actors: [{ type: "codex-exec", mission: "Discover widgetsmith-cli from public surfaces." }],
    execution: { target: "e2b-terminal", runtimeAuth: "openai-env" },
    scenario: { mode: "dry-run", caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 10 } },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("terminal dry-run project binding", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "humanish-terminal-cwd-"));
  });
  afterEach(async () => {
    vi.mocked(resolveCommittedPersona).mockReset();
    await rm(root, { recursive: true, force: true });
  });

  it("pins a symlink cwd before the alias can be retargeted", async () => {
    const actual = await vi.importActual<typeof import("../../../src/study/persona-resolve.js")>(
      "../../../src/study/persona-resolve.js",
    );
    const physicalA = path.join(root, "project-a");
    const physicalB = path.join(root, "project-b");
    const cwdAlias = path.join(root, "project-alias");
    const decoyRuns = path.join(physicalB, ".humanish", "runs");
    const decoyLatest = path.join(decoyRuns, "latest.json");
    const sentinel = "outside sentinel must stay unchanged\n";
    await mkdir(physicalA);
    await mkdir(decoyRuns, { recursive: true });
    await writeFile(decoyLatest, sentinel, "utf8");
    symlinkSync(physicalA, cwdAlias, "dir");
    const pinnedA = await realpath(physicalA);
    vi.mocked(resolveCommittedPersona).mockImplementation(async (...args) => {
      unlinkSync(cwdAlias);
      symlinkSync(physicalB, cwdAlias, "dir");
      return actual.resolveCommittedPersona(...args);
    });

    const result = await runTerminalProductLab({
      cwd: cwdAlias,
      config: dryConfig(),
      dryRun: true,
      runId: "pinned",
    });

    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const bundle = JSON.parse(
      await readFile(path.join(pinnedA, ".humanish", "runs", "pinned", "run.json"), "utf8"),
    );
    expect(bundle.runId).toBe("pinned");
    expect(await readFile(decoyLatest, "utf8")).toBe(sentinel);
    expect(await readdir(decoyRuns)).toEqual(["latest.json"]);
  });
});
