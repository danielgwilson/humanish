import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CuaObservation } from "../src/computer-use.js";
import {
  checkHostedCodexCompatibility,
  createLocalAgentProvider,
  detectLocalAgents,
  localAgentDoctorMessage,
  localAgentTurnSchema,
  parseAgentJson,
  toCuaActions,
  type SpawnLike
} from "../src/local-agent-cli.js";

const FRAME = Buffer.from("89504e470d0a1a0a", "hex"); // enough to be a file; the fake never reads it

function observation(): CuaObservation {
  return { screenshot: FRAME, stateSignature: "s1" };
}

/** A CLI that answers with whatever text the test hands it. Nothing is spawned, nothing is spent. */
function fakeCli(reply: string, code = 0): SpawnLike {
  return async (_bin, args, _options) => {
    // Codex writes its answer to --output-last-message; the provider reads that file back.
    const outIndex = args.indexOf("--output-last-message");
    if (outIndex >= 0) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(args[outIndex + 1]!, reply, "utf8");
      return { code, stdout: "", stderr: "" };
    }
    return { code, stdout: reply, stderr: "" };
  };
}

describe("the action vocabulary a local agent answers in", () => {
  it("maps the kinds it is allowed to use", () => {
    expect(toCuaActions([{ kind: "click", x: 10.4, y: 20.6 }])).toEqual([{ kind: "click", x: 10, y: 21 }]);
    expect(toCuaActions([{ kind: "type", text: "hello" }])).toEqual([{ kind: "type", text: "hello" }]);
    expect(toCuaActions([{ kind: "keypress", keys: ["Control", "a"] }])).toEqual([
      { kind: "keypress", keys: ["Control", "a"] }
    ]);
  });

  it("DROPS an action it cannot honour rather than inventing the missing half", () => {
    // A click with no coordinates is not a click at (0,0). Filling that in would record a
    // coordinate the participant never chose, in evidence someone is meant to trust.
    expect(toCuaActions([{ kind: "click" }])).toEqual([]);
    expect(toCuaActions([{ kind: "type", text: "" }])).toEqual([]);
    expect(toCuaActions([{ kind: "keypress", keys: [] }])).toEqual([]);
    expect(toCuaActions([{ kind: "teleport", x: 1, y: 2 }])).toEqual([]);
  });

  it("keeps the schema strict-mode legal", () => {
    // OpenAI structured outputs reject a schema whose `required` omits any property — measured as
    // a 400 before any thinking happened, which is how this rule was learned.
    const schema = localAgentTurnSchema() as Record<string, any>;
    const walk = (node: Record<string, any>): void => {
      if (node?.type === "object") {
        expect(Object.keys(node.properties ?? {}).sort()).toEqual([...(node.required ?? [])].sort());
        for (const child of Object.values(node.properties ?? {})) walk(child as Record<string, any>);
      }
      if (node?.type === "array" && node.items) walk(node.items as Record<string, any>);
    };
    walk(schema);
  });
});

describe("reading the agent's answer", () => {
  it("accepts clean JSON and JSON wrapped in a fence", () => {
    // Codex returns the first; Claude Code returns the second. One parser, because a surface where
    // one adapter works and the other silently does not is worse than either.
    expect(parseAgentJson('{"done":true}')).toEqual({ done: true });
    expect(parseAgentJson('here you go\n```json\n{"done":false}\n```\n')).toEqual({ done: false });
  });

  it("treats an answer with no JSON as a turn ERROR, never as an empty turn", () => {
    // An empty turn reads to the loop as "the participant chose to do nothing", which is a
    // finding. A CLI that returned prose is a broken turn, which is not.
    expect(() => parseAgentJson("I could not see the screenshot.")).toThrow(/did not return a JSON object/);
  });
});

