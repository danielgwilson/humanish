// A participant's trace the run writer wrote past RUN_ARTIFACT_MAX_BYTES, the most any reader reads
// of one file. The run still finishes, the sandbox id sweep records the trace it could not read,
// no file but the receipts names the sandbox, verify grades the run local_only with the trace named
// as unscanned, and the Observer shows the participant without its items.

import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { RunBundle, StoredRunBundle } from "../../src/run/bundle.js";
import { renderObserver } from "../../src/observer/render.js";
import { RUN_ARTIFACT_MAX_BYTES } from "../../src/run/contained-output.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { runScope } from "../../src/run/run.js";
import { appendSandboxReceipt, SANDBOX_RECEIPTS_ARTIFACT } from "../../src/run/sandbox-receipts.js";
import { loadStreamTraces } from "../../src/run/stream-trace.js";
import { missingLocalEvidenceArtifacts } from "../../src/verify/artifacts.js";
import { verifyRun } from "../../src/verify/verify.js";
import { PASSING_OUTCOME } from "../helpers/finished-run.js";
import { syntheticActor } from "../helpers/run-traces.js";

// Shaped like an E2B id and built at run time, so this file holds none at a sandbox-id key. A
// receipt makes Run.finish sweep the run's files for it.
const RAW = ["i", "q7m2x9k4w8", "n1p3v6z5a"].join("");
const RUN = "long-trace";
// The trace path the computer-use route registers for a run of one participant.
const TRACE = "actor.json";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-trace-past-limit-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** Every run file, by path relative to the run folder, that holds `text`. */
async function filesHolding(text: string): Promise<string[]> {
  const runRoot = path.join(cwd, ".humanish", "runs", RUN);
  const holding: string[] = [];
  for (const entry of await readdir(runRoot, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (entry.isFile() && (await readFile(file)).includes(text))
      holding.push(path.relative(runRoot, file));
  }
  return holding.sort();
}

/**
 * A live run of one participant whose one message is `text`, finished through the run scope. Like
 * a computer-use participant, the stream registers its trace as actor.json and a feedback
 * candidate cites that trace, so verify requires the file as evidence. An event, the review and a
 * route log quote the sandbox's raw id, as a startup error can.
 */
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
    events: [
      ...template.events,
      {
        id: "event-startup",
        at: template.createdAt,
        level: "error",
        type: "desktop.startup",
        message: `sandbox ${RAW} ended`,
      },
    ],
    streams: [
      {
        ...stream!,
        actor: syntheticActor(text),
        artifacts: [
          ...stream!.artifacts,
          { label: "actor trace", path: TRACE, kind: "trace" as const },
        ],
      },
    ],
    feedbackCandidates: [
      {
        schema: "humanish.feedback-candidate.v1",
        id: "participant-report",
        run_id: RUN,
        stream_id: stream!.id,
        adapter_id: "synthetic-app",
        scenario_id: template.scenario.id,
        persona_id: template.persona.id,
        actor: "computer-use",
        substrate: "e2b-desktop",
        failure_owner: "target-app",
        summary: "The participant reported friction.",
        expected: "Finish the task.",
        actual: "The participant stopped.",
        evidence: [{ path: TRACE, kind: "trace", note: "Full actor trace." }],
        redaction: { status: "passed", notes: "Synthetic text." },
        idempotency_key: "participant-report",
        proposed_next_state: "watch",
        acceptance_proof: ["Read the participant's trace."],
      },
    ],
  };
  return runScope(async (scope) => {
    const started = await scope.startRun({
      cwd,
      runId: RUN,
      mintRunId: () => RUN,
      mode: "live",
      renderReview: (published) =>
        `# Review ${published.runId}\n\n${published.events.map((event) => event.message).join("\n")}\n`,
    });
    if (!started.ok) throw new Error(started.message);
    started.run.participantStarted();
    await appendSandboxReceipt(started.run.paths, { at: "t", laneId: "lane-01", sandboxId: RAW });
    const logs = path.join(started.run.paths.absoluteRunRoot, "logs");
    await mkdir(logs, { recursive: true });
    await writeFile(path.join(logs, "route.log"), `connection to ${RAW} closed\n`);
    await started.run.finish(bundle, PASSING_OUTCOME);
  });
}

it("finishes a run whose trace passes the read limit, and verify grades it local_only naming the trace", async () => {
  const { finished } = await finishLiveRun(`${RAW} ${"x".repeat(RUN_ARTIFACT_MAX_BYTES)}`);
  expect(finished).toBeDefined();
  // The sweep could not read the trace, and run.json was written again after it: still only the
  // receipts name the sandbox.
  expect(await filesHolding(RAW)).toEqual([SANDBOX_RECEIPTS_ARTIFACT]);
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

it("fails verify for a trace past the read limit that the stream also names as its screenshot", async () => {
  await finishLiveRun(`${RAW} ${"x".repeat(RUN_ARTIFACT_MAX_BYTES)}`);
  const file = path.join(cwd, ".humanish", "runs", RUN, "run.json");
  const written = JSON.parse(await readFile(file, "utf8")) as StoredRunBundle;
  const stream = written.streams[0]!;
  stream.ui = { ...stream.ui, screenshotUrl: stream.trace!.path };
  await writeFile(file, JSON.stringify(written));

  const verified = await verifyRun(cwd, RUN);
  expect(verified.ok).toBe(false);
  expect(verified.shareSafety.status).toBe("blocked");
  expect(verified.checks).toContainEqual(
    expect.objectContaining({
      name: "local evidence artifacts exist",
      ok: false,
      message: expect.stringContaining(stream.trace!.path),
    }),
  );
}, 120_000);

it("counts a trace verify found past the read limit as missing once the file is emptied", async () => {
  await finishLiveRun("a short message");
  const runPaths = await resolveRunPath(cwd, RUN);
  const stored = JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", RUN, "run.json"), "utf8"),
  ) as StoredRunBundle;
  const { bundle } = await loadStreamTraces(runPaths!, stored);
  // Verify measured the trace past the limit, and the file was emptied before its evidence check.
  await truncate(path.join(cwd, ".humanish", "runs", RUN, TRACE), 0);

  expect(await missingLocalEvidenceArtifacts(runPaths!, bundle, new Set([TRACE]))).toContain(TRACE);
});
