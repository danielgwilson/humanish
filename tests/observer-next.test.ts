import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { renderObserver } from "../src/observer.js";
import { OBSERVER_DATA_SCHEMA } from "../src/observer-data.js";
import { runDryRun } from "../src/run.js";

// The HUMANISH_OBSERVER=next seam (#426 stage 3): renderObserverHtml is the one choke
// point every surface funnels through, so these two tests pin both sides of the switch —
// the flag renders the prebuilt workspace artifact with the snapshot injected, and the
// default path keeps producing the legacy renderer untouched until parity sign-off.

const ARTIFACT = path.resolve("observer/dist/index.html");

beforeAll(() => {
  // Root `pnpm check` runs tests before the root build; make the workspace artifact
  // self-sufficiently present the same way CI's observer job builds it.
  if (!existsSync(ARTIFACT)) {
    execSync("pnpm --filter humanish-observer build", { cwd: path.resolve("."), stdio: "pipe" });
  }
});

async function withRunBundle<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-observer-next-"));
  const tempApp = path.join(tempRoot, "minimal-app");
  try {
    await cp(path.resolve("fixtures/minimal-app"), tempApp, { recursive: true });
    await runDryRun({ cwd: tempApp, dryRun: true, runId: "observer-proof" });
    return await callback(tempApp);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

describe("HUMANISH_OBSERVER=next", () => {
  it("renders the prebuilt workspace artifact with the snapshot inlined", async () => {
    await withRunBundle(async (cwd) => {
      process.env.HUMANISH_OBSERVER = "next";
      let html: string;
      try {
        const result = await renderObserver(cwd, "latest");
        expect(result.ok).toBe(true);
        html = await readFile(path.join(cwd, result.observerPath ?? ""), "utf8");
      } finally {
        delete process.env.HUMANISH_OBSERVER;
      }
      expect(html).not.toContain("__HUMANISH_OBSERVER_DATA__");
      expect(html).toContain(`"schema":"${OBSERVER_DATA_SCHEMA}"`);
      expect(html).toContain("<title>Humanish Observer — observer-proof</title>");
      // The durability property the rebuild exists for: no network references.
      expect(html).not.toContain("fonts.googleapis");
    });
  });

  it("keeps the legacy renderer byte-for-byte the default", async () => {
    await withRunBundle(async (cwd) => {
      const result = await renderObserver(cwd, "latest");
      expect(result.ok).toBe(true);
      const html = await readFile(path.join(cwd, result.observerPath ?? ""), "utf8");
      // Legacy markers: the network font link (the known durability gap the flag fixes)
      // and the string-concat client. The artifact's placeholder never appears on this path.
      expect(html).toContain("fonts.googleapis");
      expect(html).not.toContain("__HUMANISH_OBSERVER_DATA__");
    });
  });
});
