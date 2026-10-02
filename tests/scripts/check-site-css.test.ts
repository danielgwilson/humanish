import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const SCRIPT = path.resolve("scripts/check-site-css.mjs");

type Caps = Record<string, Record<string, unknown>>;

function repoCaps(): Caps {
  return JSON.parse(readFileSync("scripts/caps.json", "utf8")) as Caps;
}

/** Runs the checker with the given caps over `root`, and returns its exit status and stdout. */
async function run(caps: Caps, root = "."): Promise<{ status: number; stdout: string }> {
  const file = path.join(await makeTestTempDir("humanish-site-css-check-"), "caps.json");
  await writeFile(file, JSON.stringify(caps));
  try {
    const stdout = execFileSync(
      process.execPath,
      [SCRIPT, "--caps", file, "--root", root, "--list"],
      { encoding: "utf8" },
    );
    return { status: 0, stdout };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, stdout: failed.stdout };
  }
}

/** A site with one stylesheet and one component. */
async function site(css: string, component: string): Promise<string> {
  const root = await makeTestTempDir("humanish-site-css-root-");
  for (const dir of ["site/app", "site/components", "site/lib", "site/content"])
    await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, "site/app/globals.css"), css);
  await writeFile(path.join(root, "site/components/card.tsx"), component);
  return root;
}

describe("site-css:check holds the site stylesheet to its caps in scripts/caps.json", () => {
  it("passes with the repo's own caps", async () => {
    expect((await run(repoCaps())).status).toBe(0);
  });

  it("counts a hex color in a rule and a class no component names", async () => {
    const root = await site(
      [
        ":root {",
        "  --ink: #1c1a16;",
        "}",
        "/* .ghost in a comment is not a rule */",
        ".card {",
        "  color: var(--ink);",
        "}",
        ".chip-pass {",
        "  border-color: #2b3fd6;",
        "}",
        ".tile {",
        "  color: #fff;",
        "}",
      ].join("\n"),
      "export const Card = ({ kind }) => <div className={`card chip-${kind}`} />;\n",
    );
    const result = await run({ site: { "css-hex-literals": 2, "unused-classes": 1 } }, root);

    expect(result.stdout).toContain("site/app/globals.css:9 #2b3fd6");
    expect(result.stdout).toContain("site/app/globals.css:12 #fff");
    expect(result.stdout).not.toContain("#1c1a16");
    expect(result.stdout).toMatch(/^ {2}site\/app\/globals\.css:11 \.tile$/m);
    expect(result.status).toBe(0);
  });

  it("fails when a count rises above its cap", async () => {
    const caps = repoCaps();
    const site = caps.site as Record<string, number>;
    site["css-hex-literals"] = site["css-hex-literals"]! - 1;
    const result = await run(caps);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/site\.css-hex-literals: \d+ \(cap \d+, over by 1\)/);
  });
});
