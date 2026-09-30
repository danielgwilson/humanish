import { describe, expect, it } from "vitest";

import { commandFailureInfo, isCommandExitError } from "../../src/substrates/command-failure.js";
import { tailOf } from "../../src/substrates/shell.js";

/** Shape matching @e2b/desktop's CommandExitError (name + exitCode + stderr/stdout). */
function commandExitError(fields: {
  exitCode?: number;
  stderr?: string;
  stdout?: string;
  message?: string;
}): Error {
  return Object.assign(new Error(fields.message ?? `exit status ${fields.exitCode ?? 1}`), {
    name: "CommandExitError",
    ...fields,
  });
}

describe("commandFailureInfo", () => {
  it("recovers exitCode + stderr tail from a thrown CommandExitError", () => {
    const info = commandFailureInfo(
      commandExitError({ exitCode: 127, stderr: "no browser opener found" }),
    );
    expect(info.exitCode).toBe(127);
    expect(info.stderrTail).toBe("no browser opener found");
  });

  it("returns exitCode undefined for an error with no numeric exit code (infra/timeout)", () => {
    const info = commandFailureInfo(new Error("request timed out"));
    expect(info.exitCode).toBeUndefined();
    expect(info.stderrTail).toBe("request timed out");
  });

  it("prefers stderr, then stdout, then error, then message", () => {
    expect(
      commandFailureInfo({ exitCode: 1, stderr: "E", stdout: "O", error: "X", message: "M" })
        .stderrTail,
    ).toBe("E");
    expect(
      commandFailureInfo({ exitCode: 1, stdout: "O", error: "X", message: "M" }).stderrTail,
    ).toBe("O");
    expect(commandFailureInfo({ exitCode: 1, error: "X", message: "M" }).stderrTail).toBe("X");
    expect(commandFailureInfo({ exitCode: 1, message: "M" }).stderrTail).toBe("M");
  });

  it("tolerates a non-object throw and empty output", () => {
    expect(commandFailureInfo(undefined)).toEqual({ stderrTail: "" });
    expect(commandFailureInfo("boom")).toEqual({ stderrTail: "" });
    expect(commandFailureInfo({ exitCode: 1 }).stderrTail).toBe("");
  });

  it("collapses whitespace and caps the tail length", () => {
    const long = `head ${"x".repeat(400)}   tail\nwith   spaces`;
    const out = tailOf(long);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out).not.toContain("\n");
    expect(out.endsWith("with spaces")).toBe(true);
  });
});

describe("isCommandExitError", () => {
  it("is true for a thrown CommandExitError (by SDK class name)", () => {
    expect(isCommandExitError(commandExitError({ exitCode: 2, stderr: "boom" }))).toBe(true);
  });

  it("is true for any Error carrying a numeric exitCode (structural fake, no SDK name)", () => {
    expect(isCommandExitError(Object.assign(new Error("exit status 1"), { exitCode: 1 }))).toBe(
      true,
    );
    expect(isCommandExitError({ exitCode: 0 })).toBe(true); // 0 is still a numeric exit signal
  });

  it("is FALSE for a generic Error with no name override and no exitCode (deadline/abort-shaped)", () => {
    class CuaDeadlineError extends Error {}
    class CuaAbortError extends Error {}
    expect(isCommandExitError(new Error("request timed out"))).toBe(false);
    expect(isCommandExitError(new CuaDeadlineError())).toBe(false);
    expect(isCommandExitError(new CuaAbortError())).toBe(false);
  });

  it("is FALSE for a non-object throw or a non-numeric exitCode", () => {
    expect(isCommandExitError(undefined)).toBe(false);
    expect(isCommandExitError(null)).toBe(false);
    expect(isCommandExitError("boom")).toBe(false);
    expect(isCommandExitError({ exitCode: "2" })).toBe(false);
  });
});
