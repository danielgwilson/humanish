import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("agent skill guidance", () => {
  it("keeps Mimetic setup guidance actionable and public-safe", async () => {
    const skill = await readFile("skills/mimetic-cli/SKILL.md", "utf8");

    expect(skill).toContain("name: mimetic-cli");
    expect(skill).toContain("npm i -D mimetic-cli");
    expect(skill).toContain("npx mimetic init --dry-run --json");
    expect(skill).toContain("npx mimetic init --yes --json");
    expect(skill).toContain("npx mimetic watch");
    expect(skill).toContain("npx mimetic watch --json --no-open");
    expect(skill).toContain("npx mimetic feedback issue --run latest --repo example/app --format markdown");
    expect(skill).toContain("commit `mimetic/`");
    expect(skill).toContain("ignore `.mimetic/`");
    expect(skill).toContain("OPENAI_API_KEY");
    expect(skill).toContain("E2B_API_KEY");
    expect(skill).toContain("npm i -D @e2b/desktop");

    for (const forbidden of [
      "Never read, copy, commit, summarize, or generate PII",
      "Do not edit `.env` or secret files.",
      "Stop before live"
    ]) {
      expect(skill).toContain(forbidden);
    }
  });

  it("ships OpenAI skill metadata without extra docs clutter", async () => {
    const metadata = await readFile("skills/mimetic-cli/agents/openai.yaml", "utf8");

    expect(metadata).toContain('display_name: "Mimetic CLI"');
    expect(metadata).toContain('short_description: "Set up public-safe persona simulation"');
    expect(metadata).toContain("$mimetic-cli");
  });
});
