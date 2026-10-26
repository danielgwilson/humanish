// participants[].files on the computer-use route: humanish reads each file from the study's folder
// before any sandbox exists, copies it onto the participant's hosted desktop before its session,
// confirms its size there, and records the path, size and sha256 on the participant's stream.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCuaActorSession } from "../../../src/actors/computer-use/actor.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import type { StudyDeps } from "../../../src/study/study-deps.js";
import type { StudyConfig } from "../../../src/study/types.js";
import { lab } from "../../admission/fixtures.js";
import { libraryConfig } from "../../helpers/library-config.js";
import {
  makeFanoutModule,
  scriptedParticipant,
  TWO_TURN_SESSION,
  type FanoutModuleHandle,
  type FanoutModuleOptions,
} from "../../helpers/fanout-desktop.js";
import { makeTestTempDir } from "../../helpers/temp-dir.js";

const ENV = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };
const PHOTO = "synthetic portrait photo";
const FORM = "synthetic signed form, longer";

/** A live hosted study whose participants run one at a time, so the order of events is fixed. */
function study(participants: unknown[]): StudyConfig {
  const parsed = parseStudy(
    lab("cuAppUrl", {
      mode: "live",
      participants,
      review: { analysis: false },
      execution: { concurrency: 1 },
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

/** A project with the study file at studies/desktop-files.yaml and its fixtures beside it. */
async function project(): Promise<string> {
  const cwd = await makeTestTempDir("humanish-desktop-files-route-");
  await mkdir(path.join(cwd, "studies", "fixtures"), { recursive: true });
  await writeFile(path.join(cwd, "studies", "desktop-files.yaml"), "# the study file\n");
  await writeFile(path.join(cwd, "studies", "fixtures", "photo.png"), PHOTO);
  await writeFile(path.join(cwd, "studies", "fixtures", "signed-form.pdf"), FORM);
  return cwd;
}

async function run(
  cwd: string,
  config: StudyConfig,
  options: FanoutModuleOptions = {},
  fromStudyFile = true,
): Promise<{ handle: FanoutModuleHandle; order: string[]; result: Record<string, unknown> }> {
  const order: string[] = [];
  const handle = makeFanoutModule({
    ...options,
    onFileWrite: (sandboxId, file) => order.push(`write ${sandboxId} ${file}`),
  });
  const deps: StudyDeps = {
    desktopModule: async () => handle.module,
    subjectPhaseSink: () => undefined,
    runSession: async (session) => {
      order.push("session");
      return runCuaActorSession({
        ...session,
        participant: scriptedParticipant(TWO_TURN_SESSION),
      });
    },
  };
  const outcome = await runStudyWith(
    config,
    {
      cwd,
      env: ENV,
      open: false,
      ...(fromStudyFile
        ? {
            study: {
              id: config.id,
              path: "studies/desktop-files.yaml",
              origin: "explicit" as const,
            },
          }
        : {}),
    },
    deps,
  );
  return { handle, order, result: outcome.result as unknown as Record<string, unknown> };
}

async function streams(cwd: string, runId: unknown): Promise<Record<string, unknown>[]> {
  const bundle = JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", String(runId), "run.json"), "utf8"),
  ) as { streams: Record<string, unknown>[] };
  return bundle.streams;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("participants[].files on a hosted computer-use desktop", () => {
  it("copies each participant's files to its own desktop before its session and records them", async () => {
    const cwd = await project();
    const { handle, order, result } = await run(
      cwd,
      study([
        {
          id: "applicant-a",
          files: [{ from: "fixtures/photo.png", as: "Downloads/photo.png" }],
        },
        {
          id: "applicant-b",
          files: [{ from: "fixtures/signed-form.pdf", as: "Desktop/form.pdf" }],
        },
      ]),
    );

    expect(result.ok).toBe(true);
    const placed = [...handle.files.values()].map((files) =>
      Object.fromEntries([...files].map(([file, bytes]) => [file, bytes.toString("utf8")])),
    );
    expect(placed).toEqual(
      expect.arrayContaining([{ "Downloads/photo.png": PHOTO }, { "Desktop/form.pdf": FORM }]),
    );
    expect(order).toEqual([
      "write fake-sandbox-01 Downloads/photo.png",
      "session",
      "write fake-sandbox-02 Desktop/form.pdf",
      "session",
    ]);

    const recorded = (await streams(cwd, result.runId)).map((stream) => stream.desktopFiles);
    expect(recorded).toEqual([
      [{ as: "Downloads/photo.png", size: 24, sha256: sha256(PHOTO) }],
      [{ as: "Desktop/form.pdf", size: 29, sha256: sha256(FORM) }],
    ]);
  });

  it("records the files on a single participant's stream", async () => {
    const cwd = await project();
    const { result } = await run(
      cwd,
      study([{ id: "applicant", files: [{ from: "fixtures/photo.png", as: "photo.png" }] }]),
    );
    expect(result.ok).toBe(true);
    const [stream] = await streams(cwd, result.runId);
    expect(stream?.desktopFiles).toEqual([{ as: "photo.png", size: 24, sha256: sha256(PHOTO) }]);
  });

  it("fails a participant whose file measures a different size on its desktop, before its session", async () => {
    const cwd = await project();
    const { order, result } = await run(
      cwd,
      study([{ id: "applicant", files: [{ from: "fixtures/photo.png", as: "photo.png" }] }]),
      { reportedFileSize: (_file, written) => written - 1 },
    );
    expect(result.ok).toBe(false);
    expect(order).toEqual(["write fake-sandbox-01 photo.png"]);
    expect(JSON.stringify(result)).toMatch(/photo\.png measured 23 bytes/);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", String(result.runId), "run.json"), "utf8"),
    ) as { events: { type: string; level: string }[] };
    expect(bundle.events.filter((event) => event.type.startsWith("cua-lab.desktop.files"))).toEqual(
      [expect.objectContaining({ type: "cua-lab.desktop.files.completed", level: "warn" })],
    );
  });

  it("refuses an as that holds a key from this run's environment, before any sandbox exists", async () => {
    const cwd = await project();
    const { handle, result } = await run(
      cwd,
      study([
        {
          id: "applicant",
          files: [{ from: "fixtures/photo.png", as: "Downloads/test-openai-key.png" }],
        },
      ]),
    );
    expect(result.error).toMatchObject({ code: "HUMANISH_COMPUTER_USE_DESKTOP_FILES_INVALID" });
    expect(JSON.stringify(result.error)).not.toMatch(/test-openai-key/);
    expect(handle.created).toHaveLength(0);
  });

  it("refuses a file missing from the study's folder before any sandbox exists, though the project root has one", async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, "fixtures"));
    await writeFile(path.join(cwd, "fixtures", "portrait.png"), PHOTO);
    const { handle, result } = await run(
      cwd,
      study([{ id: "applicant", files: [{ from: "fixtures/portrait.png", as: "photo.png" }] }]),
    );
    expect(result.error).toMatchObject({ code: "HUMANISH_COMPUTER_USE_DESKTOP_FILES_INVALID" });
    expect(result.runId).toBe("not-created");
    expect(handle.created).toHaveLength(0);
  });

  it("reads a library caller's files from the project folder, since its config has no study file", async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, "fixtures"));
    await writeFile(path.join(cwd, "fixtures", "portrait.png"), PHOTO);
    const { handle, result } = await run(
      cwd,
      study([{ id: "applicant", files: [{ from: "fixtures/portrait.png", as: "photo.png" }] }]),
      {},
      false,
    );
    expect(result.ok).toBe(true);
    expect(handle.files.get("fake-sandbox-01")?.get("photo.png")?.toString("utf8")).toBe(PHOTO);
  });

  it("refuses a library config that gives files to a local browser participant, before anything starts", async () => {
    const cwd = await project();
    const config = libraryConfig(
      lab("cuAppUrl", {
        mode: "live",
        execution: { target: "local", timeoutMs: 60_000 },
        participants: [
          { id: "applicant", files: [{ from: "fixtures/photo.png", as: "photo.png" }] },
        ],
      }),
    );
    const { handle, result } = await run(cwd, config);
    expect(result.error).toMatchObject({ code: "HUMANISH_COMPUTER_USE_DESKTOP_FILES_INVALID" });
    expect(handle.created).toHaveLength(0);
  });

  it("refuses a missing file on a dry run too, so it is named before a live run", async () => {
    const cwd = await project();
    const parsed = parseStudy(
      lab("cuAppUrl", {
        participants: [
          { id: "applicant", files: [{ from: "fixtures/missing.png", as: "photo.png" }] },
        ],
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const { result } = await run(cwd, parsed.config);
    expect(result.dryRun).toBe(true);
    expect(result.error).toMatchObject({ code: "HUMANISH_COMPUTER_USE_DESKTOP_FILES_INVALID" });
  });
});
