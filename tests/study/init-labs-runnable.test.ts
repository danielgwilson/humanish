import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { defaultCodexCliVersion } from "../../src/actors/codex/codex-admission.js";
import { parseStudy } from "../../src/study/config.js";
import { runInit } from "../../src/study/init.js";
import { starterFilesFor } from "../../src/study/init-templates.js";
import { resolveStudyManifest, listStudyManifests } from "../../src/study/discover.js";
import { runStudyWith } from "../../src/run-study.js";
import { routeOf } from "../../src/study/plan.js";
import { runCuaActorStudy } from "../../src/routes/computer-use/route.js";
import { isLocalBrowserStudy } from "../../src/substrates/local/runtime-config.js";

// The studies `humanish init` writes must actually run.
//
// This is the promise the whole project is built on: `npx humanish` working first-try on a new
// project, and nothing was checking it. The computer-use template shipped with
// `execution.timeoutMs: 1800000`, which the computer-use route rejects before it starts, because a
// 30-minute session plus 40 minutes of provisioning headroom exceeds the 60-minute sandbox ceiling.
// So a brand-new user who ran `humanish init` and then tried the flagship lab got
// HUMANISH_COMPUTER_USE_SUBJECT_INVALID: in dry-run, at zero spend, but as a dead first impression.
//
// Structural tests could not have caught it: the manifest parses fine and routes fine. The
// contradiction only exists between the template and a backend's runtime budget check, so the only
// thing that finds it is running the lab.

describe("every lab `humanish init` writes is runnable", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-init-labs-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "scratch", version: "1.0.0" }),
      "utf8",
    );
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("resolves, routes, and completes a dry run: for every one of them", async () => {
    const init = await runInit({ cwd, yes: true });
    expect(init.ok).toBe(true);

    const listed = await listStudyManifests(cwd);
    expect(listed.studies.length).toBeGreaterThan(0);

    for (const lab of listed.studies) {
      const resolved = await resolveStudyManifest(cwd, lab.id);
      expect(resolved.ok, `${lab.id} should resolve`).toBe(true);
      if (!resolved.ok) continue;

      // Dry-run: no provider spend, no sandbox, but far enough into each backend to hit the
      // budget and subject checks that only fire at run time.
      const outcome = await runStudyWith(resolved.config, {
        cwd,
        dryRun: true,
        open: false,
        lab: { id: resolved.config.id, path: resolved.path, origin: resolved.origin },
      });

      const result = outcome.result as {
        ok?: boolean;
        error?: { code?: string; message?: string };
      };
      expect(
        result.ok ?? true,
        `${lab.id} (${lab.path}) failed its dry run: ${result.error?.code ?? "?"} — ${result.error?.message ?? ""}`,
      ).not.toBe(false);
    }
  }, 180_000);
});

// Dry runs skip live admission, which is where a ChatGPT-account participant refuses a dollar cap
// (HUMANISH_COMPUTER_USE_UNPRICED_CAP). So each starter set also runs the live admission for the actor
// its computer-use labs declare, stopping at the first desktop request.
describe.each(["openai-computer-use", "local-agent"] as const)("the %s starter set", (actor) => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-starter-set-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("parses, dry-runs and passes live admission for every lab it writes", async () => {
    const files = starterFilesFor(actor);
    for (const file of files) {
      await mkdir(path.dirname(path.join(cwd, file.path)), { recursive: true });
      await writeFile(path.join(cwd, file.path), file.contents, "utf8");
    }
    // A signed-in ChatGPT-account Codex at the qualified version, and a synthetic provider key.
    const bin = path.join(cwd, "bin");
    await mkdir(bin);
    await writeFile(
      path.join(bin, "codex"),
      `#!${process.execPath}\nconst args = process.argv.slice(2).join(" ");\nif (args === "login status") { process.stderr.write("Logged in using ChatGPT\\n"); process.exit(0); }\nif (args === "--version") { process.stdout.write("codex-cli ${defaultCodexCliVersion()}\\n"); process.exit(0); }\nprocess.exit(99);\n`,
    );
    await chmod(path.join(bin, "codex"), 0o700);
    const env = { PATH: bin, OPENAI_API_KEY: "synthetic-starter-admission-key" };

    const labs = files.filter((file) => file.path.startsWith("humanish/studies/"));
    expect(labs.map((file) => file.path)).toContain("humanish/studies/try-live.yaml");
    for (const file of labs) {
      const parsed = parseStudy(parse(file.contents));
      expect(parsed.ok, `${file.path} should parse`).toBe(true);
      if (!parsed.ok) continue;
      const config = parsed.config;

      const outcome = await runStudyWith(config, {
        cwd,
        dryRun: true,
        open: false,
        lab: { id: config.id, path: file.path, origin: "committed" },
      });
      const dry = outcome.result as { ok?: boolean; error?: { code?: string; message?: string } };
      expect(
        dry.ok ?? true,
        `${file.path} dry run: ${dry.error?.code} ${dry.error?.message}`,
      ).not.toBe(false);

      if (routeOf(config) !== "computer-use") continue;
      // Past admission the run asks for its desktop: the local study's for a local browser lab,
      // the E2B module for a hosted one. Either throws here, so no desktop is created.
      const admitted = new Error("admission passed; no desktop is created in this test");
      const desktopReached = vi.fn(() => {
        throw admitted;
      });
      const local = isLocalBrowserStudy(config);
      let refusal = "";
      try {
        const live = await runCuaActorStudy({
          cwd,
          config: { ...config, scenario: { ...config.scenario, mode: "live" } },
          dryRun: false,
          env: { ...env, E2B_API_KEY: "synthetic-starter-e2b-key" },
          ...(local ? {} : { deps: { desktopModule: async () => desktopReached() } }),
          ...(local
            ? { localVm: { desktop: () => desktopReached(), analysisRefusal: () => undefined } }
            : {}),
        });
        refusal = `${live.error?.code} ${live.error?.message}`;
      } catch (error) {
        if (error !== admitted) throw error;
      }
      expect(
        desktopReached,
        `${file.path} (${config.actors[0]?.type}) was refused before a desktop: ${refusal}`,
      ).toHaveBeenCalled();
    }
  }, 180_000);

  it("carries a dollar cap only when the participant has an API price", () => {
    const tryLive = starterFilesFor(actor).find(
      (file) => file.path === "humanish/studies/try-live.yaml",
    )!;
    const parsed = parseStudy(parse(tryLive.contents));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.actors[0]?.type).toBe(actor);
    expect(parsed.config.execution?.timeoutMs).toBe(600_000);
    expect(parsed.config.execution?.caps?.maxUsd).toBe(actor === "local-agent" ? undefined : 2);
  });
});
