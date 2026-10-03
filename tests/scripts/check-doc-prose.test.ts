import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DOC_WORD_KINDS,
  docProse,
  docRootOf,
  isDocCapsEmphasis,
} from "../../scripts/lib/doc-prose.mjs";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const SCRIPT = path.resolve("scripts/check-code-prose.mjs");
const CODE_KINDS = [
  "issue-refs",
  "fix-tags",
  "caps",
  "lane-comments",
  "em-dashes",
  "invariant-refs",
  "authority",
  "archaeology",
  "seat-comments",
  "cua-route",
  "honest",
  "history",
  "series-codes",
  "name-refs",
];
const DOC_KINDS = [
  "issue-refs",
  "caps",
  "em-dashes",
  "invariant-refs",
  "authority",
  "honest",
  "archaeology",
  "contrast",
];

/** Runs the checker over fixture pages with every cap at 0, and returns its `--list` output. */
async function listFor(pages: Record<string, string>): Promise<string> {
  const cwd = await makeTestTempDir("humanish-doc-prose-");
  for (const [file, text] of Object.entries(pages)) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await writeFile(path.join(cwd, file), text);
  }
  const zeros = (kinds: string[]) => Object.fromEntries(kinds.map((kind) => [kind, 0]));
  const prose = {
    ...Object.fromEntries(
      ["src", "tests", "scripts", "tui", "observer"].map((root) => [root, zeros(CODE_KINDS)]),
    ),
    ...Object.fromEntries(["docs", "site", "evidence"].map((root) => [root, zeros(DOC_KINDS)])),
    markdown: { "title-case-headers": 0 },
  };
  await mkdir(path.join(cwd, "scripts"), { recursive: true });
  await writeFile(path.join(cwd, "scripts", "caps.json"), JSON.stringify({ prose }));
  try {
    return execFileSync(process.execPath, [SCRIPT, "--list"], { cwd, encoding: "utf8" });
  } catch (error) {
    return (error as { stdout: string }).stdout;
  }
}

/** The hits listed under one cap path, as `file:line word`. */
function hitsUnder(output: string, capPath: string): string[] {
  const lines = output.split("\n");
  const header = lines.findIndex((line) => line.startsWith(`${capPath}: `));
  const after = lines.slice(header + 1);
  return after
    .slice(
      0,
      after.findIndex((line) => !line.startsWith("  ")),
    )
    .map((line) => line.trim());
}

describe("docs prose roots", () => {
  it("sorts pages into docs, site and evidence, and skips history, the CLI reference and the changelog", () => {
    expect(
      [
        "README.md",
        "docs/contracts/schemas.md",
        "docs/evidence/computer-use/run-2026-09-01.md",
        "docs/history/goals/x/goal.md",
        "site/content/docs/library.mdx",
        "site/content/docs/cli.mdx",
        "CHANGELOG.md",
      ].map(docRootOf),
    ).toEqual(["docs", "docs", "evidence", undefined, "site", undefined, undefined]);
  });

  it("blanks front matter, code, link targets, URLs and tags, and keeps line numbers", () => {
    const page = [
      "---",
      "title: NOT counted",
      "---",
      "Plain prose.",
      "```bash",
      "NO=1 humanish run # 12",
      "```",
      "A `NOT` span, a [link](https://example.test/#9 'x'), <Callout NOTE>, http://host/#4.",
    ].join("\n");
    const prose = docProse(page);
    expect(prose.split("\n")).toHaveLength(page.split("\n").length);
    expect(prose).not.toMatch(/NOT|NO=|#\d/);
    expect(prose).toContain("Plain prose.");
  });

  it("reads repo file names and acronyms as names, and other caps as emphasis", () => {
    expect(
      ["README", "CONTRIBUTING", "WAI-ARIA", "E2B-desktop", "ISO-8601"].map(isDocCapsEmphasis),
    ).toEqual([false, false, false, false, false]);
    expect(["NOT", "operator-OWNED", "DRY-RUN"].map(isDocCapsEmphasis)).toEqual([true, true, true]);
  });

  it("counts slice and phase labels as archaeology, and contrast frames", () => {
    const archaeology = "SLICE 2 shipped the seam; phase 2 followed, and this slice stopped there.";
    expect(archaeology.match(DOC_WORD_KINDS.archaeology!)).toEqual([
      "SLICE 2",
      "phase 2",
      "this slice",
    ]);
    const contrast = "It is not just fast, not merely cheap, and refused rather than free.";
    expect(contrast.match(DOC_WORD_KINDS.contrast!)).toEqual([
      "not just",
      "not merely",
      "rather than",
    ]);
  });

  it("counts each kind per root, with the page and line", async () => {
    const output = await listFor({
      "README.md": "# humanish\n\nRead [CONTRIBUTING.md](CONTRIBUTING.md). It is NOT optional.\n",
      "docs/architecture/route.md": "# Route\n\nShipped in #154 — rather than later.\n",
      "site/content/docs/guide.mdx":
        "---\ntitle: Guide\n---\n\nAn honest guide; see invariant 3.\n",
      "docs/evidence/computer-use/run-2026-09-01.md": "# Run\n\nREACHED the goal.\n",
      "docs/history/plans/old.md": "# Old\n\nNOT counted — #1.\n",
    });
    expect(hitsUnder(output, "prose.docs.caps")).toEqual(["README.md:3 NOT"]);
    expect(hitsUnder(output, "prose.docs.issue-refs")).toEqual([
      "docs/architecture/route.md:3 #154",
    ]);
    expect(hitsUnder(output, "prose.docs.em-dashes")).toEqual(["docs/architecture/route.md:3 —"]);
    expect(hitsUnder(output, "prose.docs.contrast")).toEqual([
      "docs/architecture/route.md:3 rather than",
    ]);
    expect(hitsUnder(output, "prose.site.honest")).toEqual([
      "site/content/docs/guide.mdx:5 honest",
    ]);
    expect(hitsUnder(output, "prose.site.invariant-refs")).toEqual([
      "site/content/docs/guide.mdx:5 invariant 3",
    ]);
    expect(hitsUnder(output, "prose.evidence.caps")).toEqual([
      "docs/evidence/computer-use/run-2026-09-01.md:3 REACHED",
    ]);
  });
});
