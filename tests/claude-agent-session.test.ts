import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  claudeSessionToActorTrace,
  runClaudeAgentSession,
  type ClaudeQueryFn
} from "../src/claude-agent-sdk.js";
import { getActor } from "../src/actor-registry.js";
import { type ActorPersonaRef } from "../src/actor-contract.js";
import { buildClaudeSession } from "./actor-fixtures.js";

const persona: ActorPersonaRef = {
  id: "synthetic-new-user",
  traitsApplied: ["patience:low", "skill:high"],
  promptDigest: "shimproof01"
};

function fakeQuery(messages: unknown[], capture?: (options: Record<string, unknown>) => void): ClaudeQueryFn {
  return ({ options }) => {
    capture?.(options);
    return (async function* () {
      for (const message of messages) {
        yield message;
      }
    })();
  };
}

async function withRunRoot<T>(body: (runRoot: string) => Promise<T>): Promise<T> {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-claude-shim-"));
  try {
    return await body(runRoot);
  } finally {
    await rm(runRoot, { force: true, recursive: true });
  }
}

describe("runClaudeAgentSession (DI seam)", () => {
  it("collects the injected stream and routes it through the pure mapper", async () => {
    await withRunRoot(async (runRoot) => {
      const messages = buildClaudeSession().messages;
      const result = await runClaudeAgentSession({
        cwd: runRoot,
        runRoot,
        prompt: "inspect the project",
        persona,
        timeoutMs: 5000,
        queryFn: fakeQuery(messages)
      });
      expect(result.trace.schema).toBe("humanish.actor-trace.v1");
      expect(result.trace.provider).toBe("claude-agent-sdk");
      expect(result.status).toBe("passed");
      expect(result.trace.persona).toEqual(persona);
      // The shim must delegate mapping to the pure function: items match exactly.
      const expected = claudeSessionToActorTrace(
        { messages, startedAt: result.session.startedAt, completedAt: result.session.completedAt },
        persona
      );
      expect(result.trace.items).toEqual(expected.items);
      expect(result.trace.ids.model).toBe("synthetic-model");
    });
  });

  it("writes the three evidence artifacts", async () => {
    await withRunRoot(async (runRoot) => {
      const messages = buildClaudeSession().messages;
      const result = await runClaudeAgentSession({
        cwd: runRoot,
        runRoot,
        prompt: "go",
        persona,
        timeoutMs: 5000,
        queryFn: fakeQuery(messages)
      });
      const summary = JSON.parse(await readFile(path.join(runRoot, result.tracePath), "utf8"));
      expect(summary.schema).toBe("humanish.actor-trace.v1");
      expect(summary.provider).toBe("claude-agent-sdk");

      const events = (await readFile(path.join(runRoot, result.eventsPath), "utf8")).trim().split("\n");
      expect(events).toHaveLength(messages.length);
      for (const line of events) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      const transcript = await readFile(path.join(runRoot, result.transcriptPath), "utf8");
      expect(transcript).toContain("Inspecting the project setup");
    });
  });

  it("rejects generated-path aliases before query execution", async () => {
    await withRunRoot(async (runRoot) => {
      const outside = path.join(runRoot, "outside");
      const selected = path.join(runRoot, "selected");
      await mkdir(outside);
      await mkdir(selected);
      await writeFile(path.join(outside, "sentinel.txt"), "unchanged\n", "utf8");
      await symlink(outside, path.join(selected, "claude-agent-sdk"), "dir");
      let queryCalls = 0;
      await expect(runClaudeAgentSession({
        cwd: runRoot,
        runRoot: selected,
        prompt: "go",
        persona,
        timeoutMs: 5000,
        queryFn: fakeQuery(buildClaudeSession().messages, () => { queryCalls += 1; })
      })).rejects.toThrow(/symbolic links/i);
      expect(queryCalls).toBe(0);
      expect(await readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe("unchanged\n");
    });
  });

  it("retains the selected-root identity across the query window", async () => {
    await withRunRoot(async (runRoot) => {
      const first = path.join(runRoot, "first");
      const second = path.join(runRoot, "second");
      const alias = path.join(runRoot, "selected-alias");
      await mkdir(first);
      await mkdir(second);
      await writeFile(path.join(second, "sentinel.txt"), "unchanged\n", "utf8");
      await symlink(first, alias, "dir");
      const queryFn: ClaudeQueryFn = () => (async function* () {
        yield { type: "system", subtype: "init", session_id: "s", model: "m" };
        await rm(alias);
        await symlink(second, alias, "dir");
        yield { type: "result", subtype: "success", duration_ms: 1, session_id: "s", result: "done" };
      })();

      await expect(runClaudeAgentSession({
        cwd: runRoot,
        runRoot: alias,
        prompt: "go",
        persona,
        timeoutMs: 5000,
        queryFn
      })).rejects.toThrow(/changed physical destination/i);
      expect(await readFile(path.join(second, "sentinel.txt"), "utf8")).toBe("unchanged\n");
      await expect(access(path.join(second, "claude-agent-sdk", "summary.json"))).rejects.toThrow();
    });
  });

  it("binds the persona into a minimal system prompt and disables tools/settings", async () => {
    await withRunRoot(async (runRoot) => {
      let captured: Record<string, unknown> | undefined;
      await runClaudeAgentSession({
        cwd: runRoot,
        runRoot,
        prompt: "go",
        persona,
        timeoutMs: 5000,
        queryFn: fakeQuery(buildClaudeSession().messages, (options) => {
          captured = options;
        })
      });
      expect(typeof captured?.systemPrompt).toBe("string");
      expect(captured?.systemPrompt as string).toContain(persona.id);
      for (const trait of persona.traitsApplied) {
        expect(captured?.systemPrompt as string).toContain(trait);
      }
      expect(captured?.settingSources).toEqual([]);
      expect(captured?.allowedTools).toEqual([]);
      expect(captured?.maxTurns).toBeDefined();
    });
  });

  it("honors a caller-supplied system prompt verbatim", async () => {
    await withRunRoot(async (runRoot) => {
      let captured: Record<string, unknown> | undefined;
      await runClaudeAgentSession({
        cwd: runRoot,
        runRoot,
        prompt: "go",
        persona,
        timeoutMs: 5000,
        systemPrompt: "CUSTOM_PERSONA_PREAMBLE",
        queryFn: fakeQuery(buildClaudeSession().messages, (options) => {
          captured = options;
        })
      });
      expect(captured?.systemPrompt).toBe("CUSTOM_PERSONA_PREAMBLE");
    });
  });

  it("redacts a leaky local path in every artifact", async () => {
    await withRunRoot(async (runRoot) => {
      const leaky = ["", "Users", "synthetic", "secret"].join("/");
      const messages = [
        { type: "system", subtype: "init", session_id: "s", model: "m" },
        { type: "assistant", message: { content: [{ type: "text", text: `saw ${leaky}` }] } },
        { type: "result", subtype: "success", duration_ms: 1, session_id: "s", result: `done at ${leaky}` }
      ];
      const result = await runClaudeAgentSession({
        cwd: runRoot,
        runRoot,
        prompt: "go",
        persona,
        timeoutMs: 5000,
        queryFn: fakeQuery(messages)
      });
      for (const rel of [result.eventsPath, result.tracePath, result.transcriptPath]) {
        const text = await readFile(path.join(runRoot, rel), "utf8");
        expect(text).not.toContain(leaky);
      }
      const summary = await readFile(path.join(runRoot, result.tracePath), "utf8");
      expect(summary).toContain("[REDACTED_LOCAL_PATH]");
    });
  });

  it("times out a hung query, ends timed_out, and still writes artifacts", async () => {
    await withRunRoot(async (runRoot) => {
      const hanging: ClaudeQueryFn = () =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "s", model: "m" };
          await new Promise(() => {});
        })();
      const result = await runClaudeAgentSession({
        cwd: runRoot,
        runRoot,
        prompt: "go",
        persona,
        timeoutMs: 100,
        queryFn: hanging
      });
      expect(result.status).toBe("timed_out");
      expect(result.trace.completionReason).toBe("timed_out");
      const summary = JSON.parse(await readFile(path.join(runRoot, result.tracePath), "utf8"));
      expect(summary.status).toBe("timed_out");
    });
  });

  it("synthesizes a failed terminal when the stream completes without a result message", async () => {
    await withRunRoot(async (runRoot) => {
      const messages = [
        { type: "system", subtype: "init", session_id: "s", model: "m" },
        { type: "assistant", message: { content: [{ type: "text", text: "did some work" }] } }
      ];
      const result = await runClaudeAgentSession({
        cwd: runRoot,
        runRoot,
        prompt: "go",
        persona,
        timeoutMs: 5000,
        queryFn: fakeQuery(messages)
      });
      expect(result.status).toBe("failed");
      expect(result.trace.completionReason).toBe("actor_error");
      const summary = JSON.parse(await readFile(path.join(runRoot, result.tracePath), "utf8"));
      expect(summary.status).toBe("failed");
    });
  });

  it("writes a failed bundle (does not throw) when the optional SDK fails to load", async () => {
    await withRunRoot(async (runRoot) => {
      const result = await runClaudeAgentSession({
        cwd: runRoot,
        runRoot,
        prompt: "go",
        persona,
        timeoutMs: 5000,
        loadQueryFn: async () => {
          throw new Error("Live Claude Agent SDK runs require the optional peer dependency @anthropic-ai/claude-agent-sdk.");
        }
      });
      expect(result.status).toBe("failed");
      const summary = JSON.parse(await readFile(path.join(runRoot, result.tracePath), "utf8"));
      expect(summary.status).toBe("failed");
      // All three artifacts still exist (readFile throws if missing).
      for (const rel of [result.eventsPath, result.tracePath, result.transcriptPath]) {
        await readFile(path.join(runRoot, rel), "utf8");
      }
    });
  });
});

describe("actorRegistry claude live shim", () => {
  it("exposes runSession on the claude descriptor", () => {
    const claude = getActor("claude-agent-sdk");
    expect(typeof claude.runSession).toBe("function");
    expect(typeof claude.toActorTrace).toBe("function");
  });
});
