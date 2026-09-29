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
});
