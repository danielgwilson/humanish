import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { OBSERVER_DATA_PLACEHOLDER, injectObserverData } from "../scripts/inject";

// The durability constraints from #426, made executable: the Observer is ONE
// self-contained HTML file that renders from file://, offline, years later.
// Notably, the CURRENT observer (src/observer.ts) fails the network scan below —
// it links fonts.googleapis.com — which is exactly why the rebuild bakes fonts in.

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const SIZE_BUDGET_BYTES = 1_500_000; // pre-data budget; screenshots/data are injected per run

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function readArtifact(): Promise<string> {
  try {
    return await readFile(path.join(DIST, "index.html"), "utf8");
  } catch {
    throw new Error("dist/index.html missing — run `pnpm --filter humanish-observer build` before tests (CI builds first).");
  }
}

describe("observer artifact", () => {
  it("builds to exactly one file", async () => {
    await readArtifact();
    expect(await readdir(DIST)).toEqual(["index.html"]);
  });

  it("references no network resources and carries its fonts inline", async () => {
    const html = await readArtifact();
    expect(html).not.toMatch(/(?:src|href)=["']https?:/);
    expect(html).not.toMatch(/url\(\s*["']?https?:/);
    expect(html).not.toContain("fonts.googleapis");
    expect(html).toContain("data:font");
  });

  it(`stays within the ${SIZE_BUDGET_BYTES.toLocaleString("en-US")}-byte pre-data budget`, async () => {
    const { size } = await stat(path.join(DIST, "index.html"));
    expect(size).toBeLessThanOrEqual(SIZE_BUDGET_BYTES);
  });

  it("carries exactly one data slot and none of the dev fixture", async () => {
    const html = await readArtifact();
    expect(occurrences(html, OBSERVER_DATA_PLACEHOLDER)).toBe(1);
    // The dev-only golden import must be dead-code-eliminated from the build.
    expect(html).not.toContain("golden-first-run");
  });

  it("round-trips a frozen golden through the injection helper", async () => {
    const html = await readArtifact();
    const golden: unknown = JSON.parse(
      await readFile(path.join(ROOT, "..", "tests", "golden", "observer-data", "first-run.json"), "utf8")
    );
    const injected = injectObserverData(html, golden);
    expect(occurrences(injected, OBSERVER_DATA_PLACEHOLDER)).toBe(0);
    expect(injected).toContain('"runId":"golden-first-run"');
    expect(injected).toContain("<title>Humanish Observer — golden-first-run</title>");
    // The slot is single-use: injecting into an already-filled artifact must fail loudly.
    expect(() => injectObserverData(injected, golden)).toThrow(/slot not found/);
  });
});
