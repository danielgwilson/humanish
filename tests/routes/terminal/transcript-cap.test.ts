// A terminal session that prints more than the transcript cap keeps its verdict, its last agent
// messages and its token usage, and its transcript says how much output was not stored.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActorTrace } from "../../../src/actors/contract.js";
import { createLocalActorVerdictScanner } from "../../../src/run/terminal-contract.js";
import { createTerminalRecorder } from "../../../src/routes/terminal/recorder.js";
import { MAX_TRANSCRIPT_BYTES } from "../../../src/routes/terminal/types.js";
import { verifyRun } from "../../../src/verify/verify.js";
import { streamingRun, terminalConfig } from "../../helpers/terminal-live-fake.js";
import { runTerminal } from "../../helpers/route-run.js";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-tp-transcript-cap-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const said = (id: string, text: string): string =>
  `${JSON.stringify({ type: "item.completed", item: { id, type: "agent_message", text } })}\n`;
const ran = (id: string, output: string): string =>
  `${JSON.stringify({
    type: "item.completed",
    item: { id, type: "command_execution", command: "cat big.log", aggregated_output: output },
  })}\n`;
const usage = `${JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 80 },
})}\n`;

/** One message, then command output well past the cap, then the closing message and usage. */
function longSession(nonce: string, verdictAt: "end" | "middle"): string[] {
  const marker = `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonce}`;
  const output = Array.from({ length: 12 }, (_, index) =>
    ran(`cmd-${index}`, "x".repeat(64 * 1024)),
  );
  if (verdictAt === "middle") output.splice(10, 0, said("mid", `Done early.\n${marker}`));
  return [
    said("first", "I will read the log."),
    ...output,
    said("last", verdictAt === "end" ? `The widget works.\n${marker}` : "The widget works."),
    usage,
  ];
}

async function runLong(verdictAt: "end" | "middle") {
  let chunks: string[] = [];
  const result = await runTerminal({
    cwd,
    config: terminalConfig({ review: { analysis: false } }),
    dryRun: false,
    open: false,
    ...streamingRun((nonce) => {
      chunks = longSession(nonce, verdictAt);
      return chunks;
    }),
  });
  const runDir = path.join(cwd, ".humanish", "runs", result.runId);
  const trace = JSON.parse(await readFile(path.join(runDir, "actor.json"), "utf8")) as ActorTrace;
  const transcript = await readFile(path.join(runDir, "terminal-transcript.txt"), "utf8");
  const stored = (await readFile(path.join(runDir, "terminal-events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { chunk: string }).chunk);
  const total = chunks.reduce((bytes, chunk) => bytes + Buffer.byteLength(chunk), 0);
  const kept = stored.reduce((bytes, chunk) => bytes + Buffer.byteLength(chunk), 0);
  return { result, trace, transcript, total, kept };
}

describe("terminal output past the transcript cap", () => {
  it("keeps the verdict, the last messages and the token usage, and records the cut", async () => {
    const { result, trace, transcript, total, kept } = await runLong("end");
    expect(total).toBeGreaterThan(MAX_TRANSCRIPT_BYTES + 128 * 1024);
    expect(kept).toBeLessThan(MAX_TRANSCRIPT_BYTES + 128 * 1024);

    expect(result.session?.status).toBe("passed");
    expect(result.ok).toBe(true);
    const messages = trace.items.filter((item) => item.kind === "message");
    expect(messages.map((item) => item.text)).toEqual([
      "I will read the log.",
      "The widget works.",
    ]);
    expect(trace.tokenUsage).toMatchObject({ input: 1200, cachedInput: 300, output: 80 });

    // The transcript, the trace and the run events each say how many bytes were not stored.
    const cut = String(total - kept);
    expect(transcript.trimEnd().split("\n").at(-1)).toContain(cut);
    const notice = trace.items.find((item) => item.title === "terminal output truncated");
    expect(notice).toMatchObject({ kind: "notice", status: "truncated" });
    expect(notice?.text).toContain(cut);
    const run = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as { events: Array<{ type: string; level: string; message: string }> };
    const event = run.events.find((entry) => entry.type === "terminal-lab.transcript.exceeded");
    expect(event).toMatchObject({ level: "warn" });
    expect(event?.message).toContain(cut);
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
  });

  it("reads a verdict marker printed in the output that was not stored", async () => {
    const { result, transcript } = await runLong("middle");
    expect(transcript).not.toContain("HUMANISH_ACTOR_NONCE=");
    expect(result.session?.status).toBe("passed");
  });

  it("stores a session under the cap whole, with no notice", async () => {
    const result = await runTerminal({
      cwd,
      config: terminalConfig({ review: { analysis: false } }),
      dryRun: false,
      open: false,
      ...streamingRun((nonce) => [
        said("only", `Short.\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonce}`),
        usage,
      ]),
    });
    const trace = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "actor.json"), "utf8"),
    ) as ActorTrace;
    expect(result.session?.status).toBe("passed");
    expect(trace.items.some((item) => item.title === "terminal output truncated")).toBe(false);
  });
});

describe("the verdict scan over output that is not stored", () => {
  const nonce = "synthetic-nonce";
  const scan = (pieces: string[]) => {
    const scanner = createLocalActorVerdictScanner(nonce);
    for (const piece of pieces) scanner.push(piece);
    return scanner.verdict();
  };

  it("finds a marker split across pieces and whitespace, and keeps the first one", () => {
    expect(scan(["HUMANISH_ACTOR_VER", "DICT=passed \n HUMANISH_ACTOR", `_NONCE=${nonce}`])).toBe(
      "passed",
    );
    expect(
      scan([
        `HUMANISH_ACTOR_VERDICT=blocked HUMANISH_ACTOR_NONCE=${nonce}`,
        `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonce}`,
      ]),
    ).toBe("blocked");
  });

  it("ignores a marker with no nonce or another nonce", () => {
    expect(scan(["HUMANISH_ACTOR_VERDICT=passed", "HUMANISH_ACTOR_NONCE=other-nonce"])).toBeNull();
  });

  it("finds a marker the cap splits between the stored and the unstored output", () => {
    const recorder = createTerminalRecorder({
      nowIso: () => "2026-10-05T00:00:00.000Z",
      sanitize: (text) => text,
      knownSecretValues: [],
      verdictNonce: nonce,
    });
    recorder.recordStreamedTerminalChunk(
      "stdout",
      `${"x".repeat(MAX_TRANSCRIPT_BYTES)}\nHUMANISH_ACTOR_VERDICT=pas`,
    );
    recorder.recordStreamedTerminalChunk("stdout", `sed HUMANISH_ACTOR_NONCE=${nonce}\n`);
    expect(recorder.transcriptCut()?.verdict).toBe("passed");
  });

  it("does not count a usage record the cap cut through", () => {
    const recorder = createTerminalRecorder({
      nowIso: () => "2026-10-05T00:00:00.000Z",
      sanitize: (text) => text,
      knownSecretValues: [],
      verdictNonce: nonce,
    });
    const [head, rest] = [usage.slice(0, 20), usage.slice(20)];
    recorder.recordStreamedTerminalChunk("stdout", `${"x".repeat(MAX_TRANSCRIPT_BYTES)}\n${head}`);
    recorder.recordStreamedTerminalChunk("stdout", rest);
    recorder.recordStreamedTerminalChunk("stdout", usage);
    expect(recorder.transcriptCut()?.usage).toHaveLength(1);
  });
});
