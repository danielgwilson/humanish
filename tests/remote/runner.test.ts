import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { forwardedEnv, joinJournals, watchSignals } from "../../src/remote/launch.js";
import {
  parseDigests,
  parseSizes,
  startRemoteRun,
  uploadProject,
  type Runner,
} from "../../src/remote/runner.js";

const HASH = "a".repeat(64);

describe("the runner's run listing", () => {
  it("reads sha256sum lines as paths inside the run directory", () => {
    expect(
      parseDigests(`${HASH}  ./run.json\n${"b".repeat(64)} *./screenshots/lane-01/0001.png\n`),
    ).toEqual([
      { sha256: HASH, path: "run.json" },
      { sha256: "b".repeat(64), path: "screenshots/lane-01/0001.png" },
    ]);
  });

  it("skips lines that do not name a file under the directory", () => {
    expect(parseDigests(`${HASH}  /etc/passwd\nnot a digest\n${HASH}  ../escape\n`)).toEqual([]);
  });
});

describe("joining this machine's sandbox journal with the runner's", () => {
  it("keeps every line of both, once each, ending in one newline", () => {
    expect(joinJournals('{"runner":1}\n\n', '\n{"participant":1}\n')).toBe(
      '{"runner":1}\n{"participant":1}\n',
    );
    expect(joinJournals("", "")).toBe("");
    // A copy that runs again adds nothing it already added.
    expect(joinJournals('{"runner":1}\n{"participant":1}\n', '{"participant":1}\n')).toBe(
      '{"runner":1}\n{"participant":1}\n',
    );
  });
});

describe("uploading a study to the runner", () => {
  async function project() {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-upload-"));
    await mkdir(path.join(cwd, "humanish", "personas"), { recursive: true });
    await writeFile(path.join(cwd, "study.yaml"), "id: synthetic\n");
    await writeFile(path.join(cwd, "humanish", "personas", "p.md"), "persona\n");
    const written: string[] = [];
    const runner = {
      sandbox: {},
      shell: { writeFile: async (file: string) => void written.push(file) },
    } as unknown as Runner;
    return { cwd, runner, written };
  }

  it("uploads the study and every persona file to the same place in the runner's project", async () => {
    const { cwd, runner, written } = await project();
    try {
      await uploadProject(runner, cwd, ["study.yaml"], ["humanish/personas", "missing"]);
      expect(written.sort()).toEqual(["project/humanish/personas/p.md", "project/study.yaml"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses a file that links elsewhere on this machine", async () => {
    const { cwd, runner, written } = await project();
    try {
      await writeFile(path.join(cwd, "..", path.basename(cwd) + "-secret"), "KEY=synthetic\n");
      await symlink(
        path.join(cwd, "..", path.basename(cwd) + "-secret"),
        path.join(cwd, "input.txt"),
      );
      await expect(uploadProject(runner, cwd, ["study.yaml", "input.txt"], [])).rejects.toThrow(
        "input.txt is a link",
      );
      expect(written).not.toContain("project/input.txt");
    } finally {
      await rm(path.join(cwd, "..", path.basename(cwd) + "-secret"), { force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("the runner's settled evidence listing", () => {
  it("reads screenshot and recording paths with sizes, and drops anything else", () => {
    expect(
      parseSizes(
        "screenshots/p01/0001.png\t104857\nrecordings/p01/desktop.mp4\t2097152\nrun.json\t10\nscreenshots/../escape\t1\n",
      ),
    ).toEqual([
      { path: "screenshots/p01/0001.png", size: 104857 },
      { path: "recordings/p01/desktop.mp4", size: 2097152 },
    ]);
  });
});

describe("starting the runner's run", () => {
  it("runs it here, never as another remote run", async () => {
    const started: { command: string; env?: Readonly<Record<string, string>> }[] = [];
    const runner = {
      sandbox: {},
      shell: {
        start: async (command: string, options?: { env?: Readonly<Record<string, string>> }) => {
          started.push({ command, ...(options?.env === undefined ? {} : { env: options.env }) });
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    } as unknown as Runner;
    await startRemoteRun(runner, {
      study: "study.yaml",
      runId: "cua-remote",
      ownerKey: "1111222233334444",
      env: {},
    });
    expect(started[0]?.command).toContain("'--local'");
    expect(started[0]?.env).toMatchObject({ HUMANISH_INSIDE_RUNNER: "1" });
  });
});

describe("the keys a runner receives", () => {
  it("sends each planned name that is set, and of alternatives only the first one set", () => {
    expect(
      forwardedEnv(
        {
          envNames: ["E2B_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY"],
          alternatives: [["GEMINI_API_KEY", "GOOGLE_API_KEY"]],
        },
        {
          E2B_API_KEY: "synthetic-e2b",
          GEMINI_API_KEY: "synthetic-gemini",
          GOOGLE_API_KEY: "synthetic-google",
          GH_TOKEN: "synthetic-gh",
          OPENAI_API_KEY: " ",
        },
      ),
    ).toEqual({ E2B_API_KEY: "synthetic-e2b", GEMINI_API_KEY: "synthetic-gemini" });
  });
});

describe("signals while a remote run is followed", () => {
  it.each([
    ["SIGINT", "stop", 130],
    ["SIGTERM", "stop", 143],
    ["SIGHUP", "detach", 129],
  ] as const)(
    "%s is a %s with exit %d, and later signals change nothing",
    async (signal, kind, code) => {
      const signals = watchSignals();
      try {
        process.emit(signal);
        process.emit(signal === "SIGHUP" ? "SIGINT" : "SIGHUP");
        await signals.received;
        expect(signals.requested).toBe(kind);
        expect(signals.exitCode).toBe(code);
      } finally {
        signals.dispose();
      }
    },
  );
});
