import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCuaActorLab } from "../src/cua-actor-lab.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";
import { participantAssignment } from "../src/participant-assignment.js";
import { verifyRun, type RunBundle } from "../src/run.js";

describe("participant assignment evidence", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-assignment-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("projects participant fields only, scrubbing known values before secret/path patterns", () => {
    const authored = {
      mission: "Use opaque-session-value to open the settings.",
      focus: "Read /tmp/assignment.txt.",
      tasks: [{ id: "task-1", goal: "Open settings with opaque-session-value.", success: { any: [{ textIncludes: "hidden-check" }] } }],
      inboxUrl: "https://example.test/private-inbox"
    };
    expect(participantAssignment(authored, (text) => text.replaceAll("opaque-session-value", "[REDACTED_SECRET]"))).toEqual({
      mission: "Use [REDACTED_SECRET] to open the settings.",
      focus: "Read [REDACTED_LOCAL_PATH]",
      tasks: [{ id: "task-1", goal: "Open settings with [REDACTED_SECRET]." }]
    });
    expect(authored.mission).toContain("opaque-session-value");
  });

  it.each([1, 2])("persists exact declarative assignments and only task goals for %i CUA lanes", async (count) => {
    const secret = "synthetic-task-known-secret";
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "assignment-proof",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{
        type: "openai-computer-use",
        mission: `Use the settings screen with ${secret}.`,
        ...(count === 1 ? { laneFocus: { instruction: "Use the keyboard." } } : {
          lanes: [{ id: "keyboard", instruction: "Use the keyboard." }, { id: "pointer", instruction: "Use the pointer." }]
        }),
        tasks: [{ id: "save", goal: `Save a setting with ${secret}.`, success: { any: [{ textIncludes: "hidden-save-confirmation" }] } }]
      }],
      execution: { target: "e2b-desktop" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const result = await runCuaActorLab({ cwd, config: parsed.config, dryRun: true, hooks: { env: { OPENAI_API_KEY: secret } } });
    expect(result.ok).toBe(true);
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const expected = ["Use the keyboard.", "Use the pointer."].slice(0, count).map((focus) => ({
      mission: "Use the settings screen with [REDACTED_SECRET].", focus, tasks: [{ id: "save", goal: "Save a setting with [REDACTED_SECRET]." }]
    }));
    expect(bundle.streams.map((stream) => stream.assignment)).toEqual(expected);
    const observer = JSON.parse(await readFile(path.join(runDir, "observer", "observer-data.json"), "utf8")) as RunBundle;
    expect(observer.streams.map((stream) => stream.assignment)).toEqual(expected);
    expect(JSON.stringify(bundle)).not.toContain(secret);
    expect(JSON.stringify(observer)).not.toContain(secret);
    expect(JSON.stringify(bundle.streams.map((stream) => stream.assignment))).not.toContain("hidden-save-confirmation");
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);

    // Old bundles remain valid without inferring an assignment from their study or UI fields.
    delete bundle.streams[0]!.assignment;
    await writeFile(path.join(runDir, "run.json"), JSON.stringify(bundle));
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
    for (const malformed of [null, { mission: 3 }, { mission: "Test", tasks: [{ id: "save", goal: "Save", success: { textIncludes: "hidden" } }] }]) {
      Object.assign(bundle.streams[0]!, { assignment: malformed });
      await writeFile(path.join(runDir, "run.json"), JSON.stringify(bundle));
      const verified = await verifyRun(cwd, result.runId);
      expect(verified.ok).toBe(false);
      expect(verified.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
    }
  });

  it("redacts a second lane's known values and retains the runner's default mission", async () => {
    const secret = "synthetic-opaque-assignment-secret";
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "assignment-default",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", lanes: [
        { id: "first", instruction: "Use the keyboard." },
        { id: "second", instruction: `Use ${secret} from /tmp/private-assignment.` }
      ] }],
      execution: { target: "e2b-desktop" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const result = await runCuaActorLab({ cwd, config: parsed.config, dryRun: true, hooks: {
      env: { OPENAI_API_KEY: secret }
    } });
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.streams[1]?.assignment).toEqual({
      mission: "You are testing a web application. The browser is already open at the subject URL. Explore it, accomplish what the scenario asks, and stop when done.",
      focus: "Use [REDACTED_SECRET] from [REDACTED_LOCAL_PATH]"
    });
    expect(JSON.stringify(bundle)).not.toContain(secret);
    expect(parsed.config.actors[0]!.lanes![1]!.instruction).toContain(secret);
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
  });
});
