import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createProgram } from "../../src/cli/program.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";

// `humanish analyze --dry-run` admits or refuses without a provider request, so these runs send
// nothing and read no key.
const RUN_ID = "analyze-cost";
let project: string;

beforeAll(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "humanish-analyze-cost-"));
  // A completed live run to analyze: a preview bundle marked live, as the analysis tests do.
  await cp(path.resolve("fixtures/minimal-app"), project, { recursive: true });
  await runDryRun({ cwd: project, dryRun: true, runId: RUN_ID });
  const root = path.join(project, ".humanish", "runs", RUN_ID);
  const bundle = JSON.parse(await readFile(path.join(root, "run.json"), "utf8")) as RunBundle;
  bundle.mode = "live";
  bundle.streams[0]!.status = "complete";
  await writeFile(path.join(root, "run.json"), JSON.stringify(bundle) + "\n");
  await rm(path.join(root, "status.json"));
});

// The same preview run with 17 participants, analysed in two cohorts and a merge request. Its
// Codex preview participants lose their app-server records, which a live run would have to carry.
const COHORT_RUN_ID = "analyze-cost-cohorts";
beforeAll(async () => {
  await runDryRun({ cwd: project, dryRun: true, runId: COHORT_RUN_ID, participantCount: 17 });
  const root = path.join(project, ".humanish", "runs", COHORT_RUN_ID);
  const bundle = JSON.parse(await readFile(path.join(root, "run.json"), "utf8")) as RunBundle;
  bundle.mode = "live";
  for (const stream of bundle.streams) {
    stream.status = "complete";
    delete stream.codex;
    stream.artifacts = stream.artifacts.filter(
      (artifact) => !artifact.path.includes("codex-app-server"),
    );
  }
  await writeFile(path.join(root, "run.json"), JSON.stringify(bundle) + "\n");
  await rm(path.join(root, "status.json"));
});

afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

async function analyze(args: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode = 0;
  const program = createProgram({
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  program.exitOverride();
  await program.parseAsync(["node", "humanish", "analyze", "--cwd", project, ...args], {
    from: "node",
  });
  return { stdout: out.join(""), stderr: err.join(""), exitCode };
}

async function admission(maxCost: string) {
  const { stdout } = await analyze(["--run", RUN_ID, "--max-cost", maxCost, "--dry-run", "--json"]);
  return (JSON.parse(stdout) as { admission: Record<string, number> }).admission;
}

it("reports the expected cost, the worst case and the cap of an admitted dry run", async () => {
  const { estimatedCostUsd, worstCaseCostUsd } = await admission("5");
  const { stdout, exitCode } = await analyze(["--run", RUN_ID, "--max-cost", "5", "--dry-run"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain(`$${estimatedCostUsd!.toFixed(2)}`);
  expect(stdout).toContain(`$${worstCaseCostUsd!.toFixed(2)}`);
  expect(stdout).toContain("$5 cap");
});

it("names the command that runs an analysis its cap refused", async () => {
  const { estimatedCostUsd, worstCaseCostUsd } = await admission("0.01");
  // A refused dry run reports the refusal a live request would get.
  const { stderr, exitCode } = await analyze(["--run", RUN_ID, "--max-cost", "0.01", "--dry-run"]);
  expect(exitCode).toBe(2);
  expect(stderr).toContain(`$${estimatedCostUsd!.toFixed(2)}`);
  expect(stderr).toContain(`$${worstCaseCostUsd!.toFixed(2)}`);
  expect(stderr).toContain("$0.01 cap");
  expect(stderr).toContain(`analyze --run ${RUN_ID} --max-cost ${Math.ceil(worstCaseCostUsd!)}`);
});

it("puts every request of an analysis in cohorts in a dry run's worst case", async () => {
  const one = await analyze(["--run", RUN_ID, "--max-cost", "50", "--dry-run"]);
  expect(one.stdout).toContain("if the analyst writes its whole");
  const { stdout, exitCode } = await analyze([
    "--run",
    COHORT_RUN_ID,
    "--max-cost",
    "50",
    "--dry-run",
  ]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain(
    "if every request (2 cohort requests of at most 16 participants and one merge request) writes its whole",
  );
});

it("states in --max-cost's help the rule admission applies", () => {
  const analyze = createProgram().commands.find((command) => command.name() === "analyze")!;
  expect(analyze.helpInformation().replace(/\s+/g, " ")).toContain(
    "refused before it sends anything if both its worst case and its expected cost plus a 10% margin are over this.",
  );
});
