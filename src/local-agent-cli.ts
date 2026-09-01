// A computer-use brain that is already installed on the operator's machine.
//
// WHY: the fastest thing humanish can do for someone new is show them a persona driving a real
// desktop. Today that needs a provider API key before anything happens, and "go make an API key"
// is where most people stop. But a developer trying humanish very often ALREADY has a coding agent
// signed in — Codex on a ChatGPT plan, Claude Code on a Max plan — and those CLIs will look at a
// screenshot and answer with the next action. Measured, not assumed: with every OPENAI_* variable
// explicitly unset, `codex exec --image` returned a correct click on the Applications menu of a
// real desktop screenshot, and `claude -p` independently agreed within three pixels.
//
// WHAT THIS IS NOT: a way to avoid paying. Subscription usage consumes the operator's own plan,
// which is why the cost line for these runs says "not priced" rather than $0 — $0 would be a lie.
// It is also not marketed as free API access, and it fails closed on a rate limit rather than
// hammering a plan that was sold for interactive coding.
//
// WHERE IT IS SAFE, and this inverts the intuitive reading: the local agent only DECIDES. humanish
// executes the action inside the E2B sandbox, so nothing the persona chooses ever runs on the
// operator's machine. The same trick on the TERMINAL lane would be the opposite — it would move
// code execution out of the sandbox and onto a real disk — which is why this is a computer-use
// provider and nothing else. Even so, these are coding agents with their own shell and file tools,
// so each one is spawned tool-restricted, in a scratch directory, with a per-turn timeout.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ActorCapabilities, ParticipantDeclaredOutcome } from "./actor-contract.js";
import type { CuaAction, CuaProvider, CuaTurn, CuaTurnRequest } from "./computer-use.js";
import type { ReasoningEffort } from "./reasoning-effort.js";

export type LocalAgentId = "codex" | "claude";

export interface LocalAgentDescriptor {
  id: LocalAgentId;
  /** The command a person types. */
  bin: string;
  /** For humans: "Codex (ChatGPT plan)". */
  label: string;
  /** Where its credentials live, so `doctor` can say "signed in" without reading the file. */
  credentialPath: string;
}

export const LOCAL_AGENTS: readonly LocalAgentDescriptor[] = [
  { id: "codex", bin: "codex", label: "Codex", credentialPath: ".codex/auth.json" },
  { id: "claude", bin: "claude", label: "Claude Code", credentialPath: ".claude/.credentials.json" }
];

/** The action vocabulary the local agent is asked to answer in — a strict subset of CuaAction. */
const ACTION_KINDS = ["click", "double_click", "type", "keypress", "scroll", "wait", "done"] as const;

/**
 * OpenAI structured outputs run in STRICT mode: every property must appear in `required`, so
 * "optional" is expressed as a nullable type. Getting this wrong is a 400 before any thinking
 * happens, which is how this shape was arrived at.
 */
