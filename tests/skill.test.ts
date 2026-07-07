import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("agent skill guidance", () => {
  it("keeps Homun setup guidance actionable and public-safe", async () => {
    const skill = await readFile("skills/homun/SKILL.md", "utf8");

    expect(skill).toContain("name: homun");
    expect(skill).toContain("npm i -D homun");
    expect(skill).toContain("npx homun init --dry-run --json");
    expect(skill).toContain("npx homun init --yes --json");
    expect(skill).toContain("npx homun watch");
    expect(skill).toContain("npx homun watch --json --no-open");
    expect(skill).toContain("npx homun feedback issue --run latest --repo example/app --format markdown");
    expect(skill).toContain("commit `homun/`");
    expect(skill).toContain("ignore `.homun/`");
    expect(skill).toContain("OPENAI_API_KEY");
    expect(skill).toContain("E2B_API_KEY");
    expect(skill).toContain("npm i -D @e2b/desktop");
    expect(skill).toContain("## Format Stack");
    expect(skill).toContain("use `.yaml` for human-authored Homun source");
    expect(skill).toContain("use `.ts` for executable integration");
    expect(skill).toContain("use `.json` or `.ndjson` for generated machine artifacts");
    expect(skill).toContain("Do not create `.yml` files under `homun/`");

    for (const forbidden of [
      "Never read, copy, commit, summarize, or generate PII",
      "Do not edit `.env` or secret files.",
      "Stop before live"
    ]) {
      expect(skill).toContain(forbidden);
    }
  });

  it("ships OpenAI skill metadata without extra docs clutter", async () => {
    const metadata = await readFile("skills/homun/agents/openai.yaml", "utf8");

    expect(metadata).toContain('display_name: "Homun CLI"');
    expect(metadata).toContain('short_description: "Set up public-safe persona simulation"');
    expect(metadata).toContain("$homun");
  });
});
