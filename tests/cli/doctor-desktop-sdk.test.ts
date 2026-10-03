import { describe, expect, it } from "vitest";
import {
  DESKTOP_SDK_FLOOR,
  desktopSdkAdvisory,
  doctor,
  missingDesktopSdkMessage,
} from "../../src/cli/doctor.js";

describe("doctor: the desktop SDK row names the installed version and a floor", () => {
  it("an SDK older than the floor gets the advisory, with the version and the fix", () => {
    for (const version of ["2.2.3", "2.3.1"]) {
      const advisory = desktopSdkAdvisory(version, () => ({
        kind: "project",
        up: 0,
        manager: "npm",
      }));
      expect(advisory).toContain(`${version} is older than 2.3.2`);
      expect(advisory).toContain("stdin handles");
      expect(advisory).toContain("alive for minutes after its result");
      expect(advisory).toContain("npm i -D @e2b/desktop@latest");
    }
  });

  it("names the update and install commands for where humanish is installed", () => {
    const global = () => ({ kind: "global", manager: "npm" }) as const;
    expect(desktopSdkAdvisory("2.2.3", global)).toContain("`npm i -g @e2b/desktop@latest`");
    expect(missingDesktopSdkMessage(global())).toContain("`npm i -g @e2b/desktop`");
    expect(missingDesktopSdkMessage({ kind: "project", up: 1, manager: "npm" })).toContain(
      "`npm i -D --prefix .. @e2b/desktop`",
    );
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
