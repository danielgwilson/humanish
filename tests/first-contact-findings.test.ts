import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { withSiblingFlagHint } from "../src/program.js";
import { doctor } from "../src/run.js";
import { terminalSurfaceMessage } from "../src/tui-contract.js";

// Both of these were found by a participant, not by us — labs/first-contact.yaml, a real
// autonomous agent meeting humanish for the first time in an E2B shell.

describe("a rejected flag names the command that has it", () => {
  function root(): Command {
    const program = new Command("humanish");
    program.command("run").option("--dry-run", "d");
    program.command("watch").option("--no-open", "n");
    const lab = program.command("lab");
    lab.command("run").option("--no-open", "n");
    return program;
  }

  it("points at the siblings that declare it", () => {
    const enriched = withSiblingFlagHint("error: unknown option '--no-open'\n", root());
    expect(enriched).toContain("`humanish watch`");
    expect(enriched).toContain("`humanish lab run`");
    expect(enriched).toContain("not of this command");
    // The root's own name is not repeated into the suggestion.
    expect(enriched).not.toContain("humanish humanish");
  });

  it("stays quiet when no command has the flag — an invented suggestion is worse than none", () => {
    const text = "error: unknown option '--frobnicate'\n";
    expect(withSiblingFlagHint(text, root())).toBe(text);
  });

  it("leaves unrelated errors alone", () => {
    const text = "error: too many arguments.\n";
    expect(withSiblingFlagHint(text, root())).toBe(text);
  });

  it("reports truncation rather than silently dropping owners", () => {
    const program = new Command("humanish");
    for (const name of ["a", "b", "c", "d", "e"]) {
      program.command(name).option("--no-open", "n");
    }
    const enriched = withSiblingFlagHint("error: unknown option '--no-open'\n", program);
    expect(enriched).toContain("(and 2 more)");
  });
});

describe("doctor's terminal-surface row is written for whoever is reading it", () => {
  const base = { supported: true, bundlePresent: true, nodeVersion: "v22.14.0" };

  it("tells a person at a terminal what it opens", () => {
    expect(terminalSurfaceMessage({ ...base, interactive: true })).toContain("opens the interactive surface");
  });

  it("tells a reader who CANNOT use it to hand it on", () => {
    // The finding: an agent read "available in an interactive terminal", correctly concluded it
    // was not in one, and never mentioned the surface in the report it wrote for a human.
    const message = terminalSurfaceMessage({ ...base, interactive: false });
    expect(message).toContain("pass it on");
    expect(message).toContain("PERSON");
  });

  it("keeps the machine-state answers ahead of the audience question", () => {
    expect(terminalSurfaceMessage({ ...base, supported: false, interactive: true })).toContain("needs Node");
    expect(terminalSurfaceMessage({ ...base, bundlePresent: false, interactive: false })).toContain("pnpm build");
  });

  it("still reports the surface as a capability, never a gate", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-doctor-"));
    try {
      const row = (await doctor(cwd)).checks.find((check) => check.name === "terminal surface");
      expect(row?.ok).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
