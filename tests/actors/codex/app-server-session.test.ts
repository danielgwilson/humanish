import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCodexAppServerSession } from "../../../src/actors/codex/app-server.js";

// Captured before a test fakes timers, so waiting on the fake server keeps real time.
const realSetTimeout = globalThis.setTimeout;
const HANG_GUARD_MS = 60_000;

// A fake app-server: it answers the handshake, starts one thread and one turn, streams one agent
// message, and then either completes the turn and exits ("complete") or waits for a signal
// ("hang"). It writes `marker` once turn/start arrives.
const FAKE_SERVER = [
  "import fs from 'node:fs';",
  "import readline from 'node:readline';",
  "const [scenario, marker] = process.argv.slice(2);",
  "const rl = readline.createInterface({ input: process.stdin });",
  "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
  "const thread = { id: 'thread-1', sessionId: 'session-1', model: 'model-1', cliVersion: '9.9.9' };",
  "const turn = { id: 'turn-1', status: 'inProgress' };",
  "const item = { id: 'msg-1', type: 'agentMessage', text: 'Finished the synthetic task.' };",
  "rl.on('line', (line) => {",
  "  const msg = JSON.parse(line);",
  "  if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'fake/9.9.9 (test)' } });",
  "  if (msg.method === 'thread/start') { send({ id: msg.id, result: { thread } }); send({ method: 'thread/started', params: { thread } }); }",
  "  if (msg.method === 'turn/start') {",
  "    send({ id: msg.id, result: { turn } });",
  "    send({ method: 'turn/started', params: { threadId: thread.id, turn } });",
  "    send({ method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item: { ...item, text: '' } } });",
  "    send({ method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: item.text } });",
  "    send({ method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item } });",
  "    fs.writeFileSync(marker, 'turn\\n');",
  "    if (scenario === 'complete') {",
  "      send({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, status: 'completed' } } });",
  "    }",
  "  }",
  "});",
].join("\n");

// The parts of a trace that do not depend on the clock.
function stable(trace: Record<string, unknown>): Record<string, unknown> {
  const { startedAt: _started, completedAt: _completed, durationMs: _duration, ...rest } = trace;
  return rest;
}
// main's trace for these runs, clock fields removed; the refactor must keep it exactly.
const COUNTS = {
  approvals: 0,
  commandOutputs: 0,
  envelopes: 13,
  errors: 0,
  fileChanges: 0,
  itemCompletions: 1,
  itemStarts: 1,
  messages: 1,
  reasoning: 0,
  requests: 3,
  responses: 3,
  tools: 0,
  warnings: 0,
};
const METHODS: Record<string, number> = {
  initialize: 1,
  initialized: 1,
  response: 3,
  "thread/start": 1,
  "turn/start": 1,
  "thread/started": 1,
  "turn/started": 1,
  "item/started": 1,
  "item/agentMessage/delta": 1,
  "item/completed": 1,
  "turn/completed": 1,
};
const expectedTrace = (status: string, reason: string, completed: boolean) => {
  const { "turn/completed": _completed, ...withoutCompletion } = METHODS;
  return {
    schema: "humanish.codex-app-server-trace.v1",
    provider: "codex-app-server",
    protocolVersion: "v2",
    redaction: {
      status: "passed",
      notes:
        "Trace envelopes and text were redacted before persistence. App-server schemas are version-specific and are not embedded in this run artifact.",
    },
    client: { name: "humanish_cli", title: "Humanish CLI", experimentalApi: false },
    server: { commandName: "node", transport: "stdio", codexCliVersion: "9.9.9" },
    cwd: "[target-cwd]",
    promptDigest: "6b4f1c2cff9d",
    counts: completed ? COUNTS : { ...COUNTS, envelopes: 12 },
    methods: completed ? METHODS : withoutCompletion,
    items: [
      { id: "msg-1", type: "agentMessage", lifecycle: "started", title: "" },
      {
        id: "msg-1",
        type: "agentMessage",
        lifecycle: "completed",
        title: "Finished the synthetic task.",
      },
    ],
    messages: [{ itemId: "msg-1", text: "Finished the synthetic task." }],
    reasoning: [],
    plans: [],
    commands: [],
    fileChanges: [],
    tools: [],
    approvals: [],
    warnings: [],
    errors: [],
    threadId: "thread-1",
    turnId: "turn-1",
    sessionId: "session-1",
    model: "model-1",
    status,
    reason,
  };
};

describe("Codex app-server session lifecycle", () => {
  let root: string;
  let fakeServer: string;
  let marker: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "humanish-codex-session-"));
    fakeServer = path.join(root, "fake-app-server.mjs");
    marker = path.join(root, "turn-started");
    await mkdir(path.join(root, "project"));
    await writeFile(fakeServer, FAKE_SERVER, "utf8");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { force: true, recursive: true });
  });

  const run = (scenario: "complete" | "hang", timeoutMs: number) =>
    runCodexAppServerSession({
      actorCommand: [process.execPath, fakeServer, scenario, marker],
      cwd: path.join(root, "project"),
      prompt: "Do the synthetic task.",
      runRoot: path.join(root, "run"),
      timeoutMs,
    });
  const written = async (relative: string) => readFile(path.join(root, "run", relative), "utf8");

  it("finishes a completed turn with the full trace written to disk", async () => {
    const result = await run("complete", HANG_GUARD_MS);
    expect(result.status).toBe("passed");
    expect(result.reason).toBe("turn completed with status completed");
    // The runner signals the child on turn/completed and waits for it to close before finishing.
    expect(result.signal).toBe("SIGTERM");
    expect(stable(result.trace as unknown as Record<string, unknown>)).toEqual(
      expectedTrace("passed", "turn completed with status completed", true),
    );
    expect(JSON.parse(await written(result.tracePath))).toEqual(result.trace);
    expect((await written(result.eventsPath)).trim().split("\n")).toHaveLength(13);
    expect(await written(result.transcriptPath)).toBe(
      "## Agent messages\n\nFinished the synthetic task.",
    );
  });

  it("finishes a timed-out turn with the same trace, on a clock the test controls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = run("hang", 5_000);
    for (;;) {
      try {
        await access(marker);
        break;
      } catch {
        await new Promise((resolve) => realSetTimeout(resolve, 5));
      }
    }
    // The fake server exits on SIGTERM, so the run ends without the 2 s SIGKILL fallback.
    vi.advanceTimersByTime(5_000);
    const result = await pending;
    expect(result.status).toBe("timed_out");
    expect(result.reason).toBe("Codex app-server turn exceeded 5000ms timeout.");
    expect(result.signal).toBe("SIGTERM");
    expect(stable(result.trace as unknown as Record<string, unknown>)).toEqual(
      expectedTrace("timed_out", "Codex app-server turn exceeded 5000ms timeout.", false),
    );
    expect(JSON.parse(await written(result.tracePath))).toEqual(result.trace);
    expect(await written(result.transcriptPath)).toBe(
      "## Agent messages\n\nFinished the synthetic task.",
    );
  });
});
