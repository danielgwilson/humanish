import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { createProgram } from "../../src/cli/program.js";
import { lab } from "../admission/fixtures.js";

// Provider-key discovery spawns `gh auth token` and reads the e2b login, the project overlay and
// the user key store. Only a live run reads keys, so each command that can start one must still
// discover first, and a dry run must not discover at all. Real keys are stubbed empty, so a live
// case here is refused for a missing key before any sandbox or provider call.

const cleanup: string[] = [];
afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  for (const name of ["OPENAI_API_KEY", "E2B_API_KEY", "CODEX_API_KEY", "GH_TOKEN"])
    vi.stubEnv(name, "");
});

async function project(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "humanish-key-discovery-"));
  cleanup.push(dir);
  await writeFile(path.join(dir, "package.json"), '{ "name": "key-discovery-fixture" }\n');
  await mkdir(path.join(dir, "humanish", "labs"), { recursive: true });
  const labs = {
    "kd-live": lab("cuAppUrl", { scenario: { mode: "live" }, execution: { caps: { maxUsd: 1 } } }),
    "kd-dry": lab("cuAppUrl"),
    "kd-terminal-live": lab("terminal", { scenario: { mode: "live" } }),
  };
  for (const [id, raw] of Object.entries(labs))
    await writeFile(path.join(dir, "humanish", "labs", `${id}.yaml`), stringify({ ...raw, id }));
  return dir;
}

/** Runs one CLI invocation and returns how many times it ran key discovery. */
async function discoveryCalls(args: readonly string[], stdout: string[] = []): Promise<number> {
  let calls = 0;
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: () => {},
    setExitCode: () => {},
    keyDiscovery: async () => {
      calls += 1;
      return [];
    },
  });
  program.exitOverride();
  await program.parseAsync(["node", "humanish", ...args], { from: "node" });
  return calls;
}

describe("provider-key discovery runs for live runs only", () => {
  it.each([
    ["run <live lab> (also the TUI's start)", ["run", "kd-live"]],
    ["watch <live lab>", ["watch", "kd-live", "--detach"]],
    ["study check", ["study", "check", "kd-live"]],
  ])("%s discovers once", async (_name, args) => {
    const cwd = await project();
    expect(
      await discoveryCalls([...args, "--cwd", cwd, "--json", "--no-open"].filter(validFor(args))),
    ).toBe(1);
  });

  it.each([
    ["run <dry lab>", ["run", "kd-dry"]],
    ["run <live lab> --dry-run", ["run", "kd-live", "--dry-run"]],
    ["watch <live lab> --dry-run", ["watch", "kd-live", "--dry-run", "--detach"]],
    ["run without a lab (the preview)", ["run"]],
    ["watch --count", ["watch", "--count", "1", "--detach"]],
  ])("%s does not discover", async (_name, args) => {
    const cwd = await project();
    expect(
      await discoveryCalls([...args, "--cwd", cwd, "--json", "--no-open"].filter(validFor(args))),
    ).toBe(0);
  });

  it("does not discover for a live lab an option guard refuses", async () => {
    const cwd = await project();
    const stdout: string[] = [];
    const args = ["run", "kd-terminal-live", "--rerun-failed-from", "earlier-run"];
    expect(await discoveryCalls([...args, "--cwd", cwd, "--json", "--no-open"], stdout)).toBe(0);
    expect(stdout.join("")).toContain("HUMANISH_UNSUPPORTED_RERUN_FLAGS");
  });
});

/** `study check` takes neither --no-open nor a watch flag. */
function validFor(args: readonly string[]): (flag: string) => boolean {
  return (flag) => !(args[1] === "check" && flag === "--no-open");
}
