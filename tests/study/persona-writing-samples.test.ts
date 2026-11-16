import { describe, expect, it } from "vitest";

import {
  parseResolvedPersona,
  personaBrief,
  personaToDirectives,
  renderPersonaPromptSection,
} from "../../src/study/persona.js";

const GARDENER = {
  schema: "humanish.persona.v1",
  id: "weekend-gardener",
  name: "Priya",
  summary: "Plans a vegetable bed on weekends.",
  background: "Priya keeps a small allotment.\nShe looks things up on her tablet in the evening.",
  traits: {
    patience: "low",
    technical_confidence: "medium",
    accessibility_needs: "keyboard_first",
  },
  constraints: ["Use only the sample plot", "Do not buy anything"],
};

// Recorded from origin/main at 08d26adf3, before writing samples existed.
const GARDENER_SECTION_BEFORE =
  "Persona: Priya.\n\nPlans a vegetable bed on weekends.\n\nBackground:\nPriya keeps a small allotment.\nShe looks things up on her tablet in the evening.\n\nYou are impatient: if you hit repeated friction or stop making progress toward your goal, you are likely to stop. Describe what you actually encountered.\n\nYou have moderate technical confidence and generally use straightforward paths through the product.\n\nYou prefer keyboard navigation, but can use a pointer when needed. Describe any difficulty you encounter switching between them.\n\nHonor these constraints: Use only the sample plot; Do not buy anything.";
const GARDENER_DIGEST_BEFORE = "0ec5dbc15106";

const traveller = (samples: unknown, extra: Record<string, unknown> = {}) =>
  parseResolvedPersona(
    {
      id: "returning-traveller",
      name: "Jordan",
      background: "Jordan flies twice a year to see family.",
      traits: { patience: "low" },
      writing_samples: samples,
      ...extra,
    },
    { id: "returning-traveller", name: "Returning Traveller" },
  );

describe("a persona without writing samples", () => {
  it("renders the section recorded before writing samples existed", () => {
    const persona = parseResolvedPersona(GARDENER, { id: "weekend-gardener", name: "Fallback" });
    expect(renderPersonaPromptSection(persona)).toBe(GARDENER_SECTION_BEFORE);
    expect(personaBrief(persona).digest).toBe(GARDENER_DIGEST_BEFORE);
    expect(personaToDirectives(persona).traitsApplied).toEqual([
      "patience:low",
      "skill:medium",
      "accessibility:keyboard_first",
      "constraints:2",
    ]);
  });
});

describe("writing samples in the persona section", () => {
  it("come after the background and before the trait directives", () => {
    const persona = traveller(["hi need to change my flight", "the one on the 14th"]);
    expect(renderPersonaPromptSection(persona)).toBe(
      [
        "Persona: Jordan.",
        "Background:\nJordan flies twice a year to see family.",
        'These are messages Jordan typed earlier, about other things; the details in them do not apply now. They show how Jordan writes: (1) "hi need to change my flight" (2) "the one on the 14th"',
        "You are impatient: if you hit repeated friction or stop making progress toward your goal, you are likely to stop. Describe what you actually encountered.",
      ].join("\n\n"),
    );
  });

  it("escape a double quote and a backslash inside a sample", () => {
    const persona = traveller(['she said "ok" to the window seat', "row 12\\14"]);
    const section = renderPersonaPromptSection(persona).split("\n\n")[2];
    expect(section).toBe(
      'These are messages Jordan typed earlier, about other things; the details in them do not apply now. They show how Jordan writes: (1) "she said \\"ok\\" to the window seat" (2) "row 12\\\\14"',
    );
  });

  it("name an unnamed persona by its id in title case", () => {
    const persona = parseResolvedPersona(
      { writing_samples: ["is the shed paint dry yet"] },
      { id: "weekend-gardener", name: "Weekend Gardener" },
    );
    expect(renderPersonaPromptSection(persona).split("\n\n")[1]).toBe(
      'These are messages Weekend Gardener typed earlier, about other things; the details in them do not apply now. They show how Weekend Gardener writes: (1) "is the shed paint dry yet"',
    );
  });

  it("are counted in the applied traits and raise the compiler version", () => {
    const persona = traveller(["hi need to change my flight", "no the return"]);
    expect(personaToDirectives(persona).traitsApplied).toEqual([
      "patience:low",
      "writing_samples:2",
    ]);
    expect(personaBrief(persona).compilerVersion).toBe(3);
  });

  it("go through the brief's redaction", () => {
    const key = "sk-" + "syntheticvalue1234567890abcdef";
    const persona = traveller([`my code is ${key}`]);
    const brief = personaBrief(persona);
    expect(renderPersonaPromptSection(persona).includes(key)).toBe(true);
    expect(brief.text.includes(key)).toBe(false);
    expect(brief.redacted).toBe(true);
  });
});

describe("parsing writing samples", () => {
  it("collapses whitespace and drops empty lines", () => {
    const warnings: string[] = [];
    const persona = parseResolvedPersona(
      { writing_samples: ["  where   do I\n\tpay ", "   "] },
      { id: "p", name: "P" },
      warnings,
    );
    expect(persona.writingSamples).toEqual(["where do I pay"]);
    expect(warnings).toEqual([]);
  });

  it("keeps the first eight samples and warns about the rest", () => {
    const warnings: string[] = [];
    const samples = Array.from({ length: 10 }, (_, index) => `message ${index + 1}`);
    const persona = parseResolvedPersona(
      { writing_samples: samples },
      { id: "p", name: "P" },
      warnings,
    );
    expect(persona.writingSamples).toEqual(samples.slice(0, 8));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^writing_samples /);
  });

  it("shortens a sample past 280 characters after collapsing whitespace, with a warning", () => {
    const warnings: string[] = [];
    // 392 characters as written, 279 once each run of spaces is one space.
    const fits = "word   ".repeat(56);
    const tooLong = "b".repeat(281);
    const persona = parseResolvedPersona(
      { writing_samples: [fits, tooLong] },
      { id: "p", name: "P" },
      warnings,
    );
    expect(persona.writingSamples?.[0]).toHaveLength(279);
    expect(persona.writingSamples?.[1]).toHaveLength(280);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^writing_samples\[2\] /);
  });

  it("ignores an entry that is not text, with a warning naming its position", () => {
    const warnings: string[] = [];
    const persona = parseResolvedPersona(
      { writing_samples: ["ok thanks", 42, { text: "nested" }] },
      { id: "p", name: "P" },
      warnings,
    );
    expect(persona.writingSamples).toEqual(["ok thanks"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^writing_samples\[2\] /);
    expect(warnings[1]).toMatch(/^writing_samples\[3\] /);
  });

  it("ignores a value that is not a list, with a warning", () => {
    const warnings: string[] = [];
    const persona = parseResolvedPersona(
      { writing_samples: "hi need to change my flight" },
      { id: "p", name: "P" },
      warnings,
    );
    expect(persona.writingSamples).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/writing_samples/);
  });

  it("warns, without echoing it, when the evidence redaction would change a sample", () => {
    const key = "sk-" + "syntheticvalue1234567890abcdef";
    const warnings: string[] = [];
    const persona = parseResolvedPersona(
      { writing_samples: ["fine", `use ${key} for the login`] },
      { id: "p", name: "P" },
      warnings,
    );
    expect(persona.writingSamples).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^writing_samples\[2\] /);
    expect(warnings[0]!.includes(key)).toBe(false);
  });
});
