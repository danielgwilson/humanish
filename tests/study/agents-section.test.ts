import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENTS_SECTION_END_MARKER,
  AGENTS_SECTION_MARKER,
  agentsSection,
} from "../../src/cli/first-run-path.js";
import { replaceAgentsSection } from "../../src/study/agents-section.js";
import { runInit } from "../../src/study/init.js";

// Each fixture is the section a release range wrote, from its heading to its final newline,
// regenerated from the release tags. None of them has an end marker.
const FIXTURES = path.resolve("tests/fixtures/agents-md");

const BEFORE = "# AGENTS.md\n\n## House rules\n\nUse pnpm.\n\n";
const AFTER = "\n## Later notes\n\nKeep this paragraph.\n";

let cwd: string | undefined;
afterEach(async () => {
  if (cwd !== undefined) await rm(cwd, { recursive: true, force: true });
  cwd = undefined;
});

async function project(agents: string): Promise<string> {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-agents-section-"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
  await writeFile(path.join(cwd, "AGENTS.md"), agents, "utf8");
  return cwd;
}

describe("init replaces its own agents file section on a rerun", () => {
  it("replaces the section between the markers and leaves every byte outside them alone", async () => {
    const stale = agentsSection("humanish").replace("study list --json", "study list --stale");
    const dir = await project(`${BEFORE}${stale.replace(/^\n/, "")}${AFTER}`);

    const result = await runInit({ cwd: dir, yes: true, env: { HOME: dir } });

    expect(result.changes.find((change) => change.path === "AGENTS.md")?.action).toBe("update");
    const agents = await readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(agents.startsWith(BEFORE)).toBe(true);
    expect(agents.endsWith(`${AGENTS_SECTION_END_MARKER}\n${AFTER}`)).toBe(true);
    expect(agents).not.toContain("--stale");
    expect(agents.split(AGENTS_SECTION_MARKER)).toHaveLength(2);
    expect(agents.split(AGENTS_SECTION_END_MARKER)).toHaveLength(2);

    const again = await runInit({ cwd: dir, yes: true, env: { HOME: dir } });
    expect(again.changes.find((change) => change.path === "AGENTS.md")?.action).toBe("skip");
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toBe(agents);
  });

  it("recognises every section a release wrote without an end marker, and replaces only that text", async () => {
    const fixtures = (await readdir(FIXTURES)).filter((name) => name.endsWith(".md")).sort();
    expect(fixtures.length).toBe(8);
    const section = agentsSection("npx humanish");
    for (const name of fixtures) {
      const old = await readFile(path.join(FIXTURES, name), "utf8");
      expect(old).toContain(AGENTS_SECTION_MARKER);
      expect(old).not.toContain(AGENTS_SECTION_END_MARKER);

      const replaced = replaceAgentsSection(`${BEFORE}${old}${AFTER}`, section);
      expect(replaced, name).toEqual({
        kind: "replaced",
        contents: `${BEFORE}${section.replace(/^\n/, "")}${AFTER}`,
      });
    }
  });

  it("upgrades a section the last release wrote when init runs again", async () => {
    const old = await readFile(path.join(FIXTURES, "v0.110.1.md"), "utf8");
    const dir = await project(`# AGENTS.md\n\n${old}`);

    const result = await runInit({ cwd: dir, yes: true, env: { HOME: dir } });

    expect(result.changes.find((change) => change.path === "AGENTS.md")).toMatchObject({
      action: "update",
    });
    const agents = await readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# AGENTS.md\n\n## humanish ")).toBe(true);
    expect(agents.trimEnd().endsWith(AGENTS_SECTION_END_MARKER)).toBe(true);
    expect(agents.split(AGENTS_SECTION_MARKER)).toHaveLength(2);
  });

  it("leaves a hand-edited section without an end marker as it is, and says so", async () => {
    const old = await readFile(path.join(FIXTURES, "v0.110.1.md"), "utf8");
    const edited = old.replace("caps.maxUsd", "caps.maxUsd (we use 2)");
    const contents = `${BEFORE}${edited}${AFTER}`;
    const dir = await project(contents);

    const result = await runInit({ cwd: dir, yes: true, env: { HOME: dir } });

    expect(result.ok).toBe(true);
    expect(result.changes.find((change) => change.path === "AGENTS.md")?.action).toBe("skip");
    expect(result.warnings.some((warning) => warning.includes("AGENTS.md unchanged"))).toBe(true);
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toBe(contents);
  });

  it("appends a section to an agents file that has none", () => {
    expect(replaceAgentsSection(BEFORE, agentsSection())).toEqual({ kind: "absent" });
  });
});
