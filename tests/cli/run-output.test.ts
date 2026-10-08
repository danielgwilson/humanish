import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { createProgram } from "../../src/cli/program.js";
import { analysisOutcomeText } from "../../src/cli/io.js";
import { runNotFoundMessage } from "../../src/run/run-not-found.js";
import { lab, SCENARIO_YAML, type BaseName, type Patch } from "../admission/fixtures.js";

async function runCli(args: string[]) {
  let exitCode = 0;
  const out: string[] = [];
  const stdout: string[] = [];
  const program = createProgram({
    writeOut: (text) => {
      out.push(text);
      stdout.push(text);
    },
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
  return { exitCode, output: out.join(""), stdout: stdout.join("") };
}

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});
const freshProject = async () => (dir = await mkdtemp(path.join(tmpdir(), "humanish-run-output-")));

/** A fresh project holding one admission fixture study, and that study's id. */
async function fixtureStudy(base: BaseName, patch: Patch = {}) {
  const cwd = await freshProject();
  const raw = lab(base, patch);
  const id = String(raw.id);
  await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
  await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
  await writeFile(path.join(cwd, "humanish", "scenarios", "adm-journey.yaml"), SCENARIO_YAML);
  await writeFile(path.join(cwd, "humanish", "studies", `${id}.yaml`), stringify(raw));
  return { cwd, id };
}

describe("a run's review in human mode", () => {
  it("prints the verdict, summary, gaps and path, not JSON", async () => {
    const cwd = await freshProject();
    await runCli(["init", "--yes", "--cwd", cwd]);
    await runCli(["run", "first-run", "--cwd", cwd]);
    const { exitCode, output } = await runCli(["review", "--cwd", cwd]);
    expect(exitCode).toBe(0);
    expect(output).toMatch(
      /^humanish review dryrun-\S+: dry run; no product behavior was tested\n/,
    );
    expect(output).toContain("\ngaps:\n- No browser was launched.\n");
    expect(output).toMatch(/\nreview: \.humanish\/runs\/dryrun-\S+\/review\.json\n$/);
    expect(output).not.toContain("{");
  });
});

describe("a run whose execution failed under a pass verdict", () => {
  it("leads its review with how the run ended and why, not the pass", async () => {
    const cwd = await freshProject();
    await runCli(["init", "--yes", "--cwd", cwd]);
    await runCli(["run", "first-run", "--cwd", cwd]);
    const runDir = path.join(cwd, ".humanish", "runs");
    const runId = JSON.parse(await readFile(path.join(runDir, "latest.json"), "utf8")).runId;
    const bundlePath = path.join(runDir, runId, "run.json");
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    bundle.review.verdict = "pass";
    bundle.outcome = {
      state: "finished",
      ok: false,
      execution: {
        succeeded: false,
        failures: [{ kind: "provider-cleanup", message: "lane-01: cleanup unconfirmed" }],
      },
    };
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
    const reviewPath = path.join(runDir, runId, "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    await writeFile(reviewPath, `${JSON.stringify({ ...review, verdict: "pass" }, null, 2)}\n`);

    const { output } = await runCli(["review", "--cwd", cwd]);
    expect(output).toMatch(
      /^humanish review \S+: failed \(verdict pass\)\nwhy: provider-cleanup: lane-01: cleanup unconfirmed\n/,
    );
  });
});

describe("a run stopped by a signal after its participants were judged", () => {
  it("leads its review with interrupted, as humanish runs does, then the verdict", async () => {
    const cwd = await freshProject();
    await runCli(["init", "--yes", "--cwd", cwd]);
    await runCli(["run", "first-run", "--cwd", cwd]);
    const runDir = path.join(cwd, ".humanish", "runs");
    const runId = JSON.parse(await readFile(path.join(runDir, "latest.json"), "utf8")).runId;
    const bundlePath = path.join(runDir, runId, "run.json");
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    bundle.review.verdict = "fail";
    bundle.outcome = { state: "interrupted", ok: false, signal: "SIGINT", at: bundle.createdAt };
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
    const reviewPath = path.join(runDir, runId, "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    await writeFile(reviewPath, `${JSON.stringify({ ...review, verdict: "fail" }, null, 2)}\n`);

    const runs = JSON.parse((await runCli(["runs", "--cwd", cwd, "--json"])).output);
    expect(runs.runs[0].display.label).toBe("interrupted");
    const { output } = await runCli(["review", "--cwd", cwd]);
    expect(output).toMatch(/^humanish review \S+: interrupted \(verdict fail\)\n\n/);
  });
});

describe("a run that is not there", () => {
  it("says how to start one in an empty project, and how to list them otherwise", async () => {
    const cwd = await freshProject();
    expect(await runNotFoundMessage(cwd, "latest")).toBe(
      `No runs in ${cwd} yet; start one with humanish run first-run.`,
    );
    const verify = await runCli(["verify", "--run", "nope", "--cwd", cwd]);
    expect(verify.output).toContain(
      `No runs in ${cwd} yet; start one with humanish run first-run.`,
    );
    await runCli(["init", "--yes", "--cwd", cwd]);
    expect((await runCli(["run", "first-run", "--cwd", cwd])).exitCode).toBe(0);
    expect(await runNotFoundMessage(cwd, "nope")).toBe("No run nope; humanish runs lists them.");
  });

  it("is built in one place", async () => {
    const offenders: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (file.endsWith(".ts") && (await readFile(file, "utf8")).includes("Run not found:"))
          offenders.push(file);
      }
    };
    await walk("src");
    expect(offenders).toEqual([]);
  });
});

