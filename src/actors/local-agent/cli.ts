// The local-agent participant's shared pieces: which signed-in coding agents this machine has
// (Codex, Claude Code), the doctor line and hosted-Codex version check built on that, the action
// mapping and JSON reading the two Claude Code paths share, and the one-shot Claude Code provider.
//
// A developer trying humanish often already has a coding agent signed in (Codex on a ChatGPT plan,
// Claude Code on a Max plan), so `actors[0].type: local-agent` lets that agent decide the next
// action instead of a provider API key. Codex runs as a restricted app-server participant
// (actors/codex/restricted-participant.ts) and Claude Code as one session for the whole run
// (claude-session.ts). The one-shot provider below spawns `claude -p` per turn, with no memory of
// the last turn; it stays reachable through HUMANISH_LOCAL_AGENT_ONE_SHOT as a measurement switch.
// The design started from a measurement: with every OPENAI_* variable unset, `codex exec --image`
// returned a correct click on a real desktop screenshot and `claude -p` agreed within three pixels.
//
// What this is not: a way to avoid paying. Subscription usage consumes the operator's own plan,
// which is why the cost line for these runs says "not priced": $0 would be a lie.
// It is also not marketed as free API access, and it fails closed on a rate limit rather than
// hammering a plan that was sold for interactive coding.
//
// Where it is safe, and this inverts the intuitive reading: the local agent only decides. humanish
// executes the action inside the desktop sandbox, so nothing the persona chooses ever runs on the
// operator's machine. The same trick on the terminal route would be the opposite: it would move
// code execution out of the sandbox and onto a real disk, which is why this is a computer-use
// provider and nothing else. Even so, these are coding agents with their own shell and file tools,
// so each one is spawned tool-restricted, in a scratch directory, with a per-turn timeout. Claude
// Code's flags, environment and stream checks are in claude-participant.ts.

import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ActorCapabilities, ParticipantDeclaredOutcome } from "../contract.js";
import type { CuaAction, CuaProvider, CuaTurn, CuaTurnRequest } from "../computer-use/loop.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import { admitsCodexCliVersion, parseCodexCliVersion } from "../codex/codex-admission.js";
import { restrictedCodexNpmTarget } from "../codex/restricted-executable.js";
import {
  ClaudeStreamGuard,
  type ClaudeParticipantError,
  admitsClaudeCodeVersion,
  claudeCodeVersionMessage,
  claudeParticipantEnv,
  claudeParticipantFlags,
  parseClaudeCodeVersion,
} from "./claude-participant.js";

export type LocalAgentId = "codex" | "claude";

interface LocalAgentDescriptor {
  id: LocalAgentId;
  /** The command a person types. */
  bin: string;
  /** For humans: "Codex (ChatGPT plan)". */
  label: string;
  /** Legacy file location; existence is a hint, never an authentication verdict. */
  credentialPath: string;
}

const LOCAL_AGENTS: readonly LocalAgentDescriptor[] = [
  { id: "codex", bin: "codex", label: "Codex", credentialPath: ".codex/auth.json" },
  {
    id: "claude",
    bin: "claude",
    label: "Claude Code",
    credentialPath: ".claude/.credentials.json",
  },
];

interface RawAction {
  kind?: string;
  x?: number | null;
  y?: number | null;
  text?: string | null;
  keys?: string[] | null;
  ms?: number | null;
}

/**
 * Map the agent's answer onto the harness action vocabulary. Anything unrecognized is dropped
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
        if (typeof item.text === "string" && item.text.length > 0)
          actions.push({ kind: "type", text: item.text });
        break;
      case "keypress":
        if (Array.isArray(item.keys) && item.keys.length > 0)
          actions.push({ kind: "keypress", keys: [...item.keys] });
        break;
      case "scroll":
        if (x !== undefined && y !== undefined) {
          actions.push({
            kind: "scroll",
            x,
            y,
            dx: 0,
            dy: typeof item.ms === "number" ? item.ms : 300,
          });
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

/** The declared outcome, only if it is one of the three words; anything else is absence. */
export function declaredOutcomeOf(value: unknown): ParticipantDeclaredOutcome | undefined {
  return value === "reached" || value === "not_reached" || value === "blocked" ? value : undefined;
}

