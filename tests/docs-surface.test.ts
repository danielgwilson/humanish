import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { createProgram } from "../src/program.js";
import { parseLabConfig } from "../src/lab-config.js";
import { parseBrowserPersonaJourneyFromScenario } from "../src/scripted-browser-actor.js";

const root = resolve(import.meta.dirname, "..");
const names = readdirSync(resolve(root, "site/content/docs"))
  .filter((name) => name.endsWith(".mdx") && name !== "cli.mdx")
  .map((name) => name.slice(0, -4));
const pages = names.map((name) => ({ name, text: readFileSync(resolve(root, `site/content/docs/${name}.mdx`), "utf8") }));
const readme = { name: "README", text: readFileSync(resolve(root, "README.md"), "utf8") };

// The website is a runnable setup path. Catch unsupported flags and stale lab examples before
// a reader spends provider money following them; parsing metadata never invokes CLI handlers.
describe("website documentation examples", () => {
  it("uses commands and flags the shipped CLI accepts", () => {
    const program = createProgram();
    const failures: string[] = [];
    let checked = 0;
    for (const { name, text } of [...pages, readme]) {
      for (const block of text.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g)) {
        for (const line of block[1]!.split("\n")) {
          if (!line.startsWith("npx humanish ")) continue;
          const tokens = line.slice("npx humanish ".length).trim().split(/\s+/);
          let command = program;
          while (tokens.length > 0 && command.commands.length > 0) {
            const child = command.commands.find((entry) => entry.name() === tokens[0]);
            if (!child) break;
            tokens.shift();
            command = child;
          }
          if (command === program) failures.push(`${name}: unknown command: ${line}`);
          const parsed = command.parseOptions(tokens);
          const invalid = parsed.unknown.filter((token) => token.startsWith("-"));
          if (invalid.length) failures.push(`${name}: unsupported flags ${invalid.join(", ")}: ${line}`);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(failures).toEqual([]);
  });

  it("accepts the complete own-app example as a live lab with a study budget, including the isolated two-participant variant", () => {
    const page = pages.find(({ name }) => name === "your-app")!;
    const yaml = page.text.match(/```yaml[^\n]*\n([\s\S]*?)```/)![1]!;
    const result = parseLabConfig(parse(yaml));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.config.actors[0]?.count).toBe(1);
    expect(result.config.scenario?.mode).toBe("live");
    expect(result.config.execution?.caps?.maxTotalUsd).toBe(4);
    expect(result.config.policies?.allowPublicTargets).toBe(true);
    const blocks = [...page.text.matchAll(/```yaml[^\n]*\n([\s\S]*?)```/g)];
    const isolated = parse(yaml);
    isolated.subject = parse(blocks[1]![1]!).subject;
    isolated.actors[0].count = 2;
    delete isolated.policies.allowPublicTargets;
    const panel = parseLabConfig(isolated);
    expect(panel.ok, JSON.stringify(panel)).toBe(true);
  });

  it("accepts the moved computer-use fragments and scripted-browser scenario", () => {
    const ownApp = parse(pages.find(({ name }) => name === "your-app")!.text.match(/```yaml[^\n]*\n([\s\S]*?)```/)![1]!);
    for (const name of ["computer-use", "local-agents"]) {
      const page = pages.find((page) => page.name === name)!;
      for (const block of page.text.matchAll(/```yaml[^\n]*\n([\s\S]*?)```/g)) {
        const fragment = parse(block[1]!);
        const combined = { ...structuredClone(ownApp), ...fragment };
        if (fragment.subject?.source === "clone") delete combined.policies.allowPublicTargets;
        const result = parseLabConfig(combined);
        expect(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);
      }
    }
    const scenario = parse(pages.find(({ name }) => name === "lab-manifests")!.text.match(/```yaml[^\n]*\n([\s\S]*?)```/)![1]!);
    const parsed = parseBrowserPersonaJourneyFromScenario({ raw: scenario, relativePath: "humanish/scenarios/todo-onboarding.yaml", sourceDigest: "docs-example" });
    expect(parsed.failure).toBeUndefined();
    expect(parsed.journey?.steps).toHaveLength(3);
  });

  it("links to existing source files and documentation pages", () => {
    const failures: string[] = [];
    for (const { name, text } of [...pages, readme]) {
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const url = match[1]!.split("#")[0]!;
        if (url.startsWith("https://humanish.dev/docs")) {
          const slug = url === "https://humanish.dev/docs" ? "index" : url.slice("https://humanish.dev/docs/".length);
          if (!existsSync(resolve(root, `site/content/docs/${slug}.mdx`))) failures.push(`${name}: ${url}`);
        } else if (url.startsWith("https://github.com/danielgwilson/humanish/blob/main/")) {
          const localPath = url.replace("https://github.com/danielgwilson/humanish/blob/main/", "");
          if (!existsSync(resolve(root, localPath))) failures.push(`${name}: ${url}`);
        } else if (url === "/docs" || url.startsWith("/docs/")) {
          const slug = url === "/docs" ? "index" : url.slice("/docs/".length);
          if (!existsSync(resolve(root, `site/content/docs/${slug}.mdx`))) failures.push(`${name}: ${url}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
