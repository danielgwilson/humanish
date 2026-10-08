import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const SCRIPT = path.resolve("site/scripts/check-docs-highlighting.mjs");

const token = (light: string, dark: string, text: string) =>
  `<span style="--shiki-light:${light};--shiki-dark:${dark}">${text}</span>`;
// github-light and github-dark color the same scopes, so each light color has one dark partner.
const highlighted = [
  token("#6F42C1", "#B392F0", "npm"),
  token("#032F62", "#9ECBFF", " install"),
  token("#005CC5", "#79B8FF", " --save-dev"),
  token("#D73A49", "#F97583", " &&"),
  token("#24292E", "#E1E4E8", " humanish"),
].join("");
// A token no rule colors has the theme's foreground, lowercase as in the theme file.
const lightCutShort = [
  token("#24292e", "#B392F0", "npm"),
  token("#24292e", "#9ECBFF", " install"),
  token("#24292e", "#79B8FF", " --save-dev"),
].join("");
const plainText = token("#24292e", "#e1e4e8", "plain output");

// Where next build writes the docs pages with a deployment adapter, as on Vercel: the hash is the
// sha256 of the route source, /docs/[[...slug]]/page.
const ADAPTER_ROOT =
  "server/route-cache/APP_PAGE/966fe5664d321b90e424723b799fc8695a949991066b442a630706cfc863a243/$";

/** A .next directory whose docs pages hold the given code, and the checker's exit status on it. */
async function check(
  pages: Record<string, string>,
  root = "server/app",
): Promise<{ status: number; output: string }> {
  const dist = await makeTestTempDir("humanish-docs-highlighting-");
  for (const [file, code] of Object.entries(pages)) {
    await mkdir(path.dirname(path.join(dist, root, file)), { recursive: true });
    await writeFile(path.join(dist, root, file), `<pre><code>${code}</code></pre>`);
  }
  try {
    const output = execFileSync(process.execPath, [SCRIPT, dist], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { status: 0, output };
  } catch (error) {
    const failed = error as { status: number; stderr: string };
    return { status: failed.status, output: failed.stderr };
  }
}

describe("the docs highlighting check", () => {
  it("passes a build whose code keeps its colors in both themes", async () => {
    const result = await check({ "docs.html": highlighted, "docs/cli.html": plainText });
    expect(result.status).toBe(0);
  });

  it("passes a build that an adapter wrote to the route cache", async () => {
    const result = await check(
      { "docs.html": highlighted, "docs/cli.html": plainText },
      ADAPTER_ROOT,
    );
    expect(result.status).toBe(0);
  });

  it("fails a page whose tokens kept their colors in one theme only", async () => {
    const result = await check({ "docs.html": lightCutShort, "docs/cli.html": highlighted });
    expect(result.status).toBe(1);
    expect(result.output).toContain("light #24292e pairs with 3 colors");
  });

  it("fails a page whose light colors belong to other scopes", async () => {
    const misassigned = token("#005CC5", "#F97583", " =");
    const result = await check({ "docs.html": highlighted, "docs/library.html": misassigned });
    expect(result.status).toBe(1);
    expect(result.output).toContain("light #005CC5 pairs with 2 colors");
    expect(result.output).toContain("#F97583 on server/app/docs/library.html");
  });

  it("fails a build with no highlighted docs code", async () => {
    expect((await check({ "docs/cli.html": "" })).status).toBe(1);
    expect((await check({ "docs/cli.html": "" }, ADAPTER_ROOT)).status).toBe(1);
  });

  it("fails a build directory with no docs pages", async () => {
    expect((await check({})).status).toBe(1);
  });

  it("fails a route cache entry whose light colors belong to other scopes", async () => {
    const misassigned = token("#005CC5", "#F97583", " =");
    const pages = { "docs.html": highlighted, "docs/library.html": misassigned };
    expect((await check(pages, ADAPTER_ROOT)).status).toBe(1);
  });
});
