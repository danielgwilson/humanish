// A participant's trace the run writer wrote past RUN_ARTIFACT_MAX_BYTES, the most any reader reads
// of one file. The run still finishes, the sandbox id sweep records the trace it could not read,
// verify grades the run local_only with the trace named as unscanned, and the Observer shows the
// participant without its items.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { RunBundle, StoredRunBundle } from "../../src/run/bundle.js";
import { renderObserver } from "../../src/observer/render.js";
import { RUN_ARTIFACT_MAX_BYTES } from "../../src/run/contained-output.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { runScope } from "../../src/run/run.js";
import { appendSandboxReceipt } from "../../src/run/sandbox-receipts.js";
import { verifyRun } from "../../src/verify/verify.js";
import { PASSING_OUTCOME } from "../helpers/finished-run.js";
import { syntheticActor } from "../helpers/run-traces.js";

// Shaped like an E2B id and built at run time, so this file holds none at a sandbox-id key. A
// receipt makes Run.finish sweep the run's files for it.
const RAW = ["i", "q7m2x9k4w8", "n1p3v6z5a"].join("");
const RUN = "long-trace";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-trace-past-limit-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** A live run of one participant whose one message is `text`, finished through the run scope. */
async function finishLiveRun(text: string) {
  await runDryRun({ cwd, dryRun: true, runId: "template" });
  const template = JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", "template", "run.json"), "utf8"),
  ) as RunBundle;
  const [stream] = template.streams;
  const bundle: RunBundle = {
    ...template,
    runId: RUN,
    mode: "live",
    artifactRoot: path.join(".humanish", "runs", RUN),
    streams: [{ ...stream!, actor: syntheticActor(text) }],
  };
  return runScope(async (scope) => {
    const started = await scope.startRun({
      cwd,
      runId: RUN,
      mintRunId: () => RUN,
      mode: "live",
      renderReview: (published) => `# Review ${published.runId}\n`,
    });
    if (!started.ok) throw new Error(started.message);
    started.run.participantStarted();
    await appendSandboxReceipt(started.run.paths, { at: "t", laneId: "lane-01", sandboxId: RAW });
    await started.run.finish(bundle, PASSING_OUTCOME);
  });
}

it("finishes a run whose trace passes the read limit, and verify grades it local_only naming the trace", async () => {
  const { finished } = await finishLiveRun("x".repeat(RUN_ARTIFACT_MAX_BYTES));
  expect(finished).toBeDefined();
  const written = JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", RUN, "run.json"), "utf8"),
  ) as StoredRunBundle;
  const trace = written.streams[0]!.trace!;
  expect(trace.bytes).toBeGreaterThan(RUN_ARTIFACT_MAX_BYTES);
  expect(written.events).toContainEqual(
    expect.objectContaining({
      level: "warn",
      type: "sandbox-ids.unresolved",
      message: expect.stringContaining(trace.path),
    }),
  );

  const verified = await verifyRun(cwd, RUN);
  expect(verified.ok, JSON.stringify(verified.checks.filter((check) => !check.ok))).toBe(true);
  expect(verified.shareSafety.status).toBe("local_only");
  expect(verified.shareSafety.reasons).toContainEqual({
    code: "UNSCANNED_ARTIFACT",
    message: expect.stringContaining(trace.path),
  });
  expect(verified.warnings).toContainEqual(expect.stringContaining(trace.path));

  // The Observer shows the participant without its items and says why.
  const observer = await renderObserver(cwd, RUN, { open: false });
  expect(observer.ok, observer.error?.message).toBe(true);
  const data = JSON.parse(
    await readFile(
      path.join(cwd, ".humanish", "runs", RUN, "observer", "observer-data.json"),
      "utf8",
    ),
  ) as { events: { type: string; message: string }[] };
  expect(data.events).toContainEqual(
    expect.objectContaining({
      type: "trace.unavailable",
      message: expect.stringContaining(trace.path),
    }),
  );
}, 120_000);

it("fails verify for a trace whose index records more bytes than the limit and its file holds", async () => {
  await finishLiveRun("a short message");
  const file = path.join(cwd, ".humanish", "runs", RUN, "run.json");
  const written = JSON.parse(await readFile(file, "utf8")) as StoredRunBundle;
  written.streams[0]!.trace!.bytes = RUN_ARTIFACT_MAX_BYTES + 1;
  await writeFile(file, JSON.stringify(written));

  const verified = await verifyRun(cwd, RUN);
  expect(verified.ok).toBe(false);
  expect(verified.checks).toContainEqual(
    expect.objectContaining({
      name: "local evidence artifacts exist",
      ok: false,
      message: expect.stringContaining(`${RUN_ARTIFACT_MAX_BYTES + 1} bytes`),
    }),
  );
});
