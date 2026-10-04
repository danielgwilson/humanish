import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CuaObservation } from "../../../src/actors/computer-use/loop.js";
import {
  checkHostedCodexCompatibility,
  createLocalAgentProvider,
  detectLocalAgents,
  localAgentDoctorMessage,
  parseAgentJson,
  toCuaActions,
  type SpawnLike,
} from "../../../src/actors/local-agent/cli.js";

const FRAME = Buffer.from("89504e470d0a1a0a", "hex"); // enough to be a file; the fake never reads it

function observation(): CuaObservation {
  return { screenshot: FRAME, stateSignature: "s1" };
}

/** A CLI that answers with whatever text the test hands it. Nothing is spawned, nothing is spent. */
function fakeCli(reply: string, code = 0): SpawnLike {
  return async () => ({ code, stdout: reply, stderr: "" });
}

/** The init a restricted Claude Code writes (tests/fixtures/claude-code-stream-json). */
const RESTRICTED_INIT = {
  type: "system",
  subtype: "init",
  tools: ["Read"],
  mcp_servers: [],
  permissionMode: "dontAsk",
};

/** A one-shot stream-json stdout: the restricted init, any extra messages, then a result. */
function claudeStream(resultText: string, extra: object[] = []): string {
  return [
    RESTRICTED_INIT,
    ...extra,
    { type: "result", subtype: "success", is_error: false, result: resultText },
  ]
    .map((message) => JSON.stringify(message))
    .join("\n");
}

describe("the action vocabulary a local agent answers in", () => {
  it("maps the kinds it is allowed to use", () => {
    expect(toCuaActions([{ kind: "click", x: 10.4, y: 20.6 }])).toEqual([
      { kind: "click", x: 10, y: 21 },
    ]);
    expect(toCuaActions([{ kind: "type", text: "hello" }])).toEqual([
      { kind: "type", text: "hello" },
    ]);
    expect(toCuaActions([{ kind: "keypress", keys: ["Control", "a"] }])).toEqual([
      { kind: "keypress", keys: ["Control", "a"] },
    ]);
  });

  it("drops an action it cannot honour rather than inventing the missing half", () => {
    // A click with no coordinates is not a click at (0,0). Filling that in would record a
    // coordinate the participant never chose, in evidence someone is meant to trust.
    expect(toCuaActions([{ kind: "click" }])).toEqual([]);
    expect(toCuaActions([{ kind: "type", text: "" }])).toEqual([]);
    expect(toCuaActions([{ kind: "keypress", keys: [] }])).toEqual([]);
    expect(toCuaActions([{ kind: "teleport", x: 1, y: 2 }])).toEqual([]);
  });
});

describe("reading the agent's answer", () => {
  it("accepts clean JSON and JSON wrapped in a fence", () => {
    // Codex returns the first; Claude Code returns the second. One parser, because a surface where
    // one adapter works and the other silently does not is worse than either.
    expect(parseAgentJson('{"done":true}')).toEqual({ done: true });
    expect(parseAgentJson('here you go\n```json\n{"done":false}\n```\n')).toEqual({ done: false });
  });

  it("treats an answer with no JSON as a turn error, never as an empty turn", () => {
    // An empty turn reads to the loop as "the participant chose to do nothing", which is a
    // finding. A CLI that returned prose is a broken turn, which is not.
    expect(() => parseAgentJson("I could not see the screenshot.")).toThrow(
      /did not return a JSON object/,
    );
  });
});

