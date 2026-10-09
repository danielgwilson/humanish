// Route-level reads of the planned subject that no other test pinned: a provisioned subject never
// uses an adopter-hosted comms catch, a clone fan-out records each participant's clone provenance,
// and a desktop-cli run records its product as the subject that verify and the bundle readers accept.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRunBundle } from "../../../src/run/locate.js";
import { parseStudy } from "../../../src/study/config.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../../src/study/types.js";
import { verifyRun } from "../../../src/verify/verify.js";
import { libraryConfig } from "../../helpers/library-config.js";
import { runComputerUse } from "../../helpers/route-run.js";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-subject-kind-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(cwd, { recursive: true, force: true });
});

function cloneStudy(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: STUDY_SCHEMA,
    id: "subject-kind-clone",
    route: "computer-use",
    subject: {
      source: "clone",
      repos: ["example-org/example-app"],
      serve: { install: "pnpm install", start: "pnpm start", url: "http://127.0.0.1:3000/" },
    },
    actor: {
      type: "openai-computer-use",
      persona: "first-time-visitor",
      mission: "Explore and stop.",
    },
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    review: { analysis: false },
    ...extra,
  };
}

function cloneLab(extra: Record<string, unknown>): StudyConfig {
  const parsed = parseStudy(cloneStudy(extra));
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
      // parseStudy refuses an external catch on a clone subject, which the route never reads; a
      // library caller can still pass one.
      config: libraryConfig(
        cloneStudy({
          mode: "live",
          comms: { email: { external: { catchBaseUrl: "https://catch.example.test" } } },
        }),
      ),
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
      config: cloneLab({ participants: [{ id: "a" }, { id: "b" }] }),
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

function desktopCliLab(extra: Record<string, unknown> = {}): StudyConfig {
  const parsed = parseStudy({
    schema: STUDY_SCHEMA,
    id: "subject-kind-desktop-cli",
    route: "computer-use",
    subject: {
      source: "desktop-cli",
      product: { name: "sample-cli", publicSurfaces: ["https://example.com/sample-cli"] },
    },
    actor: {
      type: "openai-computer-use",
      persona: "first-time-visitor",
      mission: "Find out what the CLI does and stop.",
    },
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    review: { analysis: false },
    ...extra,
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

interface RecordedRun {
  subject?: unknown;
  events: { type: string; message: string }[];
}

async function readRunJson(runId: string): Promise<RecordedRun> {
  return JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8"),
  ) as RecordedRun;
}

const DESKTOP_CLI_SUBJECT = {
  source: "desktop-cli",
  product: "sample-cli",
  state: { provenance: "undeclared" },
};

describe("a desktop-cli subject", () => {
  it.each([
    { label: "one participant", extra: {}, participants: 1 },
    { label: "a fan-out", extra: { participants: [{ id: "a" }, { id: "b" }] }, participants: 2 },
  ])("is recorded with its product in run.json and the result ($label)", async (row) => {
    const result = await runComputerUse({ cwd, config: desktopCliLab(row.extra), dryRun: true });
    expect(result.ok).toBe(true);
    expect((await readRunJson(result.runId)).subject).toEqual(DESKTOP_CLI_SUBJECT);
    expect(result.subject).toEqual(DESKTOP_CLI_SUBJECT);
    expect(result.lanes?.map((lane) => lane.subject)).toEqual(
      Array.from({ length: row.participants }, () => DESKTOP_CLI_SUBJECT),
    );
  });

  it("is declared by its product name in the subject event", async () => {
    const single = await runComputerUse({ cwd, config: desktopCliLab(), dryRun: true });
    const fanout = await runComputerUse({
      cwd,
      config: desktopCliLab({ participants: [{ id: "a" }, { id: "b" }] }),
      dryRun: true,
    });
    const declared = async (runId: string) =>
      (await readRunJson(runId)).events
        .filter((event) => event.type === "cua-lab.subject.declared")
        .map((event) => event.message);
    expect(await declared(single.runId)).toEqual([
      "Subject product declared: sample-cli, used from a terminal window inside the desktop sandbox.",
    ]);
    expect(await declared(fanout.runId)).toEqual([
      "Participant a: subject product declared: sample-cli, used from a terminal window inside the participant's own desktop sandbox.",
      "Participant b: subject product declared: sample-cli, used from a terminal window inside the participant's own desktop sandbox.",
    ]);
  });

  it("is read by verify and by the bundle loader that observe, review and export use", async () => {
    const result = await runComputerUse({ cwd, config: desktopCliLab(), dryRun: true });
    const verified = await verifyRun(cwd, result.runId);
    expect(
      verified.checks.filter((check) => !check.ok).map((check) => check.name),
      "failed verify checks",
    ).toEqual([]);
    expect((await loadRunBundle(cwd, result.runId))?.bundle.subject).toEqual(DESKTOP_CLI_SUBJECT);
  });
});
