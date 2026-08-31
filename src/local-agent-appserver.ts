// A codex app-server THREAD as the computer-use brain, instead of a fresh `codex exec` per turn.
//
// WHY THIS REPLACED THE ONE-SHOT VERSION, measured on this machine:
//   `codex exec` per turn        ~9s every turn, and every turn starts cold
//   app-server thread            ~500ms ONCE, then 2.7s / 5.8s / 8.9s per turn
//
// The speed is the smaller half. `codex exec` boots a CLI, loads config, agents and MCP servers on
// every single turn, and — the part that actually matters — hands the model a conversation that
// begins fresh each time. A participant driving a desktop that way has AMNESIA: it cannot remember
// that it already tried the menu, because nothing carried. A thread remembers, which is how the
// OpenAI computer-use provider has always worked (previous_response_id), and it is the difference
// between studying one participant and studying sixty strangers who each see one screenshot.
//
// The protocol is not guessed: `codex app-server generate-json-schema` emits it, and it gives us
// exactly what this loop needs — `turn/start` takes `input: [{type:"localImage", path}, ...]`,
// an `outputSchema` that constrains the reply (so no fence-scraping), and per-turn `effort` and
// `model` overrides described as applying "for this turn and subsequent turns".

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import type { ActorCapabilities } from "./actor-contract.js";
import type { CuaProvider, CuaTurn, CuaTurnRequest } from "./computer-use.js";
import type { ReasoningEffort } from "./reasoning-effort.js";
import { toCuaActions } from "./local-agent-cli.js";

type JsonObject = Record<string, unknown>;

/** The transport, injected so tests drive a fake server with no CLI and no spend. */
export interface AppServerTransport {
  request(method: string, params: JsonObject): Promise<JsonObject>;
  notify(method: string, params: JsonObject): void;
  /** Resolves when the named notification arrives after the current turn began. */
  awaitNotification(method: string, timeoutMs: number): Promise<JsonObject>;
  close(): void;
}

/** Newline-delimited JSON-RPC over the child's stdio — the framing codex-app-server.ts uses. */
export function stdioTransport(child: ChildProcessWithoutNullStreams): AppServerTransport {
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void }>();
  const waiters: Array<{ method: string; resolve: (value: JsonObject) => void }> = [];
  let nextId = 0;

  rl.on("line", (line: string) => {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return; // the server also logs non-JSON; ignore rather than crash the run
    }
    const id = message.id;
    if (typeof id === "number" && pending.has(id)) {
      const entry = pending.get(id)!;
      pending.delete(id);
      if (message.error !== undefined) {
        entry.reject(new Error(`codex app-server: ${JSON.stringify(message.error).slice(0, 300)}`));
      } else {
        entry.resolve((message.result ?? {}) as JsonObject);
      }
      return;
    }
    if (typeof message.method === "string") {
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (waiters[index]!.method === message.method) {
          waiters.splice(index, 1)[0]!.resolve(message);
        }
      }
    }
  });

  return {
    request: async (method, params) =>
      await new Promise<JsonObject>((resolve, reject) => {
        const id = (nextId += 1);
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    notify: (method, params) => {
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    },
    awaitNotification: async (method, timeoutMs) =>
      await new Promise<JsonObject>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
        waiters.push({
          method,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          }
        });
      }),
    close: () => {
      rl.close();
      child.kill();
    }
  };
}

export interface AppServerProviderOptions {
  /** Absent = spawn `codex app-server`. Injected in tests. */
  transport?: AppServerTransport;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Per-turn wall clock. */
  timeoutMs?: number;
  cwd?: string;
  /** The persona/mission, set ONCE on the thread instead of re-sent every turn. */
  baseInstructions?: string;
}

export const APP_SERVER_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open"
};

/** The reply shape a turn is constrained to. Strict mode: every property in `required`. */
export function turnOutputSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["reasoning", "done", "message", "actions"],
    properties: {
      reasoning: { type: "string" },
      done: { type: "boolean" },
      message: { type: ["string", "null"] },
      actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "x", "y", "text", "keys", "ms"],
          properties: {
            kind: { type: "string", enum: ["click", "double_click", "type", "keypress", "scroll", "wait", "done"] },
            x: { type: ["integer", "null"] },
            y: { type: ["integer", "null"] },
            text: { type: ["string", "null"] },
            keys: { type: ["array", "null"], items: { type: "string" } },
            ms: { type: ["integer", "null"] }
          }
        }
      }
    }
  };
}

function readNested(value: unknown, keys: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as JsonObject)[key];
  }
  return typeof current === "string" ? current : undefined;
}

export interface AppServerSession {
  provider: CuaProvider;
  /** Ends the thread and the process. The run owns the lifetime, not the provider. */
  close(): void;
}

/**
 * Start a thread and return a provider that spends it, one `turn/start` per computer-use turn.
 *
 * The thread is started EAGERLY (before the first screenshot) so the ~500ms handshake is paid
 * while the sandbox is still booting rather than inside turn one.
 */
