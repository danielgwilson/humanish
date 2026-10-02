// Pins what the CLI does today when a lab run is refused before any run starts: stdout, stderr,
// exit code, whether a run directory appeared, how many processes started, and whether a
// declared scorer's host code ran. The planLab migration must keep this golden byte-identical
// except for changes its compatibility contract lists.

import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommanderError } from "commander";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { createProgram } from "../../src/cli/program.js";
import { lab, SCENARIO_YAML, type RawLab } from "./fixtures.js";

const subprocess = vi.hoisted(() => ({ calls: 0 }));

vi.mock("node:child_process", async (importOriginal) =>
  (await import("./subprocess-spy.js")).countedChildProcess(await importOriginal(), subprocess),
);

const live = { scenario: { mode: "live" } };
const unpricedCap = { ...live, execution: { caps: { maxUsd: 1 } } };

const labs: Record<string, RawLab> = {
  "adm-terminal-live-no-caps": lab("terminal", { scenario: { mode: "live", caps: undefined } }),
  "adm-scripted": lab("scriptedAppUrl"),
  "adm-cu": lab("cuAppUrl"),
  "adm-preview": lab("preview"),
  "adm-cu-unpriced": lab("cuAppUrl", unpricedCap, { model: "unpriced-model" }),
  "adm-shared-unpriced": lab("sharedProvisioned", unpricedCap, { model: "unpriced-model" }),
  "adm-shared-live": lab("sharedProvisioned", live),
  "adm-clone-codex-app-server": lab("cuClone", {}, { type: "codex-app-server" }),
  "adm-clone-no-serve": lab("cuClone", { subject: { serve: undefined } }),
  "adm-cu-local-app": lab("cuLocalApp"),
  "adm-terminal-live": lab("terminal", live),
  "adm-cu-local-tree-live": lab("cuLocalTree", live),
  "adm-cu-live": lab("cuAppUrl", live),
};

// Writes a marker when imported, so a case can tell whether scorer host code ran.
const SCORER = `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./scorer-ran", import.meta.url), "ran");
export function score() {
  return { schema: "humanish.adapter-score.v1", namespace: "adm", status: "pass", score: 1, summary: "ok" };
}
`;

const cases: readonly (readonly string[])[] = [
  // An option conflict wins over a live-only rule the route checks later (F2).
  ["watch", "adm-terminal-live-no-caps", "--expose", "--json"],
  ["lab", "run", "adm-terminal-live-no-caps", "--json"],
  ["lab", "run", "adm-scripted", "--rerun-failed-from", "prior-run", "--json"],
  // These two refuse on stderr with no envelope, even under --json.
  ["lab", "run", "adm-cu", "--lanes", "lane-01", "--json"],
  ["lab", "run", "adm-cu", "--count", "0", "--json"],
  ["lab", "run", "adm-cu", "--port", "99999", "--json"],
  ["lab", "run", "adm-preview", "--count", "0", "--json"],
  ["lab", "run", "adm-scripted", "--scorer", "./scorer.mjs", "--json"],
  // The count is checked before the scorer loads, so its host code never runs (F4).
  ["lab", "run", "adm-cu", "--scorer", "./scorer.mjs", "--count", "0", "--json"],
  // A plan refusal also comes before the scorer loads (F4).
  ["lab", "run", "adm-terminal-live-no-caps", "--scorer", "./scorer.mjs", "--json"],
  // A parse-valid local-app lab with no executor: the computer-use planner refuses it.
  ["lab", "run", "adm-cu-local-app", "--scorer", "./scorer.mjs", "--json"],
  // Missing keys win over an unpriced cap on computer use (F3); shared world checks price first.
  ["lab", "run", "adm-cu-unpriced", "--json"],
  ["lab", "run", "adm-shared-unpriced", "--json"],
  // A refusal for this machine (keys, runtime auth) also comes before the scorer loads.
  ["lab", "run", "adm-terminal-live", "--scorer", "./scorer.mjs", "--json"],
  ["lab", "run", "adm-cu-unpriced", "--scorer", "./scorer.mjs", "--json"],
  ["lab", "run", "adm-shared-live", "--scorer", "./scorer.mjs", "--json"],
  ["watch", "adm-shared-live", "--port", "99999"],
  // A live run is never share_ready, so watch refuses --safe on every path (lab or not).
  ["watch", "adm-cu", "--safe", "--json"],
  ["watch", "adm-scripted", "--safe", "--json"],
  ["watch", "--safe", "--json"],
  // Refused at parse since P0b, before any route runs.
  ["lab", "run", "adm-clone-codex-app-server", "--json"],
  ["lab", "inspect", "adm-clone-codex-app-server", "--json"],
  ["lab", "run", "adm-clone-no-serve", "--json"],
];

const cleanup: string[] = [];
const records: Record<string, unknown> = {};

afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  for (const name of ["OPENAI_API_KEY", "E2B_API_KEY", "CODEX_API_KEY"]) vi.stubEnv(name, "");
});

