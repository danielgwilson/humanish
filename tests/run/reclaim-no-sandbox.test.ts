// `humanish reclaim` on a scripted run against an app-url subject. Its status.json records
// `sandboxes: none` at start, and reclaim reports it clean without loading the E2B SDK only when
// run.json agrees: the scripted route wrote it, its subject is no clone, it lists no provider
// resource and its outcome marks no cleanup unconfirmed. A status record that disagrees with
// run.json, which a copied or edited status.json would, sends the run down the live path.

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { RECLAIM_RECEIPT_ARTIFACT, reclaimRunSandboxes } from "../../src/run/reclaim.js";
import { sandboxOwnerTags } from "../../src/run/sandbox-creates.js";
import { appendSandboxOwner } from "../../src/run/sandbox-receipts.js";
import { runStudyWith } from "../../src/run-study.js";
import { parseStudyDocument } from "../../src/study/config.js";
import { V2_SCHEMA } from "../../src/study/types.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const RUN = "reclaim-scripted";

type Json = Record<string, unknown>;

/**
 * A scripted app-url run as the route writes it, recorded live: the route's dry run, with both
 * records' mode set to live. Returns the project and an editor for the run's JSON files.
 */
async function scriptedRun() {
  const cwd = await makeTestTempDir("humanish-reclaim-scripted-");
  await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
  await cp(
    path.resolve("humanish", "scenarios", "scripted-first-run.yaml"),
    path.join(cwd, "humanish", "scenarios", "scripted-first-run.yaml"),
  );
  const parsed = parseStudyDocument({
    schema: V2_SCHEMA,
    id: "reclaim-scripted",
    title: "Reclaim on a scripted run",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:9/" },
    actors: [{ type: "scripted-browser", persona: "synthetic-new-user" }],
    scenario: { ref: "scripted-first-run" },
    review: { analysis: false },
    execution: { target: "local" },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  const outcome = await runStudyWith(parsed.config, { cwd, runId: RUN, open: false });
  if (outcome.route !== "scripted" || !outcome.result.ok)
    throw new Error("the scripted dry run failed");
  const runRoot = path.join(cwd, ".humanish", "runs", RUN);
  const editJson = async (file: string, edit: (value: Json) => void) => {
    const filePath = path.join(runRoot, file);
    const value = JSON.parse(await readFile(filePath, "utf8")) as Json;
    edit(value);
    await writeFile(filePath, JSON.stringify(value));
  };
  for (const file of ["run.json", "status.json"])
    await editJson(file, (record) => void (record.mode = "live"));
  return { cwd, runRoot, editJson };
}

function check(cwd: string) {
  const loadModule = vi.fn(async () => {
    throw new Error("the E2B SDK was loaded");
  });
  return {
    loadModule,
    result: () => reclaimRunSandboxes(cwd, RUN, { loadModule, check: true }),
  };
}

describe("humanish reclaim on a scripted app-url run", () => {
  it.each([false, true])(
    "reports it clean with reason no-sandbox and loads no E2B SDK (check %s)",
    async (checkOnly) => {
      const { cwd } = await scriptedRun();
      const loadModule = vi.fn();
      const result = await reclaimRunSandboxes(cwd, RUN, { loadModule, check: checkOnly });
      expect(result).toMatchObject({
        ok: true,
        state: "clean",
        reason: "no-sandbox",
        receiptCount: 0,
        outcomes: [],
        tagSearch: { status: "not-run", found: 0 },
      });
      expect(loadModule).not.toHaveBeenCalled();
    },
  );

  it.each<[string, (run: Awaited<ReturnType<typeof scriptedRun>>) => Promise<void>]>([
    [
      "status.json records nothing about sandboxes",
      ({ editJson }) => editJson("status.json", (status) => void delete status.sandboxes),
    ],
    [
      "status.json names another run",
      ({ editJson }) => editJson("status.json", (status) => void (status.runId = "another-run")),
    ],
    [
      "run.json records a clone subject",
      ({ editJson }) =>
        editJson(
          "run.json",
          (bundle) =>
            void (bundle.subject = {
              repo: "example-org/example-app",
              envNames: [],
              state: { provenance: "undeclared" },
            }),
        ),
    ],
    [
      "run.json lists a provider resource",
      ({ editJson }) =>
        editJson(
          "run.json",
          (bundle) =>
            void (bundle.providerResources = [
              {
                schema: "humanish.provider-resource.v1",
                provider: "e2b-desktop",
                kind: "sandbox",
                id: "[redacted-sandbox-id]",
                owner: "humanish",
                status: "unknown",
              },
            ]),
        ),
    ],
    [
      "run.json's outcome marks a sandbox cleanup unconfirmed",
      ({ editJson }) =>
        editJson("run.json", (bundle) => {
          const outcome = bundle.outcome as { execution: { warnings?: unknown[] } };
          outcome.execution.warnings = [
            { kind: "sandbox-cleanup", message: "subject: unconfirmed" },
          ];
        }),
    ],
    [
      "run.json was written by another route",
      ({ editJson }) =>
        editJson(
          "run.json",
          (bundle) =>
            void (bundle.lifecycle = [
              { at: "2026-10-05T00:00:00.000Z", event: "cua-lab.run.created", message: "x" },
            ]),
        ),
    ],
    ["run.json cannot be read", ({ runRoot }) => writeFile(path.join(runRoot, "run.json"), "{")],
    ["run.json is missing", ({ runRoot }) => rm(path.join(runRoot, "run.json"))],
    [
      "its journal records owner tags",
      async ({ cwd }) => {
        const paths = await resolveRunPath(cwd, RUN);
        await appendSandboxOwner(paths!, sandboxOwnerTags(paths!));
      },
    ],
    [
      "an earlier reclaim names a sandbox",
      ({ runRoot }) =>
        writeFile(
          path.join(runRoot, RECLAIM_RECEIPT_ARTIFACT),
          JSON.stringify({ runId: RUN, outcomes: [{ state: "pending" }] }),
        ),
    ],
  ])("searches E2B and is not clean when %s", async (_case, change) => {
    const run = await scriptedRun();
    await change(run);
    const { loadModule, result } = check(run.cwd);
    const reclaimed = await result();
    expect(loadModule).toHaveBeenCalledOnce();
    expect(reclaimed.reason).toBeUndefined();
    expect(reclaimed.state).not.toBe("clean");
  });

  it("reclaim --check exits 0 and prints the run as clean", async () => {
    const { cwd } = await scriptedRun();
    let out = "";
    let exitCode: number | undefined;
    const program = createProgram({
      writeOut: (text) => {
        out += text;
      },
      writeErr: () => undefined,
      setExitCode: (code) => {
        exitCode = code;
      },
    });
    await program.parseAsync(
      ["node", "humanish", "reclaim", "--check", "--run", RUN, "--cwd", cwd],
      { from: "node" },
    );
    expect(exitCode).toBe(0);
    expect(out).toMatch(new RegExp(`^Reclaim check ${RUN}: clean\\.`));
  });
});
