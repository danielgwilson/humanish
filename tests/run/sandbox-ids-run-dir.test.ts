import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { sandboxIdDigest } from "../../src/evidence/redaction.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { runScope, type RunScope } from "../../src/run/run.js";
import type { PreparedOutputRoot } from "../../src/run/contained-output.js";
import { holdsKeyedSandboxId } from "../../src/run/sandbox-ids.js";
import { appendedSandboxIds, appendSandboxReceipt } from "../../src/run/sandbox-receipts.js";

// A finished run names its sandboxes by digest in every file but sandbox-receipts.ndjson, including
// files a route wrote itself, such as a participant's actor.json quoting an SDK error.

// Shaped like E2B ids and built at run time, so this file holds none at a sandbox-id key.
const RAW = ["i", "q7m2x9k4w8", "n1p3v6z5a"].join("");
const UNJOURNALED = ["i", "z5a8c3e1g7", "k2m4o6q9b"].join("");
type Run = Extract<Awaited<ReturnType<RunScope["startRun"]>>, { ok: true }>["run"];
const label = (id: string): string => `[redacted-sandbox-id ${sandboxIdDigest(id)}]`;

let template: RunBundle;
let templateRoot: string;
let cwd: string;

beforeAll(async () => {
  templateRoot = await mkdtemp(path.join(tmpdir(), "humanish-sandbox-dir-template-"));
  await runDryRun({ cwd: templateRoot, dryRun: true, runId: "template" });
  template = JSON.parse(
    await readFile(path.join(templateRoot, ".humanish", "runs", "template", "run.json"), "utf8"),
  ) as RunBundle;
});
afterAll(async () => {
  await rm(templateRoot, { recursive: true, force: true });
});
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-sandbox-dir-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function finishRun(runId: string, during: (run: Run) => Promise<void>) {
  const { finished } = await runScope(async (scope) => {
    const started = await scope.startRun({
      cwd,
      runId,
      mintRunId: () => "minted",
      mode: "dry-run",
      renderReview: (bundle) => `# Review ${bundle.runId}\n`,
      observer: { open: false },
    });
    if (!started.ok) throw new Error(started.message);
    await during(started.run);
    await started.run.finish({
      ...template,
      runId,
      artifactRoot: path.join(".humanish", "runs", runId),
    });
  });
  return { finished, dir: path.join(cwd, ".humanish", "runs", runId) };
}

const receipt = (sandboxId: string) => ({ at: "t", laneId: "lane-01", sandboxId });

