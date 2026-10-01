import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";

// A live OpenAI analysis sends OPENAI_API_KEY, so `humanish analyze` looks keys up like the other
// commands that make a provider call. Discovery runs against a temp home here, and undici's fetch
// is replaced so the request goes nowhere; the test reads the key the request carried.
const sent = vi.hoisted(() => ({ authorization: [] as string[] }));
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: async (_url: string, init: { headers: Record<string, string> }) => {
    sent.authorization.push(init.headers.Authorization ?? "");
    return { ok: false, status: 401, body: null };
  },
}));

import { createProgram } from "../../src/cli/program.js";
import { discoverProviderKeys, setUserKey } from "../../src/keys/key-resolution.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";

const RUN_ID = "analyze-key-discovery";
const STORE_KEY = "synthetic-store-openai-key";
const cleanup: string[] = [];
let home: string;
let project: string;

afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(async () => {
  sent.authorization.length = 0;
  home = await mkdtemp(path.join(os.tmpdir(), "humanish-analyze-home-"));
  project = await mkdtemp(path.join(os.tmpdir(), "humanish-analyze-project-"));
  cleanup.push(home, project);
  // The key exists only in the user store: no environment value, no strict mode.
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("HUMANISH_STRICT_KEYS", "");
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
  setUserKey("OPENAI_API_KEY", STORE_KEY, process.env, { homeDir: home });
  // A completed live run to analyze: a preview bundle marked live, as the analysis tests do.
  await cp(path.resolve("fixtures/minimal-app"), project, { recursive: true });
  await runDryRun({ cwd: project, dryRun: true, runId: RUN_ID });
  const root = path.join(project, ".humanish", "runs", RUN_ID);
  const bundle = JSON.parse(await readFile(path.join(root, "run.json"), "utf8")) as RunBundle;
  bundle.mode = "live";
  bundle.streams[0]!.status = "complete";
  await writeFile(path.join(root, "run.json"), JSON.stringify(bundle) + "\n");
  await rm(path.join(root, "status.json"));
});

async function analyze(args: readonly string[]): Promise<{ stderr: string; discoveries: number }> {
  const stderr: string[] = [];
  let discoveries = 0;
  const program = createProgram({
    writeOut: () => {},
    writeErr: (text) => stderr.push(text),
    setExitCode: () => {},
    keyDiscovery: (options) => {
      discoveries += 1;
      return discoverProviderKeys({
        ...options,
        deps: { homeDir: home, execText: async () => null },
      });
    },
  });
  program.exitOverride();
  await program.parseAsync(["node", "humanish", "analyze", "--cwd", project, ...args, "--json"], {
    from: "node",
  });
  return { stderr: stderr.join(""), discoveries };
}

it("sends the key saved with `keys set` when the environment has none", async () => {
  const { stderr } = await analyze(["--run", RUN_ID, "--max-cost", "5"]);
  expect(sent.authorization).toEqual([`Bearer ${STORE_KEY}`]);
  expect(stderr).toContain("humanish keys: OPENAI_API_KEY from");
  expect(stderr).not.toContain(STORE_KEY);
});

it.each([
  ["a dry run", ["--run", RUN_ID, "--max-cost", "5", "--dry-run"]],
  ["the Codex account analyst", ["--run", "no-such-run", "--provider", "codex"]],
])("does not look up keys for %s", async (_name, args) => {
  const { discoveries } = await analyze(args);
  expect(discoveries).toBe(0);
  expect(sent.authorization).toEqual([]);
});
