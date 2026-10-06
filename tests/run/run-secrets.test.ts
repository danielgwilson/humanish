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

  it("leaves its values out of JSON and object spread", () => {
    const secrets = new RunSecrets([value("key")]);
    expect(JSON.stringify({ secrets })).not.toContain(value("key"));
    expect(JSON.stringify({ ...secrets })).not.toContain(value("key"));
  });
});
