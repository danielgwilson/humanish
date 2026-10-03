import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Every route's recorded run directory, live and failed: a raw sandbox id may appear in
// sandbox-receipts.ndjson and nowhere else the run writes. The goldens hold each file of the run
// directory under its name; `<result>` is the route's own return value, which the study runner
// redacts before a caller or the CLI sees it (tests/run/sandbox-ids-result.test.ts).

const GOLDEN_DIRS = ["tests/golden/routes", "tests/golden/failures"];

async function goldenFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? goldenFiles(file) : Promise.resolve([file]);
    }),
  );
  return nested.flat().filter((file) => file.endsWith(".json"));
}

const goldens = (await Promise.all(GOLDEN_DIRS.map(goldenFiles))).flat().sort();
const withReceipts = await Promise.all(
  goldens.map(async (file) => {
    const snapshot = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const receipts = snapshot["sandbox-receipts.ndjson"];
    const ids = Array.isArray(receipts)
      ? receipts.flatMap((receipt: { sandboxId?: unknown }) =>
          typeof receipt.sandboxId === "string" ? [receipt.sandboxId] : [],
        )
      : [];
    return { file, snapshot, ids };
  }),
);
const cases = withReceipts.filter((golden) => golden.ids.length > 0);

describe("raw sandbox ids in recorded run directories", () => {
  it("covers every route that creates a sandbox", () => {
    const routes = new Set(cases.map(({ file }) => path.basename(file).split("-")[0]));
    expect([...routes].sort()).toEqual(
      expect.arrayContaining(["computer", "scripted", "shared", "terminal"]),
    );
  });

  it.each(
    cases.map(
      ({ file, snapshot, ids }) => [path.relative("tests/golden", file), snapshot, ids] as const,
    ),
  )("%s names its sandboxes only in sandbox-receipts.ndjson", (_name, snapshot, ids) => {
    for (const [entry, content] of Object.entries(snapshot)) {
      if (entry === "sandbox-receipts.ndjson" || entry === "<result>") continue;
      const text = JSON.stringify(content);
      for (const id of ids) expect(text, `${entry} names ${id}`).not.toContain(id);
    }
  });
});
