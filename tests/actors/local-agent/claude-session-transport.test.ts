import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { CuaTurnRequest } from "../../../src/actors/computer-use/loop.js";
import { startClaudeSession } from "../../../src/actors/local-agent/claude-session.js";

// The stdio transport of the persistent Claude Code session, driven through a fake `claude -p`
// child. Its wire shapes follow tests/fixtures/claude-code-stream-json/interrupted-turn.ndjson,
// captured from Claude Code 2.1.285.

type Json = Record<string, unknown>;

const request = (): CuaTurnRequest => ({
  instructions: "Finish the synthetic task.",
  observation: { screenshot: Buffer.from("89504e470d0a1a0a", "hex"), stateSignature: "s" },
});

/** A fake `claude -p --input-format stream-json` child: it records stdin and the test writes stdout. */
function fakeClaudeChild() {
  const received: Json[] = [];
  const messages = new EventEmitter();
  const stdout = new PassThrough();
  let pendingText = "";
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      pendingText += chunk.toString("utf8");
      for (let end = pendingText.indexOf("\n"); end >= 0; end = pendingText.indexOf("\n")) {
        const message = JSON.parse(pendingText.slice(0, end)) as Json;
        pendingText = pendingText.slice(end + 1);
        received.push(message);
        messages.emit("message", message);
      }
      callback();
    },
  });
  let kills = 0;
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: () => {
      kills += 1;
      child.emit("close", null, "SIGTERM");
      return true;
    },
  });
  return {
    received,
    messages,
    kills: () => kills,
    users: () => received.filter((message) => message.type === "user"),
    write: (message: Json) => stdout.write(`${JSON.stringify(message)}\n`),
    spawnFn: (() => child) as unknown as typeof spawn,
  };
}

/** A `result` answering one user message, as Claude Code 2.1.285 writes it. */
function resultFor(uuid: unknown, reply: Json, usage = { input_tokens: 10, output_tokens: 5 }) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    ...(typeof uuid === "string" ? { user_message_uuid: uuid, user_message_uuids: [uuid] } : {}),
    result: JSON.stringify(reply),
    usage,
  };
}

describe("the persistent Claude Code session transport", () => {
  it.fails("delivers a result only to the request that produced it", async () => {
    const fake = fakeClaudeChild();
    fake.messages.on("message", (message: Json) => {
      if (message.type !== "control_request") return;
      fake.write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: { still_queued: [], cancelled: [] },
        },
      });
    });
    const session = await startClaudeSession({ spawnFn: fake.spawnFn });
    const first = new AbortController();
    const stalled = session.provider.nextTurn(request(), first.signal);
    await vi.waitFor(() => expect(fake.users()).toHaveLength(1));
    first.abort();
    await expect(stalled).rejects.toThrow("run stopped");

    const retry = session.provider.nextTurn(request(), new AbortController().signal);
    await vi.waitFor(() => expect(fake.users()).toHaveLength(2));
    const [stale, current] = fake.users();
    // The stalled turn finishes late, after its retry was sent.
    fake.write(resultFor(stale?.uuid, { message: "stale answer", done: true, actions: [] }));
    fake.write(resultFor(current?.uuid, { message: "current answer", done: true, actions: [] }));

    await expect(retry).resolves.toMatchObject({ message: "current answer" });
    await session.close();
  });
});
