import { CommanderError, type Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  prepare: vi.fn(),
  status: vi.fn(),
}));
vi.mock("../../src/substrates/local/runtime.js", () => ({
  prepareLocalRuntime: seams.prepare,
  localRuntimeStatus: seams.status,
}));

import { createProgram } from "../../src/cli/program.js";

async function runCli(args: string[]) {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  const override = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(override);
  };
  override(program);
  try {
    await program.parseAsync(["node", "humanish", ...args], { from: "node" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

const capacity = {
  host: "lima-vm",
  memoryGiB: 8,
  cpus: 6,
  reservedMemoryGiB: 1,
  perDesktop: { memoryGiB: 3, cpus: 2 },
  desktops: 2,
};

describe("humanish runtime", () => {
  beforeEach(() => {
    seams.prepare.mockResolvedValue({ image: "synthetic", runtimeRevision: "synthetic" });
    seams.status.mockResolvedValue({
      ok: true,
      installed: true,
      message: "Local browser runtime is installed. No E2B key is needed.",
      capacity,
    });
  });

  it("passes --memory and --cpus to setup as the Lima VM size", async () => {
    const run = await runCli(["runtime", "setup", "--memory", "13", "--cpus", "8", "--json"]);
    expect(run.exitCode).toBe(0);
    expect(seams.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ size: { memoryGiB: 13, cpus: 8 } }),
    );
  });
  it("leaves the VM size alone when setup gets no size", async () => {
    await runCli(["runtime", "setup", "--json"]);
    expect(seams.prepare.mock.calls[0]![0]).not.toHaveProperty("size");
  });
  it("refuses a size that is not a whole number before setup starts", async () => {
    const run = await runCli(["runtime", "setup", "--memory", "lots"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("--memory");
    expect(seams.prepare).not.toHaveBeenCalled();
  });
  it("reports the VM size, each desktop's reservation and how many desktops fit", async () => {
    const json = await runCli(["runtime", "status", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ capacity });
    const human = await runCli(["runtime", "status"]);
    expect(human.stdout).toContain("8 GiB");
    expect(human.stdout).toContain("reserves 3 GiB");
    expect(human.stdout).toContain("2 desktops fit");
  });
});
