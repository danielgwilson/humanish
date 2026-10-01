import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  admitAccount,
  admitEffectiveConfig,
  admitInitialize,
  admitMcpStatus,
  admitThread,
  admitted,
  configArguments,
  threadConfigFor,
  threadStartParams,
} from "../../../src/actors/codex/restricted-launch.js";
import { RestrictedCodexStop } from "../../../src/actors/codex/restricted-transport.js";

// The captured app-server replies the restricted session admits (tests/fixtures/restricted-codex).
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../../fixtures/restricted-codex/${name}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
const initialize = fixture("initialize.json");
const effective = fixture("effective-config.json");
const account = fixture("account-read-projection.json");
const thread = fixture("thread-start.json");
const mcp = fixture("mcp-status.json");

const home = "/private/probe/home";
const cwd = "/private/probe/cwd";
const expectedInit = {
  cliVersion: "0.157.1",
  home,
  operatorAuth: false,
  platform: "linux" as const,
};
const threadExpected = {
  selectedModel: "gpt-6-astra",
  cwd,
  reasoningEffort: "low" as const,
  cliVersion: "0.157.1",
};

describe("restricted launch admission", () => {
  it("unwraps an admitted value and stops on a refusal with its code", () => {
    expect(admitted({ value: 3 })).toBe(3);
    expect(() => admitted({ refusal: "codex_unsafe_configuration" })).toThrow(RestrictedCodexStop);
    try {
      admitted({ refusal: "codex_login_required" });
    } catch (error) {
      expect((error as RestrictedCodexStop).code).toBe("codex_login_required");
    }
  });

  it("admits the captured initialize reply and refuses each mismatch as an unsupported version", () => {
    expect(admitInitialize(initialize, expectedInit)).toEqual({ value: undefined });
    const refused = { refusal: "codex_unsupported_version" };
    expect(admitInitialize(initialize, { ...expectedInit, cliVersion: "0.159.2" })).toEqual(
      refused,
    );
    expect(admitInitialize({ ...initialize, userAgent: 7 }, expectedInit)).toEqual(refused);
    expect(admitInitialize({ ...initialize, codexHome: "/elsewhere" }, expectedInit)).toEqual(
      refused,
    );
    expect(admitInitialize(initialize, { ...expectedInit, platform: "darwin" })).toEqual(refused);
    expect(admitInitialize({ ...initialize, platformFamily: "windows" }, expectedInit)).toEqual(
      refused,
    );
    // Operator auth keeps the operator's own Codex home.
    expect(
      admitInitialize(
        { ...initialize, codexHome: "/elsewhere" },
        { ...expectedInit, operatorAuth: true },
      ),
    ).toEqual({ value: undefined });
  });

  it("admits the captured config with the model it selects, and refuses an unsafe one", () => {
    expect(admitEffectiveConfig(effective, `${home}/config.toml`, "gpt-6-astra", {})).toEqual({
      value: "gpt-6-astra",
    });
    expect(admitEffectiveConfig(effective, "/other/config.toml", "gpt-6-astra", {})).toEqual({
      refusal: "codex_unsafe_configuration",
    });
  });

  it("admits a ChatGPT account, an API key only with operator auth, and refuses the rest", () => {
    expect(admitAccount(account, false)).toEqual({ value: "chatgpt-account" });
    const apiKey = { account: { type: "apiKey" }, requiresOpenaiAuth: true };
    expect(admitAccount(apiKey, false)).toEqual({ refusal: "codex_unsupported_auth" });
    expect(admitAccount(apiKey, true)).toEqual({ value: "api-key" });
    expect(admitAccount({ account: null, requiresOpenaiAuth: true }, false)).toEqual({
      refusal: "codex_login_required",
    });
    expect(admitAccount({ ...account, requiresOpenaiAuth: false }, false)).toEqual({
      refusal: "codex_unsupported_auth",
    });
    expect(admitAccount({ account: { type: "other" }, requiresOpenaiAuth: true }, true)).toEqual({
      refusal: "codex_unsupported_auth",
    });
  });

  it("disables every inherited MCP server and refuses names it could not target", () => {
    const withServers = { config: { mcp_servers: { docs: {}, "local-2": {} } } };
    expect(threadConfigFor(withServers, { model: "m" })).toEqual({
      value: {
        model: "m",
        "mcp_servers.docs.enabled": false,
        "mcp_servers.local-2.enabled": false,
      },
    });
    expect(threadConfigFor({ config: {} }, { a: 1 })).toEqual({ value: { a: 1 } });
    expect(threadConfigFor({ config: { mcp_servers: { "has.dot": {} } } }, {})).toEqual({
      refusal: "codex_unsafe_configuration",
    });
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`s${index}`, {}]));
    expect(threadConfigFor({ config: { mcp_servers: many } }, {})).toEqual({
      refusal: "codex_unsafe_configuration",
    });
    // The overrides object is copied, never mutated.
    const overrides = { a: 1 };
    threadConfigFor(withServers, overrides);
    expect(overrides).toEqual({ a: 1 });
  });

  it("starts a read-only ephemeral thread with the participant's one tool, or none", () => {
    const tool = { name: "humanish_ui", description: "d", inputSchema: { type: "object" } };
    const params = threadStartParams({
      cwd,
      model: "m",
      participant: { tool },
      request: { instructions: "i" },
      config: { c: 1 },
    });
    expect(params).toMatchObject({
      cwd,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      model: "m",
      allowProviderModelFallback: false,
      environments: [],
      runtimeWorkspaceRoots: [],
      dynamicTools: [{ type: "function", ...tool }],
      baseInstructions: "i",
      config: { c: 1 },
    });
    expect(
      threadStartParams({
        cwd,
        model: undefined,
        participant: undefined,
        request: { instructions: "i" },
        config: {},
      }).dynamicTools,
    ).toEqual([]);
  });

  it("admits the captured thread with its model and id, and refuses a model it did not select", () => {
    expect(admitThread(thread, threadExpected)).toEqual({
      value: { model: "gpt-6-astra", threadId: "thread-synthetic" },
    });
    expect(admitThread(thread, { ...threadExpected, selectedModel: undefined })).toEqual({
      value: { model: "gpt-6-astra", threadId: "thread-synthetic" },
    });
    const refused = { refusal: "codex_unsafe_configuration" };
    expect(admitThread(thread, { ...threadExpected, selectedModel: "other" })).toEqual(refused);
    expect(admitThread(thread, { ...threadExpected, cwd: "/other" })).toEqual(refused);
    const noModel = { ...thread, thread: { ...(thread.thread as object), model: "" } };
    expect(admitThread(noModel, threadExpected)).toEqual(refused);
  });

  it("admits an empty MCP status page and refuses a running server or another page", () => {
    expect(admitMcpStatus(mcp)).toEqual({ value: undefined });
    expect(admitMcpStatus({ data: [{}], nextCursor: null })).toEqual({
      refusal: "codex_unsafe_configuration",
    });
    expect(admitMcpStatus({ data: [], nextCursor: "next" })).toEqual({
      refusal: "codex_unsafe_configuration",
    });
    expect(admitMcpStatus({ nextCursor: null })).toEqual({ refusal: "codex_unsafe_configuration" });
  });

  it("passes an operator-auth launch's overrides as -c arguments", () => {
    expect(configArguments({ model: "m", "features.x": false })).toEqual([
      "-c",
      'model="m"',
      "-c",
      "features.x=false",
    ]);
  });
});