export function localAgentTurnSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["reasoning", "done", "message", "outcome", "actions"],
    properties: {
      reasoning: { type: "string" },
      done: { type: "boolean" },
      message: { type: ["string", "null"] },
      // The participant's own word for how it ended (#570). Null until done.
      outcome: { type: ["string", "null"], enum: ["reached", "not_reached", "blocked", null] },
      actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "x", "y", "text", "keys", "ms"],
          properties: {
            kind: { type: "string", enum: [...ACTION_KINDS] },
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

interface RawAction {
  kind?: string;
  x?: number | null;
  y?: number | null;
  text?: string | null;
  keys?: string[] | null;
  ms?: number | null;
}

/**
 * Map the agent's answer onto the harness action vocabulary. Anything unrecognized is DROPPED
 * rather than guessed at: a coordinate we invented would be recorded as the participant's choice.
 */
export function toCuaActions(raw: readonly RawAction[]): CuaAction[] {
  const actions: CuaAction[] = [];
  for (const item of raw) {
    const x = typeof item.x === "number" ? Math.round(item.x) : undefined;
    const y = typeof item.y === "number" ? Math.round(item.y) : undefined;
    switch (item.kind) {
      case "click":
        if (x !== undefined && y !== undefined) actions.push({ kind: "click", x, y });
        break;
      case "double_click":
        if (x !== undefined && y !== undefined) actions.push({ kind: "double_click", x, y });
        break;
      case "type":
        if (typeof item.text === "string" && item.text.length > 0) actions.push({ kind: "type", text: item.text });
        break;
      case "keypress":
        if (Array.isArray(item.keys) && item.keys.length > 0) actions.push({ kind: "keypress", keys: [...item.keys] });
        break;
      case "scroll":
        if (x !== undefined && y !== undefined) {
          actions.push({ kind: "scroll", x, y, dx: 0, dy: typeof item.ms === "number" ? item.ms : 300 });
        }
        break;
      case "wait":
        actions.push({ kind: "wait", ...(typeof item.ms === "number" ? { ms: item.ms } : {}) });
        break;
      default:
        break; // "done" carries no action; unknown kinds are dropped on purpose
    }
  }
  return actions;
}

/**
 * Pull the JSON object out of whatever the CLI printed. Codex writes clean JSON to
 * `--output-last-message`; Claude Code wraps it in a ```json fence. Both are handled here rather
 * than in two places, and a response with no object at all is a turn error, never an empty turn —
 * an empty turn would read to the loop as "the participant chose to do nothing".
 */
/** The declared outcome, only if it is one of the three words; anything else is absence. */
export function declaredOutcomeOf(value: unknown): ParticipantDeclaredOutcome | undefined {
  return value === "reached" || value === "not_reached" || value === "blocked" ? value : undefined;
}

export function parseAgentJson(text: string): Record<string, unknown> {
  // ORDER MATTERS, and a test caught it: Claude Code's envelope is valid JSON whose `result`
  // STRING contains a ```json fence. Stripping fences first reached inside that string and
  // mangled the envelope. So: parse what we were given, and only go fence-hunting if it is not
  // already JSON.
  const attempts = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1] !== undefined) attempts.push(fenced[1].trim());
  const bare = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (text.indexOf("{") >= 0 && bare.length > 1) attempts.push(bare);

  for (const attempt of attempts) {
    if (attempt.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(attempt);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next shape
    }
  }
  throw new Error("the local agent did not return a JSON object");
}

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type SpawnLike = (
  bin: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal }
) => Promise<SpawnResult>;

