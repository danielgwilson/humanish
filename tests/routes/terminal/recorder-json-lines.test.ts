// The recorder stores each complete line of the agent's `codex exec --json` stdout with its JSON
// strings redacted as decoded text, so a line break after a path stays in the transcript. Stderr,
// lines that are not JSON and an unfinished line get the redaction they had before.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REDACTION_MARKERS, redactText } from "../../../src/evidence/redaction.js";
import { createTerminalRecorder } from "../../../src/routes/terminal/recorder.js";
import { MAX_TRANSCRIPT_BYTES, PENDING_LINE_CHARS } from "../../../src/routes/terminal/types.js";
import { propertyParameters } from "../../helpers/scrub-arbitraries.js";
import { streamingRun, terminalConfig } from "../../helpers/terminal-live-fake.js";
import { runTerminal } from "../../helpers/route-run.js";

const LOCAL = REDACTION_MARKERS.localPath;
const RUNTIME = REDACTION_MARKERS.runtimePath;

/** A Codex `item.completed` line for a command whose output is `output`. */
const ran = (id: string, command: string, output: string): string =>
  JSON.stringify({
    type: "item.completed",
    item: { id, type: "command_execution", command, aggregated_output: output, exit_code: 0 },
  });
const said = (id: string, text: string): string =>
  JSON.stringify({ type: "item.completed", item: { id, type: "agent_message", text } });

function recorderOf(): ReturnType<typeof createTerminalRecorder> {
  return createTerminalRecorder({
    nowIso: () => "2026-10-08T00:00:00.000Z",
    scrub: (text) => text,
    knownSecretValues: [],
    verdictNonce: "synthetic-nonce",
  });
}

/** What the recorder stores for one stream, given the chunks as the callbacks deliver them. */
function stored(
  chunks: ReadonlyArray<readonly ["stdout" | "stderr", string]>,
  stream: "stdout" | "stderr" = "stdout",
): string {
  const recorder = recorderOf();
  for (const [from, chunk] of chunks) recorder.recordStreamedTerminalChunk(from, chunk);
  recorder.endStdout();
  return recorder.terminalEvents
    .filter((event) => event.stream === stream)
    .map((event) => event.chunk)
    .join("");
}

/** `text` in chunks of `size` characters. */
const inChunks = (text: string, size: number): Array<["stdout", string]> =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, at) => [
    "stdout",
    text.slice(at * size, (at + 1) * size),
  ]);

// Shapes from terminal-2026-10-08T19-37-41-516Z-d85572b8 item_1 and item_8,
// terminal-2026-10-08T19-50-16-019Z-c04b55bf item_7 and terminal-2026-10-08T19-38-20-124Z-b33029a8
// item_5, with the paths before redaction written back in.
const TRANSCRIPTS: Array<[string, string, string, string]> = [
  [
    "mktemp",
    "/bin/bash -lc 'mktemp -d -p /home/user humanish-eval.XXXXXX'",
    "/home/user/humanish-eval.k3f9qz\n",
    `${RUNTIME}\n`,
  ],
  [
    "init",
    "/bin/bash -lc 'npx humanish init --yes'",
    "humanish init applied\ncwd: /home/user/humanish-eval.k3f9qz\n\ncreated:\n  AGENTS.md\n",
    `humanish init applied\ncwd: ${RUNTIME}\n\ncreated:\n  AGENTS.md\n`,
  ],
  [
    "doctor",
    "/bin/bash -lc 'npx humanish doctor'",
    "- ok claude participant transcripts: no transcript from an earlier Claude Code participant under /home/user/.claude/projects\n- ok key OPENAI_API_KEY: not required for the selected participant route\n",
    `- ok claude participant transcripts: no transcript from an earlier Claude Code participant under ${RUNTIME}\n- ok key OPENAI_API_KEY: not required for the selected participant route\n`,
  ],
  [
    "npm init",
    "/bin/bash -lc 'npm init -y'",
    'Wrote to /tmp/humanish-eval.5nt7xb/package.json:\n\n{\n  "name": "humanish-eval.5nt7xb"\n}\n',
    `Wrote to ${LOCAL}\n\n{\n  "name": "humanish-eval.5nt7xb"\n}\n`,
  ],
];

