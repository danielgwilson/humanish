import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTOR_TRACE_SCHEMA } from "../src/actor-contract.js";
import type { CuaActorSessionOptions } from "../src/computer-use-actor.js";
import type { CuaLoopResult } from "../src/computer-use.js";
import { runCuaActorLab, type CuaActorLabHooks } from "../src/cua-actor-lab.js";
import { runConcurrentSharedWorld } from "../src/concurrent-shared-world-lab.js";
import type { SharedWorldLabHooks } from "../src/shared-world-lab.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig, type LabConfig } from "../src/lab-config.js";
import type { E2BDesktopCreateOptions, E2BDesktopModule, E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";
import type { CommsReceivingRun } from "../src/comms-receiving.js";
import { COMMS_RECEIVING_SCHEMA, type CommsReceivingEvidence, type ReceivingSurface } from "../src/comms-receiving-types.js";
import { writeContainedOutputFile, type PreparedOutputDirectory } from "../src/selected-output-paths.js";

type Preparation = { participants: string[]; runPaths: PreparedOutputDirectory; registerSecrets(values: string[]): void };
const seam = vi.hoisted(() => ({ prepare: undefined as undefined | ((args: Preparation) => Promise<CommsReceivingRun>) }));
vi.mock("../src/comms-receiving-runtime.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  prepareReceivingRun: (args: Preparation) => seam.prepare!(args)
}));

