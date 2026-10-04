// One Claude Code process as the computer-use brain, instead of a fresh `claude -p` per turn.
//
// Why: `actors[].localAgent: codex` already runs through a persistent app-server thread,
// so the participant remembers what it tried. `claude` spawned `claude -p` per turn, so every
// turn started cold. Measured on the same study with the same credentials (n=1 each): one-shot,
// 188 actions over 90 turns and never finished; a thread that remembers, 21 actions over 8 turns
// and goal_satisfied in 103 s. A participant that cannot remember trying the menu tries the menu
// again. Until this existed, comparing the two agents measured the transport, not the model.
//
// The mechanism, checked on this machine before it was written: `claude -p --input-format
// stream-json --output-format stream-json --verbose` is a bidirectional session over stdio. One
// NDJSON `user` message in, a stream of `system` / `assistant` / `result` messages out, then it
// waits for the next `user` message with the conversation intact. Two messages, one session id,
// and a codeword given in the first turn was recalled in the second. The process runs with the
// flags and environment in claude-participant.ts, and every message it writes passes the stream
// guard there: a tool call other than Read inside the session folder stops it.
//
// What this is not: a change to the loop, the executor, the trace, or the Observer. Only where
// the next action comes from.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

import type { ActorCapabilities } from "../contract.js";
import type { CuaProvider, CuaTurn, CuaTurnRequest } from "../computer-use/loop.js";
import { ComputerUseProviderError } from "../computer-use/provider-error.js";
import {
  declaredOutcomeOf,
  parseAgentJson,
  promptFor,
  toCuaActions,
  LOCAL_AGENT_CAPABILITIES,
} from "./cli.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import {
  ClaudeParticipantError,
  ClaudeStreamGuard,
  claudeParticipantEnv,
  claudeParticipantFlags,
  type ClaudeParticipantErrorCode,
} from "./claude-participant.js";

type JsonObject = Record<string, unknown>;

/** The transport, injected so tests drive a fake session with no CLI and no spend. */
export interface ClaudeStreamTransport {
  /**
   * Send one user turn and resolve with the `result` that answers it. Rejects when the session
   * ends, `timeoutMs` passes or `signal` aborts. A turn given up that way is interrupted, and its
   * late result reaches no later turn.
   */
  turn(message: JsonObject, timeoutMs: number, signal?: AbortSignal): Promise<JsonObject>;
  close(): void;
  /** The first refusal the stream guard raised, if any. */
  refusal?(): ClaudeParticipantError | undefined;
}

/** How long Claude Code may take to acknowledge an interrupt before the session is ended. */
const INTERRUPT_RECEIPT_TIMEOUT_MS = 5_000;

/** Results can no longer be paired with the turns that asked for them. */
class ClaudeSessionDesyncError extends Error {}

/** The user messages a `result` answers. Claude Code 2.1.285 names them; older versions may not. */
function answeredMessageIds(result: JsonObject): string[] {
  const many = result.user_message_uuids;
  if (Array.isArray(many)) return many.filter((id): id is string => typeof id === "string");
  return typeof result.user_message_uuid === "string" ? [result.user_message_uuid] : [];
}

interface WaitingTurn {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
}

/**
 * Register turn `id` in `waiting` and settle when its result arrives. On timeout or abort the
 * turn leaves `waiting` and `onGiveUp` runs before the rejection.
 */
function waitForTurn(
  waiting: Map<string, WaitingTurn>,
  id: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onGiveUp: () => void,
): Promise<JsonObject> {
  return new Promise<JsonObject>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const giveUp = (error: Error): void => {
      if (!waiting.delete(id)) return;
      finish();
      onGiveUp();
      reject(error);
    };
    const timer = setTimeout(
      () => giveUp(new Error(`Claude Code produced no result within ${timeoutMs}ms`)),
      timeoutMs,
    );
    const onAbort = (): void => giveUp(new Error("run stopped"));
    signal?.addEventListener("abort", onAbort, { once: true });
    waiting.set(id, {
      resolve: (value) => {
        finish();
        resolve(value);
      },
      reject: (error) => {
        finish();
        reject(error);
      },
    });
  });
}

