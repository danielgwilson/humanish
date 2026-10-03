import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runRoute } from "../../src/cli/commands/study-route-run.js";
import { sharedWorldRouteRun } from "../../src/cli/commands/study-route-shared-world.js";
import type { CliIo } from "../../src/cli/io.js";
import { parseStudyDocument } from "../../src/study/config.js";
import { prepareStudy, type RunStudyOptions } from "../../src/run-study.js";
import { V2_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import { liveObserverResult } from "../../src/observer/live.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { freePort } from "../helpers/free-port.js";

// The route is replaced so the test drives the CLI's own onObserverReady against a real run
// directory and a real Observer server, the part of the watch path that can fail on the operator's
// machine (a taken port) before any participant starts.
vi.mock("../../src/run-study.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/run-study.js")>()),
  prepareStudy: vi.fn(),
}));

/** A planned lab whose run calls the watch's Observer gate, then fails. */
function gatedRun(
  failure: Error,
  live: () => Parameters<NonNullable<RunStudyOptions["onObserverReady"]>>[0],
) {
  vi.mocked(prepareStudy).mockImplementation(async (_config, options) => ({
    ok: true,
    run: async () => {
      await options.onObserverReady?.(live());
      throw failure;
    },
  }));
}

function liveConcurrentConfig(): StudyConfig {
  const lanes = [1, 2].map((n) => ({ id: `persona-0${n}`, persona: `persona-${n}` }));
  const parsed = parseStudyDocument({
    schema: V2_SCHEMA,
    id: "concurrent-observer-gate",
    subject: {
      source: "clone",
      topology: "shared-world",
      exposure: "synthetic",
      repos: ["example-org/collab-app"],
      serve: {
        install: "pnpm install",
        start: "pnpm start -H 0.0.0.0",
        url: "http://127.0.0.1:3000/",
      },
      state: { checkpoint: [{ name: "notes-count", command: "psql query notes" }] },
    },
    actors: [{ type: "openai-computer-use", mission: "Use the shared app.", lanes }],
    execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 2 },
    scenario: { mode: "live" },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function captureIo(): CliIo & { out: string[]; exitCode: number | undefined } {
  const io = {
    out: [] as string[],
    exitCode: undefined as number | undefined,
    writeOut: (text: string) => io.out.push(text),
    // The failure's error line goes to stderr; record it with stdout.
    writeErr: (text: string) => io.out.push(text),
    setExitCode: (code: number) => {
      io.exitCode = code;
    },
  };
  return io;
}

describe("the concurrent watch path's live Observer gate (W6)", () => {
  let cwd: string;
  let blocker: Server | undefined;
  // The port-in-use message probes the taken port to name its owner, so the blocker has to drop
  // those connections before it can close.
  const sockets = new Set<Socket>();
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-concurrent-gate-"));
    expect((await runDryRun({ cwd, dryRun: true, runId: "gated" })).ok).toBe(true);
  });
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()));
    blocker = undefined;
    vi.mocked(prepareStudy).mockReset();
    await rm(cwd, { recursive: true, force: true });
  });

  const live = () => liveObserverResult(cwd, "gated", path.join(cwd, ".humanish", "runs", "gated"));
  // The lab command's path for a watch: the backend's setup, then its one runStudyWith call.
  const runWatch = async (args: { io: CliIo; port: number }): Promise<void> => {
    const config = liveConcurrentConfig();
    const run = sharedWorldRouteRun({
      command: new Command(),
      io: args.io,
      config,
      mode: "watch",
      options: { cwd, port: String(args.port) },
    });
    if (run === undefined) throw new Error("expected the watch setup to proceed");
    await runRoute(config, run);
  };

  it("reports an Observer that cannot start as a structured failure naming the run", async () => {
    const port = await freePort();
    blocker = createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) => blocker!.listen(port, "127.0.0.1", resolve));
    gatedRun(new Error("the route must stop when its gate fails"), live);
    const io = captureIo();

    await runWatch({ io, port });

    expect(io.exitCode).toBe(2);
    const printed = io.out.join("");
    expect(printed).toContain("The live Observer could not start");
    expect(printed).toContain("gated");
  });

  it("closes a started Observer server when the run fails after the gate", async () => {
    const port = await freePort();
    const failure = new Error("synthetic route failure");
    gatedRun(failure, live);

    await expect(runWatch({ io: captureIo(), port })).rejects.toBe(failure);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(/fetch failed/);
  });
});
