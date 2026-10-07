import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { expect, it } from "vitest";
import { parseStudy } from "../../src/study/config.js";
import { inspectStudyManifest } from "../../src/study/discover.js";
import { starterFilesFor, DEFAULT_LOCAL_BROWSER_STARTER } from "../../src/study/init-templates.js";
import { lab } from "../admission/fixtures.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const scripted = (warnings: string[]) =>
  warnings.filter((warning) => warning.includes("reads like a script"));

it("keeps committed studies and init templates free of mission and background warnings", async () => {
  const failures: Record<string, string[]> = {};
  const roots = [process.cwd()];
  for (const files of [
    starterFilesFor("openai-computer-use"),
    starterFilesFor("local-agent", DEFAULT_LOCAL_BROWSER_STARTER, "codex"),
    starterFilesFor("local-agent", DEFAULT_LOCAL_BROWSER_STARTER, "claude"),
  ]) {
    const cwd = await makeTestTempDir("humanish-warning-starters-");
    for (const file of files) {
      await mkdir(path.dirname(path.join(cwd, file.path)), { recursive: true });
      await writeFile(path.join(cwd, file.path), file.contents);
    }
    roots.push(cwd);
  }
  for (const cwd of roots) {
    for (const name of await readdir(path.join(cwd, "humanish/studies"))) {
      if (!name.endsWith(".yaml")) continue;
      const result = await inspectStudyManifest(cwd, `humanish/studies/${name}`);
      expect(result.ok, name).toBe(true);
      const warnings = result.warnings.filter(
        (warning) =>
          warning.includes("reads like a script") || warning.includes("has no persona background"),
      );
      if (warnings.length) failures[`${cwd}/${name}`] = warnings;
    }
  }
  expect(failures).toEqual({});
});

it("keeps study examples in documentation free of scripted mission warnings", async () => {
  const files = ["README.md", "CONTRIBUTING.md"];
  for (const root of ["docs", "site/content/docs"]) {
    for (const file of await readdir(root, { recursive: true })) {
      if (/\.(md|mdx)$/.test(file)) files.push(path.join(root, file));
    }
  }
  const failures: Record<string, string[]> = {};
  let checked = 0;
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    for (const [index, match] of [
      ...contents.matchAll(/```ya?ml[^\n]*\n([\s\S]*?)```/g),
    ].entries()) {
      let raw: unknown;
      try {
        raw = parse(match[1]!);
      } catch {
        continue;
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const example = raw as Record<string, unknown>;
      if (!example.actor && !example.participants) continue;
      const result = parseStudy(
        example.schema === "humanish.study.v3" ? example : lab("cuAppUrl", example),
      );
      // Partial examples still contribute their participant text when unrelated fields are omitted.
      const actor = record(example.actor);
      const fallback = result.ok
        ? result
        : parseStudy(
            lab(
              example.route === "terminal"
                ? "terminal"
                : example.route === "scripted"
                  ? "scriptedAppUrl"
                  : "cuAppUrl",
              {
                ...(example.participants === undefined
                  ? {}
                  : { participants: example.participants }),
                ...(record(example.subject).appUrl === undefined
                  ? {}
                  : { subject: { appUrl: record(example.subject).appUrl } }),
              },
              {
                ...(actor.mission === undefined ? {} : { mission: actor.mission }),
                ...(actor.tasks === undefined ? {} : { tasks: actor.tasks }),
              },
            ),
          );
      expect(fallback.ok, `${file}:${index}`).toBe(true);
      if (!fallback.ok) throw new Error(fallback.error.message);
      checked++;
      const warnings = scripted(fallback.warnings);
      if (warnings.length) failures[`${file}:${index}`] = warnings;
    }
  }
  expect(checked).toBeGreaterThan(10);
  expect(failures).toEqual({});
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
