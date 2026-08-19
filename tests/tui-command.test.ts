import { describe, expect, it } from "vitest";

import { createProgram, type TuiRuntime } from "../src/program.js";
import { TUI_MIN_NODE_MAJOR, nodeSupportsTui, tuiBundleUrl, type TuiModule, type TuiOptions } from "../src/tui-contract.js";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const fakeTty = (isTTY: boolean): NodeJS.WriteStream =>
  ({ isTTY, columns: 80, rows: 24, on: () => {}, off: () => {}, write: () => true }) as unknown as NodeJS.WriteStream;

async function runCli(args: string[], runtime: Partial<TuiRuntime>): Promise<CliResult> {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
    tuiRuntime: runtime
  });
  program.exitOverride();
  await program.parseAsync(["node", "humanish", ...args], { from: "node" });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

/** A runtime where everything works, so each test can break exactly one thing. */
function workingRuntime(overrides: Partial<TuiRuntime> = {}): Partial<TuiRuntime> & { seen: TuiOptions[] } {
  const seen: TuiOptions[] = [];
  const module: TuiModule = {
    startTui: async (options) => {
      seen.push(options);
      return 0;
    }
  };
  return {
    stdin: fakeTty(true) as unknown as NodeJS.ReadStream,
    stdout: fakeTty(true),
    nodeVersion: `v${TUI_MIN_NODE_MAJOR}.0.0`,
    loadTui: async () => module,
    seen,
    ...overrides
  };
}

describe("humanish tui: the one command that refuses instead of degrading (#455)", () => {
  it("refuses a non-interactive stdout, and names the commands that DO answer the question", async () => {
    // The agent path. Every other humanish command is built to be driven by a program; this one
    // cannot be, and a TUI that rendered frames into a pipe would poison a transcript with escape
    // codes and read as a hang. So it fails closed — and the refusal is only useful if it says
    // where to go instead.
    const result = await runCli(["tui", "--json"], workingRuntime({ stdout: fakeTty(false) }));
    const parsed = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; message: string } };

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("HUMANISH_TUI_REQUIRES_TTY");
    expect(parsed.error.message).toContain("humanish runs --json");
    expect(parsed.error.message).toContain("humanish lab run --json");
    expect(result.exitCode).toBe(2);
  });

  it("refuses a non-interactive stdin too — a piped-in keystream is not an operator", async () => {
    const result = await runCli(
      ["tui", "--json"],
      workingRuntime({ stdin: fakeTty(false) as unknown as NodeJS.ReadStream })
    );
    expect((JSON.parse(result.stdout) as { error: { code: string } }).error.code).toBe("HUMANISH_TUI_REQUIRES_TTY");
    expect(result.exitCode).toBe(2);
  });

  it("refuses an unsupported Node WITHOUT implying the rest of the CLI is broken", async () => {
    const result = await runCli(["tui", "--json"], workingRuntime({ nodeVersion: "v20.11.0" }));
    const parsed = JSON.parse(result.stdout) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("HUMANISH_TUI_UNSUPPORTED_NODE");
    expect(parsed.error.message).toContain("v20.11.0");
    // The distinction that matters to someone on an older runtime: this is one optional surface,
    // not the tool.
    expect(parsed.error.message).toContain("Every other humanish command still works");
    expect(result.exitCode).toBe(2);
  });

  it("says so plainly when the bundle is missing instead of throwing a module-not-found", async () => {
    const result = await runCli(["tui", "--json"], workingRuntime({ loadTui: async () => null }));
    const parsed = JSON.parse(result.stdout) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("HUMANISH_TUI_BUNDLE_MISSING");
    expect(parsed.error.message).toContain("pnpm build");
    expect(result.exitCode).toBe(2);
  });

  it("hands the surface a resolved cwd and the project-reading capability, and returns its exit code", async () => {
    const runtime = workingRuntime();
    const result = await runCli(["tui", "--cwd", "."], runtime);

    expect(runtime.seen).toHaveLength(1);
    const options = runtime.seen[0]!;
    expect(options.cwd.startsWith("/")).toBe(true);
    expect(typeof options.capabilities.readRunIndex).toBe("function");
    expect(options.version.cli).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.exitCode).toBe(0);
    // The surface owned the screen and has already said whatever there was to say; the CLI must not
    // print an envelope over the top of it.
    expect(result.stdout).toBe("");
  });

  it("propagates a non-zero exit from the surface", async () => {
    const runtime = workingRuntime({ loadTui: async () => ({ startTui: async () => 1 }) });
    const result = await runCli(["tui"], runtime);
    expect(result.exitCode).toBe(1);
  });
});

describe("the Node floor is stated once and read by everyone", () => {
  it("parses real version strings, and refuses to guess at nonsense", () => {
    expect(nodeSupportsTui("v22.0.0")).toBe(true);
    expect(nodeSupportsTui("v24.12.0")).toBe(true);
    expect(nodeSupportsTui("v20.19.0")).toBe(false);
    expect(nodeSupportsTui("")).toBe(false);
    expect(nodeSupportsTui("banana")).toBe(false);
  });

  it("resolves the bundle beside the compiled CLI, so the loader and doctor look in one place", () => {
    expect(tuiBundleUrl("file:///opt/humanish/dist/program.js").pathname).toBe("/opt/humanish/dist/tui-app.js");
  });
});
