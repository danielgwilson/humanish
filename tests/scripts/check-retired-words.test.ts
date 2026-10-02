import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const SCRIPT = path.resolve("scripts/check-retired-words.ts");

type Caps = { vocabulary: Record<string, number> };

/** This repo's scripts/caps.json. */
function repoCaps(): Caps {
  return JSON.parse(readFileSync("scripts/caps.json", "utf8")) as Caps;
}

/** Runs the checker over this repo's src/ with the given caps file, and returns its exit status
 *  and stdout. */
async function run(caps: Caps): Promise<{ status: number; stdout: string }> {
  const file = path.join(await makeTestTempDir("humanish-vocabulary-check-"), "caps.json");
  await writeFile(file, JSON.stringify(caps));
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", SCRIPT, "--caps", file], {
      encoding: "utf8",
    });
    return { status: 0, stdout };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, stdout: failed.stdout };
  }
}

describe("vocabulary:check holds each word to its cap in scripts/caps.json", () => {
  it("passes with the repo's own caps", async () => {
    expect((await run(repoCaps())).status).toBe(0);
  });

  it("fails when a word has no cap, naming its path and today's count", async () => {
    const caps = repoCaps();
    delete caps.vocabulary.lab;
    const result = await run(caps);

    expect(result.status).toBe(1);
    const count = /^vocabulary\.lab: (\d+) \(no cap\)$/m.exec(result.stdout)?.[1];
    expect(result.stdout).toMatch(
      new RegExp(`A count has no cap\\. Add it to .*: vocabulary\\.lab: ${count}\\.`),
    );
  });

  it("fails when a cap sits above its count, and asks for it to be lowered", async () => {
    const caps = repoCaps();
    caps.vocabulary.lane = caps.vocabulary.lane! + 1;
    const result = await run(caps);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      `vocabulary.lane: ${caps.vocabulary.lane} -> ${caps.vocabulary.lane - 1}`,
    );
  });
});
