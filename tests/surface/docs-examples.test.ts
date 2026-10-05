import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Command, CommanderError } from "commander";
import { parse } from "yaml";
import { createProgram } from "../../src/cli/program.js";
import { parseStudy } from "../../src/study/config.js";
import { declaredParticipantCount } from "../../src/study/study-fields.js";
import { parseBrowserPersonaJourneyFromScenario } from "../../src/actors/scripted-browser/journey.js";

const root = resolve(import.meta.dirname, "..", "..");
const names = readdirSync(resolve(root, "site/content/docs"))
  .filter((name) => name.endsWith(".mdx") && name !== "cli.mdx")
  .map((name) => name.slice(0, -4));
const pages = names.map((name) => ({
  name,
  text: readFileSync(resolve(root, `site/content/docs/${name}.mdx`), "utf8"),
}));
const readme = { name: "README", text: readFileSync(resolve(root, "README.md"), "utf8") };
const llms = {
  name: "llms.txt",
  text: readFileSync(resolve(root, "site/public/llms.txt"), "utf8"),
};

/** The body of each fenced YAML block on a page. */
function yamlBlocks(text: string): string[] {
  return [...text.matchAll(/```yaml[^\n]*\n([\s\S]*?)```/g)].map((block) => block[1]!);
}

// A run id changes with every run, so shown and printed output compare with ids replaced.
const RUN_ID = /dryrun-\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{8}/g;

/** The body of each fenced text block on a page, with run ids replaced. */
function textBlocks(text: string): string[] {
  return [...text.matchAll(/```text\n([\s\S]*?)```/g)].map((block) =>
    block[1]!.replaceAll(RUN_ID, "<run>"),
  );
}

let project: string | undefined;
afterEach(async () => {
  if (project) await rm(project, { recursive: true, force: true });
  project = undefined;
});

