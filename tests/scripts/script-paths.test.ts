import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Scripts load compiled modules by path ("../dist/run/locate.js"), which tsc and knip do not
// follow. A quoted dist/ or src/ path must name a source that exists: dist/<p>.js and
// dist/<p>.d.ts compile from src/<p>.ts, and scripts/finish-build.mjs copies the other dist files.
const QUOTED_PATH = /["'`]((?:\.\.?\/)*(?:dist|src)\/[\w./-]+\.(?:d\.ts|m?js|m?ts|html))["'`]/g;
const COMMAND_PATH = /(?:^|\s)((?:scripts|dist|src)\/[\w./-]+)/g;
const buildOutputs = new Set(
  [...readFileSync("scripts/finish-build.mjs", "utf8").matchAll(/to: "(dist\/[^"]+)"/g)].map(
    (match) => match[1]!,
  ),
);

function missing(path: string): boolean {
  const bare = path.replace(/^(?:\.\.?\/)+/, "");
  if (bare.startsWith("scripts/")) return !existsSync(bare);
  if (buildOutputs.has(bare)) return false;
  return !existsSync(bare.replace(/^dist\//, "src/").replace(/(?:\.d\.ts|\.m?js)$/, ".ts"));
}
const quotedPaths = (text: string) => [...text.matchAll(QUOTED_PATH)].map((match) => match[1]!);

describe("script paths into dist/ and src/", () => {
  it("resolves every quoted path in scripts/ and every path in package.json scripts", () => {
    const scripts = readdirSync("scripts", { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(?:m?[jt]s|py)$/.test(file))
      .map((file) => join("scripts", file));
    const paths = scripts.flatMap((file) =>
      quotedPaths(readFileSync(file, "utf8")).map((path) => `${file}: ${path}`),
    );
    const commands = Object.entries(
      (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> })
        .scripts,
    );
    for (const [name, command] of commands)
      for (const match of command.matchAll(COMMAND_PATH))
        paths.push(`package.json ${name}: ${match[1]!}`);
    expect(paths.length).toBeGreaterThan(40);
    expect(paths.filter((entry) => missing(entry.slice(entry.lastIndexOf(" ") + 1)))).toEqual([]);
  });

  it("maps dist/ paths to their sources and skips copied build outputs", () => {
    const text = [
      'import { gone } from "../dist/substrates/local/firecracker-study.js";',
      'import { createProgram } from "../src/cli/program.js";',
      'const bundle = path.resolve("dist/tui-app.js");',
      'const types = "dist/run/locate.d.ts";',
    ].join("\n");
    expect(quotedPaths(text).filter(missing)).toEqual([
      "../dist/substrates/local/firecracker-study.js",
    ]);
  });
});
