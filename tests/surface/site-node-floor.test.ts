import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The site states the Node version the CLI needs in several places. Each claim must equal the
// floor in package.json engines.node, and the site description must read the same in llms.txt.

const root = path.resolve(import.meta.dirname, "../..");

async function files(directory: string, extensions: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(relative, extensions)));
    else if (extensions.includes(path.extname(entry.name))) found.push(relative);
  }
  return found;
}

describe("site Node claims", () => {
  it("state the engines.node floor everywhere", async () => {
    const { engines } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const match = /^>=(\d+)\.(\d+)\.\d+$/.exec(engines.node);
    expect(match, `engines.node ${engines.node}`).not.toBeNull();
    const floor = `${match![1]}.${match![2]}`;
    const sources = [
      ...(await files("site/components", [".tsx", ".ts"])),
      ...(await files("site/app", [".tsx", ".ts"])),
      ...(await files("site/content", [".mdx", ".md"])),
      "site/public/llms.txt",
    ];
    const claims: string[] = [];
    for (const file of sources) {
      const text = await readFile(path.join(root, file), "utf8");
      for (const claim of text.matchAll(/\bNode (\d+(?:\.\d+)?)(?:\+| or newer)/g))
        claims.push(`${file}: Node ${claim[1]}`);
    }
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.filter((claim) => !claim.endsWith(`Node ${floor}`))).toEqual([]);
  });

  it("describe the product in llms.txt as the layout does", async () => {
    const layout = await readFile(path.join(root, "site/app/layout.tsx"), "utf8");
    const description = /const DESCRIPTION =\s*"([^"]+)"/.exec(layout)?.[1];
    expect(description).toBeDefined();
    const llms = await readFile(path.join(root, "site/public/llms.txt"), "utf8");
    // The description is the first blockquote, right under the title.
    const quote = /^((?:> .*\n)+)/m
      .exec(llms)?.[1]
      ?.replace(/^> /gm, "")
      .replace(/\n/g, " ")
      .trim();
    expect(quote).toBe(description!.replace(/’/g, "'"));
  });
});
