import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runDryRun } from "../src/run.js";

async function withDogfoodCopy<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-dogfood-fixture-"));

  try {
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "humanish-dogfood-fixture" }, null, 2)
    );
    await cp(path.resolve("humanish"), path.join(tempRoot, "humanish"), { recursive: true });
    return await callback(tempRoot);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

describe("humanish dogfood config", () => {
  it("describes humanish as its own target app", async () => {
    const config = await readFile("humanish/config.ts", "utf8");
    const adapter = await readFile("humanish/adapters/app.ts", "utf8");
    const scenario = await readFile("humanish/scenarios/first-run-smoke.yaml", "utf8");

    expect(config).toContain('name: "humanish"');
    expect(config).toContain('startCommand: "pnpm humanish -- --help"');
    expect(adapter).toContain('id: "humanish"');
    expect(adapter).toContain("humanish feedback issue --run latest");
    expect(adapter).toContain("humanish watch");
    expect(scenario).toContain("run a one-command 4-sim watch, verify");
    expect(`${config}\n${adapter}\n${scenario}`).not.toContain("synthetic-app");
  });

  it("keeps self-dogfood scripts and coverage public-safe", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const coverage = await readFile("humanish/coverage-matrix.md", "utf8");
    const readme = await readFile("humanish/README.md", "utf8");

    expect(packageJson.scripts["humanish:run"]).toBe("pnpm humanish -- run --dry-run");
    expect(packageJson.scripts["humanish:watch"]).toBe("pnpm humanish -- watch");
    expect(packageJson.scripts["humanish:watch:ci"]).toBe("pnpm humanish -- watch --json --no-open");
    expect(packageJson.scripts["humanish:dogfood"]).toBe("pnpm humanish -- watch");
    expect(packageJson.scripts["humanish:feedback"]).toBe("pnpm humanish -- feedback issue --repo danielgwilson/humanish");
    expect(coverage).toContain("codex-exec");
    expect(coverage).toContain("workspace trust is missing");
    expect(readme).toContain("one-command `watch`");
    expect(readme).toContain("codex-exec");
    expect(readme).toContain("Generated run bundles");
  });

  it("feeds committed persona and scenario content into the dry-run bundle", async () => {
    await withDogfoodCopy(async (cwd) => {
      const result = await runDryRun({ cwd, dryRun: true, runId: "dogfood-source-proof" });

      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".humanish/runs/dogfood-source-proof/run.json"), "utf8")
      ) as {
        persona: { id: string; name: string; source: string; sourceDigest: string };
        scenario: { id: string; title: string; goal: string; source: string; sourceDigest: string };
      };

      expect(bundle.persona).toMatchObject({
        id: "synthetic-new-user",
        name: "Open-Source Maintainer Trial User",
        source: "humanish/personas/synthetic-new-user.yaml"
      });
      expect(bundle.scenario).toMatchObject({
        id: "first-run-smoke",
        title: "Humanish CLI first-run smoke",
        source: "humanish/scenarios/first-run-smoke.yaml"
      });
      expect(bundle.scenario.goal).toContain("run a one-command 4-sim watch");
      expect(bundle.persona.sourceDigest).toMatch(/^[a-f0-9]{12}$/);
      expect(bundle.scenario.sourceDigest).toMatch(/^[a-f0-9]{12}$/);
    });
  });
});
