// What a Claude Code participant may do on the operator's machine, and the checks that hold it
// there.
//
// The participant reads the screen of the app under test, so any text the app shows is input to a
// coding agent running on the host. `--allowedTools Read` alone only pre-approves Read: the
// participant would keep every other tool, the operator's permission mode, hooks, MCP servers and
// `CLAUDE.md`, the full environment, and Claude Code would save each frame it read under
// `~/.claude/projects`. Measured on Claude Code 2.1.289 (2026-10-04): with the flags below and a
// `--settings` that allowed `Bash(*)` and `Read(//**)`, the init message listed Read as the only
// tool and no MCP server, a Read outside the session folder was denied, and no transcript
// directory appeared. Without `--restricted` the same session could see the operator's `CLAUDE.md`.
//
// Flags are one layer. The stream is the second: every message is checked, and a tool call other
// than Read inside the session folder stops the participant (claude-session.ts, cli.ts).

import path from "node:path";

import { dotenvSetNames } from "../../keys/env-file.js";

type JsonObject = Record<string, unknown>;

/**
 * The first release with `--restricted`. The changelog adds it in 2.1.248; `claude --help` of
 * 2.1.247 does not list it and 2.1.248 lists it with `--tools`, `--strict-mcp-config`,
 * `--no-session-persistence` and `--permission-mode dontAsk`.
 */
export const CLAUDE_CODE_MIN_VERSION = "2.1.248";

/** The only tool a participant has: Read, for the screenshot humanish writes into its folder. */
const PARTICIPANT_TOOL = "Read";

/** The permission mode the participant runs in, and the one its init message must report. */
const PERMISSION_MODE = "dontAsk";

/**
 * The flags that restrict a participant, shared by the session and one-shot paths. Each one was
 * checked against `claude --help` of 2.1.248 and 2.1.289.
 */
export function claudeParticipantFlags(model?: string): string[] {
  return [
    // Removes Bash, WebFetch and the other code-running tools, confines file tools to the working
    // directory, refuses bypassPermissions, and ignores user, project and local settings files,
    // which is where hooks, permission rules and plugins come from. The operator's `CLAUDE.md`
    // does not load either (measured on 2.1.289).
    "--restricted",
    // Read is the only built-in tool that exists in the session.
    "--tools",
    PARTICIPANT_TOOL,
    // No MCP server loads from any configuration.
    "--strict-mcp-config",
    // Anything that would need approval is denied without a prompt.
    "--permission-mode",
    PERMISSION_MODE,
    // No transcript under `~/.claude/projects`, so frames stay in the run folder.
    "--no-session-persistence",
    ...(model === undefined ? [] : ["--model", model]),
  ];
}

/**
 * Names the participant's environment keeps from the host. Measured on Linux: `HOME` alone signs
 * in a `claude.ai` login, and `PATH` finds `claude`. `USER` and `LOGNAME` name the macOS keychain
 * account, `CLAUDE_CONFIG_DIR` moves Claude Code's own login and config, and the proxy and CA
 * names are for hosts that reach the API through a proxy. Everything else is dropped: provider
 * keys, `GH_TOKEN`, every `--dotenv` name, `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`, and
 * the `CLAUDE_CODE_*` variables of a Claude Code session humanish itself runs inside.
 */
export const CLAUDE_PARTICIPANT_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "CLAUDE_CONFIG_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

/**
 * The participant's whole environment: the allowlisted names `source` holds, minus any a `--dotenv`
 * file set. The advisor is a server-side tool Claude Code enables by default on some plans; it is
 * turned off so the only tool the stream can show is Read.
 */
export function claudeParticipantEnv(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const fromDotenv = dotenvSetNames(source);
  const env: NodeJS.ProcessEnv = { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" };
  for (const name of CLAUDE_PARTICIPANT_ENV_NAMES) {
    const value = source[name];
    if (typeof value === "string" && !fromDotenv.has(name)) env[name] = value;
  }
  return env;
}

/** `2.1.289` from `2.1.289 (Claude Code)`; undefined for anything else. */
export function parseClaudeCodeVersion(text: string): string | undefined {
  return /^(\d+\.\d+\.\d+)(?:\s|$)/.exec(text.trim())?.[1];
}

/** Whether `version` is at or above CLAUDE_CODE_MIN_VERSION. */
export function admitsClaudeCodeVersion(version: string | undefined): boolean {
  if (version === undefined) return false;
  const have = version.split(".").map(Number);
  const floor = CLAUDE_CODE_MIN_VERSION.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (have[index]! !== floor[index]!) return have[index]! > floor[index]!;
  }
  return true;
}

