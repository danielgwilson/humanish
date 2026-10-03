// Committed personas must reach the browser run kinds, not just the terminal one.
//
// `composeParticipantInstructions` must not emit a bare `Persona: <id>.` line or hardcode
// `traitsApplied: []`: on every computer-use route that makes the persona axis a label with no
// behavior behind it. A live two-participant contrast (impatient expert vs patient newcomer) came
// back with near-identical action profiles, which looked like a finding about personas and was
// actually a finding about the composer. These tests assert the persona's compiled directive text
// lands in the prompt, because a prompt digest changing is not evidence that behavior changed.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { composeParticipantInstructions } from "../../src/routes/computer-use/participant-prompt.js";
import { DEVICE_PRESETS } from "../../src/study/device-presets.js";
import {
  labPersonaIds,
  personaTitleFromId,
  resolveCommittedPersona,
  resolveCommittedPersonasForCwd,
} from "../../src/study/persona-resolve.js";
import { prepareSelectedOutputDirectory } from "../../src/run/contained-output.js";
import { parseResolvedPersona, personaToDirectives } from "../../src/study/persona.js";

const DEVICE = { name: "desktop", preset: DEVICE_PRESETS.desktop } as const;

async function committed(id: string) {
  const raw = parseYaml(await readFile(path.resolve("humanish/personas", `${id}.yaml`), "utf8"));
  return parseResolvedPersona(raw, { id, name: personaTitleFromId(id) });
}

describe("composeParticipantInstructions applies committed personas", () => {
  it("puts the compiled directives in the prompt and records the traits truthfully", async () => {
    const persona = await committed("skeptical-power-user");
    const composed = composeParticipantInstructions({
      mission: "Sign in and rename the workspace.",
      persona: "skeptical-power-user",
      resolvedPersona: persona,
      device: DEVICE,
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
    const expert = composeParticipantInstructions({
      ...args,
      persona: "skeptical-power-user",
      resolvedPersona: await committed("skeptical-power-user"),
    });
    const newcomer = composeParticipantInstructions({
      ...args,
      persona: "synthetic-new-user",
      resolvedPersona: await committed("synthetic-new-user"),
    });

    expect(expert.instructions).not.toBe(newcomer.instructions);
    expect(expert.persona.promptDigest).not.toBe(newcomer.persona.promptDigest);
    expect(expert.persona.traitsApplied).not.toEqual(newcomer.persona.traitsApplied);
  });

  it("falls back to the bare id with empty traitsApplied when no persona resolved", () => {
    const composed = composeParticipantInstructions({
      mission: "Sign in and rename the workspace.",
      persona: "not-a-committed-persona",
      device: DEVICE,
    });
    expect(composed.instructions).toContain("Persona: not-a-committed-persona.");
    // A persona that declared nothing must never be credited with traits it does not have.
    expect(composed.persona.traitsApplied).toEqual([]);
  });
});

describe("committed persona resolution", () => {
  it("resolves ids the study config actually declares, per participant and per actor", () => {
    expect(labPersonaIds({ actors: [{ persona: "synthetic-new-user" }] })).toEqual([
      "synthetic-new-user",
    ]);
    expect(
      labPersonaIds({
        actors: [
          {
            persona: "synthetic-new-user",
            lanes: [{ persona: "skeptical-power-user" }, { persona: "synthetic-new-user" }],
          },
        ],
      }),
    ).toEqual(["synthetic-new-user", "skeptical-power-user"]);
    expect(labPersonaIds({ actors: [{ lanes: [{}] }] })).toEqual([]);
  });

  it("reads committed persona files from the project root", async () => {
    const resolved = await resolveCommittedPersonasForCwd(process.cwd(), [
      "skeptical-power-user",
      "synthetic-new-user",
    ]);
    expect(resolved.warnings).toEqual([]);
    expect(resolved.personas.get("skeptical-power-user")?.traits.patience).toBe("low");
    expect(resolved.personas.get("synthetic-new-user")?.traits.patience).toBe("medium");
  });

  it("reads a machine-local persona, and a committed persona with the same id wins", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-local-persona-"));
    try {
      const write = async (dir: string, id: string, patience: string) => {
        await mkdir(path.join(cwd, dir), { recursive: true });
        await writeFile(
          path.join(cwd, dir, `${id}.yaml`),
          `name: ${id}\ntraits:\n  patience: ${patience}\n`,
        );
      };
      await write(".humanish/local/personas", "local-only", "low");
      await write(".humanish/local/personas", "both-places", "low");
      await write("humanish/personas", "both-places", "high");
      const resolved = await resolveCommittedPersonasForCwd(cwd, ["local-only", "both-places"]);
      expect(resolved.warnings).toEqual([]);
      expect(resolved.personas.get("local-only")?.traits.patience).toBe("low");
      expect(resolved.personas.get("both-places")?.traits.patience).toBe("high");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("warns and falls back on a persona file that is not valid YAML", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-broken-persona-"));
    try {
      await mkdir(path.join(cwd, "humanish", "personas"), { recursive: true });
      await writeFile(
        path.join(cwd, "humanish", "personas", "broken.yaml"),
        "traits: {patience: low",
      );
      const projectRoot = await prepareSelectedOutputDirectory(path.dirname(cwd), cwd);
      const { persona, warnings } = await resolveCommittedPersona(projectRoot, "broken");
      expect(persona).toBeNull();
      expect(warnings.join(" ")).toContain("could not be parsed as YAML");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not resolve (and does not throw on) unsafe ids or missing files", async () => {
    const resolved = await resolveCommittedPersonasForCwd(process.cwd(), [
      "../../etc/passwd",
      "personas/nested",
      "no-such-persona",
    ]);
    expect(resolved.personas.size).toBe(0);
    expect(resolved.warnings).toHaveLength(3);
    expect(resolved.warnings.join(" ")).toContain("no persona context");
  });
});
