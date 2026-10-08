import { describe, expect, it } from "vitest";
import { decodeEscapes } from "../../src/evidence/encoded-text.js";
import { redactText } from "../../src/evidence/redaction.js";
import { encodedForms, scrubSecretValues } from "../../src/evidence/secret-scrub.js";
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

describe("scrubSecretValues on encoded and marker-shaped text", () => {
  it("returns the decoded text when it holds no value", () => {
    for (const text of ["\\/", "%25", "&amp; %C3%A9 \\u0041"])
      expect(scrubSecretValues(["743921"])(text)).toBe(decodeEscapes(text));
  });

  it("replaces the whole text when its decoded text still decodes to a value", () => {
    // A value encoded twice: the decoded text shows %4d, which decodes to M.
    expect(scrubSecretValues(["PPQM"])("%50%50%51%254d")).toBe("[REDACTED_SECRET]");
  });

  it("returns the UTF-8 reading when it finds more values", () => {
    // Only é is percent-encoded, so the byte reading shows Ã© next to a literal à.
    expect(scrubSecretValues(["tango-é-à"])("x tango-%C3%A9-à y")).toBe("x [REDACTED_SECRET] y");
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

  it("removes a value escaped in sequence or holding a byte-order mark", () => {
    expect(scrubSecretValues(["743921"])("7%343921")).toBe("[REDACTED_SECRET]");
    const marked = "tango\uFEFFlima";
    for (const text of ["x tango%EF%BB%BFlima y", "x tango\\ufefflima y", `x ${marked} y`])
      expect(scrubSecretValues([marked])(text)).toBe("x [REDACTED_SECRET] y");
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

  it("reads `&constructor;` as written and finds the value after it", () => {
    // Lower-case letters, digits and four capitals, built here so no long literal looks like a key.
    const run = (first: string, count: number): string =>
      String.fromCharCode(...Array.from({ length: count }, (_, at) => first.charCodeAt(0) + at));
    const value = run("a", 26) + run("0", 10) + run("A", 4);
    const text = `&constructor; %61${value.slice(1)}${"!".repeat(40)}`;
    expect(scrubSecretValues([value])(text)).toBe(
      `&constructor; [REDACTED_SECRET]${"!".repeat(40)}`,
    );
  });

  it("keeps the text around a value inside an entity it does not know", () => {
    expect(scrubSecretValues(["value"])("a%20&xvaluey;z")).toBe("a &x[REDACTED_SECRET]y;z");
  });

  it("removes a value whose UTF-8 reading is its own bytes read as Latin-1", () => {
    // xÃ©z is the bytes of xéz read one per character; reading them as UTF-8 recovers xéz.
    expect(encodedForms("xÃ©z")).toContain("xéz");
    expect(encodedForms("Ãz")).not.toContain("z");
    const scrub = scrubSecretValues(["xÃ©z", "éàxx"]);
    expect(scrub("x%C3%A9z é%C3%A0xx é%C3%A0xx")).toBe(
      "[REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET]",
    );
    expect(scrub("x%C3%A9z é%C3%A0xx")).toBe("[REDACTED_SECRET] [REDACTED_SECRET]");
  });

  it("keeps the text of every marker humanish writes", () => {
    const scrub = scrubSecretValues(["TEXT", "CODE"]);
    expect(scrub("[REDACTED_PROMPT_TEXT] [REDACTED_LOBBY_CODE] TEXT CODE")).toBe(
      "[REDACTED_PROMPT_TEXT] [REDACTED_LOBBY_CODE] [REDACTED_SECRET] [REDACTED_SECRET]",
    );
  });
});

describe("scrubSecretValues on values that overlap themselves", () => {
  /** Milliseconds for the fastest of five scrubs. */
  const fastest = (values: string[], text: string): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const started = performance.now();
      scrubSecretValues(values)(text);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };

  // Each shape grows the value with the text, so a search that compares the value again at every
  // overlapping start takes sixteen times as long for four times the length: one letter took
  // 1.42 s at 131,072 characters and 92.6 s at 1 MiB. Linear takes about four times as long.
  it.each([
    ["a run of one letter", (n: number) => ["a".repeat(n / 2)], (n: number) => "a".repeat(n)],
    [
      "two letters read as UTF-8",
      (n: number) => ["éà".repeat(n / 4)],
      (n: number) => "é%C3%A0".repeat(n / 2),
    ],
    [
      "a letter encoded twice",
      (n: number) => ["a".repeat(n / 2)],
      (n: number) => "%2561".repeat(n),
    ],
  ])("scrubs %s in time linear in its length", (_shape, values, text) => {
    const [small, large] = [32_768, 131_072];
    expect(scrubSecretValues(values(small))(text(small))).toBe("[REDACTED_SECRET]");
    const ratio =
      fastest(values(large), text(large)) / Math.max(20, fastest(values(small), text(small)));
    expect(ratio).toBeLessThan(10);
  });
});
