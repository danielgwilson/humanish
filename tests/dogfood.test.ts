import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runDryRun } from "../src/run/run.js";

async function withDogfoodCopy<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-dogfood-fixture-"));

  try {
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "humanish-dogfood-fixture" }, null, 2),
    );
    await cp(path.resolve("humanish"), path.join(tempRoot, "humanish"), { recursive: true });
    return await callback(tempRoot);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

describe("humanish dogfood config", () => {
  it("feeds committed persona and scenario content into the dry-run bundle", async () => {
    await withDogfoodCopy(async (cwd) => {
      const result = await runDryRun({ cwd, dryRun: true, runId: "dogfood-source-proof" });

      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".humanish/runs/dogfood-source-proof/run.json"), "utf8"),
      ) as {
        persona: { id: string; name: string; source: string; sourceDigest: string };
        scenario: { id: string; title: string; goal: string; source: string; sourceDigest: string };
      };

      expect(bundle.persona).toMatchObject({
        id: "synthetic-new-user",
        name: "First-Time Trial User",
        source: "humanish/personas/synthetic-new-user.yaml",
      });
      expect(bundle.scenario).toMatchObject({
        id: "first-run-smoke",
        title: "Humanish CLI first-run smoke",
        source: "humanish/scenarios/first-run-smoke.yaml",
      });
      expect(bundle.scenario.goal).toContain("run a one-command 4-sim watch");
      expect(bundle.persona.sourceDigest).toMatch(/^[a-f0-9]{12}$/);
      expect(bundle.scenario.sourceDigest).toMatch(/^[a-f0-9]{12}$/);
    });
  });
});