/**
 * Pull the JSON object out of whatever the CLI printed: clean JSON, a Claude Code envelope, or an
 * answer wrapped in a ```json fence. A response with no object at all is a turn error, never an
 * empty turn: an empty turn would read to the loop as "the participant chose to do nothing".
 */
export function parseAgentJson(text: string): Record<string, unknown> {
  // Order matters, and a test caught it: Claude Code's envelope is valid JSON whose `result`
  // string contains a ```json fence. Stripping fences first reached inside that string and
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
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    /** Called with each complete stdout line; returning true kills the process at once. */
    onLine?: (line: string) => boolean;
  },
) => Promise<SpawnResult>;

const defaultSpawn: SpawnLike = async (bin, args, options) =>
  await new Promise<SpawnResult>((resolve) => {
    const child = spawn(bin, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let scanned = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    // Stopping a run must stop the thinking too: a local agent mid-turn can hold a terminal for
    // minutes, and a Stop that leaves it running is not a stop.
    const onAbort = (): void => {
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      for (let end = stdout.indexOf("\n", scanned); end >= 0; end = stdout.indexOf("\n", scanned)) {
        const line = stdout.slice(scanned, end);
        scanned = end + 1;
        if (options.onLine?.(line) === true) child.kill("SIGKILL");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
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
  /** Only Claude Code runs one-shot; hosted Codex runs as an app-server participant. */
  agent: "claude";
  /** Per-turn wall clock. A coding agent left to think can outlast the run. */
  timeoutMs?: number;
  /**
   * Recorded in the trace's model settings. Low by default: a computer-use run is sixty turns, and
   * a high-effort answer per turn costs minutes. The study can raise it.
   */
  reasoningEffort?: ReasoningEffort;
  /** Model override passed to the CLI (`--model`). Absent = the CLI's own default. */
  model?: string;
  spawnFn?: SpawnLike;
  /** Scratch root for the screenshot and schema handed to the CLI. */
  workRoot?: string;
  /** Where the participant's few environment names come from. Absent = process.env. */
  env?: Readonly<Record<string, string | undefined>>;
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
  license: "open",
};

/** The turn prompt for Claude Code: the instructions, the screenshot to read, and the reply shape. */
export function promptFor(request: CuaTurnRequest, screenshotPath: string): string {
  const hint =
    request.contextHint === undefined ? "" : `\n\nNote from the harness: ${request.contextHint}`;
  // Claude Code has no --output-schema, so the reply shape is stated in the prompt.
  const shape =
    '{"reasoning":string,"done":boolean,"message":string|null,"outcome":"reached"|"not_reached"|"blocked"|null,' +
    '"actions":[{"kind":"click|double_click|type|keypress|scroll|wait|done",' +
    '"x":int|null,"y":int|null,"text":string|null,"keys":[string]|null,"ms":int|null}]}';
  // prose-check: model prompt (the participant model reads this, not a person)
  return [
    request.instructions,
    "",
    `Read the image file ${screenshotPath}. That image is the CURRENT SCREEN. You are the participant: decide what to do next, ` +
      "as this person would. Coordinates are pixels from the top-left of the screenshot.",
    "Return between one and three actions. Set done=true ONLY when the task is finished or you are " +
      "giving up, and put your closing words in message. When done=true, set outcome: reached if " +
      "the task is finished, blocked if something in the app stopped you, not_reached if you are " +
      "stopping for another reason. Otherwise outcome is null.",
    `Reply with ONLY a JSON object of this shape: ${shape}`,
    hint,
  ].join("\n");
}

/**
 * A CuaProvider that spawns a signed-in Claude Code (`claude -p`) once per turn, with no memory of
 * the last turn. The run's default is one session (claude-session.ts); this path is reached only
 * through HUMANISH_LOCAL_AGENT_ONE_SHOT, to measure "remembers" against "does not".
 *
 * The loop, the executor, the trace, the affordance record and the Observer are unchanged: the
 * only thing that differs is where the next action comes from.
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
        throw new Error(
          "the local-agent provider needs a screenshot and this observation has none",
        );
      }
      const work = await mkdtemp(path.join(options.workRoot ?? tmpdir(), "humanish-local-agent-"));
      try {
        const screenshotPath = path.join(work, "screen.png");
        await writeFile(screenshotPath, frame);
        const prompt = promptFor(request, screenshotPath);
        const folders = [work, await realpath(work).catch(() => work)];
        const watch = new ClaudeStreamGuard(folders);

        const result = await spawnFn(descriptor.bin, claudeOneShotArgs(prompt, options.model), {
          cwd: work,
          env: claudeParticipantEnv(options.env ?? process.env),
          timeoutMs,
          ...(signal === undefined ? {} : { signal }),
          // Stops the process as soon as a line is refused; the full scan below decides the turn.
          onLine: (line) => inspectLine(watch, line) !== undefined,
        });
        const { refusal, result: final } = scanClaudeStream(result.stdout, folders);
        if (refusal !== undefined) throw refusal;
        if (result.code !== 0) {
          // Fail loud with the CLI's own words. A rate-limited plan says so here, and that is a
          // sentence the operator can act on, unlike "turn failed".
          const detail = (result.stderr || result.stdout).trim().slice(-400);
          throw new Error(`${descriptor.label} exited ${result.code ?? "on a signal"}: ${detail}`);
        }
        if (final === undefined) throw new Error(`${descriptor.label} returned no result message`);
        if (final.is_error === true) {
          const ending = typeof final.subtype === "string" ? final.subtype : "in error";
          const said = typeof final.result === "string" ? final.result.slice(0, 160) : "";
          throw new Error(`${descriptor.label} turn ended ${ending}: ${said}`);
        }
        const payload = typeof final.result === "string" ? final.result : "";

        const turn = parseAgentJson(payload);
        const actions = toCuaActions(
          Array.isArray(turn.actions) ? (turn.actions as RawAction[]) : [],
        );
        const done =
          turn.done === true || (actions.length === 0 && typeof turn.message === "string");
        const outcome = declaredOutcomeOf(turn.outcome);
        return {
          actions,
          pendingSafetyChecks: [],
          done,
          ...(outcome === undefined ? {} : { outcome }),
          ...(typeof turn.reasoning === "string" && turn.reasoning.length > 0
            ? { reasoning: turn.reasoning }
            : {}),
          ...(typeof turn.message === "string" && turn.message.length > 0
            ? { message: turn.message }
            : {}),
          // No `usage`: a subscription CLI does not report tokens we can price, and inventing a
          // number here is what would make the run's cost line a lie.
        };
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

/** The one-shot argv: stream-json out so every message can be checked, then the prompt after `--`. */
function claudeOneShotArgs(prompt: string, model?: string): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    // Required for stream-json output in -p mode.
    "--verbose",
    ...claudeParticipantFlags(model),
    // `--tools` takes a list, so a prompt placed right after it would be read as a tool name.
    // `--` ends the options so the prompt is the prompt.
    "--",
    prompt,
  ];
}

/** The refusal one stdout line proves, if any. A line that is not JSON proves nothing. */
function inspectLine(guard: ClaudeStreamGuard, line: string): ClaudeParticipantError | undefined {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  return message !== null && typeof message === "object" && !Array.isArray(message)
    ? guard.inspect(message as Record<string, unknown>)
    : undefined;
}

/** The first refusal in a finished one-shot stream, and its last `result` message. */
function scanClaudeStream(
  stdout: string,
  folders: readonly string[],
): { refusal?: ClaudeParticipantError; result?: Record<string, unknown> } {
  const guard = new ClaudeStreamGuard(folders);
  let result: Record<string, unknown> | undefined;
  for (const line of stdout.split("\n")) {
    const refusal = inspectLine(guard, line);
    if (refusal !== undefined) return { refusal };
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message?.type === "result") result = message;
    } catch {
      // not a message
    }
  }
  return result === undefined ? {} : { result };
}

