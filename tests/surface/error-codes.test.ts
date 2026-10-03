import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The study rename gave every error code a route or study prefix. A code that still says lab, such
// as `HUMANISH_CUA_LAB_UNPRICED_CAP`, or sim, `HUMANISH_INVALID_SIM_COUNT`, fails here, wherever it
// appears in shipped code.

const RETIRED_CODE =
  /HUMANISH_(?:CUA_|TERMINAL_|CONCURRENT_SHARED_WORLD_|SCRIPTED_)?LAB_[A-Z0-9_]+|HUMANISH_LAUNCH_INVALID_LAB\b|HUMANISH_INVALID_SIM_COUNT\b/g;

const SHIPPED_ROOTS = ["src", "tui/src", "observer"];

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(ts|tsx|mts|js|mjs)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.split(path.sep).includes("node_modules"));
}

describe("error codes", () => {
  it("name the study or the route, and none says lab", async () => {
    const survivors: string[] = [];
    for (const root of SHIPPED_ROOTS) {
      for (const file of await sourceFiles(root)) {
        const text = await readFile(file, "utf8");
        for (const match of text.matchAll(RETIRED_CODE)) survivors.push(`${file}: ${match[0]}`);
      }
    }
    expect(survivors).toEqual([]);
  });

  it("matches each retired family", () => {
    const codes = [
      "HUMANISH_LAB_INVALID",
      "HUMANISH_CUA_LAB_UNPRICED_CAP",
      "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED",
      "HUMANISH_TERMINAL_LAB_CAPS_EXCEEDED",
      "HUMANISH_SCRIPTED_LAB_BROWSER_MISSING",
      "HUMANISH_LAUNCH_INVALID_LAB",
      "HUMANISH_INVALID_SIM_COUNT",
    ];
    expect(codes.join(" ").match(RETIRED_CODE)).toEqual(codes);
    expect(
      "HUMANISH_STUDY_INVALID HUMANISH_COMPUTER_USE_UNPRICED_CAP HUMANISH_LAUNCH_INVALID_STUDY HUMANISH_INVALID_PARTICIPANT_COUNT".match(
        RETIRED_CODE,
      ),
    ).toBeNull();
  });
});