/**
 * NDJSON over the child's stdio. Each user message carries a fresh `uuid`, and a `result` goes
 * only to the turn whose uuid it names. A turn given up on is interrupted with a control request,
 * and the next user message waits for the interrupt's receipt, so its `cancel_queued` cancels an
 * abandoned message still in the queue but never the message sent after it. Every message passes
 * `guard` first; one it refuses ends the session and kills the process.
 */
function stdioClaudeTransport(
  child: ChildProcessWithoutNullStreams,
  guard: ClaudeStreamGuard,
): ClaudeStreamTransport {
  const rl = readline.createInterface({ input: child.stdout });
  const waiting = new Map<string, WaitingTurn>();
  // Given-up turns whose result may still arrive; it must reach nobody.
  const abandoned = new Set<string>();
  const receipts = new Map<string, () => void>();
  let acknowledged: Promise<void> = Promise.resolve();
  let interrupts = 0;
  let stderrTail = "";
  let ended: Error | undefined;
  // The first refusal outranks every other ending: a forbidden line in the same stdout chunk as a
  // result, or as a line that desynchronized the session, is read before the waiting turn resumes.
  let refused: ClaudeParticipantError | undefined;

  const write = (message: JsonObject): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const end = (error: Error): void => {
    if (ended !== undefined) return;
    ended = error;
    for (const turn of waiting.values()) turn.reject(error);
    waiting.clear();
    for (const settle of receipts.values()) settle();
    receipts.clear();
  };
  const stop = (): void => {
    rl.close();
    child.stdin.end();
    child.kill();
  };
  const desynchronize = (reason: string): void => {
    end(new ClaudeSessionDesyncError(reason));
    stop();
  };

  const abandon = (id: string): void => {
    abandoned.add(id);
    if (ended !== undefined) return;
    interrupts += 1;
    const requestId = `humanish-interrupt-${interrupts}`;
    const receipt = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        receipts.delete(requestId);
        desynchronize(
          `Claude Code did not acknowledge an interrupt within ${INTERRUPT_RECEIPT_TIMEOUT_MS}ms`,
        );
        resolve();
      }, INTERRUPT_RECEIPT_TIMEOUT_MS);
      receipts.set(requestId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    acknowledged = acknowledged.then(() => receipt);
    write({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "interrupt", cancel_queued: true },
    });
  };

  const deliver = (result: JsonObject): void => {
    const ids = answeredMessageIds(result);
    if (ids.length === 0) {
      // Without a named message, pairing is certain only while one turn waits and none was given up.
      const [only, ...others] = waiting.keys();
      if (only !== undefined && others.length === 0 && abandoned.size === 0) {
        const turn = waiting.get(only);
        waiting.delete(only);
        turn?.resolve(result);
      } else {
        desynchronize("a result named no user message while another turn could still answer");
      }
      return;
    }
    let known = false;
    for (const id of ids) {
      if (abandoned.delete(id)) {
        known = true;
        continue;
      }
      const turn = waiting.get(id);
      if (turn === undefined) continue;
      waiting.delete(id);
      turn.resolve(result);
      known = true;
    }
    if (!known) desynchronize("a result answered a user message this session did not send");
  };

  rl.on("line", (line: string) => {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return; // never a reason to end a run
    }
    const refusal = guard.inspect(message);
    if (refusal !== undefined) {
      // The refusal is recorded before the kill, so the exit it causes cannot replace it. SIGKILL:
      // a tool the flags somehow allowed may already be running.
      refused ??= refusal;
      end(refusal);
      child.kill("SIGKILL");
      stop();
      return;
    }
    if (message.type === "result") {
      deliver(message);
    } else if (message.type === "control_response") {
      const response = message.response as JsonObject | undefined;
      const requestId = response?.request_id;
      const settle = typeof requestId === "string" ? receipts.get(requestId) : undefined;
      if (typeof requestId !== "string" || settle === undefined) return;
      receipts.delete(requestId);
      settle();
      if (response?.subtype !== "success") desynchronize("Claude Code refused an interrupt");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-400);
  });
  child.on("close", (code, signal) => {
    // Fail loud with the CLI's own words: a rate-limited plan says so here, which is a sentence
    // the operator can act on, unlike "turn failed".
    end(
      new Error(
        `Claude Code exited ${code ?? `on ${signal ?? "a signal"}`}${stderrTail.trim() ? `: ${stderrTail.trim()}` : ""}`,
      ),
    );
  });

  return {
    async turn(message, timeoutMs, signal) {
      if (ended !== undefined) throw refused ?? ended;
      await acknowledged;
      if (ended !== undefined) throw refused ?? ended;
      if (signal?.aborted) throw new Error("run stopped");
      const id = randomUUID();
      const result = waitForTurn(waiting, id, timeoutMs, signal, () => abandon(id));
      write({ ...message, uuid: id });
      let answer: JsonObject;
      try {
        answer = await result;
      } catch (error) {
        throw refused ?? error;
      }
      if (refused !== undefined) throw refused;
      return answer;
    },
    close() {
      end(new Error("Claude Code session closed"));
      stop();
    },
    refusal: () => refused,
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
  /** Injected in tests to see the argv and environment the child gets. */
  spawnFn?: typeof spawn;
  /** Where the participant's few environment names come from. Absent = process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

const CLAUDE_SESSION_CAPABILITIES: ActorCapabilities = LOCAL_AGENT_CAPABILITIES;

export interface ClaudeSession {
  provider: CuaProvider;
  /**
   * Ends the process and removes its scratch directory. The run owns the lifetime, not the
   * provider. `refusal` is a stream refusal no turn reported, such as a forbidden call after the
   * last turn ended or was given up; it fails the run.
   */
  close(): Promise<{ refusal?: ClaudeParticipantErrorCode }>;
}

