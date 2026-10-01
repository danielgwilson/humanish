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
vi.mock("../src/routes/computer-use/route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/routes/computer-use/route.js")>()),
  runCuaActorLab: spy("runCuaActorLab"),
}));
vi.mock("../src/routes/scripted/route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/routes/scripted/route.js")>()),
  runScriptedBrowserLab: spy("runScriptedBrowserLab"),
}));
vi.mock("../src/routes/terminal/route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/routes/terminal/route.js")>()),
  runTerminalProductLab: spy("runTerminalProductLab"),
}));
vi.mock("../src/routes/shared-world/route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/routes/shared-world/route.js")>()),
  runConcurrentSharedWorld: spy("runConcurrentSharedWorld"),
}));
vi.mock("../src/run/dry-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/run/dry-run.js")>()),
  runDryRun: spy("runDryRun"),
}));

const humanish = await import("../src/index.js");
const plan = await import("../src/lab/plan.js");
const routing = await import("../src/lab/routing.js");
const validation = await import("../src/lab/validation.js");
const { parseLabConfig } = await import("../src/lab/config.js");
const { lab } = await import("./admission/fixtures.js");

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

  it("warns once for each routing helper, returns what the internal one returns, and leaves internal calls silent", () => {
    const parsed = parseLabConfig(lab("cuAppUrl"));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const config = parsed.config;
    const pairs = [
      [
        "actorResolvesToTerminal",
        () => humanish.actorResolvesToTerminal("codex"),
        () => routing.actorResolvesToTerminal("codex"),
      ],
      ["cuaLaneCount", () => humanish.cuaLaneCount(config), () => routing.cuaLaneCount(config)],
      [
        "resolveSeatUrl",
        () => humanish.resolveSeatUrl("http://127.0.0.1:3000/", "/a"),
        () => routing.resolveSeatUrl("http://127.0.0.1:3000/", "/a"),
      ],
      [
        "cuaLaneValidationReason",
        () => humanish.cuaLaneValidationReason(config),
        () => validation.cuaLaneValidationReason(config),
      ],
      [
        "sharedWorldValidationReason",
        () => humanish.sharedWorldValidationReason(config),
        () => validation.sharedWorldValidationReason(config),
      ],
      [
        "concurrentSharedWorldValidationReason",
        () => humanish.concurrentSharedWorldValidationReason(config),
        () => validation.concurrentSharedWorldValidationReason(config),
      ],
      [
        "externalPublicSharedWorldValidationReason",
        () => humanish.externalPublicSharedWorldValidationReason(config),
        () => validation.externalPublicSharedWorldValidationReason(config),
      ],
      [
        "resolveLabDryRun",
        () => humanish.resolveLabDryRun(config, undefined, true),
        () => plan.resolveLabDryRun(config, undefined, true),
      ],
    ] as const;

    for (const [, , internal] of pairs) internal();
    expect(emitWarning.mock.calls).toEqual([]);

    for (let round = 0; round < 2; round += 1)
      for (const [, exported, internal] of pairs) expect(exported()).toEqual(internal());
    const warnings = emitWarning.mock.calls.map(([message, detail]) => ({
      message: String(message),
      code: (detail as { code?: string }).code,
    }));
    expect(warnings.map((warning) => warning.code)).toEqual(
      pairs.map(() => "HUMANISH_DEPRECATED_EXPORT"),
    );
    for (const [index, [name]] of pairs.entries())
      expect(warnings[index]!.message).toMatch(
        new RegExp(`^${name} is deprecated and is removed in the next minor\\. Use `),
      );
    expect(humanish.MAX_CUA_LANES).toBe(routing.MAX_CUA_LANES);
  });
});
