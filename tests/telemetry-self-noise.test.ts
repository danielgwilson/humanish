import { describe, expect, it } from "vitest";
import { disabledByEnvironment, inHumanishCheckout, isOwnCheckoutRun } from "../src/telemetry.js";

// In the two days after telemetry shipped in 0.62.0, 82% of all events (4,042 of 4,932, from 49
// of 59 anonymous ids) came from humanish's own CI and test suite. The shape gave it away: about
// fifty ids each running nearly every subcommand roughly once, which is a test matrix rather than
// a group of people. The one number whose job is measuring adoption was measuring us.

function fakeReader(files: Record<string, string>): (p: string) => string {
  return (p: string) => {
    const found = files[p];
    if (found === undefined) throw new Error(`ENOENT ${p}`);
    return found;
  };
}

describe("telemetry excludes our own runs (metric integrity)", () => {
  it("detects a humanish source checkout from a nested directory", () => {
    const files = { "/repo/package.json": JSON.stringify({ name: "humanish", private: true }) };
    expect(inHumanishCheckout("/repo/src/deep/nested", fakeReader(files))).toBe(true);
  });

  it("does not match an adopter's project that merely depends on humanish", () => {
    const files = {
      "/app/package.json": JSON.stringify({ name: "acme-web", dependencies: { humanish: "^0.62.0" } })
    };
    // This is the case that must keep reporting: a real user, in their own project.
    expect(inHumanishCheckout("/app", fakeReader(files))).toBe(false);
  });

  it("does not match humanish installed inside node_modules", () => {
    const files = {
      "/app/node_modules/humanish/package.json": JSON.stringify({ name: "humanish" }),
      "/app/package.json": JSON.stringify({ name: "acme-web" })
    };
    expect(inHumanishCheckout("/app/node_modules/humanish", fakeReader(files))).toBe(false);
  });

  it("a CLI spawned from our checkout into a temp cwd is still ours (the walk the 0.63.0 fix lacked)", () => {
    // This box: tests, the TUI smoke and the release dogfood spawn dist/cli.js with cwd under /tmp
    // and a constructed env. 1,251 events reached the adopter metric that way, 2026-08-31..09-03.
    const files = { "/repo/package.json": JSON.stringify({ name: "humanish", private: true }) };
    expect(isOwnCheckoutRun("/tmp/humanish-smoke-abc", "/repo/dist", fakeReader(files))).toBe(true);
    expect(isOwnCheckoutRun("/repo/tests", "/repo/dist", fakeReader(files))).toBe(true);
  });

  it("an adopter's installed copy reports from any cwd: node_modules disqualifies the CLI walk", () => {
    const files = {
      "/app/node_modules/humanish/package.json": JSON.stringify({ name: "humanish" }),
      "/app/package.json": JSON.stringify({ name: "acme-web", dependencies: { humanish: "^0.75.0" } })
    };
    expect(isOwnCheckoutRun("/app", "/app/node_modules/humanish/dist", fakeReader(files))).toBe(false);
    expect(isOwnCheckoutRun("/tmp/scratch", "/app/node_modules/humanish/dist", fakeReader(files))).toBe(false);
  });

  it("returns false when nothing is readable rather than silencing real telemetry", () => {
    // The failure direction matters: losing one event beats disabling the dataset.
    expect(inHumanishCheckout("/nowhere", fakeReader({}))).toBe(false);
  });

  it("honours DO_NOT_TRACK, our own variable, and HUMANISH_DEV", () => {
    expect(disabledByEnvironment({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(disabledByEnvironment({ HUMANISH_TELEMETRY_DISABLED: "1" })).toBe(true);
    expect(disabledByEnvironment({ HUMANISH_DEV: "1" })).toBe(true);
    expect(disabledByEnvironment({})).toBe(false);
    // "0"/"false"/empty are opt-INs, not opt-outs, so a shell exporting CI=0 still reports.
    expect(disabledByEnvironment({ DO_NOT_TRACK: "0" })).toBe(false);
    expect(disabledByEnvironment({ DO_NOT_TRACK: "false" })).toBe(false);
  });

  it("does not key on CI, because an adopter's pipeline is real usage", () => {
    // Next.js records CI as a property rather than suppressing it; the `ci` property already
    // separates pipeline usage from interactive usage in the dataset.
    expect(disabledByEnvironment({ CI: "true" })).toBe(false);
  });

  it("the suite itself is opted out", () => {
    // vitest.config.ts sets both. If this ever fails, the test matrix is polluting adoption data.
    expect(disabledByEnvironment(process.env)).toBe(true);
  });
});
