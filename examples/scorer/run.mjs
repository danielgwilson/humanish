// @ts-check
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LAB_CONFIG_SCHEMA, parseLabConfig, runLab, verifyRun } from "humanish";
import { score } from "./scorer.mjs";

// One scorer module, attached two ways to a dry run of a computer-use lab: as library hooks and
// through the CLI's --scorer flag. A dry run needs no keys, desktop or running app.
const lab = {
  schema: LAB_CONFIG_SCHEMA,
  id: "scorer-example",
  title: "Score a dry run",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  actors: [
    { type: "openai-computer-use", persona: "pixel-pat", mission: "Find the pricing page." },
  ],
  execution: { target: "e2b-desktop" },
  review: { analysis: false },
};

// A throwaway project directory; both runs write their bundles under its .humanish/runs/.
const project = await mkdtemp(join(tmpdir(), "humanish-scorer-example-"));
// JSON is valid YAML, so the CLI reads the same manifest the library call uses.
await writeFile(join(project, "lab.yaml"), `${JSON.stringify(lab, null, 2)}\n`);
await copyFile(new URL("./scorer.mjs", import.meta.url), join(project, "scorer.mjs"));

/** @param {string} runId */
async function scored(runId) {
  const runJson = join(project, ".humanish", "runs", runId, "run.json");
  /** @type {import("humanish").RunBundle} */
  const bundle = JSON.parse(await readFile(runJson, "utf8"));
  const verification = await verifyRun(project, runId);
  return { runId, adapterScore: bundle.adapterScore, verified: verification.ok };
}

const parsed = parseLabConfig(lab);
if (!parsed.ok) throw new Error(parsed.error.message);
const outcome = await runLab(parsed.config, { cwd: project, dryRun: true, cuaHooks: { score } });
if (outcome.backend !== "cua" || !outcome.result.ok) {
  throw new Error(`Library dry run failed: ${JSON.stringify(outcome.result)}`);
}
const library = await scored(outcome.result.runId);

// The package exports only its library entry; the CLI bin is the sibling cli.js.
const bin = fileURLToPath(new URL("./cli.js", import.meta.resolve("humanish")));
const { stdout } = await promisify(execFile)(
  process.execPath,
  [bin, "lab", "run", "lab.yaml", "--dry-run", "--no-open", "--scorer", "scorer.mjs", "--json"],
  { cwd: project },
);
const cli = await scored(JSON.parse(stdout).runId);

const report = { project, library, cli };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
for (const run of [library, cli]) {
  if (run.adapterScore?.namespace !== "example-scorer" || !run.verified) {
    throw new Error(`Run ${run.runId} has no verified example score`);
  }
}
