// A persona id names a persona file, a desktop template names the image a run launches on, and a
// desktop file's `as` names where it lands, and the run records all three. Redacting one would
// name another file, image or path, so the parser refuses one that looks like a secret or a local
// path. The values come from SECRET_FORMATS, each of which
// makes verify grade a run blocked; tests/run/planted-study-secrets.test.ts checks the bundles.
import { describe, expect, it } from "vitest";

import { containsSensitive } from "../../src/evidence/redaction.js";
import { parseStudy } from "../../src/study/config.js";
import { lab, type RawLab } from "../admission/fixtures.js";
import { SECRET_FORMATS, synthetic } from "../helpers/secret-formats.js";

const FIELDS: readonly (readonly [string, (text: string) => RawLab])[] = [
  ["actor.persona", (text) => lab("cuAppUrl", {}, { persona: text })],
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
