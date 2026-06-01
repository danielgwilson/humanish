import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runDryRun } from "../src/run.js";

async function withDogfoodCopy<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mimetic-dogfood-fixture-"));

  try {
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "mimetic-cli-dogfood-fixture" }, null, 2)
    );
    await cp(path.resolve("mimetic"), path.join(tempRoot, "mimetic"), { recursive: true });
    return await callback(tempRoot);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

describe("mimetic dogfood config", () => {
  it("describes mimetic-cli as its own target app", async () => {
    const config = await readFile("mimetic/config.ts", "utf8");
    const adapter = await readFile("mimetic/adapters/app.ts", "utf8");
    const scenario = await readFile("mimetic/scenarios/first-run-smoke.yaml", "utf8");

    expect(config).toContain('name: "mimetic-cli"');
    expect(config).toContain('startCommand: "pnpm mimetic -- --help"');
    expect(adapter).toContain('id: "mimetic-cli"');
    expect(adapter).toContain("mimetic feedback issue --run latest");
    expect(scenario).toContain("Prove that Mimetic can explain, initialize, dry-run, verify, observe, and draft feedback for itself");
    expect(`${config}\n${adapter}\n${scenario}`).not.toContain("synthetic-app");
  });

  it("keeps self-dogfood scripts and coverage public-safe", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const coverage = await readFile("mimetic/coverage-matrix.md", "utf8");
    const readme = await readFile("mimetic/README.md", "utf8");

    expect(packageJson.scripts["mimetic:run"]).toBe("pnpm mimetic -- run --dry-run");
    expect(packageJson.scripts["mimetic:watch"]).toBe("pnpm mimetic -- watch --no-open");
    expect(packageJson.scripts["mimetic:feedback"]).toBe("pnpm mimetic -- feedback issue --repo danielgwilson/mimetic-cli");
    expect(coverage).toContain("live run fails closed until actor support exists");
    expect(readme).toContain("no real Codex TUI actor yet");
    expect(readme).toContain("Generated run bundles");
  });

  it("feeds committed persona and scenario content into the dry-run bundle", async () => {
    await withDogfoodCopy(async (cwd) => {
      const result = await runDryRun({ cwd, dryRun: true, runId: "dogfood-source-proof" });

      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/dogfood-source-proof/run.json"), "utf8")
      ) as {
        persona: { id: string; name: string; source: string; sourceDigest: string };
        scenario: { id: string; title: string; goal: string; source: string; sourceDigest: string };
      };

      expect(bundle.persona).toMatchObject({
        id: "synthetic-new-user",
        name: "Open-Source Maintainer Trial User",
        source: "mimetic/personas/synthetic-new-user.yaml"
      });
      expect(bundle.scenario).toMatchObject({
        id: "first-run-smoke",
        title: "Mimetic CLI first-run smoke",
        source: "mimetic/scenarios/first-run-smoke.yaml"
      });
      expect(bundle.scenario.goal).toContain("Mimetic can explain, initialize, dry-run");
      expect(bundle.persona.sourceDigest).toMatch(/^[a-f0-9]{12}$/);
      expect(bundle.scenario.sourceDigest).toMatch(/^[a-f0-9]{12}$/);
    });
  });
});