/** The refusal for a Claude Code release below the floor, or one whose version could not be read. */
export function claudeCodeVersionMessage(version: string | undefined): string {
  return (
    `Claude Code participants need Claude Code ${CLAUDE_CODE_MIN_VERSION} or newer, the first release with --restricted; ` +
    `${version === undefined ? "the installed release did not report a version" : `this machine has ${version}`}. ` +
    "Run `claude update` (or reinstall Claude Code), then retry."
  );
}

export type ClaudeParticipantErrorCode =
  /** Claude Code started with more than Read, with an MCP server, or in another permission mode. */
  | "HUMANISH_CLAUDE_PARTICIPANT_UNRESTRICTED"
  /** The participant called a tool other than Read inside its folder, or Claude Code denied one. */
  | "HUMANISH_CLAUDE_PARTICIPANT_TOOL_REFUSED";

/** The participant was stopped because its stream showed something it may not do. */
export class ClaudeParticipantError extends Error {
  readonly code: ClaudeParticipantErrorCode;
  constructor(code: ClaudeParticipantErrorCode, reason: string) {
    super(`${code}: ${reason}; the participant was stopped`);
    this.name = "ClaudeParticipantError";
    this.code = code;
  }
}

/** A tool name safe to repeat in run evidence: a built-in name, never an MCP server's. */
const toolLabel = (name: unknown): string =>
  typeof name === "string" && /^[A-Z][A-Za-z]{1,40}$/.test(name) ? name : "a non-built-in tool";

/**
 * Checks every stream-json message from one participant process. `inspect` returns the error the
 * message proves, or undefined. A `result` counts only after an init message was admitted.
 */
export class ClaudeStreamGuard {
  private admitted = false;

  /** `folders`: the session folder, as given to Claude Code and as resolved on disk. */
  constructor(private readonly folders: readonly string[]) {}

  inspect(message: JsonObject): ClaudeParticipantError | undefined {
    if (message.type === "system") return this.system(message);
    if (message.type === "assistant") return this.assistant(message);
    if (message.type === "control_request") {
      const request = message.request as JsonObject | undefined;
      // humanish never answers a permission prompt; one arriving means a tool was about to run.
      if (request?.subtype === "can_use_tool")
        return refused(`Claude Code asked to run ${toolLabel(request.tool_name)}`);
      return undefined;
    }
    if (message.type === "result") {
      if (!this.admitted)
        return new ClaudeParticipantError(
          "HUMANISH_CLAUDE_PARTICIPANT_UNRESTRICTED",
          "Claude Code answered before it reported its tools",
        );
      const denials = message.permission_denials;
      if (Array.isArray(denials) && denials.length > 0) {
        const first = denials[0] as JsonObject | undefined;
        return refused(`Claude Code denied a ${toolLabel(first?.tool_name)} call`);
      }
    }
    return undefined;
  }

  private system(message: JsonObject): ClaudeParticipantError | undefined {
    if (message.subtype === "permission_denied")
      return refused(`Claude Code denied a ${toolLabel(message.tool_name)} call`);
    if (message.subtype !== "init") return undefined;
    const tools = message.tools;
    if (!Array.isArray(tools) || tools.length !== 1 || tools[0] !== PARTICIPANT_TOOL) {
      const listed = Array.isArray(tools) ? tools.map(toolLabel).join(", ") : "no tool list";
      return new ClaudeParticipantError(
        "HUMANISH_CLAUDE_PARTICIPANT_UNRESTRICTED",
        `Claude Code started with ${listed || "no tools"} where only Read is allowed`,
      );
    }
    const servers = message.mcp_servers;
    if (!Array.isArray(servers) || servers.length !== 0)
      return new ClaudeParticipantError(
        "HUMANISH_CLAUDE_PARTICIPANT_UNRESTRICTED",
        "Claude Code started with an MCP server configuration",
      );
    if (message.permissionMode !== PERMISSION_MODE)
      return new ClaudeParticipantError(
        "HUMANISH_CLAUDE_PARTICIPANT_UNRESTRICTED",
        `Claude Code started in permission mode ${typeof message.permissionMode === "string" ? message.permissionMode.slice(0, 40) : "(none)"}`,
      );
    this.admitted = true;
    return undefined;
  }

