import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import type { Sandbox } from "@e2b/desktop";

import {
  followRemoteRun,
  joinJournals,
  runnerKeys,
  watchSignals,
} from "../../src/remote/launch.js";
import {
  listRemoteRun,
  parseDigests,
  parseSizes,
  readProject,
  readRemoteFiles,
  setUpRunner,
  startRemoteRun,
  waitForRemoteRun,
  type Runner,
} from "../../src/remote/runner.js";
import { createRunArtifactPaths } from "../../src/run/paths.js";
import { E2B_SYSTEM_CA_BUNDLE, EGRESS_PLACEHOLDER } from "../../src/substrates/e2b/egress-keys.js";

// The runner's network is checked against the installed Desktop SDK's create overload.
type InstalledSdkNetwork = NonNullable<
  NonNullable<Parameters<typeof Sandbox.create>[1]>["network"]
>;

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

describe("reading a study for the runner", () => {
  async function project() {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-upload-"));
    await mkdir(path.join(cwd, "humanish", "personas"), { recursive: true });
    await writeFile(path.join(cwd, "study.yaml"), "id: synthetic\n");
    await writeFile(path.join(cwd, "humanish", "personas", "p.md"), "persona\n");
    return cwd;
  }

  it("reads the study and every persona file, by their paths in the project", async () => {
    const cwd = await project();
    try {
      const files = await readProject(cwd, ["study.yaml"], ["humanish/personas", "missing"]);
      expect(
        files.map((file) => [file.path, Buffer.from(file.bytes).toString("utf8")]).sort(),
      ).toEqual([
        ["humanish/personas/p.md", "persona\n"],
        ["study.yaml", "id: synthetic\n"],
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses a file that links elsewhere on this machine", async () => {
    const cwd = await project();
    const outside = path.join(cwd, "..", `${path.basename(cwd)}-outside`);
    try {
      await writeFile(outside, "outside the project\n");
      await symlink(outside, path.join(cwd, "input.txt"));
      await expect(readProject(cwd, ["study.yaml", "input.txt"], [])).rejects.toThrow(
        "input.txt is a link",
      );
    } finally {
      await rm(outside, { force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("setting up a runner", () => {
  it("installs Node and the dependencies and uploads the study while this humanish is still packing, then unpacks it", async () => {
    const events: string[] = [];
    const runner = {
      sandbox: {},
      shell: {
        run: async (command: string) => {
          const step = command.includes("nodejs.org")
            ? "node"
            : command.includes("npm install")
              ? `npm ${command.includes("'zod@^4.6.5'") && command.includes("'@e2b/desktop@2.4.0'") ? "with" : "without"} the dependencies`
              : command.includes("humanish.tgz")
                ? "unpack"
                : "other";
          events.push(step);
          return {
            exitCode: 0,
            stdout: step === "unpack" ? "0.0.0-synthetic\n" : "",
            stderr: "",
          };
        },
        writeFile: async (file: string) => void events.push(`write ${file}`),
      },
    } as unknown as Runner;
    let packed!: (bytes: Uint8Array) => void;
    const tarball = new Promise<Uint8Array>((resolve) => {
      packed = resolve;
    });
    const setup = setUpRunner(runner, {
      tarball,
      dependencies: ["zod@^4.6.5", "@e2b/desktop@2.4.0"],
      project: [{ path: "study.yaml", bytes: Buffer.from("id: synthetic\n") }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.sort()).toEqual([
      "node",
      "npm with the dependencies",
      "write project/study.yaml",
    ]);
    packed(Buffer.from("synthetic tarball"));
    expect(await setup).toBe("0.0.0-synthetic");
    expect(events.slice(3)).toEqual(["write .humanish-remote/humanish.tgz", "unpack"]);
  });

  it("fails with the step and its output when Node does not install", async () => {
    const runner = {
      sandbox: {},
      shell: {
        run: async (command: string) =>
          command.includes("nodejs.org")
            ? {
                exitCode: 22,
                stdout: "",
                stderr: "curl: (22) The requested URL returned error: 503",
              }
            : { exitCode: 0, stdout: "", stderr: "" },
        writeFile: async () => undefined,
      },
    } as unknown as Runner;
    await expect(
      setUpRunner(runner, {
        tarball: Promise.resolve(Buffer.from("t")),
        dependencies: [],
        project: [],
      }),
    ).rejects.toThrow(/Installing Node failed in the runner sandbox \(exit 22\).*503/);
  });
});

/** A runner whose commands and file reads run on this machine, in a home directory of their own. */
async function localRunner() {
  const home = await mkdtemp(path.join(tmpdir(), "humanish-runner-home-"));
  const runner = {
    sandbox: {
      files: {
        read: async (file: string) =>
          Readable.toWeb(createReadStream(path.join(home, file))) as ReadableStream<Uint8Array>,
      },
    },
    shell: {
      run: (command: string) =>
        new Promise((resolve) => {
          execFile(
            "bash",
            ["-c", command],
            { cwd: home, env: { ...process.env, HOME: home }, encoding: "utf8" },
            (error, stdout, stderr) =>
              resolve({
                exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
                stdout,
                stderr,
              }),
          );
        }),
    },
  } as unknown as Runner;
  const runDir = path.join(home, "project", ".humanish", "runs", "cua-remote");
  await mkdir(runDir, { recursive: true });
  await mkdir(path.join(home, ".humanish-remote"), { recursive: true });
  return { home, runner, runDir };
}

describe("waiting on the runner's run", () => {
  it("answers as soon as the run writes its result, well before the wait ends", async () => {
    const { home, runner, runDir } = await localRunner();
    try {
      await writeFile(
        path.join(runDir, "status.json"),
        `${JSON.stringify({ runId: "cua-remote", state: "finished", analysis: { state: "done" } }, null, 2)}\n`,
      );
      await writeFile(path.join(home, ".humanish-remote", "watch.err"), "last line\n");
      const started = Date.now();
      setTimeout(
        () =>
          void writeFile(
            path.join(home, ".humanish-remote", "result.json"),
            `${JSON.stringify({ exitCode: 0, result: { ok: true } })}\n`,
          ),
        300,
      );
      const run = await waitForRemoteRun(
        runner,
        "cua-remote",
        // The process check is left out of this test: other processes on this machine could match.
        { state: "finished", alive: false },
        15_000,
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(run).toMatchObject({
        state: "finished",
        result: { exitCode: 0, result: { ok: true } },
        errTail: "last line",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("answers at once when the run's state is not the one the launcher has seen", async () => {
    const { home, runner, runDir } = await localRunner();
    try {
      await writeFile(
        path.join(runDir, "status.json"),
        `${JSON.stringify({ runId: "cua-remote", state: "running" }, null, 2)}\n`,
      );
      const started = Date.now();
      const run = await waitForRemoteRun(
        runner,
        "cua-remote",
        { state: undefined, alive: false },
        15_000,
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(run.state).toBe("running");
      expect(run.result).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("copying the runner's run back", () => {
  it("lists every file with its size and digest, and copies the ones asked for, byte for byte", async () => {
    const { home, runner, runDir } = await localRunner();
    try {
      await mkdir(path.join(runDir, "screenshots", "p01"), { recursive: true });
      await writeFile(path.join(runDir, "run.json"), '{"synthetic":true}\n');
      await writeFile(path.join(runDir, "empty.ndjson"), "");
      await writeFile(
        path.join(runDir, "screenshots", "p01", "0001.png"),
        Buffer.from([0, 1, 2, 255]),
      );
      const listed = await listRemoteRun(runner, "cua-remote");
      expect(listed.map((file) => [file.path, file.size]).sort()).toEqual([
        ["empty.ndjson", 0],
        ["run.json", 19],
        ["screenshots/p01/0001.png", 4],
      ]);
      const copied = new Map<string, string>();
      await readRemoteFiles(runner, "cua-remote", listed, async (file, bytes) => {
        copied.set(file.path, Buffer.from(bytes).toString("hex"));
      });
      expect(Object.fromEntries(copied)).toEqual({
        "empty.ndjson": "",
        "run.json": Buffer.from('{"synthetic":true}\n').toString("hex"),
        "screenshots/p01/0001.png": "000102ff",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses a file that changed after it was listed", async () => {
    const { home, runner, runDir } = await localRunner();
    try {
      await writeFile(path.join(runDir, "run.json"), '{"synthetic":true}\n');
      const listed = await listRemoteRun(runner, "cua-remote");
      await writeFile(path.join(runDir, "run.json"), '{"synthetic":false}\n');
      await expect(
        readRemoteFiles(runner, "cua-remote", listed, async () => undefined),
      ).rejects.toThrow("run.json changed or arrived damaged");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses a run directory that holds a link", async () => {
    const { home, runner, runDir } = await localRunner();
    try {
      await symlink("/etc/hostname", path.join(runDir, "hostname"));
      await expect(listRemoteRun(runner, "cua-remote")).rejects.toThrow(
        "holds something other than files and folders",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
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
  const plan = {
    envNames: [
      "E2B_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "HUMANISH_E2B_MAX_SANDBOX_MINUTES",
      "OPENAI_API_KEY",
    ],
    alternatives: [["GEMINI_API_KEY", "GOOGLE_API_KEY"]],
    plainKeys: [],
  };
  const env = {
    E2B_API_KEY: "synthetic-e2b",
    GEMINI_API_KEY: "synthetic-gemini",
    GOOGLE_API_KEY: "synthetic-google",
    GH_TOKEN: "synthetic-gh",
    HUMANISH_E2B_MAX_SANDBOX_MINUTES: "60",
    OPENAI_API_KEY: "synthetic-openai",
  };

  it("on E2B, creates the runner with each key in a header transform and starts its run with placeholders", () => {
    const keys = runnerKeys({ ...plan, provider: "e2b" }, env);
    const network: InstalledSdkNetwork = keys.network;
    expect(network).toEqual({
      allowPublicTraffic: false,
      rules: {
        "api.e2b.app": [{ transform: { headers: { "X-API-Key": "synthetic-e2b" } } }],
        "api.openai.com": [
          { transform: { headers: { Authorization: "Bearer synthetic-openai" } } },
        ],
        "generativelanguage.googleapis.com": [
          { transform: { headers: { "x-goog-api-key": "synthetic-gemini" } } },
        ],
      },
    });
    expect(keys.env).toEqual({
      E2B_API_KEY: EGRESS_PLACEHOLDER,
      GEMINI_API_KEY: EGRESS_PLACEHOLDER,
      HUMANISH_E2B_MAX_SANDBOX_MINUTES: "60",
      NODE_EXTRA_CA_CERTS: E2B_SYSTEM_CA_BUNDLE,
      OPENAI_API_KEY: EGRESS_PLACEHOLDER,
    });
    expect(JSON.stringify(keys.env)).not.toMatch(/synthetic/);
    expect(keys.held).toEqual(["E2B_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"]);
    expect(keys.sent).toEqual(["HUMANISH_E2B_MAX_SANDBOX_MINUTES"]);
  });

  it("holds a Claude participant's key in E2B's proxy and sends it to a Modal runner", () => {
    const claude = { envNames: ["ANTHROPIC_API_KEY"], alternatives: [], plainKeys: [] };
    const set = { ANTHROPIC_API_KEY: "synthetic-anthropic" };
    const e2b = runnerKeys({ ...claude, provider: "e2b" }, set);
    expect(e2b.held).toEqual(["ANTHROPIC_API_KEY"]);
    expect(e2b.env.ANTHROPIC_API_KEY).toBe(EGRESS_PLACEHOLDER);
    expect(Object.keys(e2b.network.rules ?? {})).toEqual(["api.anthropic.com"]);
    const modal = runnerKeys({ ...claude, provider: "modal" }, set);
    expect(modal.env).toEqual(set);
    expect(modal.sent).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("on E2B, holds the E2B key for the API host of the forwarded E2B_DOMAIN", () => {
    const keys = runnerKeys(
      { provider: "e2b", envNames: ["E2B_API_KEY", "E2B_DOMAIN"], alternatives: [], plainKeys: [] },
      { E2B_API_KEY: "synthetic-e2b", E2B_DOMAIN: "e2b.example.test" },
    );
    expect(Object.keys(keys.network.rules ?? {})).toEqual(["api.e2b.example.test"]);
    expect(keys.env.E2B_DOMAIN).toBe("e2b.example.test");
  });

  it("on E2B, sends a terminal study's runtime key as its value and still holds the E2B key", () => {
    const keys = runnerKeys(
      {
        provider: "e2b",
        envNames: ["CODEX_API_KEY", "E2B_API_KEY", "OPENAI_API_KEY"],
        alternatives: [],
        plainKeys: ["CODEX_API_KEY", "OPENAI_API_KEY"],
      },
      env,
    );
    expect(Object.keys(keys.network.rules ?? {})).toEqual(["api.e2b.app"]);
    expect(keys.env).toEqual({
      E2B_API_KEY: EGRESS_PLACEHOLDER,
      NODE_EXTRA_CA_CERTS: E2B_SYSTEM_CA_BUNDLE,
      OPENAI_API_KEY: "synthetic-openai",
    });
    expect(keys.held).toEqual(["E2B_API_KEY"]);
    expect(keys.sent).toEqual(["OPENAI_API_KEY"]);
  });

  it("on E2B, sends only the runtime key Codex reads as its value, and holds the analyst's", () => {
    const both = { ...env, CODEX_API_KEY: "synthetic-codex" };
    const terminal = {
      provider: "e2b" as const,
      envNames: ["CODEX_API_KEY", "OPENAI_API_KEY"],
      plainKeys: ["CODEX_API_KEY", "OPENAI_API_KEY"],
    };
    // The analysis reads OPENAI_API_KEY, so it goes to the runner, held in the proxy.
    const analysed = runnerKeys({ ...terminal, alternatives: [] }, both);
    expect(analysed.env).toMatchObject({
      CODEX_API_KEY: "synthetic-codex",
      OPENAI_API_KEY: EGRESS_PLACEHOLDER,
    });
    expect(analysed.held).toEqual(["OPENAI_API_KEY"]);
    // Nothing else reads it, so it stays here.
    const alone = runnerKeys(
      { ...terminal, alternatives: [["CODEX_API_KEY", "OPENAI_API_KEY"]] },
      both,
    );
    expect(alone.env).toEqual({ CODEX_API_KEY: "synthetic-codex" });
    expect(alone.network.rules).toBeUndefined();
  });

  it("on Modal, which has no header transform, sends each planned key that is set as an environment variable", () => {
    const keys = runnerKeys(
      {
        provider: "modal",
        envNames: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "MODAL_TOKEN_ID", "OPENAI_API_KEY"],
        alternatives: [["GEMINI_API_KEY", "GOOGLE_API_KEY"]],
        plainKeys: [],
      },
      { ...env, MODAL_TOKEN_ID: "synthetic-modal", OPENAI_API_KEY: " " },
    );
    expect(keys.network).toEqual({ allowPublicTraffic: false });
    expect(keys.env).toEqual({
      GEMINI_API_KEY: "synthetic-gemini",
      MODAL_TOKEN_ID: "synthetic-modal",
    });
    expect(keys.held).toEqual([]);
    expect(keys.sent).toEqual(["GEMINI_API_KEY", "MODAL_TOKEN_ID"]);
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

describe("following a remote run", () => {
  it("lets the run go as soon as the terminal closes, without waiting out a read in the runner", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-follow-"));
    const created = await createRunArtifactPaths(cwd, "cua-remote");
    if (!created.ok) throw new Error("run directory not created");
    // Each read waits in the runner for longer than this test may take.
    const runner = {
      sandbox: {},
      shell: {
        run: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ exitCode: 0, stdout: "", stderr: "" }), 60_000).unref(),
          ),
      },
    } as unknown as Runner;
    const signals = watchSignals();
    try {
      const following = followRemoteRun({
        launch: { cwd, env: {}, say: () => undefined },
        runner,
        paths: created.paths,
        runId: "cua-remote",
        signals,
        proxyUrl: "http://127.0.0.1:0",
      });
      setTimeout(() => process.emit("SIGHUP"), 50);
      expect(await following).toEqual({ runId: "cua-remote", exitCode: 0, detached: true });
    } finally {
      signals.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