describe("a finished run's directory", () => {
  it("names each sandbox by digest in the text files the route wrote, and leaves other files", async () => {
    const { dir } = await finishRun("route-files", async (run) => {
      await appendSandboxReceipt(run.paths, receipt(RAW));
      const actorDir = path.join(run.paths.physicalRunRoot, "participants", "lane-01");
      await mkdir(actorDir, { recursive: true });
      await writeFile(
        path.join(actorDir, "actor.json"),
        JSON.stringify({ reason: `screenshot failed: sandbox ${RAW} is not running` }),
      );
      await writeFile(
        path.join(run.paths.physicalRunRoot, "comms.yaml"),
        `# lease for ${RAW}\nsandboxId: ${RAW}\nnote: kill(${RAW}) returned true\n---\nid: 9007199254740993\n`,
      );
      // Not text verify or export reads as such: a NUL byte, and an extension the sweep skips.
      await writeFile(path.join(run.paths.physicalRunRoot, "notes.log"), `\0${RAW}\n`);
      await writeFile(path.join(run.paths.physicalRunRoot, "state.tar"), `${RAW}\n`);
    });
    const actor = JSON.parse(
      await readFile(path.join(dir, "participants", "lane-01", "actor.json"), "utf8"),
    );
    expect(actor.reason).toBe(`screenshot failed: sandbox ${label(RAW)} is not running`);
    // Plain replacement: the second document and the large integer stay as written.
    const yamlLabel = `redacted-sandbox-id-${sandboxIdDigest(RAW)}`;
    expect(await readFile(path.join(dir, "comms.yaml"), "utf8")).toBe(
      `# lease for ${yamlLabel}\nsandboxId: ${yamlLabel}\nnote: kill(${yamlLabel}) returned true\n---\nid: 9007199254740993\n`,
    );
    expect(await readFile(path.join(dir, "notes.log"), "utf8")).toBe(`\0${RAW}\n`);
    expect(await readFile(path.join(dir, "state.tar"), "utf8")).toBe(`${RAW}\n`);
    expect(await readFile(path.join(dir, "sandbox-receipts.ndjson"), "utf8")).toContain(RAW);
  });

  it("replaces an id whose receipt write failed, and one in status.json's settled outcome", async () => {
    const { finished, dir } = await finishRun("unjournaled", async (run) => {
      // A directory where the journal goes makes the append fail; the run goes on.
      await mkdir(path.join(run.paths.physicalRunRoot, "sandbox-receipts.ndjson"));
      await appendSandboxReceipt(run.paths, receipt(UNJOURNALED));
      await writeFile(
        path.join(run.paths.physicalRunRoot, "teardown.log"),
        `kill(${UNJOURNALED}) returned true\n`,
      );
    });
    expect(await readFile(path.join(dir, "teardown.log"), "utf8")).toBe(
      `kill(${label(UNJOURNALED)}) returned true\n`,
    );
    await finished!.recordOutcome({
      ok: false,
      execution: {
        succeeded: false,
        failures: [{ kind: "sandbox-cleanup", message: `kill(${UNJOURNALED}) timed out` }],
      },
    });
    const status = await readFile(path.join(dir, "status.json"), "utf8");
    expect(status).not.toContain(UNJOURNALED);
    expect(JSON.parse(status).outcome.execution.failures[0].message).toBe(
      `kill(${label(UNJOURNALED)}) timed out`,
    );
  });

  it("gives a run created later at a deleted run's path none of its ids", async () => {
    const first = await finishRun("reused", async (run) => {
      await mkdir(path.join(run.paths.physicalRunRoot, "sandbox-receipts.ndjson"));
      await appendSandboxReceipt(run.paths, receipt(UNJOURNALED));
    });
    await rm(first.dir, { recursive: true });
    const { dir } = await finishRun("reused", async (run) => {
      await writeFile(path.join(run.paths.physicalRunRoot, "notes.txt"), `${UNJOURNALED}\n`);
    });
    expect(await readFile(path.join(dir, "notes.txt"), "utf8")).toBe(`${UNJOURNALED}\n`);
  });
});

describe("the ids a run's records hold", () => {
  it("reads a sandbox-id key spelled with an escape", () => {
    const text = `{"sandbox\\u0049d": "${RAW}"}`;
    expect(JSON.parse(text)).toEqual({ ["sandbox" + "Id"]: RAW });
    expect(holdsKeyedSandboxId("lease.json", text)).toBe(true);
    expect(holdsKeyedSandboxId("lease.json", `{"note": "${RAW}"}`)).toBe(false);
  });

  it("keeps unjournaled ids for the latest 64 run directories only", async () => {
    // Roots that cannot be written, so every append fails and only the memory holds the id.
    const root = (index: number) =>
      ({
        physicalPath: path.join(cwd, "missing", String(index)),
        requestedPath: path.join(cwd, "missing", String(index)),
        identity: { dev: 1n, ino: BigInt(index), birthtimeNs: 1n },
      }) as PreparedOutputRoot;
    for (let index = 0; index <= 64; index += 1)
      await appendSandboxReceipt(root(index), receipt(`${UNJOURNALED}-${index}`));
    expect(appendedSandboxIds(root(0))).toEqual([]);
    expect(appendedSandboxIds(root(64))).toEqual([`${UNJOURNALED}-64`]);
  });
});
