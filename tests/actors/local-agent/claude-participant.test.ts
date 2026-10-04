import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_MIN_VERSION,
  CLAUDE_PARTICIPANT_ENV_NAMES,
  ClaudeStreamGuard,
  admitsClaudeCodeVersion,
  claudeParticipantEnv,
  claudeParticipantFlags,
  leftoverClaudeTranscripts,
  parseClaudeCodeVersion,
} from "../../../src/actors/local-agent/claude-participant.js";

type Json = Record<string, unknown>;

const FOLDER = "/tmp/humanish-claude-session-AbC123";

/** The captured restricted stream: init, an inside Read, an outside Read, its denial, the result. */
const captured = readFileSync(
  new URL("../../fixtures/claude-code-stream-json/restricted-denial.ndjson", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Json);
const [init, insideRead, outsideRead, denied, result] = captured as [Json, Json, Json, Json, Json];

const toolUse = (block: Json): Json => ({
  type: "assistant",
  message: { role: "assistant", content: [block] },
});

describe("the participant's flags and environment", () => {
  it("restricts tools, MCP, settings, permission mode and persistence", () => {
    expect(claudeParticipantFlags()).toEqual([
      "--restricted",
      "--tools",
      "Read",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
    ]);
    expect(claudeParticipantFlags("haiku").slice(-2)).toEqual(["--model", "haiku"]);
  });

  it("keeps only the names Claude Code needs to sign in and run", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/home/dev",
      USER: "dev",
      LANG: "C.UTF-8",
      CLAUDE_CONFIG_DIR: "/home/dev/.claude-alt",
      HTTPS_PROXY: "http://proxy.example:3128",
      OPENAI_API_KEY: "sk-synthetic",
      E2B_API_KEY: "e2b_synthetic",
      CODEX_API_KEY: "synthetic",
      GH_TOKEN: "synthetic",
      GITHUB_TOKEN: "synthetic",
      ANTHROPIC_API_KEY: "synthetic",
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic",
      // A `--dotenv` name and the variables of a Claude Code session humanish runs inside.
      STRIPE_SECRET_KEY: "synthetic",
      CLAUDECODE: "1",
      CLAUDE_CODE_MESSAGING_TOKEN: "synthetic",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
      CLAUDE_CODE_SESSION_ID: "synthetic",
      TMPDIR: "/tmp/synthetic",
    };
    expect(claudeParticipantEnv(source)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      USER: "dev",
      LANG: "C.UTF-8",
      CLAUDE_CONFIG_DIR: "/home/dev/.claude-alt",
      HTTPS_PROXY: "http://proxy.example:3128",
      CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
    });
    for (const name of CLAUDE_PARTICIPANT_ENV_NAMES)
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|^CLAUDE_CODE_/);
  });
});

describe("the Claude Code release a participant needs", () => {
  it("reads the version Claude Code prints", () => {
    expect(parseClaudeCodeVersion("2.1.289 (Claude Code)\n")).toBe("2.1.289");
    expect(parseClaudeCodeVersion('{"loggedIn": true}')).toBeUndefined();
    expect(parseClaudeCodeVersion("")).toBeUndefined();
  });

  it("admits the floor and newer, and refuses older or unread releases", () => {
    expect(admitsClaudeCodeVersion(CLAUDE_CODE_MIN_VERSION)).toBe(true);
    for (const newer of ["2.1.289", "2.2.0", "3.0.0", "2.1.1000"])
      expect(admitsClaudeCodeVersion(newer), newer).toBe(true);
    for (const older of ["2.1.247", "2.0.999", "1.9.300"])
      expect(admitsClaudeCodeVersion(older), older).toBe(false);
    expect(admitsClaudeCodeVersion(undefined)).toBe(false);
  });
});

