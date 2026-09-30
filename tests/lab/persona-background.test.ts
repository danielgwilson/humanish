import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseResolvedPersona,
  renderPersonaPromptSection,
  personaBrief,
  scrubPersonaBrief,
  PERSONA_BACKGROUND_MAX_BYTES,
} from "../../src/lab/persona.js";
import { resolveCommittedPersonasForCwd } from "../../src/lab/persona-resolve.js";
import { composeLaneInstructions, withInboxMission } from "../../src/cua-actor-lab.js";
import { inspectLabManifest } from "../../src/lab/discover.js";
import { buildInitialRequest } from "../../src/actors/computer-use/openai-provider.js";
import { DEVICE_PRESETS } from "../../src/lab/device-presets.js";

const fallback = { id: "organizer", name: "Organizer" };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function project(persona: unknown) {
  const root = await mkdtemp(path.join(tmpdir(), "humanish-background-"));
  roots.push(root);
  await mkdir(path.join(root, "humanish/personas"), { recursive: true });
  await mkdir(path.join(root, "humanish/labs"), { recursive: true });
  await writeFile(path.join(root, "humanish/personas/organizer.yaml"), JSON.stringify(persona));
  await writeFile(
    path.join(root, "humanish/labs/study.yaml"),
    JSON.stringify({
      schema: "humanish.lab.v2",
      id: "study",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:8000" },
      actors: [
        {
          type: "openai-computer-use",
          persona: "organizer",
          mission: "Organize Saturday's event.",
        },
      ],
      scenario: { mode: "dry-run" },
      execution: { target: "e2b-desktop" },
    }),
  );
  return root;
}

describe("rich participant backgrounds", () => {
  it("preserves paragraphs and trailing facts through file resolution, inspection and provider composition", async () => {
    const background =
      "Coordinates volunteers with spreadsheets.\n\n".repeat(160) +
      "Final fact: previous public rosters caused unwanted contact.";
    const root = await project({ ...fallback, background });
    const resolved = await resolveCommittedPersonasForCwd(root, ["organizer"]);
    const persona = resolved.personas.get("organizer")!;
    expect(persona.background).toBe(background);
    expect(persona.traits).toEqual({});
    expect(resolved.warnings).toEqual([]);
    const composed = composeLaneInstructions({
      mission: "Organize Saturday's event.",
      resolvedPersona: persona,
      persona: "organizer",
      device: { name: "desktop", preset: DEVICE_PRESETS.desktop },
      tasks: [
        {
          id: "organize",
          goal: "Make the plan available to volunteers.",
          success: { any: [{ textIncludes: "hidden-evaluator-sentinel" }] },
        },
      ],
    });
    const request = buildInitialRequest({
      model: "synthetic-model",
      instructions: composed.instructions,
      reasoningEffort: "low",
    });
    expect(request.instructions).toContain(background);
    expect(request.instructions).not.toContain("hidden-evaluator-sentinel");
    expect(composed.persona.traitsApplied).toEqual([]);
    expect(composed.persona.brief?.text).toContain(background);
    expect(composed.persona.brief?.sourceDigest).toBeTruthy();
    expect(composed.persona.brief?.text).not.toContain("Organize Saturday's event.");
    const inspected = await inspectLabManifest(root, "study");
    expect(inspected.ok).toBe(true);
    expect(inspected.personas?.[0]?.brief).toEqual(composed.persona.brief);
  });

  it("rejects invalid and oversized backgrounds rather than silently running without them", async () => {
    for (const background of [123, "", "é".repeat(PERSONA_BACKGROUND_MAX_BYTES / 2 + 1)]) {
      const root = await project({ ...fallback, background });
      await expect(resolveCommittedPersonasForCwd(root, ["organizer"])).rejects.toThrow(
        "background",
      );
      expect(await inspectLabManifest(root, "study")).toMatchObject({
        ok: false,
        error: { code: "HUMANISH_LAB_INVALID" },
      });
    }
    const boundary = "a".repeat(PERSONA_BACKGROUND_MAX_BYTES);
    expect(parseResolvedPersona({ background: boundary }, fallback).background).toBe(boundary);
  });

  it("diagnoses discarded legacy values and unknown context without echoing their contents", () => {
    const warnings: string[] = [];
    const persona = parseResolvedPersona(
      {
        summary: "x".repeat(281),
        backstory: "unused private content",
        traits: { patience: "invalid", extra: "unused" },
        constraints: Array(10).fill("x".repeat(170)),
      },
      fallback,
      warnings,
    );
    expect(persona.summary).toHaveLength(280);
    expect(persona.constraints).toHaveLength(8);
    expect(warnings.join(" ")).toContain("Unsupported persona field");
    expect(warnings.join(" ")).toContain("shortened");
    expect(warnings.join(" ")).toContain("first eight");
    expect(warnings.join(" ")).not.toContain("unused private content");
    expect(persona.traits.patience).toBe("medium");
  });

  it("omits absent access needs and undeclared rich-profile traits while retaining explicit traits", () => {
    const warnings: string[] = [];
    const persona = parseResolvedPersona(
      {
        background: "Uses spreadsheets daily.",
        traits: { patience: "high", accessibility_needs: "none_declared" },
      },
      fallback,
      warnings,
    );
    const text = renderPersonaPromptSection(persona);
    expect(text).toContain("determined");
    expect(text).not.toContain("moderate technical");
    expect(text).not.toContain("none_declared");
    expect(text).not.toContain("one recovery");
    expect(warnings.join(" ")).toContain("conflicting instructions");
    expect(parseResolvedPersona({}, fallback).traits).toEqual({
      patience: "medium",
      skill: "medium",
    });
  });

  it("retains a redacted persona brief without changing the participant's actual context", () => {
    const secret = "synthetic-unshaped-secret";
    const persona = parseResolvedPersona(
      { background: `Public-safe context except ${secret}.` },
      fallback,
    );
    const reference = {
      id: persona.id,
      traitsApplied: [],
      promptDigest: "synthetic",
      brief: personaBrief(persona),
    };
    const sanitized = scrubPersonaBrief(reference, (text) =>
      text.replaceAll(secret, "[REDACTED_SECRET]"),
    );
    expect(sanitized.brief?.text).not.toContain(secret);
    expect(sanitized.brief?.redacted).toBe(true);
    expect(sanitized.brief?.digest).toBe(reference.brief.digest);
    expect(renderPersonaPromptSection(persona)).toContain(secret);
  });

  it("states where email is available without forbidding participant abandonment", () => {
    const spec = { instructions: "Arrange an event." } as Parameters<typeof withInboxMission>[0];
    const withInbox = withInboxMission(spec, "http://127.0.0.1:8000", "synthetic@example.test");
    expect(withInbox.instructions).toContain("Your inbox is available");
    expect(withInbox.instructions).toContain("stop based on your situation");
    expect(withInbox.instructions).not.toContain("do not end");
    expect(spec.instructions).toBe("Arrange an event.");
  });
});