type Route = "cua-clone" | "cua-local-tree" | "concurrent-provisioned" | "concurrent-external";
function configuration(route: Route): LabConfig {
  const concurrent = route.startsWith("concurrent-");
  const external = route === "concurrent-external";
  const parsed = parseLabConfig({ schema: LAB_CONFIG_SCHEMA, id: `receiving-${route}`, title: "Receiving orchestration proof",
    subject: external
      ? { source: "app-url", topology: "shared-world", appUrl: "https://collaboration.example.test/", publicTarget: { owner: "example-operator", authorized: true } }
      : { source: route === "cua-local-tree" ? "local-tree" : "clone", ...(concurrent ? { topology: "shared-world", exposure: "synthetic" } : {}),
        ...(route === "cua-local-tree" ? {} : { repos: ["example-org/example-app"] }),
        serve: { install: "pnpm install", start: "pnpm start -H 0.0.0.0", url: "http://127.0.0.1:3000/" },
        ...(concurrent ? { state: { seed: [{ name: "seed", command: "pnpm seed" }], checkpoint: [{ name: "count", command: "pnpm count" }] } } : {}) },
    ...(external ? { policies: { allowPublicTargets: true } } : {}),
    actors: [{ type: "openai-computer-use", mission: "Use your own email to join the app.", lanes: [
      { id: "participant-a", persona: "first-time-visitor", ...(external ? { host: true } : {}), ...(concurrent && !external ? { entry: "/seat-a" } : {}) },
      { id: "participant-b", persona: "returning-user", ...(concurrent && !external ? { entry: "/seat-b" } : {}) }
    ] }],
    comms: { email: { connection: "mail" } },
    execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 2 }, scenario: { mode: "live" }, review: { analysis: false }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function desktopModule(events: string[], failCreate: boolean) {
  const created: Array<{ id: string; options: E2BDesktopCreateOptions; files: Array<{ name: string; data: string | ArrayBuffer }> }> = [];
  const killed: string[] = [];
  const module: E2BDesktopModule = { Sandbox: {
    create: async (first: string | E2BDesktopCreateOptions, second?: E2BDesktopCreateOptions) => {
      events.push("desktop-create");
      if (failCreate) throw new Error("Synthetic allocation refusal");
      const options = typeof first === "string" ? second! : first;
      const record = { id: `synthetic-desktop-${created.length + 1}`, options, files: [] as Array<{ name: string; data: string | ArrayBuffer }> };
      created.push(record);
      const [width, height] = options.resolution ?? [1440, 950];
      const desktop = {
        sandboxId: record.id, getInfo: async () => ({ cpuCount: 2, memoryMB: 2048 }),
        commands: { run: async (command: string) => {
          if (command.includes("xdpyinfo")) return { exitCode: 0, stdout: `dimensions: ${width}x${height} pixels\n` };
          if (command.includes("getwindowgeometry")) return { exitCode: 0, stdout: `X=0\nY=0\nWIDTH=${width}\nHEIGHT=${height}\n` };
          if (command.includes("browser_preference='default'")) return { exitCode: 0, stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\n" };
          if (command.includes("find_chrome_window")) return { exitCode: 0, stdout: "WINDOW_ID=424242\n" };
          if (command.includes("browserWindow: { x: window.screenX")) return { exitCode: 0, stdout: JSON.stringify({ browserWindow: { x: 0, y: 0, width, height }, viewport: { width, height: height - 100, deviceScaleFactor: 1 } }) };
          if (command.includes("/status")) return { exitCode: 0, stdout: "0" };
          if (command.includes("rev-parse")) return { exitCode: 0, stdout: "12".repeat(20) + "\n" };
          if (command.includes("curl")) return { exitCode: 0, stdout: "READY" };
          return { exitCode: 0, stdout: "" };
        } },
        files: { write: async (name: string, data: string | ArrayBuffer) => { record.files.push({ name, data }); } },
        launch: async () => undefined, open: async () => undefined, getHost: (port: number) => `${port}-${record.id}.e2b.app`,
        screenshot: async () => new Uint8Array([1, 2, 3, 4]), wait: async () => undefined,
        stream: { start: async () => undefined, getAuthKey: () => "synthetic-stream-key", getUrl: () => "https://stream.invalid/synthetic-stream-key" }
      } as E2BDesktopSandbox;
      return desktop;
    },
    kill: async id => { killed.push(id); events.push(`kill:${id}`); return true; }
  } };
  return { module, created, killed };
}

describe("configured receiving through exported study runners", () => {
  const roots: string[] = [];
  afterEach(async () => { seam.prepare = undefined; vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  it.each(["cua-clone", "cua-local-tree", "concurrent-provisioned", "concurrent-external"] as const)("%s acquires before desktop allocation, isolates projections, and finishes restricted evidence", async route => {
    await proof(route, false);
  });
  it.each(["cua-clone", "concurrent-provisioned", "concurrent-external"] as const)("%s finishes pre-acquired inboxes when desktop allocation fails", async route => {
    await proof(route, true);
  });

  async function proof(route: Route, failCreate: boolean): Promise<void> {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-receiving-outer-")); roots.push(cwd);
    const events: string[] = [], prompts: string[] = [];
    const config = configuration(route);
    const sandbox = desktopModule(events, failCreate);
    const addresses = new Map<string, string>();
    const attached = new Map<string, ReceivingSurface>();
    const ended = new Set<string>();
    let receivingEvidence!: CommsReceivingEvidence;
    let artifactRoot!: PreparedOutputDirectory;
    const persist = () => writeContainedOutputFile(artifactRoot, "comms/receiving.json", JSON.stringify(receivingEvidence), "utf8");
    const finishParticipant = vi.fn(async (participantId: string) => {
      if (ended.has(participantId)) return;
      ended.add(participantId);
      await attached.get(participantId)?.stop();
      receivingEvidence.participants.find(item => item.participantId === participantId)!.cleanup = "absent";
      await persist();
    });
    const finish = vi.fn(async () => {
      events.push("receiving-finish");
      await Promise.all([...addresses.keys()].map(finishParticipant));
      receivingEvidence.state = "finished";
      await persist();
      return structuredClone(receivingEvidence);
    });
    seam.prepare = async args => {
      events.push("receiving-acquire"); artifactRoot = args.runPaths;
      args.participants.forEach((participantId, index) => addresses.set(participantId, `participant-${index + 1}@example.test`));
      args.registerSecrets([...addresses.values()]);
      receivingEvidence = { schema: COMMS_RECEIVING_SCHEMA, channel: "email", provider: "agentmail", publication: "restricted-real-communications",
        state: "running", browserConfinement: "mail-surface-only", limitations: [], participants: args.participants.map((participantId, index) => ({
          participantId, leaseId: `00000000-0000-4000-8000-00000000000${index}`, acquisition: "active", cleanup: "pending",
          observed: 0, published: 0, linkCount: 0, codeCount: 0, blockedAssetCount: 0, blockedLinkCount: 0, messages: [], limitations: []
        })) };
      await persist();
      return { address: id => addresses.get(id)!, snapshot: () => structuredClone(receivingEvidence), finish, finishParticipant,
        attach: async (id, { surface }) => {
          expect(attached.has(id)).toBe(false); attached.set(id, surface);
          await surface.publish([{ path: "inbox", body: `<p>${addresses.get(id)}</p>`, contentType: "text/html; charset=utf-8" }]);
        }
      };
    };
    const noNetwork = vi.fn(async () => { throw new Error("Unexpected live network request in receiving orchestration proof"); });
    vi.stubGlobal("fetch", noNetwork);
    const runSession = async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
      prompts.push(options.instructions);
      options.onObservedUrl?.("https://collaboration.example.test/lobby/AB2CD9");
      await new Promise(resolve => setTimeout(resolve, 15));
      return { status: "passed", completionReason: "goal_satisfied", reason: "Synthetic wiring task completed", trace: {
        schema: ACTOR_TRACE_SCHEMA, provider: "synthetic-cua", protocol: "cua-loop", lane: "computer-use", persona: options.persona,
        redaction: { status: "passed", screenshots: "n/a", notes: "Synthetic transport proof without frames" },
        startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", durationMs: 1000,
        status: "passed", completionReason: "goal_satisfied", reason: "Synthetic wiring task completed", ids: {},
        counts: { actions: 1, messages: 1, screenshots: 0 }, items: [
          { id: "message", kind: "message", lifecycle: "completed", title: "Result", text: "Reached the goal." },
          { id: "action", kind: "ui_action", lifecycle: "completed", title: "Click" }
        ], capabilities: { headless: true, structuredTrace: true, lanes: ["computer-use"], producesScreenshots: true, byoModel: false, preGrantableApprovals: false, inProcessTools: false, license: "proprietary" }
      } };
    };
    const hooks: CuaActorLabHooks & SharedWorldLabHooks = {
      env: { OPENAI_API_KEY: "synthetic-openai", E2B_API_KEY: "synthetic-e2b", AGENTMAIL_API_KEY: "synthetic-management-key-canary" },
      loadDesktopModule: async () => sandbox.module, runSession, onPhase: () => undefined,
      detachedTimers: { now: () => 0, sleep: async () => undefined }, proberCadenceMs: 100_000, handoffDeadlineMs: 1500,
      readLobbyCodeFromFrame: async () => undefined,
      packLocalTree: async () => ({ archive: { archivePath: "/unused/source.tar.gz", archiveSha256: "ab".repeat(32), fileCount: 1, totalBytes: 4, git: { commit: "12".repeat(20), dirty: false } }, buffer: new TextEncoder().encode("test").buffer }),
      renderObserverFn: async (project, run) => ({ schema: "humanish.observer-result.v1", ok: true, cwd: project, run, warnings: [] })
    };
    const result = route.startsWith("cua-")
      ? await runCuaActorLab({ cwd, config, dryRun: false, hooks })
      : await runConcurrentSharedWorld({ cwd, config, dryRun: false, hooks });
    expect(events.indexOf("receiving-acquire")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("receiving-acquire")).toBeLessThan(events.indexOf("desktop-create"));
    expect(finish).toHaveBeenCalledOnce();
    expect(receivingEvidence.participants.every(item => item.cleanup === "absent")).toBe(true);
    expect(noNetwork).not.toHaveBeenCalled();
    expect(sandbox.killed).toHaveLength(sandbox.created.length);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish/runs", result.runId, "run.json"), "utf8"));
    expect(bundle.publication.restrictions).toContain("real-communications");
    expect(bundle.commsReceiving).toMatchObject({ state: "finished", publication: "restricted-real-communications" });
    expect(JSON.stringify(bundle)).not.toContain("synthetic-management-key-canary");
    if (failCreate) { expect(attached.size).toBe(0); return; }
    expect(result.ok).toBe(true);
    expect(attached.size).toBe(2);
    expect(new Set([...attached.values()].map(surface => surface)).size).toBe(2);
    expect([...attached.values()].every(surface => surface.url === "http://127.0.0.1:8026/inbox")).toBe(true);
    expect(prompts).toHaveLength(2);
    for (const address of addresses.values()) {
      expect(prompts.filter(prompt => prompt.includes(address))).toHaveLength(1);
      const desktops = sandbox.created.filter(item => item.files.some(file => typeof file.data === "string" && file.data.includes(address)));
      expect(desktops).toHaveLength(1);
      for (const other of addresses.values()) if (other !== address) expect(JSON.stringify(desktops[0]!.files)).not.toContain(other);
    }
    expect(JSON.stringify(sandbox.created.map(item => item.options))).not.toContain("synthetic-management-key-canary");
  }
});
