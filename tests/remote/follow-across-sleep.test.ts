// The machine that follows a remote run sleeps or is stopped while the run goes on in its runner.
// Moving the fake wall clock without firing a timer is what a stopped process sees when it resumes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  followRemoteRun,
  watchSignals,
  type RemoteOutcome,
  type Signals,
} from "../../src/remote/launch.js";
import type { Runner } from "../../src/remote/runner.js";
import { createRunArtifactPaths, type PreparedRunArtifactPaths } from "../../src/run/paths.js";

vi.mock("../../src/run/reclaim.js", () => ({
  reclaimRunSandboxes: async () => ({ ok: true }),
}));

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const SECTION = "--- humanish ";
/** About how long one read waits in the runner before it answers or fails. */
const READ_MS = 5 * SECOND;
const FINISHED = { exitCode: 0, result: { ok: true } };

const realImmediate = setImmediate;

/** What the runner's next read does: answers with this run, or does not answer. */
type Reply = "unanswered" | { state?: string; result?: typeof FINISHED };

function readAnswer(reply: Exclude<Reply, "unanswered">) {
  const stdout = [
    `${SECTION}alive 1`,
    `${SECTION}status`,
    ...(reply.state === undefined ? [] : [JSON.stringify({ state: reply.state })]),
    `${SECTION}result`,
    ...(reply.result === undefined ? [] : [JSON.stringify(reply.result)]),
    `${SECTION}err`,
  ].join("\n");
  return { exitCode: 0, stdout, stderr: "" };
}

let cwd: string;
let paths: PreparedRunArtifactPaths;
let signals: Signals;
let reply: Reply;
/** A read the runner has not answered yet, for the test to settle or leave stalled. */
interface HeldRead {
  fail(): void;
  answer(reply: Exclude<Reply, "unanswered">): void;
}
let heldRead: HeldRead | undefined;
let holdReads: boolean;
/** What the runner lists as settled evidence, and how long it takes to send each such file. */
let settledListing: string;
let sendFileMs: number;
let filesSent: number;
let reads: number;
let outcome: RemoteOutcome | undefined;

const runner = {
  sandbox: {
    files: {
      read: async function* () {
        await new Promise((resolve) => setTimeout(resolve, sendFileMs));
        filesSent += 1;
        yield new Uint8Array([1]);
      },
    },
  },
  shell: {
    run: (command: string) => {
      // Every other command, such as the copy back's listing, finds nothing to copy.
      if (!command.includes("alive()"))
        return reply === "unanswered"
          ? Promise.reject(new Error("no route to the runner"))
          : Promise.resolve({
              exitCode: 0,
              stdout: command.includes("-newermt") ? settledListing : "",
              stderr: "",
            });
      reads += 1;
      return new Promise((resolve, reject) => {
        if (holdReads) {
          heldRead = {
            fail: () => reject(new Error("the connection was lost")),
            answer: (answer) => resolve(readAnswer(answer)),
          };
          return;
        }
        setTimeout(() => {
          if (reply === "unanswered") reject(new Error("no route to the runner"));
          else resolve(readAnswer(reply));
        }, READ_MS);
      });
    },
  },
} as unknown as Runner;

/** Let promises and real file reads finish, without any fake time passing. */
const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((resolve) => realImmediate(resolve));
  }
};
const pass = async (ms: number) => {
  for (let passed = 0; passed < ms && outcome === undefined; passed += SECOND) {
    await vi.advanceTimersByTimeAsync(SECOND);
    await new Promise((resolve) => realImmediate(resolve));
  }
  await settle();
};
/** The read in flight when this machine stopped settles as it resumes, before any timer runs. */
const sleepThroughRead = async (
  ms: number,
  settleRead: (read: HeldRead) => void = (read) => read.fail(),
) => {
  holdReads = true;
  heldRead = undefined;
  while (heldRead === undefined && outcome === undefined) await pass(SECOND);
  holdReads = false;
  vi.setSystemTime(Date.now() + ms);
  if (heldRead !== undefined) settleRead(heldRead);
  await settle();
};
const follow = () => {
  void followRemoteRun({
    launch: { cwd, env: {}, say: () => undefined },
    runner,
    paths,
    runId: "cua-remote",
    signals,
    proxyUrl: undefined,
  }).then((ended) => {
    outcome = ended;
  });
};
/** The run ends in the runner; its copy back reads real files, so this waits for those too. */
const finish = async () => {
  reply = { state: "finished", result: FINISHED };
  await pass(3 * READ_MS);
  await vi.waitFor(() => expect(outcome).toBeDefined());
};
const gaveUp = async () => {
  await vi.waitFor(() => expect(outcome).toBeDefined());
  expect(outcome?.exitCode).toBe(2);
};