const defaultSpawn: SpawnLike = async (bin, args, options) =>
  await new Promise<SpawnResult>((resolve) => {
    const child = spawn(bin, [...args], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    // Stopping a run must stop the thinking too: a local agent mid-turn can hold a terminal for
    // minutes, and a Stop that leaves it running is not a stop.
    const onAbort = (): void => { child.kill("SIGKILL"); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      cleanup();
      resolve({ code: null, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on("close", (code) => {
      cleanup();
      resolve({ code, stdout, stderr });
    });
  });

export interface LocalAgentProviderOptions {
  agent: LocalAgentId;
  /** Per-turn wall clock. A coding agent left to think can outlast the run. */
  timeoutMs?: number;
  /**
   * Codex defaults to HIGH effort, which timed out at 240s on a single action; `low` answered the
   * same screenshot correctly in 9s. A computer-use run is sixty of these, so the default here is
   * deliberately low and the lab can raise it.
   */
  reasoningEffort?: ReasoningEffort;
  /** Model override passed to the CLI (`--model`). Absent = the CLI's own default. */
  model?: string;
  spawnFn?: SpawnLike;
  /** Scratch root for the screenshot and schema handed to the CLI. */
  workRoot?: string;
}

export const LOCAL_AGENT_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  // The operator brings the model by being signed into it already; humanish never sees a key.
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open"
};

export function promptFor(request: CuaTurnRequest, screenshotPath: string, agent: LocalAgentId): string {
  const hint = request.contextHint === undefined ? "" : `\n\nNote from the harness: ${request.contextHint}`;
  // Claude Code has no --output-schema, so the shape is stated in the prompt for both; codex gets
  // it enforced as well. Saying it twice costs nothing and keeps one prompt for both adapters.
  const shape =
    '{"reasoning":string,"done":boolean,"message":string|null,"outcome":"reached"|"not_reached"|"blocked"|null,'
    + '"actions":[{"kind":"click|double_click|type|keypress|scroll|wait|done",'
    + '"x":int|null,"y":int|null,"text":string|null,"keys":[string]|null,"ms":int|null}]}';
  const readFile = agent === "claude" ? `Read the image file ${screenshotPath}. ` : "";
  return [
    request.instructions,
    "",
    `${readFile}That image is the CURRENT SCREEN. You are the participant: decide what to do next, `
      + "as this person would. Coordinates are pixels from the top-left of the screenshot.",
    "Return between one and three actions. Set done=true ONLY when the task is finished or you are "
      + "giving up, and put your closing words in message. When done=true, set outcome: reached if "
      + "the task is finished, blocked if something in the app stopped you, not_reached if you are "
      + "stopping for another reason. Otherwise outcome is null.",
    `Reply with ONLY a JSON object of this shape: ${shape}`,
    hint
  ].join("\n");
}

/**
 * A CuaProvider backed by a coding agent that is already signed in on this machine.
 *
 * Deliberately NOT a new lane: the loop, the executor, the trace, the affordance record and the
 * Observer are all unchanged, because the only thing that differs is where the next action comes
 * from. That is also why it is honest to compare a local-agent run against an API run.
 */
export function createLocalAgentProvider(options: LocalAgentProviderOptions): CuaProvider {
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const effort = options.reasoningEffort ?? "low";
  const descriptor = LOCAL_AGENTS.find((candidate) => candidate.id === options.agent);
  if (descriptor === undefined) {
    throw new Error(`unknown local agent "${options.agent}"`);
  }

  return {
    id: `local-agent-${descriptor.id}`,
    version: options.model ?? `${descriptor.bin} (local, operator-authenticated)`,
    modelSettings: { reasoningEffort: effort },
    capabilities: LOCAL_AGENT_CAPABILITIES,
    // It reasons over pixels, so the loop must hand it a frame or fail closed.
    requiresFrame: true,
    async nextTurn(request: CuaTurnRequest, signal?: AbortSignal): Promise<CuaTurn> {
      const frame = request.observation.screenshot;
      if (frame === undefined) {
        throw new Error("the local-agent provider needs a screenshot and this observation has none");
      }
      const work = await mkdtemp(path.join(options.workRoot ?? tmpdir(), "humanish-local-agent-"));
      try {
        const screenshotPath = path.join(work, "screen.png");
        await writeFile(screenshotPath, frame);
        const prompt = promptFor(request, screenshotPath, descriptor.id);

        let args: string[];
        if (descriptor.id === "codex") {
          const schemaPath = path.join(work, "turn-schema.json");
          await writeFile(schemaPath, JSON.stringify(localAgentTurnSchema()), "utf8");
          args = [
            "exec",
            "--image", screenshotPath,
            "--output-schema", schemaPath,
            "--output-last-message", path.join(work, "turn.json"),
            "--skip-git-repo-check",
            // The agent's OWN shell tools stay read-only: it is here to look at a picture, and a
            // coding agent that decides to go exploring is exploring the operator's disk.
            "--sandbox", "read-only",
            "-c", `model_reasoning_effort=${effort}`,
            ...(options.model === undefined ? [] : ["--model", options.model]),
            prompt
          ];
        } else {
          args = [
            "-p",
            "--output-format", "json",
            // Read is the only tool it needs — the screenshot — and the only one it gets.
            "--allowedTools", "Read",
            ...(options.model === undefined ? [] : ["--model", options.model]),
            prompt
          ];
        }

        const result = await spawnFn(descriptor.bin, args, { cwd: work, timeoutMs, ...(signal === undefined ? {} : { signal }) });
        if (result.code !== 0) {
          // Fail loud with the CLI's own words. A rate-limited plan says so here, and that is a
          // sentence the operator can act on, unlike "turn failed".
          const detail = (result.stderr || result.stdout).trim().slice(-400);
          throw new Error(`${descriptor.label} exited ${result.code ?? "on a signal"}: ${detail}`);
        }

        // Codex writes the structured answer to a file; Claude Code returns an envelope on stdout
        // whose `result` field holds the text.
        let payload = result.stdout;
        if (descriptor.id === "codex") {
          const { readFile: read } = await import("node:fs/promises");
          payload = await read(path.join(work, "turn.json"), "utf8");
        } else {
          const envelope = parseAgentJson(result.stdout);
          payload = typeof envelope.result === "string" ? envelope.result : result.stdout;
        }

        const turn = parseAgentJson(payload);
        const actions = toCuaActions(Array.isArray(turn.actions) ? (turn.actions as RawAction[]) : []);
        const done = turn.done === true || (actions.length === 0 && typeof turn.message === "string");
        const outcome = declaredOutcomeOf(turn.outcome);
        return {
          actions,
          pendingSafetyChecks: [],
          done,
          ...(outcome === undefined ? {} : { outcome }),
          ...(typeof turn.reasoning === "string" && turn.reasoning.length > 0 ? { reasoning: turn.reasoning } : {}),
          ...(typeof turn.message === "string" && turn.message.length > 0 ? { message: turn.message } : {})
          // No `usage`: a subscription CLI does not report tokens we can price, and inventing a
          // number here is what would make the run's cost line a lie.
        };
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}

export interface DetectedLocalAgent extends LocalAgentDescriptor {
  /** Resolved path to the binary. */
  binPath: string;
  /**
   * Whether a credential file exists for it. EXISTENCE ONLY — never read, never parsed, never
   * reported beyond this boolean. "signed in somewhere" is all doctor needs to say, and it is all
   * we are entitled to know.
   */
  credentialsPresent: boolean;
}

export interface DetectLocalAgentsOptions {
  /** Injected for tests: resolves a binary name to a path, or undefined. */
  which?: (bin: string) => Promise<string | undefined>;
  /** Injected for tests: does this path exist? */
  exists?: (file: string) => Promise<boolean>;
  home?: string;
}

/**
 * Which coding agents are installed and signed in on this machine.
 *
 * This is the whole point of the feature at the surface: someone new does not have to go and make
 * an API key if the thing that can drive the study is already on their laptop. `doctor` says so,
 * and says it as a capability rather than a gate — a machine with no local agent is not broken,
 * it just needs a key.
 */
export async function detectLocalAgents(options: DetectLocalAgentsOptions = {}): Promise<DetectedLocalAgent[]> {
  const home = options.home ?? process.env.HOME ?? "";
  const which = options.which ?? (async (bin: string) => {
    const found = await defaultSpawn("sh", ["-lc", `command -v ${bin} 2>/dev/null || true`], {
      cwd: home || ".",
      timeoutMs: 10_000
    });
    const resolved = found.stdout.trim().split("\n")[0]?.trim();
    return resolved !== undefined && resolved.length > 0 ? resolved : undefined;
  });
  const exists = options.exists ?? (async (file: string) => {
    const { access } = await import("node:fs/promises");
    return await access(file).then(() => true).catch(() => false);
  });

  const found: DetectedLocalAgent[] = [];
  for (const descriptor of LOCAL_AGENTS) {
    const binPath = await which(descriptor.bin);
    if (binPath === undefined) continue;
    found.push({
      ...descriptor,
      binPath,
      credentialsPresent: home.length > 0 && (await exists(path.join(home, descriptor.credentialPath)))
    });
  }
  return found;
}

/** One line for `doctor`, in the register the other rows use. */
export function localAgentDoctorMessage(found: readonly DetectedLocalAgent[]): string {
  if (found.length === 0) {
    return "no local coding agent found — a live run needs a provider API key (`humanish keys set openai`)";
  }
  const ready = found.filter((agent) => agent.credentialsPresent);
  if (ready.length === 0) {
    const names = found.map((agent) => agent.label).join(", ");
    return `${names} installed but not signed in — sign in, or use a provider API key`;
  }
  const names = ready.map((agent) => agent.label).join(", ");
  return `${names} signed in — a live run can use ${ready.length === 1 ? "it" : "one"} instead of a provider API key (actors[0].type: local-agent)`;
}