describe("the provider", () => {
  it("turns a Claude Code answer into a CuaTurn", async () => {
    const provider = createLocalAgentProvider({
      agent: "claude",
      spawnFn: fakeCli(
        claudeStream(
          '{"reasoning":"menu top-left","done":false,"message":null,"actions":[{"kind":"click","x":52,"y":12,"text":null,"keys":null,"ms":null}]}',
        ),
      ),
    });
    const turn = await provider.nextTurn(
      { instructions: "be a new user", observation: observation() },
      new AbortController().signal,
    );
    expect(turn.actions).toEqual([{ kind: "click", x: 52, y: 12 }]);
    expect(turn.done).toBe(false);
    expect(turn.reasoning).toContain("menu");
    // No token usage is claimed: a subscription CLI reports nothing we could price, and a number
    // invented here is what would make the run's cost line a lie.
    expect(turn.usage).toBeUndefined();
  });

  it("unwraps Claude Code's envelope and its code fence", async () => {
    const provider = createLocalAgentProvider({
      agent: "claude",
      spawnFn: fakeCli(
        claudeStream(
          '```json\n{"reasoning":"done here","done":true,"message":"I finished","actions":[]}\n```',
        ),
      ),
    });
    const turn = await provider.nextTurn(
      { instructions: "be a new user", observation: observation() },
      new AbortController().signal,
    );
    expect(turn.done).toBe(true);
    expect(turn.message).toBe("I finished");
    expect(turn.actions).toEqual([]);
  });

  it("declares that it needs a frame, and refuses a turn without one", async () => {
    const provider = createLocalAgentProvider({ agent: "claude", spawnFn: fakeCli("{}") });
    expect(provider.requiresFrame).toBe(true);
    await expect(
      provider.nextTurn(
        { instructions: "x", observation: { stateSignature: "s" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/needs a screenshot/);
  });

  it("surfaces the CLI's own words when it exits non-zero", async () => {
    // A rate-limited plan says so here. "turn failed" would throw away the one sentence the
    // operator can act on.
    const provider = createLocalAgentProvider({
      agent: "claude",
      spawnFn: async () => ({ code: 1, stdout: "", stderr: "rate limit reached for your plan" }),
    });
    await expect(
      provider.nextTurn(
        { instructions: "x", observation: observation() },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/rate limit reached/);
  });

  it("records the effort it ran at, and defaults it low", async () => {
    // A run is sixty turns, and a high-effort answer per turn costs minutes.
    const provider = createLocalAgentProvider({ agent: "claude", spawnFn: fakeCli("{}") });
    expect(provider.modelSettings?.reasoningEffort).toBe("low");
  });

  it("kills the CLI when the run is stopped mid-turn", async () => {
    // Stop shipped in 0.54.0 and a local agent can hold a terminal for minutes. A stop that
    // leaves it thinking is not a stop.
    const controller = new AbortController();
    let sawSignal: AbortSignal | undefined;
    const provider = createLocalAgentProvider({
      agent: "claude",
      spawnFn: async (_bin, _args, options) => {
        sawSignal = options.signal;
        return {
          code: 0,
          stdout: '{"done":true,"actions":[],"reasoning":"x","message":null}',
          stderr: "",
        };
      },
    });
    // What is under test is that the run's abort signal reaches the child process.
    await provider
      .nextTurn({ instructions: "x", observation: observation() }, controller.signal)
      .catch(() => undefined);
    expect(sawSignal).toBe(controller.signal);
  });
});

describe("the one-shot Claude Code participant's limits", () => {
  it("runs Claude Code restricted to Read, with a minimal environment and the prompt after --", async () => {
    const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const spy: SpawnLike = async (_bin, args, options) => {
      seen.push({ args: [...args], env: options.env });
      return { code: 0, stdout: claudeStream('{"done":true,"actions":[]}'), stderr: "" };
    };
    const claude = createLocalAgentProvider({
      agent: "claude",
      spawnFn: spy,
      env: {
        PATH: "/usr/bin",
        HOME: "/home/dev",
        OPENAI_API_KEY: "sk-synthetic",
        GH_TOKEN: "synthetic",
        SYNTHETIC_DOTENV_SECRET: "synthetic",
      },
    });
    await claude.nextTurn(
      { instructions: "x", observation: observation() },
      new AbortController().signal,
    );
    const { args, env } = seen[0]!;
    expect(args.slice(0, -1)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--restricted",
      "--tools",
      "Read",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--",
    ]);
    expect(args.at(-1)).toContain("x");
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
    });
  });

  it("fails the turn with the refusal code when the stream shows a forbidden tool call", async () => {
    const bash = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "true" } }] },
    };
    let stopped: boolean | undefined;
    const claude = createLocalAgentProvider({
      agent: "claude",
      spawnFn: async (_bin, _args, options) => {
        stopped = options.onLine?.(JSON.stringify(bash));
        return {
          code: null,
          stdout: claudeStream('{"done":true,"actions":[]}', [bash]),
          stderr: "",
        };
      },
    });
    await expect(
      claude.nextTurn(
        { instructions: "x", observation: observation() },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "HUMANISH_CLAUDE_PARTICIPANT_TOOL_REFUSED" });
    expect(stopped).toBe(true);
  });

  it("refuses an answer from a Claude Code that did not report a restricted start", async () => {
    const claude = createLocalAgentProvider({
      agent: "claude",
      spawnFn: fakeCli(JSON.stringify({ type: "result", subtype: "success", result: "{}" })),
    });
    await expect(
      claude.nextTurn(
        { instructions: "x", observation: observation() },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "HUMANISH_CLAUDE_PARTICIPANT_UNRESTRICTED" });
  });

  it("kills a real child process at its first forbidden line", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "humanish-claude-one-shot-"));
    try {
      const lines = [
        RESTRICTED_INIT,
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
        },
      ].map((message) => JSON.stringify(message));
      // It prints the forbidden call, then would wait 30 s before answering.
      await writeFile(
        path.join(directory, "claude"),
        `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(lines.join("\n") + "\n")});\nsetTimeout(() => {}, 30000);\n`,
      );
      await chmod(path.join(directory, "claude"), 0o700);
      const claude = createLocalAgentProvider({
        agent: "claude",
        env: { PATH: directory, HOME: directory },
        workRoot: directory,
      });
      const before = Date.now();
      await expect(
        claude.nextTurn(
          { instructions: "x", observation: observation() },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "HUMANISH_CLAUDE_PARTICIPANT_TOOL_REFUSED" });
      expect(Date.now() - before).toBeLessThan(10_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("telling the operator what they already have", () => {
  const detect = (present: string[], creds: string[]) =>
    detectLocalAgents({
      home: "/home/dev",
      env: {},
      which: async (bin) => (present.includes(bin) ? `/usr/bin/${bin}` : undefined),
      exists: async (file) => creds.some((c) => file.endsWith(c)),
      authProbe: async (bin) =>
        bin.endsWith("codex")
          ? {
              code: creds.length ? 0 : 1,
              stdout: "",
              stderr: creds.length ? "Logged in using ChatGPT" : "Not logged in",
            }
          : {
              code: creds.length ? 0 : 1,
              stdout: JSON.stringify({ loggedIn: creds.length > 0 }),
              stderr: "",
            },
    });

  it("finds an installed, signed-in agent and says a run can use it", async () => {
    const found = await detect(["codex"], [".codex/auth.json"]);
    expect(found.map((a) => a.id)).toEqual(["codex"]);
    expect(localAgentDoctorMessage(found[0]!)).toContain("instead of a provider API key");
  });

  it("distinguishes installed-but-signed-out from absent", async () => {
    const signedOut = await detect(["claude"], []);
    expect(localAgentDoctorMessage(signedOut[0]!)).toContain("not signed in");
    expect(await detect([], [])).toEqual([]);
  });

  it("does not expose credentials or status output", async () => {
    const found = await detect(["codex"], [".codex/auth.json"]);
    expect(found[0]?.credentialsPresent).toBe(true);
    expect(Object.keys(found[0] ?? {})).not.toContain("token");
  });

  it("accepts a CLI-reported keyring login without a credential file", async () => {
    const found = await detectLocalAgents({
      home: "/home/dev",
      env: {},
      which: async (bin) => (bin === "codex" ? "/usr/bin/codex" : undefined),
      exists: async () => false,
      authProbe: async () => ({
        code: 0,
        stdout: "",
        stderr: "Logged in using ChatGPT\nprivate-account-marker",
      }),
    });
    expect(found[0]).toMatchObject({
      credentialsPresent: false,
      authStatus: "authenticated",
      billing: "account-unknown",
    });
    expect(JSON.stringify(found)).not.toContain("private-account-marker");
  });

  it("does not infer authentication from a stale file or a failed status check", async () => {
    for (const [result, expected] of [
      [{ code: 1, stdout: "", stderr: "Not logged in" }, "unauthenticated"],
      [
        { code: 1, stdout: "", stderr: "unreadable configuration private-account-marker" },
        "unknown",
      ],
      [{ code: null, stdout: "", stderr: "" }, "unknown"],
      [{ code: 0, stdout: "unsupported-format private-account-marker", stderr: "" }, "unknown"],
    ] as const) {
      const found = await detectLocalAgents({
        home: "/home/dev",
        env: {},
        which: async (bin) => (bin === "codex" ? "/usr/bin/codex" : undefined),
        exists: async () => true,
        authProbe: async () => result,
      });
      expect(found[0]).toMatchObject({ credentialsPresent: true, authStatus: expected });
      expect(JSON.stringify(found) + found.map(localAgentDoctorMessage).join()).not.toContain(
        "private-account-marker",
      );
    }
  });

  it("honors CODEX_HOME while keeping status output private", async () => {
    const checked: string[] = [];
    const env = { CODEX_HOME: "/custom/codex" };
    const found = await detectLocalAgents({
      home: "/home/dev",
      env,
      which: async (bin) => (bin === "codex" ? "/usr/bin/codex" : undefined),
      exists: async (file) => {
        checked.push(file);
        return true;
      },
      authProbe: async (_bin, args, actualEnv) => {
        expect(args).toEqual(["login", "status"]);
        expect(actualEnv).toBe(env);
        return {
          code: 0,
          stdout: "",
          stderr: "Logged in using an API key - private-account-marker",
        };
      },
    });
    expect(checked).toEqual(["/custom/codex/auth.json"]);
    expect(found[0]).toMatchObject({ authStatus: "authenticated", billing: "api" });
    expect(JSON.stringify(found)).not.toContain("private-account-marker");
  });

  it("keeps an unreadable credential hint separate from CLI-reported authentication", async () => {
    const found = await detectLocalAgents({
      env: {},
      which: async (bin) => (bin === "claude" ? "/synthetic/claude" : undefined),
      exists: async () => {
        throw new Error("unreadable");
      },
      authProbe: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" }),
    });
    expect(found[0]).toMatchObject({ credentialsPresent: false, authStatus: "authenticated" });
  });

  it("bounds real subprocess status checks and drops excessive output", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "humanish-login-probe-"));
    const binary = path.join(directory, "codex");
    try {
      for (const body of [
        `if (process.argv.slice(2).join(' ') !== 'login status') process.exit(99); process.stderr.write('Logged in using ChatGPT\\nprivate-account-marker');`,
        `process.stdout.write('private-account-marker'.repeat(10000));`,
        `setInterval(() => {}, 1000);`,
      ]) {
        await writeFile(binary, `#!${process.execPath}\n${body}\n`);
        await chmod(binary, 0o700);
        const before = Date.now();
        const found = await detectLocalAgents({
          env: { PATH: directory },
          exists: async () => false,
        });
        expect(found[0]?.authStatus).toBe(body.includes("Logged in") ? "authenticated" : "unknown");
        expect(Date.now() - before).toBeLessThan(6500);
        expect(JSON.stringify(found)).not.toContain("private-account-marker");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 10000);

  it("checks the qualified hosted Codex version without initializing app-server", async () => {
    const calls: string[][] = [];
    const probe = async (_bin: string, args: readonly string[]) => {
      calls.push([...args]);
      return { code: 0, stdout: "codex-cli 0.157.1\n", stderr: "" };
    };
    await expect(
      checkHostedCodexCompatibility("/synthetic/codex", {
        platform: "linux",
        arch: "x64",
        probe,
      }),
    ).resolves.toBe("supported");
    expect(calls).toEqual([["--version"]]);
    const version = (stdout: string) => async () => ({ code: 0, stdout, stderr: "" });
    // Every host with a native build runs any stable release from 0.154.0 on.
    for (const [platform, arch, stdout, expected] of [
      ["linux", "x64", "codex-cli 0.154.0\n", "supported"],
      ["linux", "arm64", "codex-cli 0.157.1\n", "supported"],
      ["darwin", "arm64", "codex-cli 0.158.0\n", "supported"],
      ["darwin", "x64", "codex-cli 0.161.0\n", "supported"],
      ["linux", "x64", "codex-cli 0.150.0\n", "unsupported_version"],
      ["linux", "x64", "codex-cli 0.162.0-alpha.4\n", "unsupported_version"],
      ["linux", "x64", "codex-cli 0.157.1 extra\n", "unsupported_version"],
    ] as const)
      await expect(
        checkHostedCodexCompatibility("/synthetic/codex", {
          platform,
          arch,
          probe: version(stdout),
        }),
        `${platform}/${arch} ${stdout.trim()}`,
      ).resolves.toBe(expected);
    await expect(
      checkHostedCodexCompatibility("/synthetic/codex", {
        platform: "darwin",
        arch: "x64",
        probe: async () => ({ code: 0, stdout: "codex-cli 0.153.0\n", stderr: "" }),
      }),
    ).resolves.toBe("unsupported_version");
    await expect(
      checkHostedCodexCompatibility("/synthetic/codex", {
        platform: "win32",
        arch: "x64",
        probe: async () => {
          throw new Error("must not spawn");
        },
      }),
    ).resolves.toBe("unsupported_platform");
  });
});

describe("Claude Code's release and sign-in check", () => {
  it("asks Claude Code for its status and release with the participant's environment", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const detectClaude = (version: string) =>
      detectLocalAgents({
        home: "/home/dev",
        env: { PATH: "/usr/bin", HOME: "/home/dev", ANTHROPIC_API_KEY: "synthetic" },
        which: async (bin) => (bin === "claude" ? "/usr/bin/claude" : undefined),
        exists: async () => true,
        authProbe: async (_bin, args, env) => {
          calls.push({ args: [...args], env });
          return args[0] === "--version"
            ? { code: 0, stdout: `${version} (Claude Code)\n`, stderr: "" }
            : { code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
        },
      });
    const [current] = await detectClaude("2.1.289");
    expect(current).toMatchObject({ authStatus: "authenticated", version: "2.1.289" });
    expect(calls.map((call) => call.args)).toEqual([["auth", "status"], ["--version"]]);
    for (const call of calls) expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(localAgentDoctorMessage(current!)).toContain("instead of a provider API key");

    const [old] = await detectClaude("2.1.200");
    expect(localAgentDoctorMessage(old!)).toContain("2.1.248");
    expect(localAgentDoctorMessage(old!)).toContain("claude update");
  });
});
