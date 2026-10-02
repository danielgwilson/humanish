import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runInit } from "../../src/lab/init.js";
import {
  CAPS_RUN,
  EM_DASH,
  FIX_TAG,
  ISSUE_REF,
  LANE_WORD,
  WORD_KINDS,
  blankCodeSpans,
  isCapsEmphasis,
} from "../../scripts/lib/prose-rules.mjs";

// `humanish init` writes these files into an adopter's repo, where they are committed and read as
// the product's own words. They follow every rule prose:check holds src/ comments to, at zero, plus
// the retired word sim.
const SIM_WORD = /\bsims?\b/gi;

/** Blanks what is not prose: code spans, YAML keys and file names such as `AGENTS.md`. */
function prose(line: string): string {
  return blankCodeSpans(line)
    .replace(/^(\s*#?\s*(?:-\s+)?)[\w.]+:(?=\s|$)/, (key: string) => " ".repeat(key.length))
    .replace(/\b[\w.-]+\.(?:md|ya?ml|json)\b/g, (name: string) => " ".repeat(name.length));
}

function proseHits(file: string, text: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, index) => {
    const at = (kind: string, match: RegExpMatchArray) =>
      hits.push(`${file}:${index + 1} ${kind} ${JSON.stringify(match[0])}`);
    const words = prose(line);
    for (const match of words.matchAll(ISSUE_REF)) at("issue-ref", match);
    for (const match of words.matchAll(FIX_TAG)) at("fix-tag", match);
    for (const match of words.matchAll(CAPS_RUN)) if (isCapsEmphasis(match[0])) at("caps", match);
    for (const match of words.matchAll(EM_DASH)) at("em-dash", match);
    for (const match of words.matchAll(LANE_WORD)) at("lane", match);
    for (const match of words.matchAll(SIM_WORD)) at("sim", match);
    for (const [kind, pattern] of Object.entries(WORD_KINDS)) {
      for (const match of words.matchAll(pattern)) at(kind, match);
    }
  });
  return hits;
}

async function filesUnder(root: string, dir = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(root, full)));
    else found.push(path.relative(root, full));
  }
  return found;
}

/** Runs init on a machine with a provider key, or with Codex signed in and no key. */
async function initInto(machine: "provider-key" | "signed-in-codex") {
  const root = await mkdtemp(path.join(tmpdir(), "humanish-starter-prose-"));
  const cwd = path.join(root, "project");
  const bin = path.join(root, "bin");
  await mkdir(cwd);
  await mkdir(bin);
  const env: NodeJS.ProcessEnv = { HOME: path.join(root, "home"), PATH: bin };
  if (machine === "provider-key") env.OPENAI_API_KEY = "sk-starter-prose-test";
  else {
    await writeFile(path.join(bin, "codex"), "#!/bin/sh\necho 'Logged in using ChatGPT'\n");
    await chmod(path.join(bin, "codex"), 0o755);
  }
  const result = await runInit({ cwd, yes: true, env });
  expect(result.ok).toBe(true);
  return { root, cwd };
}

describe("the files humanish init writes", () => {
  it.each(["provider-key", "signed-in-codex"] as const)(
    "hold none of the prose prose:check counts (%s)",
    async (machine) => {
      const { root, cwd } = await initInto(machine);
      try {
        const files = await filesUnder(cwd);
        expect(files).toEqual(
          expect.arrayContaining([
            "AGENTS.md",
            "humanish/labs/try-live.yaml",
            "humanish/labs/lobby-trivia-3player.yaml",
          ]),
        );
        const hits: string[] = [];
        for (const file of files) {
          hits.push(...proseHits(file, await readFile(path.join(cwd, file), "utf8")));
        }
        expect(hits).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("counts a seeded hit of each kind", () => {
    expect(
      proseHits(
        "x.yaml",
        "description: See #164 for the ONE seat — FIX-2.\n  lanes: # the lane roster, honestly\n",
      ),
    ).toEqual([
      'x.yaml:1 issue-ref "#164"',
      'x.yaml:1 fix-tag "FIX-2"',
      'x.yaml:1 caps "ONE"',
      'x.yaml:1 caps "FIX-2"',
      'x.yaml:1 em-dash "—"',
      'x.yaml:1 seat-comments "seat"',
      'x.yaml:2 lane "lane"',
      'x.yaml:2 honest "honestly"',
    ]);
  });
});
