import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Sandbox } from "@e2b/desktop";

import { joinJournals, runnerKeys, watchSignals } from "../../src/remote/launch.js";
import {
  parseDigests,
  parseSizes,
  startRemoteRun,
  uploadProject,
  type Runner,
} from "../../src/remote/runner.js";
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
  const plan = {
    envNames: [
      "E2B_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "HUMANISH_E2B_MAX_SANDBOX_MINUTES",
      "OPENAI_API_KEY",
    ],
    alternatives: [["GEMINI_API_KEY", "GOOGLE_API_KEY"]],
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

  it("on E2B, holds the E2B key for the API host of the forwarded E2B_DOMAIN", () => {
    const keys = runnerKeys(
      { provider: "e2b", envNames: ["E2B_API_KEY", "E2B_DOMAIN"], alternatives: [] },
      { E2B_API_KEY: "synthetic-e2b", E2B_DOMAIN: "e2b.example.test" },
    );
    expect(Object.keys(keys.network.rules ?? {})).toEqual(["api.e2b.example.test"]);
    expect(keys.env.E2B_DOMAIN).toBe("e2b.example.test");
  });

  it("on Modal, which has no header transform, sends each planned key that is set as an environment variable", () => {
    const keys = runnerKeys(
      {
        provider: "modal",
        envNames: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "MODAL_TOKEN_ID", "OPENAI_API_KEY"],
        alternatives: [["GEMINI_API_KEY", "GOOGLE_API_KEY"]],
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
