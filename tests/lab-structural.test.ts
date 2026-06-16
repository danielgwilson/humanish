import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { parseLabConfig, LAB_CONFIG_SCHEMA } from "../src/lab-config.js";
import { runLab, selectLabBackend } from "../src/lab-engine.js";
import { resolveLabManifest } from "../src/labs.js";
import { parseBrowserPersonaJourneyFromScenario } from "../src/scripted-browser-actor.js";
import { digestText } from "../src/redaction.js";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// RUNG 1 (necessity via deletion): there is exactly ONE path. The closed `kind` enum, the kind
// switch, and the three per-kind command functions must not exist — if any survived, the
// refactor would be cosmetic.
describe("lab refactor structural necessity (rung 1)", () => {
  const labs = read("src/labs.ts");
  const program = read("src/program.ts");

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
    for (const rel of ["src/labs.ts", "src/lab-config.ts", "src/program.ts", "src/init-templates.ts"]) {
      expect(read(rel)).not.toContain("mimetic.lab.v1");
    }
  });
});

// RUNG 3 (expressiveness / no-overfit): a brand-new composition the engine never saw as a
// built-in must work config-only — parse + route with ZERO engine edits — AND the engine must
// actually CONSUME the config, not merely route a label (otherwise a "3 kinds in disguise"
// engine would pass an expressiveness test that never executes).
describe("lab config expressiveness (rung 3)", () => {
  it("a brand-new clone+e2b migration-style composition parses and routes config-only", () => {
    const result = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "migration-rehearsal",
      title: "bespoke-sim to mimetic migration",
      subject: { source: "clone", repos: ["example-org/private-app"], clone: { depth: 1, fanout: 1 } },
      // A free-form (non-registered) actor label on the clone+e2b route stays a label and routes
      // to meta. (codex-exec is now a REGISTERED terminal actor — it would be a mis-config here, so
      // this expressiveness test uses a generic migrator label to keep its point: clone+e2b config
      // routes config-only with the mission forward-declared.)
      actors: [{ type: "codex-migrator", mission: "Remove the bespoke UI sim package and adopt mimetic." }],
      execution: { target: "e2b-desktop" },
      policies: { redactRepos: true }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Routes to the E2B desktop backend purely from config — no new engine code.
    expect(selectLabBackend(result.config)).toBe("meta");
    // The mission is forward-declared today and surfaced as a warning, never silently consumed.
    expect(result.warnings.join(" ")).toContain("actors[0].mission");
  });

  it("the COMMITTED scripted-demo lab parses with zero warnings, routes to the scripted backend, and its scenario.ref resolves to executable committed steps", async () => {
    const resolved = await resolveLabManifest(ROOT, "scripted-demo");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // Every field in the committed example is consumed on this route — zero warnings.
    expect(resolved.warnings).toEqual([]);
    expect(resolved.config.actors[0]?.type).toBe("scripted-browser");
    expect(resolved.config.actors[0]?.count).toBe(2);
    expect(resolved.config.scenario?.ref).toBe("scripted-first-run");
    expect(selectLabBackend(resolved.config)).toBe("scripted");

    // The referenced committed scenario is genuinely executable (4 browser steps).
    const scenarioText = read("mimetic/scenarios/scripted-first-run.yaml");
    const parsed = parseBrowserPersonaJourneyFromScenario({
      raw: parseYaml(scenarioText),
      relativePath: "mimetic/scenarios/scripted-first-run.yaml",
      sourceDigest: digestText(scenarioText)
    });
    expect(parsed.failure).toBeUndefined();
    expect(parsed.journey?.steps).toHaveLength(4);
    expect(parsed.journey?.scenarioId).toBe("scripted-first-run");
  });

  it("synthetic behavior is a FUNCTION of config (actor count -> simCount), not just a parsed label", async () => {
    const base = (count: number) => parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "behavioral",
      subject: { source: "this-repo" },
      actors: [{ type: "synthetic-persona", count }],
      scenario: { mode: "dry-run" }
    });
    const two = base(2);
    const five = base(5);
    expect(two.ok && five.ok).toBe(true);
    if (!two.ok || !five.ok) return;

    const r2 = await runLab(two.config, { cwd: ROOT, runId: "behavioral-2", dryRun: true });
    const r5 = await runLab(five.config, { cwd: ROOT, runId: "behavioral-5", dryRun: true });
    expect(r2.backend).toBe("synthetic");
    expect(r5.backend).toBe("synthetic");
    if (r2.backend !== "synthetic" || r5.backend !== "synthetic") return;
    // Proof the engine consumes the composition, not just routes 1 of 3 fixed backends.
    expect(r2.result.simCount).toBe(2);
    expect(r5.result.simCount).toBe(5);
  });
});