describe("the provider", () => {
  it("turns a codex answer into a CuaTurn", async () => {
    const provider = createLocalAgentProvider({
      agent: "codex",
      spawnFn: fakeCli('{"reasoning":"menu top-left","done":false,"message":null,"actions":[{"kind":"click","x":52,"y":12,"text":null,"keys":null,"ms":null}]}')
    });
    const turn = await provider.nextTurn({ instructions: "be a new user", observation: observation() }, new AbortController().signal);
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
      spawnFn: fakeCli(JSON.stringify({
        result: '```json\n{"reasoning":"done here","done":true,"message":"I finished","actions":[]}\n```'
      }))
    });
    const turn = await provider.nextTurn({ instructions: "be a new user", observation: observation() }, new AbortController().signal);
    expect(turn.done).toBe(true);
    expect(turn.message).toBe("I finished");
    expect(turn.actions).toEqual([]);
  });

  it("declares that it needs a frame, and refuses a turn without one", async () => {
    const provider = createLocalAgentProvider({ agent: "codex", spawnFn: fakeCli("{}") });
    expect(provider.requiresFrame).toBe(true);
    await expect(provider.nextTurn({ instructions: "x", observation: { stateSignature: "s" } }, new AbortController().signal))
      .rejects.toThrow(/needs a screenshot/);
  });

  it("surfaces the CLI's own words when it exits non-zero", async () => {
    // A rate-limited plan says so here. "turn failed" would throw away the one sentence the
    // operator can act on.
    const provider = createLocalAgentProvider({
      agent: "codex",
      spawnFn: async () => ({ code: 1, stdout: "", stderr: "rate limit reached for your plan" })
    });
    await expect(provider.nextTurn({ instructions: "x", observation: observation() }, new AbortController().signal))
      .rejects.toThrow(/rate limit reached/);
  });

  it("records the effort it ran at, and defaults it LOW", async () => {
    // Codex defaults to high, which timed out at 240s on a single action; low answered the same
    // screenshot correctly in 9s, and a run is sixty of these.
    const provider = createLocalAgentProvider({ agent: "codex", spawnFn: fakeCli("{}") });
    expect(provider.modelSettings?.reasoningEffort).toBe("low");
  });


  it("kills the CLI when the run is stopped mid-turn", async () => {
    // Stop shipped in 0.54.0 and a local agent can hold a terminal for minutes. A stop that
    // leaves it thinking is not a stop.
    const controller = new AbortController();
    let sawSignal: AbortSignal | undefined;
    const provider = createLocalAgentProvider({
      agent: "codex",
      spawnFn: async (_bin, _args, options) => {
        sawSignal = options.signal;
        return { code: 0, stdout: '{"done":true,"actions":[],"reasoning":"x","message":null}', stderr: "" };
      }
    });
    // The fake never writes codex's answer file, so the turn throws after the spawn — irrelevant
    // here: what is under test is that the run's abort signal reaches the child process.
    await provider.nextTurn({ instructions: "x", observation: observation() }, controller.signal)
      .catch(() => undefined);
    expect(sawSignal).toBe(controller.signal);
  });

  it("restricts the agent's own tools — it is here to look at a picture", async () => {
    const seen: string[][] = [];
    const spy: SpawnLike = async (_bin, args, _o) => {
      seen.push([...args]);
      return { code: 0, stdout: '{"done":true,"actions":[],"reasoning":"x","message":null}', stderr: "" };
    };
    const codex = createLocalAgentProvider({ agent: "codex", spawnFn: spy });
    await codex.nextTurn({ instructions: "x", observation: observation() }, new AbortController().signal).catch(() => undefined);
    expect(seen[0]).toContain("--sandbox");
    expect(seen[0]).toContain("read-only");

    seen.length = 0;
    const claude = createLocalAgentProvider({ agent: "claude", spawnFn: spy });
    await claude.nextTurn({ instructions: "x", observation: observation() }, new AbortController().signal).catch(() => undefined);
    expect(seen[0]).toContain("--allowedTools");
    expect(seen[0]).toContain("Read");
    // The prompt comes AFTER a `--`: --allowedTools takes a list, and a prompt placed right after
    // it was read as a tool name (Claude Code 2.1.257 exited 1, "Input must be provided", on three
    // of three live runs, 2026-09-01).
    const args = seen[0]!;
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toContain("x");
    expect(args.indexOf("--allowedTools") + 1).toBe(args.indexOf("Read"));
  });
});