/** The argv of the session process: stream-json both ways, then the restricting flags. */
export function claudeSessionArgs(model?: string): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    // Required for stream-json output in -p mode; it is what makes each message visible.
    "--verbose",
    ...claudeParticipantFlags(model),
  ];
}

/** The message shape Claude Code reads on stdin in stream-json mode. */
export function userMessage(text: string): JsonObject {
  return { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
}

/**
 * Start one Claude Code session and return a provider that spends it, one user message per
 * computer-use turn. Started eagerly (before the first screenshot) so the CLI's own boot is paid
 * while the sandbox is still settling rather than inside turn one.
 */
export async function startClaudeSession(
  options: ClaudeSessionOptions = {},
): Promise<ClaudeSession> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const effort = options.reasoningEffort ?? "low";
  const work = await mkdtemp(path.join(options.workRoot ?? tmpdir(), "humanish-claude-session-"));
  // The folder as given to Claude Code and as resolved on disk (macOS /var is /private/var).
  const folders = [work, await realpath(work).catch(() => work)];

  let child: ChildProcessWithoutNullStreams | undefined;
  let transport = options.transport;
  if (transport === undefined) {
    const spawnFn = options.spawnFn ?? spawn;
    child = spawnFn("claude", claudeSessionArgs(options.model), {
      cwd: work,
      env: claudeParticipantEnv(options.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    transport = stdioClaudeTransport(child, new ClaudeStreamGuard(folders));
  }

  let turnIndex = 0;
  let previousShot: string | undefined;
  // Whether a turn already failed with the stream's refusal, so close does not report it twice.
  let refusalReported = false;
  // A turn that delivered no result of its own spent tokens that no delivered turn reports. Its
  // late result is discarded rather than added to another turn, so the usage stays unknown.
  let usageIncomplete = false;
  const provider: CuaProvider = {
    id: "local-agent-claude-session",
    version: options.model ?? "claude (local, operator-authenticated, one session per run)",
    modelSettings: { reasoningEffort: effort },
    capabilities: CLAUDE_SESSION_CAPABILITIES,
    requiresFrame: true,
    get interactionUsageIncomplete() {
      return usageIncomplete;
    },
    async nextTurn(request: CuaTurnRequest, signal?: AbortSignal): Promise<CuaTurn> {
      const frame = request.observation.screenshot;
      if (frame === undefined) {
        throw new Error(
          "the Claude session provider needs a screenshot and this observation has none",
        );
      }
      turnIndex += 1;
      const shot = path.join(work, `screen-${String(turnIndex).padStart(3, "0")}.png`);
      await writeFile(shot, frame);
      const hint =
        request.contextHint === undefined
          ? ""
          : `\n\nNote from the harness: ${request.contextHint}`;
      // The persona and the reply shape are in the conversation after turn one; re-sending them
      // every turn is what the one-shot version had to do, and it is most of what it cost.
      // prose-check: model prompt (the participant model reads this, not a person)
      const text =
        turnIndex === 1
          ? promptFor(request, shot)
          : `Read the image file ${shot}. That is the CURRENT SCREEN, after your last actions took effect. ` +
            "Same participant, same task: decide what to do next. " +
            "Reply with ONLY a JSON object of the same shape as before." +
            hint;
      let result: JsonObject;
      try {
        result = await transport!.turn(userMessage(text), timeoutMs, signal);
      } catch (error) {
        usageIncomplete = true;
        // A refused stream keeps its code: the run fails with it.
        if (error instanceof ClaudeParticipantError) {
          refusalReported = true;
          throw error;
        }
        if (error instanceof ClaudeSessionDesyncError) {
          // The stream no longer pairs results with turns, so no later turn can trust it.
          throw new ComputerUseProviderError("protocol_error", {
            dispatched: "unknown",
            usageComplete: false,
            cleanup: "unconfirmed",
          });
        }
        throw error;
      }
      // The frame it already looked at is not needed on disk; the conversation remembers it.
      if (previousShot !== undefined) await unlink(previousShot).catch(() => undefined);
      previousShot = shot;
      return turnFromResult(result);
    },
  };

  return {
    provider,
    close: async () => {
      transport?.close();
      child?.kill();
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
      const late = refusalReported ? undefined : transport?.refusal?.();
      return late === undefined ? {} : { refusal: late.code };
    },
  };
}

/** Read a stream-json `result` message into a CuaTurn. Exported for tests. */
export function turnFromResult(result: JsonObject): CuaTurn {
  if (
    result.is_error === true ||
    (typeof result.subtype === "string" && result.subtype !== "success")
  ) {
    // A turn that errored is a broken turn, never an empty one: an empty turn reads to the loop
    // as "the participant chose to do nothing".
    throw new Error(
      `Claude Code turn ended ${String(result.subtype ?? "in error")}: ${String(result.result ?? "").slice(0, 160)}`,
    );
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
  const count = (key: string): number | undefined =>
    typeof usage?.[key] === "number" ? (usage[key] as number) : undefined;
  // Anthropic's input_tokens counts only the tokens after the last cache breakpoint; cache reads
  // and writes are reported beside it. ActorTokenUsage.input is the whole prompt, with cachedInput
  // and cacheWriteInput as parts of it, so the three are summed.
  const uncachedInput = count("input_tokens");
  const output = count("output_tokens");
  const cachedInput = count("cache_read_input_tokens");
  const cacheWriteInput = count("cache_creation_input_tokens");
  const input =
    uncachedInput === undefined
      ? undefined
      : uncachedInput + (cachedInput ?? 0) + (cacheWriteInput ?? 0);
  return {
    actions,
    pendingSafetyChecks: [],
    done,
    ...(outcome === undefined ? {} : { outcome }),
    ...(typeof parsed.reasoning === "string" && parsed.reasoning.length > 0
      ? { reasoning: parsed.reasoning }
      : {}),
    ...(typeof parsed.message === "string" && parsed.message.length > 0
      ? { message: parsed.message }
      : {}),
    // Claude Code reports its token counts per turn. They are recorded as counts; the
    // run's cost line stays "not priced", because a subscription is not a rate card.
    ...(input === undefined && output === undefined
      ? {}
      : {
          usage: {
            ...(input === undefined ? {} : { input }),
            ...(output === undefined ? {} : { output }),
            ...(cachedInput === undefined ? {} : { cachedInput }),
            ...(cacheWriteInput === undefined ? {} : { cacheWriteInput }),
          },
        }),
  };
}
