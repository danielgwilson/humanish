import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runDryRun } from "../src/run.js";

async function withDogfoodCopy<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "homun-dogfood-fixture-"));

  try {
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "homun-dogfood-fixture" }, null, 2)
    );
    await cp(path.resolve("homun"), path.join(tempRoot, "homun"), { recursive: true });
    return await callback(tempRoot);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

describe("homun dogfood config", () => {
  it("describes homun as its own target app", async () => {
    const config = await readFile("homun/config.ts", "utf8");
    const adapter = await readFile("homun/adapters/app.ts", "utf8");
    const scenario = await readFile("homun/scenarios/first-run-smoke.yaml", "utf8");

    expect(config).toContain('name: "homun"');
    expect(config).toContain('startCommand: "pnpm homun -- --help"');
    expect(adapter).toContain('id: "homun"');
    expect(adapter).toContain("homun feedback issue --run latest");
    expect(adapter).toContain("homun watch");
    expect(scenario).toContain("run a one-command 4-sim watch, verify");
    expect(`${config}\n${adapter}\n${scenario}`).not.toContain("synthetic-app");
  });

  it("keeps self-dogfood scripts and coverage public-safe", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const coverage = await readFile("homun/coverage-matrix.md", "utf8");
    const readme = await readFile("homun/README.md", "utf8");

    expect(packageJson.scripts["homun:run"]).toBe("pnpm homun -- run --dry-run");
    expect(packageJson.scripts["homun:watch"]).toBe("pnpm homun -- watch");
    expect(packageJson.scripts["homun:watch:ci"]).toBe("pnpm homun -- watch --json --no-open");
    expect(packageJson.scripts["homun:dogfood"]).toBe("pnpm homun -- watch");
    expect(packageJson.scripts["homun:feedback"]).toBe("pnpm homun -- feedback issue --repo danielgwilson/homun");
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
        await readFile(path.join(cwd, ".homun/runs/dogfood-source-proof/run.json"), "utf8")
      ) as {
        persona: { id: string; name: string; source: string; sourceDigest: string };
        scenario: { id: string; title: string; goal: string; source: string; sourceDigest: string };
      };

      expect(bundle.persona).toMatchObject({
        id: "synthetic-new-user",
        name: "Open-Source Maintainer Trial User",
        source: "homun/personas/synthetic-new-user.yaml"
      });
      expect(bundle.scenario).toMatchObject({
        id: "first-run-smoke",
        title: "Homun CLI first-run smoke",
        source: "homun/scenarios/first-run-smoke.yaml"
      });
      expect(bundle.scenario.goal).toContain("run a one-command 4-sim watch");
      expect(bundle.persona.sourceDigest).toMatch(/^[a-f0-9]{12}$/);
      expect(bundle.scenario.sourceDigest).toMatch(/^[a-f0-9]{12}$/);
    });
  });
});
