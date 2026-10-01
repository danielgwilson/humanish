import { describe, expect, it } from "vitest";
import { scrubSecretValues } from "../../src/evidence/secret-scrub.js";

describe("scrubSecretValues", () => {
  it("scrubs a value of any length, and ignores an empty one", () => {
    expect(scrubSecretValues(["abc"])("refused abc")).toBe("refused [REDACTED_SECRET]");
    expect(scrubSecretValues([""])("refused abc")).toBe("refused abc");
  });

  it("removes a longer value whole when a shorter value is part of it", () => {
    const short = ["tango", "lima", "catch", "01"].join("-");
    const scrub = scrubSecretValues([short, `${short}-private`]);
    expect(scrub(`refused ${short}-private`)).toBe("refused [REDACTED_SECRET]");
  });

  it("removes percent-encoded, base64, base64url, hex and JSON-escaped forms", () => {
    const value = 'tango/lima+key"0123?';
    const scrub = scrubSecretValues([value]);
    for (const form of [
      encodeURIComponent(value),
      Buffer.from(value).toString("base64"),
      Buffer.from(value).toString("base64url"),
      Buffer.from(value).toString("hex"),
      JSON.stringify(value).slice(1, -1),
    ])
      expect(scrub(`refused ${form} here`)).toBe("refused [REDACTED_SECRET] here");
  });

  it("finds escape forms the encoders do not write, such as lowercase percent-encoding", () => {
    const scrub = scrubSecretValues(["tango/lima+key"]);
    const text = scrub("refused tango%2flima%2bkey");
    expect(text).not.toContain("tango");
    expect(text).toContain("[REDACTED_SECRET]");
  });

  it("leaves the marker intact when a value is part of it", () => {
    expect(scrubSecretValues(["SECRET", "tango-lima"])("refused tango-lima")).toBe(
      "refused [REDACTED_SECRET]",
    );
  });
});