describe("the stream guard", () => {
  it("admits the captured init and the Read inside the session folder", () => {
    const guard = new ClaudeStreamGuard([FOLDER]);
    expect(guard.inspect(init)).toBeUndefined();
    expect(guard.inspect(insideRead)).toBeUndefined();
  });

  it("refuses the captured Read outside the folder, its denial, and the result that lists it", () => {
    const guard = new ClaudeStreamGuard([FOLDER]);
    guard.inspect(init);
    for (const message of [outsideRead, denied, result])
      expect(guard.inspect(message)?.code).toBe("HUMANISH_CLAUDE_PARTICIPANT_TOOL_REFUSED");
  });

  it("refuses every tool but Read, including server and MCP tools", () => {
    const guard = new ClaudeStreamGuard([FOLDER]);
    guard.inspect(init);
    for (const block of [
      { type: "tool_use", name: "Bash", input: { command: "true" } },
      { type: "tool_use", name: "Write", input: { file_path: `${FOLDER}/x` } },
      { type: "server_tool_use", name: "advisor", input: {} },
      { type: "mcp_tool_use", name: "mcp__synthetic__tool", input: {} },
      { type: "server_tool_use", name: "Read", input: { file_path: `${FOLDER}/x` } },
    ])
      expect(guard.inspect(toolUse(block))?.code, JSON.stringify(block)).toBe(
        "HUMANISH_CLAUDE_PARTICIPANT_TOOL_REFUSED",
      );
  });

  it("refuses a Read that leaves the folder by a relative or home path, and one with no path", () => {
    const guard = new ClaudeStreamGuard([FOLDER]);
    for (const input of [
      { file_path: "../outside/canary.txt" },
      { file_path: "/etc/hosts" },
      { file_path: "~/.config/humanish/keys.env" },
      {},
    ])
      expect(guard.inspect(toolUse({ type: "tool_use", name: "Read", input }))?.code).toBe(
        "HUMANISH_CLAUDE_PARTICIPANT_TOOL_REFUSED",
      );
    expect(
      guard.inspect(
        toolUse({ type: "tool_use", name: "Read", input: { file_path: "screen-002.png" } }),
      ),
    ).toBeUndefined();
  });

  it("refuses a permission prompt sent to the harness", () => {
    const guard = new ClaudeStreamGuard([FOLDER]);
    expect(
      guard.inspect({
        type: "control_request",
        request_id: "r1",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: {} },
      })?.code,
    ).toBe("HUMANISH_CLAUDE_PARTICIPANT_TOOL_REFUSED");
  });

  it("refuses a session that did not start restricted", () => {
    for (const changed of [
      { tools: ["Bash", "Edit", "Read", "Write"] },
      { tools: [] },
      { tools: undefined },
      { mcp_servers: [{ name: "synthetic", status: "connected" }] },
      { mcp_servers: undefined },
      { permissionMode: "auto" },
      { permissionMode: "bypassPermissions" },
    ]) {
      const guard = new ClaudeStreamGuard([FOLDER]);
      expect(guard.inspect({ ...init, ...changed })?.code, JSON.stringify(changed)).toBe(
        "HUMANISH_CLAUDE_PARTICIPANT_UNRESTRICTED",
      );
    }
  });

  it("names no MCP server or tool name that is not built in", () => {
    const guard = new ClaudeStreamGuard([FOLDER]);
    const refusal = guard.inspect({ ...init, tools: ["Read", "mcp__private-server__lookup"] });
    expect(refusal?.message).not.toContain("private-server");
  });

  it("refuses a result that arrives before an admitted init", () => {
    const guard = new ClaudeStreamGuard([FOLDER]);
    expect(guard.inspect({ type: "result", subtype: "success", result: "{}" })?.code).toBe(
      "HUMANISH_CLAUDE_PARTICIPANT_UNRESTRICTED",
    );
  });
});

describe("leftover participant transcripts", () => {
  const names = [
    "-tmp-humanish-claude-session-AbC123",
    "-tmp-humanish-claude-session-XyZ789",
    "-var-folders-ab-T-humanish-local-agent-Q1w2E3",
    "-home-dev-humanish-claude-session-notes",
    "-home-dev-project",
  ];

  it("counts only participant folders and prints a command for the kinds found", async () => {
    let listed = "";
    const found = await leftoverClaudeTranscripts({}, "/home/dev", async (directory) => {
      listed = directory;
      return names;
    });
    expect(listed).toBe("/home/dev/.claude/projects");
    expect(found.count).toBe(3);
    expect(found.removeCommand).toBe(
      "rm -rf '/home/dev/.claude/projects'/*-humanish-claude-session-?????? '/home/dev/.claude/projects'/*-humanish-local-agent-??????",
    );
  });

  it("follows CLAUDE_CONFIG_DIR and prints no command when nothing matched", async () => {
    const found = await leftoverClaudeTranscripts(
      { CLAUDE_CONFIG_DIR: "/srv/claude" },
      "/home/dev",
      async () => ["-home-dev-project"],
    );
    expect(found).toEqual({ directory: "/srv/claude/projects", count: 0 });
  });

  it("treats a missing projects folder as empty", async () => {
    const found = await leftoverClaudeTranscripts({}, "/home/dev", async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(found.count).toBe(0);
  });
});
