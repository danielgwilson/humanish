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

  it("removes a percent-encoded value with non-ASCII characters", () => {
    const value = `tango-${"é"}-lima-${"à"}`;
    const text = scrubSecretValues([value])(`refused ${encodeURIComponent(value)} here`);
    expect(text).toBe("refused [REDACTED_SECRET] here");
  });

  it("removes a value whose own characters are UTF-8 bytes read one by one", () => {
    const value = `tango-${"\u00c3\u00a9"}-lima`;
    expect(scrubSecretValues([value])("refused tango-%C3%A9-lima here")).toBe(
      "refused [REDACTED_SECRET] here",
    );
  });

  it("leaves the marker intact when a value is part of it", () => {
    expect(scrubSecretValues(["SECRET", "tango-lima"])("refused tango-lima")).toBe(
      "refused [REDACTED_SECRET]",
    );
  });

  // T is built at runtime so no literal looks like a credential.
  const T = ["tango", "lima", "catch", "01"].join("-");

  it("removes base64 and base64url of a value at any byte offset", () => {
    const scrub = scrubSecretValues([T]);
    for (const prefix of ["", "x", "xy"])
      for (const encoding of ["base64", "base64url"] as const) {
        const encoded = Buffer.from(prefix + T + "!").toString(encoding);
        // Only the characters the prefix and the trailing byte share may remain.
        expect(scrub(encoded)).toMatch(
          /^[A-Za-z0-9+/_-]{0,3}\[REDACTED_SECRET\][A-Za-z0-9+/_=-]{0,4}$/,
        );
      }
  });

  it("removes overlapping values that start at different places", () => {
    const scrub = scrubSecretValues([T, "catch-01-private-credential"]);
    expect(scrub(Buffer.from(`${T}-private-credential`).toString("hex"))).toBe("[REDACTED_SECRET]");
    expect(scrub(`${T}-private-credential`)).toBe("[REDACTED_SECRET]");
  });

  it("scrubs and returns the decoded text when the text has escapes", () => {
    const scrub = scrubSecretValues([T, `${T}-private`]);
    expect(scrub(`refused ${T}%2dprivate`)).toBe("refused [REDACTED_SECRET]");
  });

  it("never matches inside a marker", () => {
    expect(scrubSecretValues(["SECRET", T])(`${T} %20`)).toBe("[REDACTED_SECRET]  ");
    expect(scrubSecretValues(["SECRET"])("already [REDACTED_SECRET] here")).toBe(
      "already [REDACTED_SECRET] here",
    );
  });

  it("scrubs a value that is not well-formed Unicode without throwing", () => {
    const value = "x".repeat(16) + "\uD800";
    expect(scrubSecretValues([value])(`refused ${value}`)).toBe("refused [REDACTED_SECRET]");
  });
});
