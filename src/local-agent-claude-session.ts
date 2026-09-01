// ONE Claude Code process as the computer-use brain, instead of a fresh `claude -p` per turn.
//
// WHY (#520): `actors[].localAgent: codex` already runs through a persistent app-server thread,
// so the participant remembers what it tried. `claude` spawned `claude -p` per turn, so EVERY
// turn started cold. Measured on the same lab with the same credentials (n=1 each): one-shot,
// 188 actions over 90 turns and never finished; a thread that remembers, 21 actions over 8 turns
// and goal_satisfied in 103 s. A participant that cannot remember trying the menu tries the menu
// again. Until this existed, comparing the two agents measured the transport, not the model.
//
// THE MECHANISM, checked on this machine before it was written: `claude -p --input-format
// stream-json --output-format stream-json --verbose` is a bidirectional session over stdio. One
// NDJSON `user` message in, a stream of `system` / `assistant` / `result` messages out, then it
// waits for the next `user` message with the conversation intact. Two messages, one session id,
// and a codeword given in the first turn was recalled in the second. `--allowedTools Read` keeps
// the bound the one-shot version had: it looks at a picture, and that is all it can do.
//
// What this is NOT: a change to the loop, the executor, the trace, or the Observer. Only where
// the next action comes from.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

import type { ActorCapabilities } from "./actor-contract.js";
import type { CuaProvider, CuaTurn, CuaTurnRequest } from "./computer-use.js";
import { declaredOutcomeOf, parseAgentJson, promptFor, toCuaActions, LOCAL_AGENT_CAPABILITIES } from "./local-agent-cli.js";
import type { ReasoningEffort } from "./reasoning-effort.js";

type JsonObject = Record<string, unknown>;

/** The transport, injected so tests drive a fake session with no CLI and no spend. */
export interface ClaudeStreamTransport {
  /** Write one NDJSON message to the session. */
  send(message: JsonObject): void;
  /** Resolves with the next `result` message; rejects if the session ends first or the clock runs out. */
  awaitResult(timeoutMs: number, signal?: AbortSignal): Promise<JsonObject>;
  close(): void;
}

/** NDJSON over the child's stdio. Everything that is not a `result` is a progress line and is ignored. */
export function stdioClaudeTransport(child: ChildProcessWithoutNullStreams): ClaudeStreamTransport {
  const rl = readline.createInterface({ input: child.stdout });
  let waiter: { resolve: (value: JsonObject) => void; reject: (error: Error) => void } | undefined;
  let stderrTail = "";
  let exited: string | undefined;

  const fail = (error: Error): void => {
    const pending = waiter;
    waiter = undefined;
    pending?.reject(error);
  };
  rl.on("line", (line: string) => {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return; // never a reason to end a run
    }
    if (message.type !== "result") return;
    const pending = waiter;
    waiter = undefined;
    pending?.resolve(message);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-400);
  });
  child.on("close", (code, signal) => {
    exited = `Claude Code exited ${code ?? `on ${signal ?? "a signal"}`}${stderrTail.trim() ? `: ${stderrTail.trim()}` : ""}`;
    // Fail loud with the CLI's own words: a rate-limited plan says so here, which is a sentence
    // the operator can act on, unlike "turn failed".
    fail(new Error(exited));
  });

  return {
    send(message) {
      if (exited !== undefined) throw new Error(exited);
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    awaitResult(timeoutMs, signal) {
      if (exited !== undefined) return Promise.reject(new Error(exited));
      return new Promise<JsonObject>((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error(`Claude Code produced no result within ${timeoutMs}ms`)), timeoutMs);
        const onAbort = (): void => fail(new Error("run stopped"));
        signal?.addEventListener("abort", onAbort, { once: true });
        waiter = {
          resolve: (value) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(value); },
          reject: (error) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(error); }
        };
      });
    },
    close() {
      rl.close();
      child.stdin.end();
      child.kill();
    }
  };
}

export interface ClaudeSessionOptions {
  /** Absent = spawn `claude`. Injected in tests. */
  transport?: ClaudeStreamTransport;
  model?: string;
  /** Recorded on the trace; Claude Code's `-p` mode takes no effort flag, so this is what was asked for, not applied. */
  reasoningEffort?: ReasoningEffort;
  /** Per-turn wall clock. */
  timeoutMs?: number;
  /** Scratch root for the session's working directory (the screenshots it is allowed to Read). */
  workRoot?: string;
  /** Extra arguments, e.g. a model override. Tests never pass any. */
  spawnFn?: typeof spawn;
}

export const CLAUDE_SESSION_CAPABILITIES: ActorCapabilities = LOCAL_AGENT_CAPABILITIES;

export interface ClaudeSession {
  provider: CuaProvider;
  /** Ends the process and removes its scratch directory. The run owns the lifetime, not the provider. */
  close(): Promise<void>;
}

