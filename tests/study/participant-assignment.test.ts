import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STUDY_SCHEMA } from "../../src/study/types.js";
import { parseStudy } from "../../src/study/config.js";
import { participantList } from "../../src/study/study-fields.js";
import { participantAssignment } from "../../src/study/participant-assignment.js";
import { verifyRun } from "../../src/verify/verify.js";
import { type RunBundle } from "../../src/run/bundle.js";
import { runComputerUse } from "../helpers/route-run.js";
import {
  DEFAULT_MISSION,
  DEFAULT_TYPING,
} from "../../src/routes/computer-use/participant-prompt.js";
import { runSharedWorld } from "../helpers/route-run.js";
import { baseSeams, concurrentConfig, makeRendezvous } from "../helpers/shared-world-fakes.js";
import { writePersonaFiles } from "../helpers/persona-files.js";

/** The personas this file's studies name, which need their files to run. */
const STUDY_PERSONAS = [
  "autonomous-creative-agent",
  "first-time-visitor",
  "persona-1",
  "persona-2",
  "persona-3",
] as const;

describe("participant assignment evidence", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-assignment-"));
    await writePersonaFiles(cwd, ...STUDY_PERSONAS);
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("projects participant fields only, scrubbing known values before secret/path patterns", () => {
    const authored = {
      mission: "Use opaque-session-value to open the settings.",
      focus: "Read /tmp/assignment.txt.",
      tasks: [
        {
          id: "task-1",
          goal: "Open settings with opaque-session-value.",
          success: { any: [{ textIncludes: "hidden-check" }] },
        },
      ],
      inboxUrl: "https://example.test/private-inbox",
    };
    expect(
      participantAssignment(authored, (text) =>
        text.replaceAll("opaque-session-value", "[REDACTED_SECRET]"),
      ),
    ).toEqual({
      mission: "Use [REDACTED_SECRET] to open the settings.",
      focus: "Read [REDACTED_LOCAL_PATH]",
      tasks: [{ id: "task-1", goal: "Open settings with [REDACTED_SECRET]." }],
    });
    expect(authored.mission).toContain("opaque-session-value");
  });

  it.each([1, 2])(
    "persists exact declarative assignments and only task goals for %i computer-use participants",
    async (count) => {
      const secret = "synthetic-task-known-secret";
      const parsed = parseStudy({
        schema: STUDY_SCHEMA,
        id: "assignment-proof",
        route: "computer-use",
        subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
        actor: {
          type: "openai-computer-use",
          mission: `Use the settings screen with ${secret}.`,
          tasks: [
            {
              id: "save",
              goal: `Save a setting with ${secret}.`,
              success: { any: [{ textIncludes: "hidden-save-confirmation" }] },
            },
          ],
        },
        participants:
          count === 1
            ? { instruction: "Use the keyboard." }
            : [
                { id: "keyboard", instruction: "Use the keyboard." },
                { id: "pointer", instruction: "Use the pointer." },
              ],
        execution: { target: "e2b-desktop" },
      });
      if (!parsed.ok) throw new Error(parsed.error.message);
      const result = await runComputerUse({
        cwd,
        config: parsed.config,
        dryRun: true,
        env: { OPENAI_API_KEY: secret },
      });
      expect(result.ok).toBe(true);
      const runDir = path.join(cwd, ".humanish", "runs", result.runId);
      const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
      const expected = ["Use the keyboard.", "Use the pointer."].slice(0, count).map((focus) => ({
        mission: "Use the settings screen with [REDACTED_SECRET].",
        typing: DEFAULT_TYPING,
        focus,
        tasks: [{ id: "save", goal: "Save a setting with [REDACTED_SECRET]." }],
      }));
      expect(bundle.streams.map((stream) => stream.assignment)).toEqual(expected);
      const observer = JSON.parse(
        await readFile(path.join(runDir, "observer", "observer-data.json"), "utf8"),
      ) as RunBundle;
      expect(observer.streams.map((stream) => stream.assignment)).toEqual(expected);
      expect(JSON.stringify(bundle)).not.toContain(secret);
      expect(JSON.stringify(observer)).not.toContain(secret);
      expect(JSON.stringify(bundle.streams.map((stream) => stream.assignment))).not.toContain(
        "hidden-save-confirmation",
      );
      expect((await verifyRun(cwd, result.runId)).ok).toBe(true);

      // Old bundles remain valid without inferring an assignment from their study or UI fields.
      delete bundle.streams[0]!.assignment;
      await writeFile(path.join(runDir, "run.json"), JSON.stringify(bundle));
      expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
      for (const malformed of [
        null,
        { mission: 3 },
        {
          mission: "Test",
          tasks: [{ id: "save", goal: "Save", success: { textIncludes: "hidden" } }],
        },
      ]) {
        Object.assign(bundle.streams[0]!, { assignment: malformed });
        await writeFile(path.join(runDir, "run.json"), JSON.stringify(bundle));
        const verified = await verifyRun(cwd, result.runId);
        expect(verified.ok).toBe(false);
        expect(verified.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
      }
    },
  );

  it("redacts a second participant's known values and retains the runner's default mission", async () => {
    const secret = "synthetic-opaque-assignment-secret";
    const parsed = parseStudy({
      schema: STUDY_SCHEMA,
      id: "assignment-default",
      route: "computer-use",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actor: { type: "openai-computer-use" },
      participants: [
        { id: "first", instruction: "Use the keyboard." },
        { id: "second", instruction: `Use ${secret} from /tmp/private-assignment.` },
      ],
      execution: { target: "e2b-desktop" },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const result = await runComputerUse({
      cwd,
      config: parsed.config,
      dryRun: true,
      env: { OPENAI_API_KEY: secret },
    });
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    expect(bundle.streams[1]?.assignment).toEqual({
      mission: DEFAULT_MISSION,
      typing: DEFAULT_TYPING,
      focus: "Use [REDACTED_SECRET] from [REDACTED_LOCAL_PATH]",
    });
    expect(JSON.stringify(bundle)).not.toContain(secret);
    expect(participantList(parsed.config)![1]!.instruction).toContain(secret);
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
  });
});

describe("typing text in participant assignment evidence", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-assignment-typing-"));
    await writePersonaFiles(cwd, ...STUDY_PERSONAS);
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const secret = "synthetic-typing-known-secret";

  async function computerUseAssignments(typing: unknown): Promise<{
    assignments: unknown[];
    runId: string;
    runDir: string;
  }> {
    const parsed = parseStudy({
      schema: STUDY_SCHEMA,
      id: "assignment-typing",
      route: "computer-use",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actor: { type: "openai-computer-use", ...(typing === undefined ? {} : { typing }) },
      participants: [{ id: "first" }, { id: "second" }],
      execution: { target: "e2b-desktop" },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const result = await runComputerUse({
      cwd,
      config: parsed.config,
      dryRun: true,
      env: { OPENAI_API_KEY: secret },
    });
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
    return {
      assignments: bundle.streams.map((stream) => stream.assignment),
      runId: result.runId,
      runDir,
    };
  }

  it.each([
    ["the built-in paragraph when the study sets none", undefined, DEFAULT_TYPING],
    ["false when the study leaves the paragraph out", false, false],
    [
      "the study's own text, redacted",
      `Type with ${secret} in mind.`,
      "Type with [REDACTED_SECRET] in mind.",
    ],
  ])("records %s", async (_label, typing, recorded) => {
    const { assignments } = await computerUseAssignments(typing);
    expect(assignments).toEqual([
      { mission: DEFAULT_MISSION, typing: recorded },
      { mission: DEFAULT_MISSION, typing: recorded },
    ]);
  });

  it("records each shared-world participant's typing text", async () => {
    const config = concurrentConfig();
    config.actor.typing = false;
    const { env, deps } = baseSeams({ worldVersion: 0 }, makeRendezvous(3));
    const result = await runSharedWorld({ cwd, config, dryRun: true, env, deps });
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    expect(bundle.streams.map((stream) => stream.assignment?.typing)).toEqual([
      false,
      false,
      false,
    ]);
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
  });

  it.each([true, 3, null])("fails verify on a recorded typing of %s", async (malformed) => {
    const { runId, runDir } = await computerUseAssignments(undefined);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    Object.assign(bundle.streams[0]!.assignment!, { typing: malformed });
    await writeFile(path.join(runDir, "run.json"), JSON.stringify(bundle));
    const verified = await verifyRun(cwd, runId);
    expect(verified.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
  });
});
