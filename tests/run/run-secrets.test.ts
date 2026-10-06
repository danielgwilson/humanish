import { describe, expect, it } from "vitest";

import { RunSecrets } from "../../src/run/secrets.js";

const value = (label: string): string => ["synthetic", label, "value"].join("-");

describe("RunSecrets", () => {
  it("replaces each seeded value with [REDACTED_SECRET] and leaves a value under four characters", () => {
    const secrets = new RunSecrets([value("key"), "abc", ""]);
    expect(secrets.values()).toEqual([value("key")]);
    expect(secrets.scrub(`use ${value("key")} and abc`)).toBe("use [REDACTED_SECRET] and abc");
  });

  it("takes a route's own marker and floor", () => {
    const secrets = new RunSecrets([value("repo"), "abc", ""], {
      marker: "[redacted]",
      minLength: 1,
    });
    expect(secrets.values()).toEqual([value("repo"), "abc"]);
    expect(secrets.scrub(`${value("repo")} abc`)).toBe("[redacted] [redacted]");
  });

  it("scrubs a value added after the scrub was handed out", () => {
    const secrets = new RunSecrets([value("key")]);
    const scrub = secrets.scrub;
    const values = secrets.values();
    secrets.add([value("address"), value("key"), "abc"]);
    expect(values).toEqual([value("key"), value("address")]);
    expect(scrub(`mail ${value("address")}`)).toBe("mail [REDACTED_SECRET]");
  });

  it("replaces a value a URL carries percent-encoded and leaves the rest of the text as written", () => {
    const spaced = ["synthetic", "known", "value"].join(" ");
    const secrets = new RunSecrets([spaced]);
    expect(
      secrets.scrub(`at http://127.0.0.1:3000/a%2Fb/${encodeURIComponent(spaced)}?q=%22`),
    ).toBe("at http://127.0.0.1:3000/a%2Fb/[REDACTED_SECRET]?q=%22");
    // An escape that is not UTF-8 stays as written beside the value.
    expect(secrets.scrub(`%E2 synthetic%20known%20value and ${spaced}`)).toBe(
      "%E2 [REDACTED_SECRET] and [REDACTED_SECRET]",
    );
    const json = JSON.stringify({ url: `https://example.test/%22${encodeURIComponent(spaced)}` });
    expect(JSON.parse(secrets.scrub(json))).toEqual({
      url: "https://example.test/%22[REDACTED_SECRET]",
    });
    expect(secrets.scrub("100% of 50%25 stays")).toBe("100% of 50%25 stays");
  });

  it("replaces a value's JSON-escaped and base64 forms, and keeps JSON text parseable", () => {
    const quoted = ["synthetic", '"quoted"', "value"].join(" ");
    const secrets = new RunSecrets([quoted]);
    expect(secrets.scrub(`printed ${JSON.stringify({ token: quoted })}`)).toBe(
      'printed {"token":"[REDACTED_SECRET]"}',
    );
    expect(secrets.scrub(`basic ${Buffer.from(quoted).toString("base64")}`)).toBe(
      "basic [REDACTED_SECRET]",
    );
    const backslash = ["synthetic", "value", "\\"].join("-");
    const json = JSON.stringify({ token: backslash, next: "kept" });
    expect(JSON.parse(new RunSecrets([backslash]).scrub(json))).toEqual({
      token: "[REDACTED_SECRET]",
      next: "kept",
    });
  });

  it("replaces a value a terminal escape sequence splits, with the sequence", () => {
    const secrets = new RunSecrets([value("key")]);
    const split = `${value("key").slice(0, 6)}\x1b[31m${value("key").slice(6)}`;
    expect(secrets.scrub(`printed ${split} here`)).toBe("printed [REDACTED_SECRET] here");
    expect(secrets.spans(`at ${split}`)).toEqual([[3, 3 + split.length]]);
  });

  it("replaces a value that an ASCII-only JSON serializer prints with \\u escapes", () => {
    const accented = ["synthetic", "caf\u00e9", "value"].join("-");
    const ascii = JSON.stringify({ key: accented }).replace("\u00e9", "\\u00e9");
    expect(ascii).toContain("\\u00e9");
    expect(new RunSecrets([accented]).scrub(ascii)).toBe('{"key":"[REDACTED_SECRET]"}');
  });

  it("replaces the JSON-escaped form of a value as short as the floor", () => {
    const short = ["q", '"', "z", "7"].join("");
    expect(new RunSecrets([short]).scrub(JSON.stringify({ key: short }))).toBe(
      '{"key":"[REDACTED_SECRET]"}',
    );
  });

  it("lists each value's forms longest first, for a scrub that matches across chunks", () => {
    const spaced = ["synthetic", "known", "value"].join(" ");
    const secrets = new RunSecrets([spaced]);
    const forms = secrets.forms();
    expect(secrets.values()).toEqual([spaced]);
    expect(forms).toContain(spaced);
    expect(forms).toContain(encodeURIComponent(spaced));
    expect(forms.map((form) => form.length)).toEqual(
      [...forms].map((form) => form.length).sort((left, right) => right - left),
    );
    secrets.add([value("address")]);
    expect(forms).toContain(value("address"));
  });

  it("leaves its values out of JSON and object spread", () => {
    const secrets = new RunSecrets([value("key")]);
    expect(JSON.stringify({ secrets })).not.toContain(value("key"));
    expect(JSON.stringify({ ...secrets })).not.toContain(value("key"));
  });
});
