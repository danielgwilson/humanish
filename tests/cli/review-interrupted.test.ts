// `humanish review` on a computer-use run a signal stopped after its desktop started. The run's
// last live flush wrote a review that describes the session as running, and the interrupt rewrote
// run.json with an interrupted outcome. Review must say the run was interrupted, as runDisplay does.
import { Command, CommanderError } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { activeRuns } from "../../src/run/active-runs.js";
import { buildRunSource, type RunBundle } from "../../src/run/bundle.js";
import { runScope } from "../../src/run/run.js";
import { buildSingleParticipantBundle } from "../../src/routes/computer-use/single-bundle.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const RUN = "interrupted-in-session";

async function runCli(args: string[]) {
  let exitCode = 0;
  const stdout: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: () => {},
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
  return { exitCode, output: stdout.join("") };
}

/** Start a live run, flush the route's in-progress bundle, then stop it as the CLI's SIGINT does. */
async function interruptedRun(cwd: string): Promise<RunBundle> {
  let live: RunBundle | undefined;
  await runScope(async (scope) => {
    const started = await scope.startRun({
      cwd,
      runId: RUN,
      mintRunId: () => RUN,
      mode: "live",
      renderReview: (bundle) => `# Review ${bundle.runId}\n`,
    });
    if (!started.ok) throw new Error(started.message);
    live = buildSingleParticipantBundle({
      verdict: "contract_proof_only",
      actorId: "openai-computer-use",
      appUrl: "http://127.0.0.1:3000/",
      run: started.run,
      dryRun: false,
      studyId: "interrupted-review",
      mission: "Explore the app and stop.",
      persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "digest" },
      resolution: [1440, 960],
      screenshots: [],
      inProgress: true,
      source: await buildRunSource({ cwd, humanishSource: "present", packageName: "humanish" }),
    });
    await started.run.writeSnapshot(live);
    const active = activeRuns().find((run) => run.runId === RUN);
    if (active === undefined) throw new Error(`run ${RUN} is not registered as active`);
    await active.status.interrupt("SIGINT");
  });
  if (live === undefined) throw new Error("the run wrote no live bundle");
  return live;
}

describe("humanish review on a run interrupted during its session", () => {
  it("says the run was interrupted in place of the live flush's running summary", async () => {
    const cwd = await makeTestTempDir("humanish-review-interrupted-");
    const live = await interruptedRun(cwd);

    const human = await runCli(["review", "--run", RUN, "--cwd", cwd]);
    expect(human.exitCode).toBe(0);
    const [headline, , summary] = human.output.split("\n");
    expect(headline).toBe(`humanish review ${RUN}: interrupted`);
    expect(summary).toMatch(/^Interrupted by SIGINT while 1 of 1 participant was still running\./);
    expect(human.output).not.toContain(live.review.summary);
    for (const gap of live.review.gaps) expect(human.output).not.toContain(gap);

    const json = await runCli(["review", "--run", RUN, "--cwd", cwd, "--json"]);
    const result = JSON.parse(json.output) as { summary: string; display?: { state: string } };
    expect(result.display?.state).toBe("interrupted");
    expect(result.summary).toBe(summary);
  });
});