export async function startAppServerSession(
  options: AppServerProviderOptions = {}
): Promise<AppServerSession> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const cwd = options.cwd ?? process.cwd();
  const effort = options.reasoningEffort ?? "low";

  let child: ChildProcessWithoutNullStreams | undefined;
  let transport = options.transport;
  if (transport === undefined) {
    child = spawn("codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    // The server logs to stderr; draining it keeps the pipe from filling and stalling the run.
    child.stderr.resume();
    transport = stdioTransport(child);
  }

  await transport.request("initialize", {
    clientInfo: { name: "humanish_cli", title: "Humanish CLI", version: "0.1.0" },
    capabilities: {}
  });
  transport.notify("initialized", {});

  const thread = await transport.request("thread/start", {
    cwd,
    // The participant is here to look at a screen, not to touch this machine. read-only + never
    // is the same bound the one-shot version had, declared once for the whole thread.
    approvalPolicy: "never",
    sandbox: "read-only",
    serviceName: "humanish",
    // Nothing about this study belongs in the operator's codex history.
    ephemeral: true,
    ...(options.baseInstructions === undefined ? {} : { baseInstructions: options.baseInstructions }),
    ...(options.model === undefined ? {} : { model: options.model })
  });
  const threadId = readNested(thread, ["thread", "id"]);
  if (threadId === undefined) {
    transport.close();
    throw new Error("codex app-server did not return a thread id");
  }

  const provider: CuaProvider = {
    id: "local-agent-codex-app-server",
    version: options.model ?? "codex app-server (local, operator-authenticated)",
    modelSettings: { reasoningEffort: effort },
    capabilities: APP_SERVER_CAPABILITIES,
    requiresFrame: true,
    async nextTurn(request: CuaTurnRequest, signal?: AbortSignal): Promise<CuaTurn> {
      const frame = request.observation.screenshot;
      if (frame === undefined) {
        throw new Error("the codex app-server provider needs a screenshot and this observation has none");
      }
      const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const path = await import("node:path");
      const work = await mkdtemp(path.join(tmpdir(), "humanish-appserver-"));
      try {
        const shot = path.join(work, "screen.png");
        await writeFile(shot, frame);
        const hint = request.contextHint === undefined ? "" : `\n\nNote from the harness: ${request.contextHint}`;

        const completed = transport!.awaitNotification("turn/completed", timeoutMs);
        await transport!.request("turn/start", {
          threadId,
          cwd,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
          // Per-turn, because a lane declares it and the schema says it applies to this turn and
          // the ones after — so a lane that raises effort raises it from that point on.
          effort,
          ...(options.model === undefined ? {} : { model: options.model }),
          outputSchema: turnOutputSchema(),
          input: [
            { type: "localImage", path: shot },
            {
              type: "text",
              // The persona already lives in baseInstructions; this is only the turn's ask, which
              // is why it stays this short.
              text: `This is the current screen. What do you do next?${hint}`,
              text_elements: []
            }
          ]
        });

        const abort = signal === undefined
          ? undefined
          : new Promise<never>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("run stopped")), { once: true });
            });
        const note = await (abort === undefined ? completed : Promise.race([completed, abort]));
        return turnFromNotification(note);
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };

  return {
    provider,
    close: () => {
      transport?.close();
      child?.kill();
    }
  };
}

/** Read a `turn/completed` notification into a CuaTurn. Exported for tests. */
export function turnFromNotification(note: JsonObject): CuaTurn {
  const params = (note.params ?? {}) as JsonObject;
  const turn = (params.turn ?? {}) as JsonObject;
  // Read the protocol, do not guess it: `turn/completed` carries `turn.items`, and the model's
  // answer is the LAST `agentMessage` item, whose `text` is a plain string. The first cut of this
  // looked for `turn.output`, found nothing, and silently produced an empty turn — which the loop
  // read as "the participant is finished", ending a live study after one screenshot.
  const items = Array.isArray(turn.items) ? (turn.items as JsonObject[]) : [];
  const message = [...items].reverse().find((item) => item.type === "agentMessage");
  const text = typeof message?.text === "string" ? message.text : "";
  let parsed: JsonObject;
  try {
    // `outputSchema` constrains it to JSON, but a fence costs nothing to tolerate.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    parsed = JSON.parse((fenced?.[1] ?? text).trim()) as JsonObject;
  } catch {
    // A turn whose constrained output did not arrive is a BROKEN turn, never an empty one: an
    // empty turn reads to the loop as "the participant chose to do nothing".
    throw new Error(`codex app-server returned no structured turn output (${text.slice(0, 160)})`);
  }
  const actions = toCuaActions(Array.isArray(parsed.actions) ? (parsed.actions as never[]) : []);
  return {
    actions,
    pendingSafetyChecks: [],
    // EXPLICIT only. The first version also inferred done from "no actions plus a message", and
    // that inference ended a live study on turn one with a 7-second "goal_satisfied": the model
    // narrated the screen, chose no action, and the provider called it finished. The schema
    // guarantees a `done` boolean, so there is nothing to infer.
    done: parsed.done === true,
    ...(typeof parsed.reasoning === "string" && parsed.reasoning.length > 0 ? { reasoning: parsed.reasoning } : {}),
    ...(typeof parsed.message === "string" && parsed.message.length > 0 ? { message: parsed.message } : {})
    // No `usage`: a subscription thread reports nothing we could price, and a number invented here
    // is what would make the run's cost line a lie.
  };
}
