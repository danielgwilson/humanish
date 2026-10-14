// A persona id names a persona file, a desktop template names the image a run launches on, a
// desktop file's `as` names where it lands, and actor.model names the model a provider runs. The
// run records all four. Redacting one would name another file, image, path or model, so the parser
// refuses one that looks like a secret or a local path. The values come from SECRET_FORMATS, each
// of which makes verify grade a run blocked; tests/run/planted-study-secrets.test.ts checks the
// bundles.
import { describe, expect, it } from "vitest";

import { containsSensitive } from "../../src/evidence/redaction.js";
import { parseStudy } from "../../src/study/config.js";
import { lab, type RawLab } from "../admission/fixtures.js";
import { DEFAULT_OPENAI_CU_MODEL } from "../../src/actors/computer-use/openai-provider.js";
import { SECRET_ENCODINGS, SECRET_FORMATS, synthetic } from "../helpers/secret-formats.js";

const FIELDS: readonly (readonly [string, (text: string) => RawLab])[] = [
  ["actor.persona", (text) => lab("cuAppUrl", {}, { persona: text })],
  ["actor.model", (text) => lab("terminal", {}, { model: text })],
  [
    "participants[1].persona",
    (text) => lab("cuAppUrl", { participants: [{ id: "p1" }, { id: "p2", persona: text }] }),
  ],
  [
    "execution.desktop.template",
    (text) => lab("cuAppUrl", { execution: { desktop: { template: text } } }),
  ],
  [
    "participants[0].files[0].as",
    (text) =>
      lab("cuAppUrl", { participants: [{ id: "p1", files: [{ from: "card.png", as: text }] }] }),
  ],
];

describe.each(FIELDS)("%s", (field, study) => {
  it.each(SECRET_FORMATS.map(({ name, text }) => [name, text]))(
    "is refused when it holds a %s, in a message that names the field and holds no secret",
    (_name, text) => {
      const parsed = parseStudy(study(text));
      if (parsed.ok) throw new Error("parsed");
      expect(parsed.error.code).toBe("HUMANISH_STUDY_INVALID");
      expect(parsed.error.message).toContain(`\`${field}\``);
      expect(containsSensitive(parsed.error.message)).toBe(false);
    },
  );
});

describe("actor.model in each encoding verify decodes", () => {
  it.each(Object.entries(SECRET_ENCODINGS))(
    "refuses a key %s, in a message that does not repeat it",
    (_name, encode) => {
      const model = encode(SECRET_FORMATS[0]!.text);
      const parsed = parseStudy(lab("cuAppUrl", {}, { model }));
      if (parsed.ok) throw new Error("parsed");
      expect(parsed.error.message).toContain("`actor.model`");
      expect(parsed.error.message).not.toContain(model);
    },
  );

  it.each([DEFAULT_OPENAI_CU_MODEL, "gpt-5.4-mini", "computer-use-preview-2025-03-11"])(
    "keeps the model id %s",
    (model) => {
      const parsed = parseStudy(lab("cuAppUrl", {}, { model }));
      if (!parsed.ok) throw new Error(parsed.error.message);
      expect(parsed.config.actor?.model).toBe(model);
    },
  );
});

describe("ids that hold no secret", () => {
  it("keep a persona id that is not a file name, which runs with the id only as before", () => {
    const parsed = parseStudy(lab("cuAppUrl", {}, { persona: "Busy parent on a phone" }));
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.config.actor?.persona).toBe("Busy parent on a phone");
  });

  it.each([
    ["a template name", "desktop-node22"],
    ["a template id as E2B writes one", synthetic("abcdefghijklmnopqrstuvwxyz0123456789", 20, 7)],
  ])("keep %s", (_name, template) => {
    const parsed = parseStudy(lab("cuAppUrl", { execution: { desktop: { template } } }));
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.config.execution?.desktop?.template).toBe(template);
  });
});
