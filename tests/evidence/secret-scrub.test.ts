import { describe, expect, it } from "vitest";
import { redactText } from "../../src/evidence/redaction.js";
import { scrubSecretValues } from "../../src/evidence/secret-scrub.js";
import { survivingForm } from "../helpers/scrub-model.js";

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

  // Each find is checked against the markers by binary search. A scan of every marker per find
  // took about 6 s on this input.
  it("scrubs 1 MiB of markers and values in linear time", () => {
    const text = "[REDACTED_SECRET]%20743921 ".repeat(40_000);
    const started = performance.now();
    const scrubbed = scrubSecretValues(["743921"])(text);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(scrubbed).not.toContain("743921");
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

  it("removes a value that an escape splits", () => {
    const scrub = scrubSecretValues([T, `${T}-private`]);
    expect(scrub(`refused ${T}%2dprivate`)).toBe("refused [REDACTED_SECRET]");
  });

  it("never matches inside a marker", () => {
    expect(scrubSecretValues(["SECRET", T])(`${T} %20`)).toBe("[REDACTED_SECRET] %20");
    expect(scrubSecretValues(["SECRET"])("already [REDACTED_SECRET] here")).toBe(
      "already [REDACTED_SECRET] here",
    );
  });

  it("scrubs a value that is not well-formed Unicode without throwing", () => {
    const value = "x".repeat(16) + "\uD800";
    expect(scrubSecretValues([value])(`refused ${value}`)).toBe("refused [REDACTED_SECRET]");
  });

  it("keeps the text around a value as written", () => {
    expect(scrubSecretValues(["743921"])("a%20b 7%343921 c%2Fd")).toBe(
      "a%20b [REDACTED_SECRET] c%2Fd",
    );
    expect(scrubSecretValues(["TH]h"])("\\u0054\\u0048]\\u0068%5E")).toBe("[REDACTED_SECRET]%5E");
  });

  it("returns text with no value unchanged, escapes and all", () => {
    for (const text of ["\\/", "%25", "&amp; %C3%A9 \\u0041"])
      expect(scrubSecretValues(["743921"])(text)).toBe(text);
  });

  it("leaves a value encoded twice as it is written, so one decoding of the output shows no value", () => {
    // Returning the decoded text would show %4d, which decodes to M.
    expect(scrubSecretValues(["PPQM"])("%50%50%51%254d")).toBe("%50%50%51%254d");
  });

  it("finds a value inside a marker-shaped span that no scrub writes", () => {
    const hex = Buffer.from("743921").toString("hex");
    for (const text of [`[REDACTED_${hex}]`, "[REDACTED_74%33921]", "[REDACTED_743921]"])
      expect(scrubSecretValues(["743921"])(text)).toBe("[REDACTED_[REDACTED_SECRET]]");
    expect(scrubSecretValues(["0346"])("[REDACTED_034\\u0036]")).toBe(
      "[REDACTED_[REDACTED_SECRET]]",
    );
    expect(scrubSecretValues(["DACT"])("[REDACTED_T]")).toBe("[RE[REDACTED_SECRET]ED_T]");
  });

  it("removes a value that crosses a marker's edge", () => {
    const scrub = scrubSecretValues(["swordfish["]);
    expect(scrub("swordfish[[REDACTED_SECRET]")).toBe("[REDACTED_SECRET][REDACTED_SECRET]");
    expect(scrub("swordfish[REDACTED_SECRET]")).toBe("[REDACTED_SECRET]REDACTED_SECRET]");
    expect(scrubSecretValues(["]YNQ"])("[REDACTED_T]YNQ")).toBe("[REDACTED_T[REDACTED_SECRET]");
  });

  it("removes a value escaped in sequence, with a byte-order mark, or holding an escape", () => {
    expect(scrubSecretValues(["743921"])("7%343921")).toBe("[REDACTED_SECRET]");
    const marked = "tango\uFEFFlima";
    for (const text of ["x tango%EF%BB%BFlima y", "x tango\\ufefflima y", `x ${marked} y`])
      expect(scrubSecretValues([marked])(text)).toBe("x [REDACTED_SECRET] y");
    const hex = Buffer.from("743921").toString("hex");
    expect(scrubSecretValues(["pass%41word", "743921"])(`pass%41word and ${hex}`)).toBe(
      "[REDACTED_SECRET] and [REDACTED_SECRET]",
    );
  });

  it("removes a percent-encoded value with a non-ASCII character", () => {
    expect(scrubSecretValues(["café-secret"])("refused caf%C3%A9-secret here")).toBe(
      "refused [REDACTED_SECRET] here",
    );
  });

  it("keeps a value that is part of a marker inside the marker and removes it elsewhere", () => {
    expect(scrubSecretValues(["SECRET"])("SECRET [REDACTED_SECRET]")).toBe(
      "[REDACTED_SECRET] [REDACTED_SECRET]",
    );
    expect(scrubSecretValues(["[REDACTED_SECRET]"])("[REDACTED_SECRET]")).toBe("[REDACTED_SECRET]");
  });

  it("replaces the whole text when replacing a value that holds marker text spells it again", () => {
    // The marker that replaces `T] x` ends in `T]`, which spells the value with the next ` x`.
    expect(scrubSecretValues(["T] x"])("[REDACTED_SECRET] x x")).toBe("[REDACTED_SECRET]");
    const hex = Buffer.from("743921").toString("hex");
    const values = ["[REDACTED_SECRET]x", "743921"];
    const text = `[REDACTED_SECRET]x%78%78 ${hex}`;
    expect(survivingForm(values, scrubSecretValues(values)(text))).toBeUndefined();
  });

  it("keeps every marker redactText writes", () => {
    const home = ["", "home", "participant", "notes.txt"].join("/");
    const key = "sk-" + "syntheticvalue1234567890abcdef";
    const written = redactText(`/tmp/run-1 ${home} ${key}`);
    const markers = written.match(/\[REDACTED_[A-Z_]+\]/g) ?? [];
    expect(new Set(markers)).toEqual(
      new Set(["[REDACTED_LOCAL_PATH]", "[REDACTED_RUNTIME_PATH]", "[REDACTED_SECRET]"]),
    );
    for (const marker of markers)
      expect(scrubSecretValues([marker.slice(1, -1)])(marker)).toBe(marker);
  });
});
