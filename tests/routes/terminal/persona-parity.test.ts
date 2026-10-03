// The dry and live terminal paths must resolve the persona the same way. One lab runs both ways in
// one project. The persona ref each path hands its bundle builder must match, and both prompts must
// start with the same persona line. The live prompt is read from the fake codex command; the dry
// prompt is bound by digest only, so its digest is checked against the dry composer fed the live
// persona line.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorPersonaRef } from "../../../src/actors/contract.js";
import { digestText } from "../../../src/evidence/redaction.js";
import { renderPersonaPromptSection } from "../../../src/study/persona.js";
import { resolveCommittedPersonasForCwd } from "../../../src/study/persona-resolve.js";
import type { StudyConfig } from "../../../src/study/types.js";
import {
  buildLiveTerminalProductBundle,
  buildTerminalProductBundle,
} from "../../../src/routes/terminal/bundle.js";
import { composePrompt } from "../../../src/routes/terminal/dry-run.js";
import { runTerminalProductStudy } from "../../../src/routes/terminal/route.js";
import { passingRun, terminalConfig } from "../../helpers/terminal-live-fake.js";

vi.mock("../../../src/routes/terminal/bundle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/routes/terminal/bundle.js")>();
  return {
    ...actual,
    buildTerminalProductBundle: vi.fn(actual.buildTerminalProductBundle),
    buildLiveTerminalProductBundle: vi.fn(actual.buildLiveTerminalProductBundle),
  };
});

const PERSONA_ID = "autonomous-creative-agent";
const MISSION = "Discover widget-cli from public surfaces.";
const PRODUCT = { name: "widget-cli", publicSurfaces: ["https://example.com/widget"] };

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-tp-persona-parity-"));
  vi.mocked(buildTerminalProductBundle).mockClear();
  vi.mocked(buildLiveTerminalProductBundle).mockClear();
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function config(persona: string | undefined): StudyConfig {
  return terminalConfig({
    actors: [{ type: "codex-exec", mission: MISSION, ...(persona ? { persona } : {}) }],
    review: { analysis: false },
  });
}

async function writePersonaFile(): Promise<void> {
  await mkdir(path.join(cwd, "humanish", "personas"), { recursive: true });
  await writeFile(
    path.join(cwd, "humanish", "personas", `${PERSONA_ID}.yaml`),
    [
      `id: ${PERSONA_ID}`,
      "name: Autonomous Creative Agent",
      "traits:",
      "  patience: low",
      "  technical_confidence: high",
      "constraints:",
      "  - Only use public surfaces",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** The prompt is the final, single-quoted argument of the codex command. */
function promptOf(command: string): string {
  const marker = " --json '";
  const start = command.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  expect(command.endsWith("'")).toBe(true);
  return command.slice(start + marker.length, -1).replaceAll("'\\''", "'");
}

const personaWarnings = (warnings: readonly string[]) =>
  warnings.filter((warning) => warning.startsWith("Persona "));

/** Runs the lab dry, then live, and checks that both resolved the same persona. */
async function expectSamePersona(lab: StudyConfig) {
  const dry = await runTerminalProductStudy({ cwd, config: lab, dryRun: true, open: false });
  const commands: string[] = [];
  const live = await runTerminalProductStudy({
    cwd,
    config: lab,
    dryRun: false,
    open: false,
    ...passingRun({}, commands),
  });
  expect(dry.ok).toBe(true);
  expect(live.ok).toBe(true);
  expect(commands).toHaveLength(1);
  expect(vi.mocked(buildTerminalProductBundle)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(buildLiveTerminalProductBundle)).toHaveBeenCalledTimes(1);

  const dryRef: ActorPersonaRef = vi.mocked(buildTerminalProductBundle).mock.calls[0]![0].persona;
  const liveRef: ActorPersonaRef = vi.mocked(buildLiveTerminalProductBundle).mock.calls[0]![0]
    .persona;
  const livePrompt = promptOf(commands[0]!);
  const personaLine = livePrompt.slice(0, livePrompt.indexOf("\nproduct: "));

  const { promptDigest: dryDigest, ...dryFields } = dryRef;
  const { promptDigest: liveDigest, ...liveFields } = liveRef;
  expect(dryFields).toEqual(liveFields);
  expect(personaWarnings(dry.warnings)).toEqual(personaWarnings(live.warnings));
  expect(liveDigest).toBe(digestText(livePrompt));
  // The dry prompt starts with the same persona line the live agent received.
  expect(dryDigest).toBe(
    digestText(
      composePrompt({
        mission: MISSION,
        personaLine,
        productName: PRODUCT.name,
        publicSurfaces: PRODUCT.publicSurfaces,
      }),
    ),
  );
  return { ref: liveRef, personaLine, warnings: personaWarnings(live.warnings) };
}

describe("terminal persona parity between the dry and live paths", () => {
  it("resolves a committed persona file to the same traits, brief and prompt line", async () => {
    await writePersonaFile();
    const { ref, personaLine, warnings } = await expectSamePersona(config(PERSONA_ID));

    const resolved = (await resolveCommittedPersonasForCwd(cwd, [PERSONA_ID])).personas.get(
      PERSONA_ID,
    );
    expect(resolved).toBeDefined();
    expect(personaLine).toBe(renderPersonaPromptSection(resolved!));
    expect(ref.id).toBe(PERSONA_ID);
    expect(ref.traitsApplied).toEqual(expect.arrayContaining(["patience:low", "skill:high"]));
    expect(ref.brief).toBeDefined();
    expect(warnings).toEqual([]);
  });

  it("falls back to the persona id on both paths when no persona file is committed", async () => {
    const { ref, personaLine, warnings } = await expectSamePersona(config(PERSONA_ID));

    expect(personaLine).toBe(`persona: ${PERSONA_ID}`);
    expect(ref).toMatchObject({ id: PERSONA_ID, traitsApplied: [] });
    expect(ref.brief).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("uses the same default persona id on both paths when the actor names none", async () => {
    const { ref, personaLine } = await expectSamePersona(config(undefined));

    expect(ref.id).toBe("autonomous-terminal-agent");
    expect(personaLine).toBe("persona: autonomous-terminal-agent");
  });
});
