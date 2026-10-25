import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BRAINS } from "../../bench/lib/plan.js";
import {
  DEFAULT_PERSONA_FILE,
  fixtureDigests,
  sha256,
  writeProject,
} from "../../bench/lib/project.js";
import { MISSIONS } from "../../bench/taskly/missions.js";

const brains = [BRAINS["openai-computer-use"]];

function servedDigests(storage: "memory" | "local"): Record<string, string> {
  const project = mkdtempSync(path.join(os.tmpdir(), "humanish-bench-project-"));
  try {
    writeProject(project, brains, MISSIONS.neutral, 0.6, DEFAULT_PERSONA_FILE, storage);
    const digest = (file: string): string => sha256(readFileSync(path.join(project, file)));
    return {
      plantedAppJs: digest("build-a/app.js"),
      cleanAppJs: digest("build-b/app.js"),
      plantedIndex: digest("build-a/index.html"),
      cleanIndex: digest("build-b/index.html"),
    };
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

describe("the benchmark project", () => {
  it("serves the localStorage builds when the storage is local, with the same index.html", () => {
    const memory = servedDigests("memory");
    const local = servedDigests("local");
    const digests = fixtureDigests(DEFAULT_PERSONA_FILE, "local");
    expect(local.plantedAppJs).toBe(digests.plantedAppJs);
    expect(local.cleanAppJs).toBe(digests.cleanAppJs);
    expect(local.plantedAppJs).not.toBe(memory.plantedAppJs);
    expect(local.cleanAppJs).not.toBe(memory.cleanAppJs);
    expect(local.plantedIndex).toBe(memory.plantedIndex);
    expect(local.cleanIndex).toBe(digests.indexHtml);
  });

  it("serves the in-memory builds by default", () => {
    const memory = servedDigests("memory");
    const digests = fixtureDigests(DEFAULT_PERSONA_FILE);
    expect(memory.plantedAppJs).toBe(digests.plantedAppJs);
    expect(memory.cleanAppJs).toBe(digests.cleanAppJs);
  });
});
