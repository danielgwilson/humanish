import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInit } from "../src/init.js";
import { resolveLabManifest, listLabManifests } from "../src/labs.js";
import { runLab } from "../src/lab-engine.js";

// The labs `humanish init` writes must actually RUN.
//
// This is the promise the whole project is built on — `npx humanish` working first-try on a new
// project — and nothing was checking it. The computer-use template shipped with
// `execution.timeoutMs: 1800000`, which the computer-use route rejects before it starts, because a
// 30-minute session plus 40 minutes of provisioning headroom exceeds the 60-minute sandbox ceiling.
// So a brand-new user who ran `humanish init` and then tried the flagship lab got
// HUMANISH_CUA_LAB_SUBJECT_INVALID — in DRY-RUN, at zero spend, but as a dead first impression.
//
// Structural tests could not have caught it: the manifest parses fine and routes fine. The
// contradiction only exists between the template and a backend's runtime budget check, so the only
// thing that finds it is running the lab.

describe("every lab `humanish init` writes is runnable", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-init-labs-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "scratch", version: "1.0.0" }), "utf8");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("resolves, routes, and completes a dry run — for every one of them", async () => {
    const init = await runInit({ cwd, yes: true });
    expect(init.ok).toBe(true);

    const listed = await listLabManifests(cwd);
    expect(listed.labs.length).toBeGreaterThan(0);

    for (const lab of listed.labs) {
      const resolved = await resolveLabManifest(cwd, lab.id);
      expect(resolved.ok, `${lab.id} should resolve`).toBe(true);
      if (!resolved.ok) continue;

      // Dry-run: no provider spend, no sandbox — but far enough into each backend to hit the
      // budget and subject checks that only fire at run time.
      const outcome = await runLab(resolved.config, {
        cwd,
        dryRun: true,
        open: false,
        lab: { id: resolved.config.id, path: resolved.path, origin: resolved.origin }
      });

      const result = outcome.result as { ok?: boolean; error?: { code?: string; message?: string } };
      expect(
        result.ok ?? true,
        `${lab.id} (${lab.path}) failed its dry run: ${result.error?.code ?? "?"} — ${result.error?.message ?? ""}`
      ).not.toBe(false);
    }
  }, 180_000);
});
