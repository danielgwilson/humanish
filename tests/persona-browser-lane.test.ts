// #381: committed personas must reach BROWSER lanes, not just the terminal lane.
//
// The regression this pins: `composeLaneInstructions` used to emit a bare `Persona: <id>.` line and
// hardcode `traitsApplied: []`, so on every computer-use route the persona axis was a label with no
// behavior behind it. A live two-lane contrast (impatient expert vs patient newcomer) came back with
// near-identical action profiles — which looked like a finding about personas and was actually a
// finding about the composer. These tests assert the persona's compiled DIRECTIVE TEXT lands in the
// prompt, because a prompt digest changing is not evidence that behavior changed.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { composeLaneInstructions } from "../src/cua-actor-lab.js";
import { DEVICE_PRESETS } from "../src/device-presets.js";
import { labPersonaIds, personaTitleFromId, resolveCommittedPersonasForCwd } from "../src/persona-resolve.js";
import { parseResolvedPersona, personaToDirectives } from "../src/persona.js";

const DEVICE = { name: "desktop", preset: DEVICE_PRESETS.desktop } as const;

async function committed(id: string) {
  const raw = parseYaml(await readFile(path.resolve("humanish/personas", `${id}.yaml`), "utf8"));
  return parseResolvedPersona(raw, { id, name: personaTitleFromId(id) });
}

describe("composeLaneInstructions applies committed personas", () => {
  it("puts the compiled directives in the prompt and records the traits truthfully", async () => {
    const persona = await committed("skeptical-power-user");
    const composed = composeLaneInstructions({
      mission: "Sign in and rename the workspace.",
      persona: "skeptical-power-user",
      resolvedPersona: persona,
      device: DEVICE
    });

    const expected = personaToDirectives(persona);
    expect(composed.instructions).toContain(expected.frictionTolerance);
    expect(composed.instructions).toContain(expected.skillBias);
    if (expected.accessibilityBehavior) {
      expect(composed.instructions).toContain(expected.accessibilityBehavior);
    }
    for (const constraint of expected.constraints) {
      expect(composed.instructions).toContain(constraint);
    }
    // traitsApplied is the run's own claim about what shaped the actor; it must match the compiler.
    expect(composed.persona.traitsApplied).toEqual(expected.traitsApplied);
    expect(composed.persona.traitsApplied.length).toBeGreaterThan(0);
    expect(composed.persona.id).toBe("skeptical-power-user");
  });

  it("gives two different committed personas materially different prompts", async () => {
    const args = { mission: "Sign in and rename the workspace.", device: DEVICE } as const;
    const expert = composeLaneInstructions({
      ...args,
      persona: "skeptical-power-user",
      resolvedPersona: await committed("skeptical-power-user")
    });
    const newcomer = composeLaneInstructions({
      ...args,
      persona: "synthetic-new-user",
      resolvedPersona: await committed("synthetic-new-user")
    });

    expect(expert.instructions).not.toBe(newcomer.instructions);
    expect(expert.persona.promptDigest).not.toBe(newcomer.persona.promptDigest);
    expect(expert.persona.traitsApplied).not.toEqual(newcomer.persona.traitsApplied);
  });

  it("falls back to the bare id with EMPTY traitsApplied when no persona resolved", () => {
    const composed = composeLaneInstructions({
      mission: "Sign in and rename the workspace.",
      persona: "not-a-committed-persona",
      device: DEVICE
    });
    expect(composed.instructions).toContain("Persona: not-a-committed-persona.");
    // A persona that declared nothing must never be credited with traits it does not have.
    expect(composed.persona.traitsApplied).toEqual([]);
  });
});

describe("committed persona resolution", () => {
  it("resolves ids the lab config actually declares, per lane and per actor", () => {
    expect(
      labPersonaIds({ actors: [{ persona: "synthetic-new-user" }] })
    ).toEqual(["synthetic-new-user"]);
    expect(
      labPersonaIds({
        actors: [{ persona: "synthetic-new-user", lanes: [{ persona: "skeptical-power-user" }, { persona: "synthetic-new-user" }] }]
      })
    ).toEqual(["synthetic-new-user", "skeptical-power-user"]);
    expect(labPersonaIds({ actors: [{ lanes: [{}] }] })).toEqual([]);
  });

  it("reads committed persona files from the project root", async () => {
    const resolved = await resolveCommittedPersonasForCwd(process.cwd(), [
      "skeptical-power-user",
      "synthetic-new-user"
    ]);
    expect(resolved.warnings).toEqual([]);
    expect(resolved.personas.get("skeptical-power-user")?.traits.patience).toBe("low");
    expect(resolved.personas.get("synthetic-new-user")?.traits.patience).toBe("medium");
  });

  it("does not resolve — and does not throw on — unsafe ids or missing files", async () => {
    const resolved = await resolveCommittedPersonasForCwd(process.cwd(), [
      "../../etc/passwd",
      "personas/nested",
      "no-such-persona"
    ]);
    expect(resolved.personas.size).toBe(0);
    expect(resolved.warnings).toEqual([]);
  });
});
