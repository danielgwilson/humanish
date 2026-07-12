import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("agent skill guidance", () => {
  it("keeps Humanish setup guidance actionable and public-safe", async () => {
    const skill = await readFile("skills/humanish/SKILL.md", "utf8");

    expect(skill).toContain("name: humanish");
    expect(skill).toContain("npm i -D humanish");
    expect(skill).toContain("npx humanish init --dry-run --json");
    expect(skill).toContain("npx humanish init --yes --json");
    expect(skill).toContain("npx humanish watch");
    expect(skill).toContain("npx humanish watch --json --no-open");
    expect(skill).toContain("npx humanish feedback issue --run latest --repo example/app --format markdown");
    expect(skill).toContain("commit `humanish/`");
    expect(skill).toContain("ignore `.humanish/`");
    expect(skill).toContain("OPENAI_API_KEY");
    expect(skill).toContain("E2B_API_KEY");
    expect(skill).toContain("npm i -D @e2b/desktop");
    expect(skill).toContain("## Format Stack");
    expect(skill).toContain("use `.yaml` for human-authored Humanish source");
    expect(skill).toContain("use `.ts` for executable integration");
    expect(skill).toContain("use `.json` or `.ndjson` for generated machine artifacts");
    expect(skill).toContain("Do not create `.yml` files under `humanish/`");

    for (const forbidden of [
      "Never read, copy, commit, summarize, or generate PII",
      "Do not edit `.env` or secret files.",
      "Stop before live"
    ]) {
      expect(skill).toContain(forbidden);
    }
  });

  it("ships OpenAI skill metadata without extra docs clutter", async () => {
    const metadata = await readFile("skills/humanish/agents/openai.yaml", "utf8");

    expect(metadata).toContain('display_name: "Humanish CLI"');
    expect(metadata).toContain('short_description: "Set up public-safe persona simulation"');
    expect(metadata).toContain("$humanish");
  });
});
