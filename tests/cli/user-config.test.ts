import path from "node:path";

import { describe, expect, it } from "vitest";

import { envFlag, humanishConfigFile } from "../../src/cli/user-config.js";

describe("where humanish keeps a per-user file", () => {
  it("uses an absolute XDG_CONFIG_HOME", () => {
    expect(humanishConfigFile({ XDG_CONFIG_HOME: "/srv/config" }, "keys.env", "/home/dev")).toBe(
      path.join("/srv/config", "humanish", "keys.env"),
    );
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset or blank", () => {
    expect(humanishConfigFile({}, "telemetry.json", "/home/dev")).toBe(
      path.join("/home/dev", ".config", "humanish", "telemetry.json"),
    );
    expect(humanishConfigFile({ XDG_CONFIG_HOME: "  " }, "telemetry.json", "/home/dev")).toBe(
      path.join("/home/dev", ".config", "humanish", "telemetry.json"),
    );
  });

  it("ignores a relative XDG_CONFIG_HOME, so the file never lands in the open project", () => {
    expect(
      humanishConfigFile({ XDG_CONFIG_HOME: "relative/path" }, "update-check.json", "/home/dev"),
    ).toBe(path.join("/home/dev", ".config", "humanish", "update-check.json"));
  });
});

describe("reading an on/off environment variable", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["  ", false],
    ["0", false],
    ["false", false],
    ["FALSE", false],
    [" false ", false],
    ["1", true],
    ["true", true],
    ["yes", true],
  ] as const)("reads %j as %s", (value, on) => {
    expect(envFlag(value)).toBe(on);
  });
});
