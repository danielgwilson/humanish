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

  it("scans redaction-shaped text that is not a marker the scrubbers write", () => {
    const code = "743921";
    const scrub = scrubSecretValues([code]);
    expect(scrub(`${code} [REDACTED_${code}]`)).toBe(
      "[REDACTED_SECRET] [REDACTED_[REDACTED_SECRET]]",
    );
    const hex = Buffer.from(code).toString("hex");
    expect(scrub(`[REDACTED_${hex}]`)).toBe("[REDACTED_[REDACTED_SECRET]]");
    expect(scrub("[REDACTED_74%33921]")).toBe("[REDACTED_[REDACTED_SECRET]]");
  });

  it("leaves the exact markers the scrubbers write, even when a value is part of one", () => {
    const markers = "[REDACTED_SECRET] [REDACTED_LOCAL_PATH] [REDACTED_RUNTIME_PATH]";
    expect(scrubSecretValues(["SECRET", "LOCAL_PATH", "RUNTIME"])(markers)).toBe(markers);
  });

  it("finds a percent-encoded UTF-8 value as written and lowercased", () => {
    const value = "café-secret";
    const scrub = scrubSecretValues([value]);
    expect(encodeURIComponent(value)).toBe("caf%C3%A9-secret");
    expect(scrub("refused caf%C3%A9-secret")).toBe("refused [REDACTED_SECRET]");
    expect(scrub("refused caf%c3%a9-secret")).toBe("refused [REDACTED_SECRET]");
  });

  it("returns percent-encoded UTF-8 decoded as UTF-8", () => {
    expect(scrubSecretValues([T])(`caf%C3%A9 ${T}`)).toBe("café [REDACTED_SECRET]");
  });

  it("finds a value as written when it holds an escape", () => {
    for (const value of ["pass%41word", "pass&amp;word", "pass\\u0041word"])
      expect(scrubSecretValues([value])(`refused ${value}`)).toBe("refused [REDACTED_SECRET]");
  });

  it("keeps the spelling of everything but the value when asked", () => {
    const scrub = scrubSecretValues(["743921", "café-secret"], { keepSpelling: true });
    expect(scrub("code 7%34%33921 at 50%25 off")).toBe("code [REDACTED_SECRET] at 50%25 off");
    expect(scrub("caf%C3%A9-secret and caf%C3%A9")).toBe("[REDACTED_SECRET] and caf%C3%A9");
    expect(scrub(`refused ${T}%2dprivate`)).toBe(`refused ${T}%2dprivate`);
    expect(scrub("7&#52;3921 &amp; \\u0041")).toBe("[REDACTED_SECRET] &amp; \\u0041");
  });

  it("scrubs a value that is not well-formed Unicode without throwing", () => {
    const value = "x".repeat(16) + "\uD800";
    expect(scrubSecretValues([value])(`refused ${value}`)).toBe("refused [REDACTED_SECRET]");
  });
});
