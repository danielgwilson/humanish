import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);

// THE property a launched run depends on: it must outlive the surface that started it.
//
// A study takes minutes and costs money. If closing the TUI — or losing the SSH session it runs
// over — killed the run, the surface would be actively dangerous to use from a laptop. Asserting
// `detached: true` was passed only checks that we asked; this checks that it WORKED, by killing the
// parent for real and watching the child finish anyway.

describe("a launched run outlives the process that started it", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-detach-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps running after its parent exits", async () => {
    const marker = path.join(dir, "survived.txt");
    // Stands in for the CLI: outlives its parent by a margin, then leaves proof it got there.
    const stub = path.join(dir, "stub-cli.mjs");
    await writeFile(
      stub,
      [
        "import { writeFileSync } from 'node:fs';",
        `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'ok'), 1200);`
      ].join("\n"),
      "utf8"
    );

    // A parent that launches and then exits IMMEDIATELY — the surface being closed mid-run.
    const parent = path.join(dir, "parent.mjs");
    const launchModule = path.resolve("src/tui-launch.ts");
    await writeFile(
      parent,
      [
        `const { launchRun } = await import(${JSON.stringify(launchModule)});`,
        `const result = await launchRun({ cwd: ${JSON.stringify(dir)}, lab: 'stub', mode: 'dry-run', cliPath: ${JSON.stringify(stub)} });`,
        "if (!result.ok) { console.error(result.error.message); process.exit(1); }",
        "process.exit(0);"
      ].join("\n"),
      "utf8"
    );

    // tsx so the parent can import the TypeScript source directly.
    await run("npx", ["tsx", parent], { cwd: process.cwd() });

    // The parent is gone. If detachment did not work, the child died with it and this never appears.
    const deadline = Date.now() + 8_000;
    for (;;) {
      const found = await readFile(marker, "utf8").catch(() => null);
      if (found === "ok") break;
      if (Date.now() > deadline) {
        throw new Error("the launched process did not survive its parent exiting");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await readFile(marker, "utf8")).toBe("ok");
  }, 30_000);
});
