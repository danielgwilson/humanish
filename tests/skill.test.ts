import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("agent skill guidance", () => {
  it("keeps Mimetic setup guidance actionable and public-safe", async () => {
    const skill = await readFile("docs/skill/mimetic-cli/SKILL.md", "utf8");

    expect(skill).toContain("name: mimetic-cli");
    expect(skill).toContain("npm i -D mimetic-cli");
    expect(skill).toContain("npx mimetic init --dry-run --json");
    expect(skill).toContain("npx mimetic init --yes --json");
    expect(skill).toContain("npx mimetic watch --sims 4 --open --follow");
    expect(skill).toContain("npx mimetic watch --sims 4 --no-open --json");
    expect(skill).toContain("npx mimetic feedback issue --run latest --repo example/app --format markdown");
    expect(skill).toContain("commit `mimetic/`");
    expect(skill).toContain("ignore `.mimetic/`");
    expect(skill).toContain("OPENAI_API_KEY");
    expect(skill).toContain("E2B_API_KEY");

    for (const forbidden of [
      "Never read, copy, commit, summarize, or generate PII",
      "Do not edit `.env` or secret files.",
      "Stop and ask before using real credentials"
    ]) {
      expect(skill).toContain(forbidden);
    }
  });
});
