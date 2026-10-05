// Two route-level reads of the planned subject that no other test pinned: a provisioned subject
// never uses an adopter-hosted comms catch, and a clone fan-out records each participant's clone
// provenance.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseStudyDocument } from "../../../src/study/config.js";
import { V2_SCHEMA, type StudyConfig } from "../../../src/study/types.js";
import { runComputerUse } from "../../helpers/route-run.js";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-subject-kind-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(cwd, { recursive: true, force: true });
});

function cloneLab(extra: Record<string, unknown>): StudyConfig {
  const parsed = parseStudyDocument({
    schema: V2_SCHEMA,
    id: "subject-kind-clone",
    subject: {
      source: "clone",
      repos: ["example-org/example-app"],
      serve: { install: "pnpm install", start: "pnpm start", url: "http://127.0.0.1:3000/" },
    },
    actors: [
      { type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore and stop." },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    review: { analysis: false },
    ...extra,
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("computer-use route reads of the planned subject", () => {
  it("never probes an adopter-hosted comms catch for a clone subject", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      fetched.push(String(input));
      return new Response("{}", { status: 503 });
    });
    const result = await runComputerUse({
      cwd,
      config: cloneLab({
        scenario: { mode: "live" },
        comms: { email: { external: { catchBaseUrl: "https://catch.example.test" } } },
      }),
      dryRun: false,
      env: { OPENAI_API_KEY: "synthetic-openai", E2B_API_KEY: "synthetic-e2b" },
      deps: {
        desktopModule: async () => {
          throw new Error("the desktop is not needed past preflight in this test");
        },
      },
    }).catch((error: unknown) => ({ error: { code: String(error) } }));
    expect(fetched.filter((url) => url.startsWith("https://catch.example.test"))).toEqual([]);
    expect(result.error?.code).not.toBe("HUMANISH_COMPUTER_USE_COMMS_CATCH_UNREACHABLE");
  });

  it("records each fan-out participant's clone provenance", async () => {
    const result = await runComputerUse({
      cwd,
      config: cloneLab({
        actors: [
          {
            type: "openai-computer-use",
            persona: "first-time-visitor",
            mission: "Explore and stop.",
            lanes: [{ id: "a" }, { id: "b" }],
          },
        ],
      }),
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as { events: { type: string; message: string }[] };
    const provenance = bundle.events.filter((event) => event.type === "cua-lab.subject.provenance");
    expect(provenance.map((event) => event.message.split(":")[0])).toEqual([
      "Participant a",
      "Participant b",
    ]);
    for (const event of provenance)
      expect(event.message).toContain("subject declared: clone of example-org/example-app");
  });
});