describe("lab run output", () => {
  it("names the command that ran, never a `humanish lab <route>` command that does not exist", async () => {
    const source = await readFile("src/cli/commands/study-format.ts", "utf8");
    expect(
      source.match(/`humanish lab (cua|terminal|scripted|concurrent-shared-world) /g),
    ).toBeNull();
  });

  it("says what bare `humanish run` needs and where to go next", async () => {
    const cwd = await freshProject();
    const { exitCode, output } = await runCli(["run", "--cwd", cwd]);
    expect(exitCode).toBe(2);
    expect(output).toContain(
      "humanish run needs a study. List studies with humanish study list, or run humanish run --dry-run for a sample bundle.",
    );
  });
});

describe("the automatic analysis line", () => {
  it("has a sentence for every reason the analysis records", async () => {
    const reasons = new Set<string>();
    for (const name of await readdir("src/analysis"))
      if (name.endsWith(".ts"))
        for (const match of (await readFile(path.join("src/analysis", name), "utf8")).matchAll(
          /"(AUTOMATIC_ANALYSIS_[A-Z_]+)"/g,
        ))
          reasons.add(match[1]!);
    expect(reasons.size).toBeGreaterThan(15);
    for (const reason of reasons)
      expect(analysisOutcomeText({ state: "skipped", reason }), reason).not.toContain(reason);
    expect(analysisOutcomeText({ state: "skipped", reason: "AUTOMATIC_ANALYSIS_DRY_RUN" })).toBe(
      "skipped for dry runs",
    );
    // An unmapped reason still prints, with its state.
    expect(analysisOutcomeText({ state: "failed", reason: "SOMETHING_NEW" })).toBe(
      "failed (SOMETHING_NEW)",
    );
  });
});

describe("the subject line of a run", () => {
  it.each<[string, BaseName, string]>([
    ["an app-url", "cuAppUrl", "subject: http://127.0.0.1:3000/"],
    ["a clone", "cuClone", "subject: http://127.0.0.1:3000/"],
    ["a local-tree", "cuLocalTree", "subject: http://127.0.0.1:3000/"],
    ["a desktop-cli", "cuDesktopCli", "subject: widgetsmith-cli (desktop-cli)"],
    ["a scripted app-url", "scriptedAppUrl", "subject: http://127.0.0.1:3000/"],
    ["a scripted clone", "scriptedClone", "subject: [provisioned-subject]"],
    ["a terminal-product", "terminal", "product: widgetsmith-cli"],
  ])("names %s subject after the actor line", async (_kind, base, line) => {
    const { cwd, id } = await fixtureStudy(base);
    const { stdout } = await runCli(["run", id, "--cwd", cwd]);
    expect(stdout.split("\n")[4]).toBe(line);
  });

  it.each<[string, BaseName, string]>([
    ["an app-url", "cuAppUrl", "subject: http://127.0.0.1:3000/"],
    ["a desktop-cli", "cuDesktopCli", "subject: widgetsmith-cli (desktop-cli)"],
  ])("names %s subject when the CLI refuses an option", async (_kind, base, line) => {
    const { cwd, id } = await fixtureStudy(base);
    const { stdout } = await runCli(["run", id, "--port", "99999", "--cwd", cwd]);
    expect(stdout.split("\n")[4]).toBe(line);
  });
});

describe("the analysis line of a run that was not created", () => {
  beforeEach(async () => {
    for (const name of ["OPENAI_API_KEY", "E2B_API_KEY", "CODEX_API_KEY"]) vi.stubEnv(name, "");
    // The missing-key message names local agents it finds signed in; find none.
    const empty = await mkdtemp(path.join(tmpdir(), "humanish-run-output-path-"));
    vi.stubEnv("PATH", empty);
    vi.stubEnv("HOME", empty);
    return async () => {
      vi.unstubAllEnvs();
      await rm(empty, { recursive: true, force: true });
    };
  });

  it.each<[string, BaseName, Patch, string]>([
    [
      "a live computer-use run without keys",
      "cuAppUrl",
      { mode: "live" },
      "humanish run adm-cuappurl: live run failed\nroute: computer-use\nrun: not-created\nactor: openai-computer-use\nsubject: http://127.0.0.1:3000/\n",
    ],
    [
      "a dry run with no executor",
      "cuLocalApp",
      {},
      "humanish run adm-culocalapp: dry run failed\nroute: computer-use\nrun: not-created\nactor: openai-computer-use\nsubject: http://127.0.0.1:3000/\n",
    ],
    [
      "a live scripted run without keys",
      "scriptedClone",
      { mode: "live" },
      "humanish run adm-scriptedclone: live run failed\nroute: scripted\nrun: not-created\nactor: scripted-browser\nsubject: [provisioned-subject]\n",
    ],
    [
      "a live terminal run without keys",
      "terminal",
      { mode: "live" },
      "humanish run adm-terminal: live run failed\nroute: terminal\nrun: not-created\nactor: codex-exec\nproduct: widgetsmith-cli\n",
    ],
  ])("is left out for %s", async (_kind, base, patch, expected) => {
    const { cwd, id } = await fixtureStudy(base, patch);
    const { exitCode, stdout } = await runCli(["run", id, "--cwd", cwd]);
    expect({ exitCode, stdout }).toEqual({ exitCode: 2, stdout: expected });
  });

  it("is still printed for a dry run that was created", async () => {
    const { cwd, id } = await fixtureStudy("cuAppUrl");
    const { stdout } = await runCli(["run", id, "--cwd", cwd]);
    expect(stdout.split("\n").at(-2)).toBe("analysis: skipped for dry runs");
  });
});
