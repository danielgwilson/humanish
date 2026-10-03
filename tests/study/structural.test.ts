import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { parse as parseYaml } from "yaml";

import { parseStudy } from "../../src/study/config.js";
import { V2_SCHEMA } from "../../src/study/types.js";
import { runStudyWith } from "../../src/run-study.js";
import { routeOf } from "../../src/study/plan.js";
import { resolveStudyManifest } from "../../src/study/discover.js";
import { parseBrowserPersonaJourneyFromScenario } from "../../src/actors/scripted-browser/journey.js";
import { digestText } from "../../src/evidence/redaction.js";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const cliSources = readdirSync(path.join(ROOT, "src/cli"), { recursive: true, encoding: "utf8" })
  .filter((rel) => rel.endsWith(".ts"))
  .map((rel) => path.join("src/cli", rel));

// Rung 1 (necessity via deletion): there is exactly one path. The closed `kind` enum, the kind
// switch, and the three per-kind command functions must not exist: if any survived, the
// refactor would be cosmetic.
describe("lab refactor structural necessity (rung 1)", () => {
  const labs = read("src/study/discover.ts");
  const program = cliSources.map(read).join("\n");

  it("the LabKind enum and its guard are gone", () => {
    expect(labs).not.toMatch(/\btype\s+LabKind\b/);
    expect(labs).not.toMatch(/\bisLabKind\b/);
  });

  it("the kind-dispatch switch is gone", () => {
    expect(program).not.toMatch(/switch\s*\(\s*resolved\.manifest\.kind\s*\)/);
    expect(program).not.toMatch(/\.manifest\.kind\b/);
  });

  it("the three per-kind command functions are gone", () => {
    expect(program).not.toMatch(/runSyntheticLabCommand/);
    expect(program).not.toMatch(/runOssSmokeLabCommand/);
    expect(program).not.toMatch(/runOssMetaLabCommand/);
  });

  it("the v1 lab schema is gone from src (no back-compat)", () => {
    for (const rel of [
      "src/study/discover.ts",
      "src/study/config.ts",
      "src/study/types.ts",
      ...cliSources,
      "src/study/init-templates.ts",
    ]) {
      expect(read(rel)).not.toContain("humanish.lab.v1");
    }
  });
});

// Rung 3 (expressiveness / no-overfit): a brand-new composition the engine never saw as a
// built-in must work config-only (parse + route with zero engine edits) and the engine must
// actually consume the config, not merely route a label (otherwise a "3 kinds in disguise"
// engine would pass an expressiveness test that never executes).
describe("lab config expressiveness (rung 3)", () => {
  it("a clone+e2b composition with a free-form actor label is refused at parse", () => {
    const result = parseStudy({
      schema: V2_SCHEMA,
      id: "migration-rehearsal",
      title: "bespoke-sim to humanish migration",
      subject: {
        source: "clone",
        repos: ["example-org/private-app"],
        clone: { depth: 1, fanout: 1 },
      },
      // No route runs a free-form actor label on a clone study; parsing it would defer the failure
      // to run start, so the parser refuses it and names the actors that can run a clone study.
      actors: [
        {
          type: "codex-migrator",
          mission: "Remove the bespoke UI sim package and adopt humanish.",
        },
      ],
      execution: { target: "e2b-desktop" },
      policies: { redactRepos: true },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Got "codex-migrator"');
  });

  it("the committed scripted-demo study parses with zero warnings, routes to the scripted backend, and its scenario.ref resolves to executable committed steps", async () => {
    const resolved = await resolveStudyManifest(ROOT, "scripted-demo");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // Every field in the committed example is consumed on this route: zero warnings.
    expect(resolved.warnings).toEqual([]);
    expect(resolved.config.actors[0]?.type).toBe("scripted-browser");
    expect(resolved.config.actors[0]?.count).toBe(2);
    expect(resolved.config.scenario?.ref).toBe("scripted-first-run");
    expect(routeOf(resolved.config)).toBe("scripted");

    // The referenced committed scenario is genuinely executable (4 browser steps).
    const scenarioText = read("humanish/scenarios/scripted-first-run.yaml");
    const parsed = parseBrowserPersonaJourneyFromScenario({
      raw: parseYaml(scenarioText),
      relativePath: "humanish/scenarios/scripted-first-run.yaml",
      sourceDigest: digestText(scenarioText),
    });
    expect(parsed.failure).toBeUndefined();
    expect(parsed.journey?.steps).toHaveLength(4);
    expect(parsed.journey?.scenarioId).toBe("scripted-first-run");
  });

  it("synthetic behavior is a function of config (actor count -> simCount), not just a parsed label", async () => {
    const base = (count: number) =>
      parseStudy({
        schema: V2_SCHEMA,
        id: "behavioral",
        subject: { source: "this-repo" },
        actors: [{ type: "synthetic-persona", count }],
        scenario: { mode: "dry-run" },
      });
    const two = base(2);
    const five = base(5);
    expect(two.ok && five.ok).toBe(true);
    if (!two.ok || !five.ok) return;

    // Fixed run ids need a fresh project: a second run with the same id is refused.
    const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-structural-"));
    onTestFinished(() => rm(cwd, { force: true, recursive: true }));
    const r2 = await runStudyWith(two.config, { cwd, runId: "behavioral-2", dryRun: true });
    const r5 = await runStudyWith(five.config, { cwd, runId: "behavioral-5", dryRun: true });
    expect(r2.route).toBe("preview");
    expect(r5.route).toBe("preview");
    if (r2.route !== "preview" || r5.route !== "preview") return;
    // Proof the engine consumes the composition, not just routes 1 of 3 fixed backends.
    expect(r2.result.simCount).toBe(2);
    expect(r5.result.simCount).toBe(5);
  });
});