/** Run the CLI in this process and return what it printed, with run ids replaced. */
async function runCli(args: string[]): Promise<{ exitCode: number; output: string }> {
  let exitCode = 0;
  const out: string[] = [];
  const program = createProgram({
    writeOut: (text) => out.push(text),
    writeErr: (text) => out.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  const override = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(override);
  };
  override(program);
  try {
    await program.parseAsync(["node", "humanish", ...args], { from: "node" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  return { exitCode, output: out.join("").replaceAll(RUN_ID, "<run>") };
}

// The website is a runnable setup path. Catch unsupported flags and stale lab examples before
// a reader spends provider money following them; parsing metadata never invokes CLI handlers.
describe("website documentation examples", () => {
  it("uses commands and flags the shipped CLI accepts", () => {
    const program = createProgram();
    const failures: string[] = [];
    let checked = 0;
    for (const { name, text } of [...pages, readme, llms]) {
      const examples = [...text.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g)]
        .flatMap((block) => block[1]!.split("\n"))
        .filter((line) => line.startsWith("npx humanish "))
        .map((line) => line.slice("npx ".length));
      examples.push(...[...text.matchAll(/`npx (humanish [^`]+)`/g)].map((match) => match[1]!));
      // Readme command-table rows are copyable instructions too. Missing --repo there previously
      // escaped the fenced-example check even though Commander requires it before feedback issue.
      examples.push(...[...text.matchAll(/^\| `(humanish [^`]+)` \|/gm)].map((match) => match[1]!));
      for (const line of examples) {
        const tokens = line.slice("humanish ".length).trim().split(/\s+/);
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
        if (invalid.length)
          failures.push(`${name}: unsupported flags ${invalid.join(", ")}: ${line}`);
        for (const option of command.options) {
          if (
            option.mandatory &&
            option.defaultValue === undefined &&
            !tokens.some(
              (token) =>
                token === option.long ||
                token === option.short ||
                token.startsWith(`${option.long}=`),
            )
          ) {
            failures.push(`${name}: missing required option ${option.long}: ${line}`);
          }
        }
        const requiredArguments = command.registeredArguments.filter((arg) => arg.required).length;
        if (parsed.operands.length < requiredArguments)
          failures.push(`${name}: missing required argument: ${line}`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(failures).toEqual([]);
  });

  it("accepts the complete own-app example as a live study with a study budget, including the isolated two-participant variant", () => {
    const page = pages.find(({ name }) => name === "your-app")!;
    const yaml = page.text.match(/```yaml[^\n]*\n([\s\S]*?)```/)![1]!;
    const result = parseStudy(parse(yaml));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(declaredParticipantCount(result.config)).toBe(1);
    expect(result.config.mode).toBe("live");
    expect(result.config.caps?.maxTotalUsd).toBe(4);
    expect(result.config.policies?.allowPublicTargets).toBe(true);
    const blocks = [...page.text.matchAll(/```yaml[^\n]*\n([\s\S]*?)```/g)];
    const isolated = parse(yaml);
    isolated.subject = blocks
      .map((block) => parse(block[1]!))
      .find((block) => block.subject?.source === "clone").subject;
    isolated.participants = 2;
    delete isolated.policies.allowPublicTargets;
    const panel = parseStudy(isolated);
    expect(panel.ok, JSON.stringify(panel)).toBe(true);
  });

  it("accepts the moved computer-use fragments and scripted-browser scenario", () => {
    const ownApp = parse(
      pages
        .find(({ name }) => name === "your-app")!
        .text.match(/```yaml[^\n]*\n([\s\S]*?)```/)![1]!,
    );
    for (const name of ["computer-use", "local-agents"]) {
      const page = pages.find((page) => page.name === name)!;
      for (const block of page.text.matchAll(/```yaml[^\n]*\n([\s\S]*?)```/g)) {
        const fragment = parse(block[1]!);
        const combined = { ...structuredClone(ownApp), ...fragment };
        if (fragment.subject?.source === "clone") delete combined.policies.allowPublicTargets;
        const result = parseStudy(combined);
        expect(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);
      }
    }
    const scenario = parse(
      yamlBlocks(pages.find(({ name }) => name === "study-files")!.text).find((block) =>
        block.includes("schema: humanish.scenario.v1"),
      )!,
    );
    const parsed = parseBrowserPersonaJourneyFromScenario({
      raw: scenario,
      relativePath: "humanish/scenarios/todo-onboarding.yaml",
      sourceDigest: "docs-example",
    });
    expect(parsed.failure).toBeUndefined();
    expect(parsed.journey?.steps).toHaveLength(3);
  });

  it("links to existing source files and documentation pages", () => {
    const failures: string[] = [];
    for (const { name, text } of [...pages, readme, llms]) {
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const url = match[1]!.split("#")[0]!;
        if (url.startsWith("https://humanish.dev/docs")) {
          const slug =
            url === "https://humanish.dev/docs"
              ? "index"
              : url.slice("https://humanish.dev/docs/".length);
          if (!existsSync(resolve(root, `site/content/docs/${slug}.mdx`)))
            failures.push(`${name}: ${url}`);
        } else if (url.startsWith("https://github.com/danielgwilson/humanish/blob/main/")) {
          const localPath = url.replace("https://github.com/danielgwilson/humanish/blob/main/", "");
          if (!existsSync(resolve(root, localPath))) failures.push(`${name}: ${url}`);
        } else if (url === "/docs" || url.startsWith("/docs/")) {
          const slug = url === "/docs" ? "index" : url.slice("/docs/".length);
          if (!existsSync(resolve(root, `site/content/docs/${slug}.mdx`)))
            failures.push(`${name}: ${url}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

// The concepts page and `README.md` show a study file and the output a newcomer sees.
describe("study files and command output on the docs pages", () => {
  it("parses every complete study file on the concepts and study file pages", () => {
    let checked = 0;
    for (const name of ["concepts", "study-files"]) {
      const page = pages.find((entry) => entry.name === name)!;
      for (const block of yamlBlocks(page.text)) {
        if (!block.includes("schema: humanish.study.v3")) continue;
        const result = parseStudy(parse(block));
        expect(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("shows the output the CLI prints for the first run and the concepts study", async () => {
    const cwd = (project = await mkdtemp(join(tmpdir(), "humanish-docs-output-")));
    await runCli(["init", "--yes", "--cwd", cwd]);
    const study = yamlBlocks(pages.find(({ name }) => name === "concepts")!.text)[0]!;
    await writeFile(join(cwd, "humanish", "studies", "two-newcomers.yaml"), study);
    const printed = {
      run: (await runCli(["run", "first-run", "--cwd", cwd])).output,
      verify: (await runCli(["verify", "--cwd", cwd])).output,
      check: (await runCli(["study", "check", "two-newcomers", "--cwd", cwd])).output,
    };
    const shown = (text: string, opening: string) =>
      textBlocks(text).find((block) => block.startsWith(opening));
    const concepts = pages.find(({ name }) => name === "concepts")!.text;
    expect({
      readmeRun: shown(readme.text, "humanish run dry-run"),
      readmeVerify: shown(readme.text, "verified "),
      conceptsCheck: shown(concepts, "humanish study check"),
      conceptsVerify: shown(concepts, "verified "),
    }).toEqual({
      readmeRun: printed.run,
      readmeVerify: printed.verify,
      conceptsCheck: printed.check,
      conceptsVerify: printed.verify,
    });
  });
});
