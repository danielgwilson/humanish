import { describe, expect, it, vi } from "vitest";
import { copyCommand } from "../site/lib/copy-command.js";

describe("website install copy outcome", () => {
  it("reports success only after the actual clipboard promise resolves", async () => {
    let finish!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const report = vi.fn();
    const result = copyCommand("example command", { writeText }, report);
    expect(writeText).toHaveBeenCalledWith("example command");
    expect(report).not.toHaveBeenCalled();
    finish();
    await expect(result).resolves.toBe("success");
    expect(report.mock.calls).toEqual([["install_copy_success"]]);
  });

  it.each([
    ["rejected permission", { writeText: () => Promise.reject(new Error("private browser detail")) }],
    ["unavailable API", undefined],
    ["synchronous browser error", { writeText: () => { throw new Error("private browser detail"); } }]
  ] as const)("reports only a fixed failure event for %s", async (_name, clipboard) => {
    const report = vi.fn();
    await expect(copyCommand("private command text", clipboard, report)).resolves.toBe("failure");
    expect(report.mock.calls).toEqual([["install_copy_failure"]]);
  });

  it.each([true, false])("keeps the clipboard outcome when analytics throws (success=%s)", async (success) => {
    const report = vi.fn(() => { throw new Error("analytics unavailable"); });
    const clipboard = { writeText: () => success ? Promise.resolve() : Promise.reject(new Error("denied")) };
    await expect(copyCommand("example command", clipboard, report)).resolves.toBe(success ? "success" : "failure");
    expect(report.mock.calls).toEqual([[success ? "install_copy_success" : "install_copy_failure"]]);
  });
});
