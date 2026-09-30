import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each deprecated function warns once per process and then runs the function it always was. The
// implementations are replaced by spies here, so no run starts. This file runs in its own worker,
// so the once-per-process record starts empty.
const calls = vi.hoisted(() => [] as string[]);
const spy = (name: string) => async (options: unknown) => {
  calls.push(name);
  return { from: name, options };
};
vi.mock("../src/actors/computer-use/actor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/actors/computer-use/actor.js")>()),
  runCuaActorSession: spy("runCuaActorSession"),
}));
vi.mock("../src/routes/computer-use/lab.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/routes/computer-use/lab.js")>()),
  runCuaActorLab: spy("runCuaActorLab"),
}));
vi.mock("../src/routes/scripted-browser/lab.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/routes/scripted-browser/lab.js")>()),
  runScriptedBrowserLab: spy("runScriptedBrowserLab"),
}));
vi.mock("../src/routes/terminal/lab.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/routes/terminal/lab.js")>()),
  runTerminalProductLab: spy("runTerminalProductLab"),
}));
vi.mock("../src/routes/shared-world/lab.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/routes/shared-world/lab.js")>()),
  runConcurrentSharedWorld: spy("runConcurrentSharedWorld"),
}));
vi.mock("../src/run/dry-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/run/dry-run.js")>()),
  runDryRun: spy("runDryRun"),
}));

const humanish = await import("../src/index.js");

describe("a deprecated export", () => {
  let emitWarning: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeEach(() => {
    calls.length = 0;
    emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  });
  afterEach(() => {
    emitWarning.mockRestore();
  });

  it("warns once per process, names its replacement and delegates", async () => {
    const functions = [
      "runCuaActorSession",
      "runCuaActorLab",
      "runScriptedBrowserLab",
      "runTerminalProductLab",
      "runConcurrentSharedWorld",
      "runDryRun",
    ] as const;
    const options = { cwd: "/tmp/unused" } as never;
    for (let round = 0; round < 2; round += 1)
      for (const name of functions)
        await expect(humanish[name](options)).resolves.toEqual({ from: name, options });

    expect(calls).toEqual([...functions, ...functions]);
    const warnings = emitWarning.mock.calls.map(([message, detail]) => ({
      message: String(message),
      code: (detail as { code?: string }).code,
    }));
    expect(warnings).toHaveLength(functions.length);
    for (const [index, name] of functions.entries()) {
      expect(warnings[index]!.code).toBe("HUMANISH_DEPRECATED_EXPORT");
      expect(warnings[index]!.message).toMatch(
        new RegExp(`^${name} is deprecated and is removed in the next minor\\. Use `),
      );
    }
    expect(warnings[0]!.message).toContain("singleDispatch: true");
    expect(warnings[1]!.message).toContain("runLab(config, options)");
  });
});