  private assistant(message: JsonObject): ClaudeParticipantError | undefined {
    const inner = message.message as JsonObject | undefined;
    const content = Array.isArray(inner?.content) ? (inner.content as unknown[]) : [];
    for (const raw of content) {
      const block = raw as JsonObject | null;
      if (block === null || typeof block !== "object" || typeof block.type !== "string") continue;
      // tool_use, server_tool_use, mcp_tool_use: anything that names a tool.
      if (!block.type.endsWith("tool_use")) continue;
      if (block.type !== "tool_use" || block.name !== PARTICIPANT_TOOL)
        return refused(`the participant called ${toolLabel(block.name)}`);
      const file = (block.input as JsonObject | undefined)?.file_path;
      if (typeof file !== "string" || !this.inside(file))
        return refused("the participant tried to Read a file outside its session folder");
    }
    return undefined;
  }

  private inside(file: string): boolean {
    // Claude Code expands a leading `~` to the home directory; path.resolve would keep it literal.
    if (file.startsWith("~")) return false;
    return this.folders.some((folder) => {
      const relative = path.relative(folder, path.resolve(folder, file));
      return (
        relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      );
    });
  }
}

const refused = (reason: string): ClaudeParticipantError =>
  new ClaudeParticipantError("HUMANISH_CLAUDE_PARTICIPANT_TOOL_REFUSED", reason);

/** Transcript folders Claude Code saved for earlier participants, before `--no-session-persistence`. */
export type LeftoverClaudeTranscripts =
  | {
      /** Claude Code's projects folder. */
      directory: string;
      /** The matched folder names. */
      names: string[];
      /** Removes exactly `names`; absent when there are none or the folder path is not ASCII. */
      removeCommand?: string;
    }
  /** The folder exists but could not be listed; `code` is the error code, such as `EACCES`. */
  | { directory: string; unreadable: string };

/**
 * Claude Code names a transcript folder after the session's working directory with every
 * character but letters and digits replaced by `-`, so `/tmp/humanish-claude-session-AbC123`
 * becomes `-tmp-humanish-claude-session-AbC123`. The suffix is mkdtemp's six characters. A name
 * with any other character was not made that way and is not counted.
 */
const TRANSCRIPT_NAME = /^[A-Za-z0-9-]*-humanish-(?:claude-session|local-agent)-[A-Za-z0-9]{6}$/;

/**
 * A folder path the printed command may quote: printable ASCII. Terminal output transliterates
 * other characters, and a curly quote turned into `'` would end the quoting early.
 */
const QUOTABLE_PATH = /^[\x20-\x7e]+$/;

const shellQuoted = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** Lists leftover participant transcripts. Reads folder names only, never their contents. */
export async function leftoverClaudeTranscripts(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  list: (directory: string) => Promise<string[]>,
): Promise<LeftoverClaudeTranscripts> {
  const directory = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "projects");
  let entries: string[];
  try {
    entries = await list(directory);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // No projects folder means Claude Code never saved a session here.
    if (code === "ENOENT") return { directory, names: [] };
    return { directory, unreadable: typeof code === "string" ? code : "unknown error" };
  }
  const names = entries.filter((name) => TRANSCRIPT_NAME.test(name)).sort();
  return {
    directory,
    names,
    // Exact quoted paths: a glob would also match names doctor did not count.
    ...(names.length === 0 || !QUOTABLE_PATH.test(directory)
      ? {}
      : {
          removeCommand: `rm -rf -- ${names.map((name) => shellQuoted(path.join(directory, name))).join(" ")}`,
        }),
  };
}