async function projectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "humanish-admission-cli-"));
  cleanup.push(dir);
  await writeFile(path.join(dir, "package.json"), '{ "name": "admission-fixture" }\n');
  await writeFile(path.join(dir, "scorer.mjs"), SCORER);
  await mkdir(path.join(dir, "humanish", "labs"), { recursive: true });
  await mkdir(path.join(dir, "humanish", "scenarios"), { recursive: true });
  await writeFile(path.join(dir, "humanish", "scenarios", "adm-journey.yaml"), SCENARIO_YAML);
  for (const [id, raw] of Object.entries(labs)) {
    await writeFile(path.join(dir, "humanish", "labs", `${id}.yaml`), stringify({ ...raw, id }));
  }
  return dir;
}

/** Runs the CLI. `log` also receives its stderr, so a test can order it among other writes. */
async function runCli(args: readonly string[], log?: string[]) {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => {
      stderr.push(text);
      log?.push(text);
    },
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  program.exitOverride();
  try {
    await program.parseAsync(["node", "humanish", ...args], { from: "node" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

function normalize(text: string, dirs: readonly string[]): string {
  return dirs.reduce((value, dir) => value.split(dir).join("[cwd]"), text);
}

describe("CLI admission today", () => {
  it.each(cases.map((args) => [args.join(" "), args] as const))(
    "%s",
    async (name, args) => {
      const cwd = await projectDir();
      const dirs = [await realpath(cwd), cwd];
      // The missing-key message names local agents it finds signed in; find none on any machine.
      vi.stubEnv("PATH", path.join(cwd, "no-bin"));
      vi.stubEnv("HOME", path.join(cwd, "home"));
      subprocess.calls = 0;
      const result = await runCli([...args, "--cwd", cwd]);
      const stdout = normalize(result.stdout, dirs);
      let parsed: unknown = stdout;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        // Human output and an empty stdout stay text.
      }
      const runs = (await readdir(path.join(cwd, ".humanish", "runs")).catch(() => [])).length;
      const scorerRan = await access(path.join(cwd, "scorer-ran")).then(
        () => true,
        () => false,
      );
      records[name] = {
        exitCode: result.exitCode,
        stdout: parsed,
        stderr: normalize(result.stderr, dirs),
        runs: runs > 0,
        subprocess: subprocess.calls,
        scorerRan,
      };
      expect(runs).toBe(0);
      expect(scorerRan).toBe(false);
    },
    60_000,
  );

  it("leaves no local-tree archive or run when the scorer fails to load after admission", async () => {
    vi.unstubAllEnvs();
    const cwd = await projectDir();
    await writeFile(path.join(cwd, "throwing-scorer.mjs"), 'throw new Error("scorer import");\n');
    const tmp = await mkdtemp(path.join(tmpdir(), "humanish-admission-tmp-"));
    cleanup.push(tmp);
    vi.stubEnv("TMPDIR", tmp);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("E2B_API_KEY", "test-e2b-key");
    const hostStderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      hostStderr.push(String(chunk));
      return true;
    });

    const result = await runCli([
      "lab",
      "run",
      "adm-cu-local-tree-live",
      "--scorer",
      "./throwing-scorer.mjs",
      "--json",
      "--cwd",
      cwd,
    ]);

    // Admission packed the working tree before the scorer failed to load.
    expect(hostStderr.join("")).toMatch(/humanish local-tree: packed/);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "HUMANISH_LAB_SCORER_LOAD_FAILED" },
    });
    expect(await readdir(tmp)).toEqual([]);
    expect(await readdir(path.join(cwd, ".humanish", "runs")).catch(() => [])).toEqual([]);
  }, 60_000);

  it.each([
    ["a local-tree lab", ["adm-cu-local-tree-live"], "humanish local-tree: packed"],
    ["a fan-out lab", ["adm-cu-live", "--count", "2"], "humanish computer-use fan-out plan"],
  ])(
    "prints %s's check output before the scorer warning when the checks pass",
    async (_name, lab, checkLine) => {
      vi.unstubAllEnvs();
      const cwd = await projectDir();
      vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
      vi.stubEnv("E2B_API_KEY", "test-e2b-key");
      // A taken run id stops the run after the scorer loads and before anything is acquired.
      await mkdir(path.join(cwd, ".humanish", "runs", "taken-run"), { recursive: true });
      const log: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        log.push(String(chunk));
        return true;
      });

      const result = await runCli(
        ["lab", "run", ...lab, "--scorer", "./scorer.mjs", "--run-id", "taken-run"].concat([
          "--json",
          "--cwd",
          cwd,
        ]),
        log,
      );

      expect(JSON.parse(result.stdout)).toMatchObject({
        error: { code: "HUMANISH_RUN_ID_IN_USE" },
      });
      const text = log.join("");
      const order = [checkLine, "warning: review scorer", "After live runs: default analysis"].map(
        (line) => text.indexOf(line),
      );
      expect(order.every((index) => index >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(await access(path.join(cwd, "scorer-ran")).then(() => true)).toBe(true);
      expect(await readdir(path.join(cwd, ".humanish", "runs"))).toEqual(["taken-run"]);
    },
    60_000,
  );

  it("matches the pinned golden", async () => {
    expect(Object.keys(records)).toHaveLength(cases.length);
    await expect(`${JSON.stringify(records, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/admission/cli.json",
    );
  });
});
