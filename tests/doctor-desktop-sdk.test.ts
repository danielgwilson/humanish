import { describe, expect, it } from "vitest";
import { DESKTOP_SDK_FLOOR, desktopSdkAdvisory, doctor } from "../src/run.js";

describe("doctor: the desktop SDK row names the installed version and a floor (#581)", () => {
  it("an SDK older than the floor gets the advisory, with the version and the fix", () => {
    for (const version of ["2.2.3", "2.3.1"]) {
      const advisory = desktopSdkAdvisory(version);
      expect(advisory).toContain(`${version} is older than 2.3.2`);
      expect(advisory).toContain("stdin handles");
      expect(advisory).toContain("#581");
      expect(advisory).toContain("npm i -D @e2b/desktop@latest");
    }
  });

  it("the floor itself, a newer patch, minor and major get no advisory", () => {
    for (const version of [DESKTOP_SDK_FLOOR, "2.3.3", "2.4.0", "3.0.0"]) {
      expect(desktopSdkAdvisory(version), version).toBeUndefined();
    }
  });

  it("an unreadable version is silent rather than wrong", () => {
    expect(desktopSdkAdvisory(undefined)).toBeUndefined();
    expect(desktopSdkAdvisory("next")).toBeUndefined();
    expect(desktopSdkAdvisory("2")).toBeUndefined();
  });

  it("the live row from this checkout carries the installed version", async () => {
    const result = await doctor(process.cwd());
    const row = result.checks.find((check) => check.name === "e2b desktop sdk");
    expect(row?.ok).toBe(true);
    expect(row?.message).toMatch(/@e2b\/desktop \d+\.\d+\.\d+ is installed/);
    expect(row?.message).not.toContain("older than");
  });
});
