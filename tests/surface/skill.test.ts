import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("agent skill guidance", () => {
  it("keeps the skill's name and its safety rules", async () => {
    const skill = await readFile("skills/humanish/SKILL.md", "utf8");

    expect(skill).toContain("name: humanish");

    for (const rule of [
      "Never read, copy, commit, summarize, or generate PII",
      "Do not edit `.env` or secret files.",
      "Stop before live",
    ]) {
      expect(skill).toContain(rule);
    }
  });

  // An agent that reads a capability as not for it drops it from the report it writes for its
  // person. The section opens with the sentence init, doctor and the agents file section use.
  it("names the terminal UI for the person the agent works for", async () => {
    const skill = await readFile("skills/humanish/SKILL.md", "utf8");

    expect(skill).toContain(
      "\nTell the person you are working for: `npx humanish tui`, typed in your own terminal, lists this project's studies and runs, starts a dry or live run, and shows what each participant is doing during a run.\n",
    );
    expect(skill).not.toContain("Not For You");
  });
});
