import { describe, expect, it } from "vitest";

import { commandFailureInfo, runDesktopCommand, tailOf } from "../src/command-failure.js";

/** Shape matching @e2b/desktop's CommandExitError (name + exitCode + stderr/stdout). */
function commandExitError(fields: { exitCode?: number; stderr?: string; stdout?: string; message?: string }): Error {
  return Object.assign(new Error(fields.message ?? `exit status ${fields.exitCode ?? 1}`), {
    name: "CommandExitError",
    ...fields,
  });
}

describe("commandFailureInfo", () => {
  it("recovers exitCode + stderr tail from a thrown CommandExitError", () => {
    const info = commandFailureInfo(commandExitError({ exitCode: 127, stderr: "no browser opener found" }));
    expect(info.exitCode).toBe(127);
    expect(info.stderrTail).toBe("no browser opener found");
  });

  it("returns exitCode undefined for an error with no numeric exit code (infra/timeout)", () => {
    const info = commandFailureInfo(new Error("request timed out"));
    expect(info.exitCode).toBeUndefined();
    expect(info.stderrTail).toBe("request timed out");
  });

  it("prefers stderr, then stdout, then error, then message", () => {
    expect(commandFailureInfo({ exitCode: 1, stderr: "E", stdout: "O", error: "X", message: "M" }).stderrTail).toBe("E");
    expect(commandFailureInfo({ exitCode: 1, stdout: "O", error: "X", message: "M" }).stderrTail).toBe("O");
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

describe("runDesktopCommand", () => {
  it("returns the run result on success and never calls onFailure", async () => {
    let onFailureCalls = 0;
    const result = await runDesktopCommand(
      async () => ({ exitCode: 0, stdout: "ok" }),
      () => {
        onFailureCalls += 1;
        return new Error("should not run");
      },
    );
    expect(result).toEqual({ exitCode: 0, stdout: "ok" });
    expect(onFailureCalls).toBe(0);
  });

  it("converts a thrown CommandExitError into the caller's intended error", async () => {
    const thrown = await runDesktopCommand(
      async () => {
        throw commandExitError({ exitCode: 127, stderr: "requested browser firefox was not found" });
      },
      ({ exitCode, stderrTail }) => new Error(`browser launch failed with exit ${exitCode}: ${stderrTail}`),
    ).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "browser launch failed with exit 127: requested browser firefox was not found",
    );
  });

  it("can rethrow the ORIGINAL error (e.g. to preserve default propagation)", async () => {
    const original = commandExitError({ exitCode: 1, stderr: "infra" });
    const thrown = await runDesktopCommand(
      async () => {
        throw original;
      },
      (_info, error) => error,
    ).catch((error: unknown) => error);
    expect(thrown).toBe(original);
  });
});
