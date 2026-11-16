import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { lab } from "../admission/fixtures.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { runStudyPreflight } from "../../src/study/preflight.js";

import {
  type ResolvedPersona,
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

  // 278 letters, an emoji (two UTF-16 units) at position 279, then two more letters: 281 code points.
  const emojiAt279 = `${"a".repeat(278)}\u{1F331}bb`;
  it.each([
    [
      "a writing sample",
      { writing_samples: [emojiAt279] },
      (p: ResolvedPersona) => p.writingSamples?.[0],
    ],
    ["the summary", { summary: emojiAt279 }, (p: ResolvedPersona) => p.summary],
  ])(
    "shortens %s by code point, keeping a character that spans two code units whole",
    (_field, raw, read) => {
      const shortened = read(parseResolvedPersona(raw, { id: "p", name: "P" }));
      expect(shortened).toBe(`${"a".repeat(278)}\u{1F331}\u2026`);
    },
  );

  it("keeps a constraint whose last character spans two code units whole when it shortens it", () => {
    const persona = parseResolvedPersona(
      { constraints: [`${"c".repeat(158)}\u{1F331}dd`] },
      { id: "p", name: "P" },
    );
    expect(persona.constraints[0]).toBe(`${"c".repeat(158)}\u{1F331}\u2026`);
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
    expect(warnings[0]).toMatch(/^writing_samples\[2\] .*\bkey\b/);
    expect(warnings[0]!.includes(key)).toBe(false);
  });

  // Built here so no committed file holds an address or a number shaped like a real one.
  const email = ["sam.rivers", "example.org"].join("@");
  const phone = ["+44", "20", "7946", "0958"].join(" ");
  const sampleWarnings = (samples: string[]) => {
    const warnings: string[] = [];
    parseResolvedPersona({ writing_samples: samples }, { id: "p", name: "P" }, warnings);
    return warnings;
  };

  it("warns, without echoing it, when a sample looks like it holds an email address", () => {
    const warnings = sampleWarnings(["ok", `send it to ${email} pls`]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^writing_samples\[2\] .*email address/);
    expect(warnings[0]!.includes(email)).toBe(false);
  });

  it.each([
    ["a phone number with spaces", phone],
    ["a phone number with dashes", ["020", "7946", "0958"].join("-")],
    ["a phone number with slashes", ["0791", "112", "3456"].join("/")],
    ["a phone number with dots", ["020", "7946", "0958"].join(".")],
    ["an order number", ["4821", "3377"].join("")],
    ["a card number", ["4000", "0000", "0000", "0002"].join(" ")],
    ["a date with a four-digit year, which has eight digits", ["12", "11", "2026"].join(".")],
  ])("warns when a sample holds %s", (_shape, number) => {
    const warnings = sampleWarnings([`it is ${number} ok`]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^writing_samples\[1\] .*a long number/);
    expect(warnings[0]!.includes(number)).toBe(false);
  });

  it("gives one warning naming each kind a sample looks like it holds", () => {
    const warnings = sampleWarnings([`${email} or ${phone}`]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/email address.*long number/);
  });

  it.each([
    "the one on the 14th",
    "flight 2 at 9:40",
    "row 12 seat 4",
    "booked for 3 nights in 2027",
    "it was \u00a312.99 last time",
    "back on 14/11",
    "gate B22, 45 min late",
    "the 3.5 kg bag of compost",
  ])("does not warn about an ordinary sample with a number in it: %s", (sample) => {
    expect(sampleWarnings([sample])).toEqual([]);
  });
});

describe("study check", () => {
  it("warns about a persona's writing sample that the evidence redaction would change", async () => {
    const cwd = await makeTestTempDir("humanish-writing-samples-");
    await mkdir(path.join(cwd, "humanish/studies"), { recursive: true });
    await mkdir(path.join(cwd, "humanish/personas"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish/studies/example.yaml"),
      stringify(lab("cuAppUrl", {}, { persona: "traveller" })),
    );
    const key = "sk-" + "syntheticvalue1234567890abcdef";
    await writeFile(
      path.join(cwd, "humanish/personas/traveller.yaml"),
      stringify({
        background: "Jordan flies twice a year to see family.",
        writing_samples: ["hi need to change my flight", `my login is ${key}`],
      }),
    );
    const check = await runStudyPreflight({ cwd, study: "example" });
    expect(check.ok).toBe(true);
    const samples = check.warnings.filter((warning) => warning.includes("writing_samples"));
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatch(/^humanish\/personas\/traveller\.yaml: writing_samples\[2\] /);
    expect(samples[0]!.includes(key)).toBe(false);
  });
});