describe("telling the operator what they already have", () => {
  const detect = (present: string[], creds: string[]) =>
    detectLocalAgents({
      home: "/home/dev",
      env: {},
      which: async (bin) => (present.includes(bin) ? `/usr/bin/${bin}` : undefined),
      exists: async (file) => creds.some((c) => file.endsWith(c)),
      authProbe: async (bin) => bin.endsWith("codex")
        ? { code: creds.length ? 0 : 1, stdout: "", stderr: creds.length ? "Logged in using ChatGPT" : "Not logged in" }
        : { code: creds.length ? 0 : 1, stdout: JSON.stringify({ loggedIn: creds.length > 0 }), stderr: "" }
    });

  it("finds an installed, signed-in agent and says a run can use it", async () => {
    const found = await detect(["codex"], [".codex/auth.json"]);
    expect(found.map((a) => a.id)).toEqual(["codex"]);
    expect(localAgentDoctorMessage(found)).toContain("instead of a provider API key");
  });

  it("distinguishes installed-but-signed-out from absent", async () => {
    const signedOut = await detect(["claude"], []);
    expect(localAgentDoctorMessage(signedOut)).toContain("not signed in");
    const none = await detect([], []);
    expect(localAgentDoctorMessage(none)).toContain("needs OPENAI_API_KEY");
  });

  it("does not expose credentials or status output", async () => {
    const found = await detect(["codex"], [".codex/auth.json"]);
    expect(found[0]?.credentialsPresent).toBe(true);
    expect(Object.keys(found[0] ?? {})).not.toContain("token");
  });

  it("accepts a CLI-reported keyring login without a credential file", async () => {
    const found = await detectLocalAgents({ home: "/home/dev", env: {}, which: async bin => bin === "codex" ? "/usr/bin/codex" : undefined,
      exists: async () => false, authProbe: async () => ({ code: 0, stdout: "", stderr: "Logged in using ChatGPT\nprivate-account-marker" }) });
    expect(found[0]).toMatchObject({ credentialsPresent: false, authStatus: "authenticated", billing: "account-unknown" });
    expect(JSON.stringify(found)).not.toContain("private-account-marker");
  });

  it("does not infer authentication from a stale file or a failed status check", async () => {
    for (const [result, expected] of [
      [{ code: 1, stdout: "", stderr: "Not logged in" }, "unauthenticated"],
      [{ code: 1, stdout: "", stderr: "unreadable configuration private-account-marker" }, "unknown"],
      [{ code: null, stdout: "", stderr: "" }, "unknown"],
      [{ code: 0, stdout: "unsupported-format private-account-marker", stderr: "" }, "unknown"]
    ] as const) {
      const found = await detectLocalAgents({ home: "/home/dev", env: {}, which: async bin => bin === "codex" ? "/usr/bin/codex" : undefined,
        exists: async () => true, authProbe: async () => result });
      expect(found[0]).toMatchObject({ credentialsPresent: true, authStatus: expected });
      expect(JSON.stringify(found) + localAgentDoctorMessage(found)).not.toContain("private-account-marker");
    }
  });

  it("honors CODEX_HOME while keeping status output private", async () => {
    const checked: string[] = [];
    const env = { CODEX_HOME: "/custom/codex" };
    const found = await detectLocalAgents({ home: "/home/dev", env, which: async bin => bin === "codex" ? "/usr/bin/codex" : undefined,
      exists: async file => { checked.push(file); return true; }, authProbe: async (_bin, args, actualEnv) => {
        expect(args).toEqual(["login", "status"]); expect(actualEnv).toBe(env);
        return { code: 0, stdout: "", stderr: "Logged in using an API key - private-account-marker" };
      } });
    expect(checked).toEqual(["/custom/codex/auth.json"]);
    expect(found[0]).toMatchObject({ authStatus: "authenticated", billing: "api" });
    expect(JSON.stringify(found)).not.toContain("private-account-marker");
  });

  it("keeps an unreadable credential hint separate from CLI-reported authentication", async () => {
    const found = await detectLocalAgents({ env: {}, which: async bin => bin === "claude" ? "/synthetic/claude" : undefined,
      exists: async () => { throw new Error("unreadable"); }, authProbe: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" }) });
    expect(found[0]).toMatchObject({ credentialsPresent: false, authStatus: "authenticated" });
  });

  it("bounds real subprocess status checks and drops excessive output", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "humanish-login-probe-"));
    const binary = path.join(directory, "codex");
    try {
      for (const body of [
        `if (process.argv.slice(2).join(' ') !== 'login status') process.exit(99); process.stderr.write('Logged in using ChatGPT\\nprivate-account-marker');`,
        `process.stdout.write('private-account-marker'.repeat(10000));`,
        `setInterval(() => {}, 1000);`
      ]) {
        await writeFile(binary, `#!${process.execPath}\n${body}\n`);
        await chmod(binary, 0o700);
        const before = Date.now();
        const found = await detectLocalAgents({ env: { PATH: directory }, exists: async () => false });
        expect(found[0]?.authStatus).toBe(body.includes("Logged in") ? "authenticated" : "unknown");
        expect(Date.now() - before).toBeLessThan(6500);
        expect(JSON.stringify(found)).not.toContain("private-account-marker");
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 10000);

  it("checks the qualified hosted Codex version without initializing app-server", async () => {
    const calls: string[][] = [];
    const probe = async (_bin: string, args: readonly string[]) => {
      calls.push([...args]);
      return { code: 0, stdout: "codex-cli 0.154.0\n", stderr: "" };
    };
    await expect(checkHostedCodexCompatibility("/synthetic/codex", { platform: "linux", arch: "arm64", probe })).resolves.toBe("supported");
    expect(calls).toEqual([["--version"]]);
    await expect(checkHostedCodexCompatibility("/synthetic/codex", { platform: "darwin", arch: "x64",
      probe: async () => ({ code: 0, stdout: "codex-cli 0.153.0\n", stderr: "" }) })).resolves.toBe("unsupported_version");
    await expect(checkHostedCodexCompatibility("/synthetic/codex", { platform: "win32", arch: "x64",
      probe: async () => { throw new Error("must not spawn"); } })).resolves.toBe("unsupported_platform");
  });
});