describe("following a remote run while this machine sleeps", () => {
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-follow-sleep-"));
    const created = await createRunArtifactPaths(cwd, "cua-remote");
    if (!created.ok) throw new Error("run directory not created");
    paths = created.paths;
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    signals = watchSignals();
    reply = { state: "running" };
    heldRead = undefined;
    holdReads = false;
    settledListing = "";
    sendFileMs = 0;
    filesSent = 0;
    reads = 0;
    outcome = undefined;
  });

  afterEach(async () => {
    signals.dispose();
    vi.useRealTimers();
    await rm(cwd, { recursive: true, force: true });
  });

  it("reads again after a stop longer than the limit, and follows the run to its result", async () => {
    follow();
    await pass(30 * SECOND);
    await sleepThroughRead(3 * MINUTE);
    expect(outcome).toBeUndefined();
    const readsBefore = reads;
    await pass(READ_MS * 2);
    expect(reads).toBeGreaterThan(readsBefore);

    await finish();
    expect(outcome?.result).toEqual(FINISHED.result);
    expect(outcome?.exitCode).toBe(FINISHED.exitCode);
    expect(outcome?.error ?? "").not.toMatch(/stopped answering/);
  });

  it("keeps reading while the network stays down for a while after the wake", async () => {
    follow();
    await pass(30 * SECOND);
    reply = "unanswered";
    await sleepThroughRead(30 * MINUTE);
    await pass(90 * SECOND);
    expect(outcome).toBeUndefined();

    await finish();
    expect(outcome?.result).toEqual(FINISHED.result);
  });

  it("gives the runner up after 120 s awake without an answer", async () => {
    follow();
    await pass(30 * SECOND);
    reply = "unanswered";
    await pass(110 * SECOND);
    expect(outcome).toBeUndefined();

    await pass(20 * SECOND);
    await gaveUp();
    expect(outcome?.error).toMatch(/stopped answering for 120 s/);
  });

  it("gives the runner up 120 s awake after a wake, not counting the sleep", async () => {
    follow();
    await pass(30 * SECOND);
    reply = "unanswered";
    await pass(60 * SECOND);
    await sleepThroughRead(30 * MINUTE);
    await pass(110 * SECOND);
    expect(outcome).toBeUndefined();

    await pass(20 * SECOND);
    await gaveUp();
    expect(outcome?.error).toMatch(/stopped answering for 120 s/);
  });

  it("does not take a sleep before the run's first status for a run that did not start", async () => {
    reply = {};
    follow();
    await pass(30 * SECOND);
    reply = "unanswered";
    await sleepThroughRead(30 * MINUTE);
    expect(outcome).toBeUndefined();

    reply = { state: "running" };
    await pass(READ_MS * 2);
    expect(outcome).toBeUndefined();
    await finish();
    expect(outcome?.result).toEqual(FINISHED.result);
  });

  it("does not take an answer that sat out a sleep for a run that did not start", async () => {
    reply = {};
    follow();
    await pass(30 * SECOND);
    await sleepThroughRead(30 * MINUTE, (read) => read.answer({}));
    expect(outcome).toBeUndefined();

    reply = { state: "running" };
    await pass(READ_MS * 2);
    await finish();
    expect(outcome?.result).toEqual(FINISHED.result);
  });

  it("still ends a run the runner answers for but that never started", async () => {
    reply = {};
    follow();
    await pass(3 * MINUTE + 10 * SECOND);
    await gaveUp();
    expect(outcome?.error).toMatch(/did not start in the runner/);
  });

  it("does not take a sleep during a stop for a stop that ran out of time", async () => {
    follow();
    await pass(30 * SECOND);
    process.emit("SIGINT");
    await pass(READ_MS);
    reply = "unanswered";
    await sleepThroughRead(30 * MINUTE);
    expect(outcome).toBeUndefined();

    await finish();
    expect(outcome?.result).toEqual(FINISHED.result);
    expect(outcome?.exitCode).toBe(130);
  });

  it("counts each file of a long catch-up as an answer, so one failed read after it is retried", async () => {
    settledListing = "screenshots/a.png\t1\nscreenshots/b.png\t1\nscreenshots/c.png\t1\n";
    sendFileMs = 50 * SECOND;
    follow();
    await pass(35 * SECOND);
    reply = "unanswered";
    while (filesSent < 3 && outcome === undefined) await pass(SECOND);
    const readsBefore = reads;
    while (reads < readsBefore + 2 && outcome === undefined) await pass(SECOND);
    expect(outcome).toBeUndefined();

    await finish();
    expect(outcome?.result).toEqual(FINISHED.result);
  });

  it("gives up a runner whose reads never settle", async () => {
    follow();
    await pass(30 * SECOND);
    reply = "unanswered";
    holdReads = true;
    await pass(110 * SECOND);
    expect(outcome).toBeUndefined();

    await pass(60 * SECOND);
    await gaveUp();
    expect(outcome?.error).toMatch(/stopped answering for 120 s/);
  });
});