/** The message shape Claude Code reads on stdin in stream-json mode. */
export function userMessage(text: string): JsonObject {
  return { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
}

/**
 * Start one Claude Code session and return a provider that spends it, one user message per
 * computer-use turn. Started EAGERLY (before the first screenshot) so the CLI's own boot is paid
 * while the sandbox is still settling rather than inside turn one.
 */
export async function startClaudeSession(options: ClaudeSessionOptions = {}): Promise<ClaudeSession> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const effort = options.reasoningEffort ?? "low";
  const work = await mkdtemp(path.join(options.workRoot ?? tmpdir(), "humanish-claude-session-"));

  let child: ChildProcessWithoutNullStreams | undefined;
  let transport = options.transport;
  if (transport === undefined) {
    const spawnFn = options.spawnFn ?? spawn;
    child = spawnFn("claude", [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      // Required for stream-json output in -p mode; it is what makes the per-turn `result` visible.
      "--verbose",
      // Read is the only tool it needs — the screenshot — and the only one it gets.
      "--allowedTools", "Read",
      ...(options.model === undefined ? [] : ["--model", options.model])
    ], { cwd: work, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    transport = stdioClaudeTransport(child);
  }

  let turnIndex = 0;
  let previousShot: string | undefined;
  const provider: CuaProvider = {
    id: "local-agent-claude-session",
    version: options.model ?? "claude (local, operator-authenticated, one session per run)",
    modelSettings: { reasoningEffort: effort },
    capabilities: CLAUDE_SESSION_CAPABILITIES,
    requiresFrame: true,
    async nextTurn(request: CuaTurnRequest, signal?: AbortSignal): Promise<CuaTurn> {
      const frame = request.observation.screenshot;
      if (frame === undefined) {
        throw new Error("the Claude session provider needs a screenshot and this observation has none");
      }
      turnIndex += 1;
      const shot = path.join(work, `screen-${String(turnIndex).padStart(3, "0")}.png`);
      await writeFile(shot, frame);
      const hint = request.contextHint === undefined ? "" : `\n\nNote from the harness: ${request.contextHint}`;
      // The persona and the reply shape are in the conversation after turn one; re-sending them
      // every turn is what the one-shot version had to do, and it is most of what it cost.
      const text = turnIndex === 1
        ? promptFor(request, shot, "claude")
        : `Read the image file ${shot}. That is the CURRENT SCREEN, after your last actions took effect. `
          + "Same participant, same task: decide what to do next. "
          + "Reply with ONLY a JSON object of the same shape as before."
          + hint;
      transport!.send(userMessage(text));
      const result = await transport!.awaitResult(timeoutMs, signal);
      // The frame it already looked at is not needed on disk; the conversation remembers it.
      if (previousShot !== undefined) await unlink(previousShot).catch(() => undefined);
      previousShot = shot;
      return turnFromResult(result);
    }
  };

  return {
    provider,
    close: async () => {
      transport?.close();
      child?.kill();
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

/** Read a stream-json `result` message into a CuaTurn. Exported for tests. */
export function turnFromResult(result: JsonObject): CuaTurn {
  if (result.is_error === true || (typeof result.subtype === "string" && result.subtype !== "success")) {
    // A turn that errored is a BROKEN turn, never an empty one: an empty turn reads to the loop
    // as "the participant chose to do nothing".
    throw new Error(`Claude Code turn ended ${String(result.subtype ?? "in error")}: ${String(result.result ?? "").slice(0, 160)}`);
  }
  const text = typeof result.result === "string" ? result.result : "";
  let parsed: JsonObject;
  try {
    parsed = parseAgentJson(text);
  } catch {
    throw new Error(`Claude Code returned no structured turn output (${text.slice(0, 160)})`);
  }
  const actions = toCuaActions(Array.isArray(parsed.actions) ? (parsed.actions as never[]) : []);
  const done = parsed.done === true || (actions.length === 0 && typeof parsed.message === "string");
  const outcome = declaredOutcomeOf(parsed.outcome);
  const usage = result.usage as JsonObject | undefined;
  const count = (key: string): number | undefined => (typeof usage?.[key] === "number" ? (usage[key] as number) : undefined);
  const input = count("input_tokens");
  const output = count("output_tokens");
  const cachedInput = count("cache_read_input_tokens");
  const cacheWriteInput = count("cache_creation_input_tokens");
  return {
    actions,
    pendingSafetyChecks: [],
    done,
    ...(outcome === undefined ? {} : { outcome }),
    ...(typeof parsed.reasoning === "string" && parsed.reasoning.length > 0 ? { reasoning: parsed.reasoning } : {}),
    ...(typeof parsed.message === "string" && parsed.message.length > 0 ? { message: parsed.message } : {}),
    // Claude Code reports its token counts per turn (#531). They are recorded as counts; the
    // run's cost line stays "not priced", because a subscription is not a rate card.
    ...(input === undefined && output === undefined
      ? {}
      : {
          usage: {
            ...(input === undefined ? {} : { input }),
            ...(output === undefined ? {} : { output }),
            ...(cachedInput === undefined ? {} : { cachedInput }),
            ...(cacheWriteInput === undefined ? {} : { cacheWriteInput })
          }
        })
  };
}