describe("the recorder on Codex JSON stdout", () => {
  it.each(TRANSCRIPTS)(
    "keeps the text after a path in %s's output however the line arrives",
    (_name, command, output, redactedOutput) => {
      const line = `${ran("item_1", command, output)}\n`;
      const expected = `${ran("item_1", redactText(command), redactedOutput)}\n`;
      for (const size of [1, 7, 64, line.length])
        expect(stored(inChunks(line, size))).toBe(expected);
    },
  );

  it("redacts a path that holds a backslash and an n whole, as main does", () => {
    const literal = "/tmp/a\\ncustomer.csv";
    const recorder = recorderOf();
    recorder.recordStreamedTerminalChunk(
      "stdout",
      `${ran("item_1", "ls", literal)}\n${said("item_2", `I saved ${literal}`)}\n`,
    );
    recorder.endStdout();
    const lines = recorder.terminalEvents.map((event) => event.chunk).join("");
    expect(lines).toBe(`${ran("item_1", "ls", LOCAL)}\n${said("item_2", `I saved ${LOCAL}`)}\n`);
    expect(recorder.participantText.finish().items.map((item) => item.text)).toEqual([
      `I saved ${LOCAL}`,
    ]);
  });

  it("gives stderr, a line that is not JSON and an unfinished line the redaction they had", () => {
    // Main's reading of raw text: the path runs on through `\n` to the space.
    const rawText = "cwd: /tmp/x\\ncreated: here";
    expect(stored([["stderr", rawText]], "stderr")).toBe(`cwd: ${LOCAL} here`);
    expect(stored([["stdout", `${rawText}\n`]])).toBe(`cwd: ${LOCAL} here\n`);
    expect(stored([["stdout", `{"o":"${rawText}`]])).toBe(`{"o":"cwd: ${LOCAL} here`);
  });

  it("keeps arrival order, chunk by chunk, for a stdout line that stderr arrives inside", () => {
    // The known-value scrub across streams reads the events in arrival order.
    const recorder = recorderOf();
    recorder.recordStreamedTerminalChunk("stdout", '{"o":"/tmp/a');
    recorder.recordStreamedTerminalChunk("stderr", "warning: slow network");
    recorder.recordStreamedTerminalChunk("stdout", 'b c"}');
    recorder.recordStreamedTerminalChunk("stdout", `\n${said("item_2", "/tmp/x\ndone")}\n`);
    recorder.endStdout();
    expect(recorder.terminalEvents.map(({ stream, chunk }) => [stream, chunk])).toEqual([
      ["stdout", `{"o":"${LOCAL}`],
      ["stderr", "warning: slow network"],
      ["stdout", 'b c"}'],
      ["stdout", `\n${said("item_2", `${LOCAL}\ndone`)}\n`],
    ]);
  });

  // Such a line reaches the recorder only inside one chunk: the transcript cap stops storing
  // stdout before a line received in pieces grows that long.
  it("gives a line longer than PENDING_LINE_CHARS the redaction it had", () => {
    const long = "x".repeat(PENDING_LINE_CHARS);
    const line = `${JSON.stringify({ o: `/tmp/a\nb ${long}` })}\n`;
    expect(stored([["stdout", line]])).toBe(`{"o":"${LOCAL} ${long}"}\n`);
  });

  it("stores the line in progress before the output past the cap", () => {
    const recorder = recorderOf();
    recorder.recordStreamedTerminalChunk(
      "stdout",
      `${"x".repeat(MAX_TRANSCRIPT_BYTES)}\n{"o":"/tmp/a`,
    );
    recorder.recordStreamedTerminalChunk("stdout", '\\nb"}\n');
    expect(recorder.terminalEvents.map((event) => event.chunk).join("")).toBe(
      `${"x".repeat(MAX_TRANSCRIPT_BYTES)}\n{"o":"${LOCAL}`,
    );
  });

  it("stores the same lines wherever the callbacks split the stream", () => {
    const stream = [
      ...TRANSCRIPTS.map(([, command, output]) => `${ran("item_1", command, output)}\n`),
      "Reading additional input from stdin... /tmp/x\\nnext\n",
      `${said("item_2", "Done in /home/user/project\nNext: /tmp/a\\nb")}\n`,
    ].join("");
    const whole = stored([["stdout", stream]]);
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: stream.length - 1 }), { maxLength: 12 }),
        (cuts) => {
          const points = [0, ...cuts.sort((a, b) => a - b), stream.length];
          const chunks = points
            .slice(1)
            .map((end, at): ["stdout", string] => ["stdout", stream.slice(points[at], end)]);
          expect(stored(chunks)).toBe(whole);
        },
      ),
      propertyParameters(),
    );
  });
});

describe("a live terminal run's transcript", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-tp-json-lines-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("keeps the line break and the header after `humanish init`'s cwd", async () => {
    const [, command, output, redactedOutput] = TRANSCRIPTS[1]!;
    const line = `${ran("item_8", command, output)}\n`;
    const result = await runTerminal({
      cwd,
      config: terminalConfig({ review: { analysis: false } }),
      dryRun: false,
      open: false,
      ...streamingRun((nonce) => [
        ...inChunks(line, 9).map(([, chunk]) => chunk),
        `done\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonce}\n`,
      ]),
    });
    expect(result.ok).toBe(true);
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const expected = ran("item_8", redactText(command), redactedOutput);
    const transcript = await readFile(path.join(runDir, "terminal-transcript.txt"), "utf8");
    expect(transcript.split("\n")).toContain(expected);
    const events = (await readFile(path.join(runDir, "terminal-events.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((event) => JSON.parse(event) as { stream: string; chunk: string });
    expect(
      events
        .filter((event) => event.stream === "stdout")
        .map((event) => event.chunk)
        .join("")
        .split("\n"),
    ).toContain(expected);
  });
});
