import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseLabConfig, LAB_CONFIG_SCHEMA } from "../src/lab-config.js";
import { selectLabBackend } from "../src/lab-engine.js";

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

// RUNG 3 (expressiveness / no-overfit): brand-new lab compositions the engine never saw as a
// built-in must work config-only — they parse and route with ZERO engine edits. If a new lab
// needed code, the "general engine" would just be the three built-ins in disguise.
describe("lab config expressiveness (rung 3)", () => {
  it("a nobg-style migration lab (clone + e2b + two heterogeneous actors + mission + approval) parses and routes", () => {
    const result = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "nobg-migration",
      title: "nobg bespoke-sim -> mimetic migration",
      subject: { source: "clone", repos: ["danielgwilson/nobg"], clone: { depth: 1, fanout: 1 } },
      actors: [
        { type: "codex-exec", mission: "Remove the bespoke @nobg/ui-sim package and adopt mimetic." },
        { type: "claude-agent-sdk", persona: "skeptical-power-user", mission: "Review the migration for dual-stack residue." }
      ],
      execution: { target: "e2b-desktop", concurrency: 1 },
      policies: { redactRepos: true, noPush: true, approval: { mode: "pre-grant-allowlist", allow: ["pnpm install", "pnpm check"] } },
      review: { scoring: "migration-boot-and-review" }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The composition routes to the meta (E2B desktop) backend purely from config — no new code.
    expect(selectLabBackend(result.config)).toBe("meta");
    expect(result.config.actors.map((actor) => actor.type)).toEqual(["codex-exec", "claude-agent-sdk"]);
    expect(result.config.policies?.approval?.mode).toBe("pre-grant-allowlist");
  });

  it("an app-url + computer-use browser lab (PR #2 shape) parses and routes config-only", () => {
    const result = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "nobg-browser-user",
      subject: { source: "app-url", url: "http://127.0.0.1:3000" },
      actors: [{ type: "computer-use", persona: "synthetic-new-user", count: 2 }],
      execution: { target: "e2b-desktop" }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // app-url subjects route through the synthetic/browser-proof path today; wiring the CUA actor
    // is PR #2, but the config already expresses it with no schema change.
    expect(selectLabBackend(result.config)).toBe("synthetic");
    expect(result.config.subject.url).toBe("http://127.0.0.1:3000");
  });
});