export interface DetectedLocalAgent extends LocalAgentDescriptor {
  /** Resolved path to the binary. */
  binPath: string;
  /**
   * Whether a credential file exists for it. Existence only: never read, never parsed, never
   * reported beyond this boolean. Keyring storage may have no file at all.
   */
  credentialsPresent: boolean;
  /** CLI-reported local status, not a provider request or account-validity test. */
  authStatus: "authenticated" | "unauthenticated" | "unknown";
  /** Known Codex login billing class. Absent when the status text is not one of the pinned shapes. */
  billing?: "account-unknown" | "api";
  /** Claude Code's `--version` release. Absent for Codex and when the output is not a version. */
  version?: string;
}

export interface DetectLocalAgentsOptions {
  /** Probe only this agent: a readiness check has no reason to run the other CLI. */
  only?: LocalAgentId;
  /** Injected for tests: resolves a binary name to a path, or undefined. */
  which?: (bin: string) => Promise<string | undefined>;
  /** Injected for tests: does this path exist? */
  exists?: (file: string) => Promise<boolean>;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Status output is classified in memory and never returned or persisted. */
  authProbe?: (
    bin: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<SpawnResult>;
}

/** No shell, prompts or model request. Bound time and output even for a broken CLI. */
async function authProbe(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
  return await new Promise((resolve) => {
    const child = spawn(bin, [...args], { cwd: tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "",
      bytes = 0,
      settled = false;
    const finish = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stop = () => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ code: null, stdout: "", stderr: "" });
    };
    const timer = setTimeout(stop, 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) stop();
      else stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) stop();
      else stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish({ code: null, stdout: "", stderr: "" }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

function classifyAuth(
  agent: LocalAgentId,
  result: SpawnResult,
): Pick<DetectedLocalAgent, "authStatus" | "billing"> {
  if (agent === "codex") {
    const text = `${result.stdout}\n${result.stderr}`;
    if (result.code === 0 && /^Logged in using ChatGPT\b/m.test(text))
      return { authStatus: "authenticated", billing: "account-unknown" };
    if (result.code === 0 && /^Logged in using an API key\b/m.test(text))
      return { authStatus: "authenticated", billing: "api" };
    if (result.code === 0 && /^Logged in\b/m.test(text)) return { authStatus: "authenticated" };
    if (result.code === 1 && /^Not logged in\s*$/m.test(text))
      return { authStatus: "unauthenticated" };
  } else {
    try {
      const value: unknown = JSON.parse(result.stdout);
      if (value && typeof value === "object" && "loggedIn" in value) {
        if (value.loggedIn === true && result.code === 0) return { authStatus: "authenticated" };
        if (value.loggedIn === false && result.code === 1) return { authStatus: "unauthenticated" };
      }
    } catch {
      /* Old CLI, invalid config or unsupported status command: unknown. */
    }
  }
  return { authStatus: "unknown" };
}

export type HostedCodexCompatibility = "supported" | "unsupported_platform" | "unsupported_version";

/** Host-only compatibility check. It never initializes app-server or submits a model request. */
export async function checkHostedCodexCompatibility(
  binPath: string,
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    arch?: string;
    probe?: (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<SpawnResult>;
  } = {},
): Promise<HostedCodexCompatibility> {
  const platform = options.platform ?? process.platform,
    arch = options.arch ?? process.arch;
  if (restrictedCodexNpmTarget(platform, arch) === undefined) return "unsupported_platform";
  const result = await (options.probe ?? authProbe)(
    binPath,
    ["--version"],
    options.env ?? process.env,
  ).catch(() => ({ code: null, stdout: "", stderr: "" }));
  const version = parseCodexCliVersion(result.stdout);
  return result.code === 0 && version !== undefined && admitsCodexCliVersion(version)
    ? "supported"
    : "unsupported_version";
}

/**
 * Which coding agents are installed and signed in on this machine.
 *
 * This is the whole point of the feature at the surface: someone new does not have to go and make
 * an API key if the thing that can drive the study is already on their laptop. `doctor` says so,
 * and says it as a capability rather than a gate: a machine with no local agent is not broken,
 * it just needs a key.
 */
export async function detectLocalAgents(
  options: DetectLocalAgentsOptions = {},
): Promise<DetectedLocalAgent[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? "";
  const which =
    options.which ??
    (async (bin: string) => {
      const { access, constants } = await import("node:fs/promises");
      for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
        const candidate = path.resolve(directory, bin);
        if (
          await access(candidate, constants.X_OK)
            .then(() => true)
            .catch(() => false)
        )
          return candidate;
      }
      return undefined;
    });
  const exists =
    options.exists ??
    (async (file: string) => {
      const { access } = await import("node:fs/promises");
      return await access(file)
        .then(() => true)
        .catch(() => false);
    });

  const found: DetectedLocalAgent[] = [];
  const probe = options.authProbe ?? authProbe;
  for (const descriptor of LOCAL_AGENTS) {
    if (options.only !== undefined && descriptor.id !== options.only) continue;
    const binPath = await which(descriptor.bin);
    if (binPath === undefined) continue;
    const file =
      descriptor.id === "codex" && env.CODEX_HOME
        ? path.join(env.CODEX_HOME, "auth.json")
        : descriptor.id === "claude" && env.CLAUDE_CONFIG_DIR
          ? path.join(env.CLAUDE_CONFIG_DIR, ".credentials.json")
          : path.join(home, descriptor.credentialPath);
    // Claude Code is asked with the participant's own environment, so a login that only works
    // through a dropped variable (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN) reads as signed out.
    const probeEnv = descriptor.id === "claude" ? claudeParticipantEnv(env) : env;
    const status = await probe(
      binPath,
      descriptor.id === "codex" ? ["login", "status"] : ["auth", "status"],
      probeEnv,
    )
      .then((result) => classifyAuth(descriptor.id, result))
      .catch(() => ({ authStatus: "unknown" as const }));
    const version =
      descriptor.id === "claude"
        ? await probe(binPath, ["--version"], probeEnv)
            .then((result) =>
              result.code === 0 ? parseClaudeCodeVersion(result.stdout) : undefined,
            )
            .catch(() => undefined)
        : undefined;
    found.push({
      ...descriptor,
      binPath,
      credentialsPresent: await exists(file).catch(() => false),
      ...status,
      ...(version === undefined ? {} : { version }),
    });
  }
  return found;
}

/** Doctor's row when neither Codex nor Claude Code is installed. */
export const NO_LOCAL_AGENT_MESSAGE =
  "no local coding agent found. openai-computer-use needs OPENAI_API_KEY; local-agent needs Codex or Claude Code installed and signed in. Hosted desktops also need E2B_API_KEY.";

/** Whether a signed-in agent can still not run participants here: an old Claude Code. */
export function localAgentVersionRefusal(agent: DetectedLocalAgent): string | undefined {
  return agent.id === "claude" && !admitsClaudeCodeVersion(agent.version)
    ? claudeCodeVersionMessage(agent.version)
    : undefined;
}

/** Doctor's row for one installed agent, in the register the other rows use. */
export function localAgentDoctorMessage(agent: DetectedLocalAgent): string {
  const outdated = localAgentVersionRefusal(agent);
  if (agent.authStatus === "authenticated" && outdated !== undefined)
    return `${agent.label} reports signed in, but cannot run participants yet. ${outdated}`;
  if (agent.authStatus === "authenticated")
    return `${agent.label}${agent.version === undefined ? "" : ` ${agent.version}`} reports signed in; a study with actor.type: local-agent can use it instead of a provider API key. Account access and limits are untested.`;
  const status = agent.id === "codex" ? "codex login status" : "claude auth status";
  return agent.authStatus === "unauthenticated"
    ? `${agent.label} is installed and reports not signed in; run \`${agent.id === "codex" ? "codex login" : "claude auth login"}\``
    : `${agent.label} is installed; its sign-in status could not be checked. Run \`${status}\`, and update the CLI if needed.`;
}
