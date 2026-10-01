import { spawn } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import { link, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { runLabPreflight } from "../../src/lab/preflight.js";
import { reclaimPreflightSandboxes } from "../../src/run/reclaim.js";
import { SANDBOX_RECEIPTS_ARTIFACT } from "../../src/run/sandbox-receipts.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../src/substrates/e2b/sdk.js";

// The lab preflight probe journals its sandbox under .humanish/preflight/<probe-id>/ before any
// work, removes the journal after a confirmed kill, and `humanish reclaim --preflight` kills
// what an interrupted probe left. Fake SDK modules stand in for E2B; no provider is called.

const env = { E2B_API_KEY: "synthetic-e2b-value" };
const PROBE_TIMEOUT_MS = 30_000;
const LEASE_BUFFER_MS = 5 * 60_000;

function previewLab(extra: string[] = []): string {
  return [
    "schema: humanish.lab.v2",
    "id: preview",
    "subject:",
    "  source: app-url",
    "  appUrl: https://preview.example.test/start",
    "execution:",
    "  target: e2b-desktop",
    ...extra,
    "actors:",
    "  - type: openai-computer-use",
    "scenario:",
    "  mode: live",
    "policies:",
    "  allowPublicTargets: true",
  ].join("\n");
}

function cloneLab(options: { serve?: string[]; seed?: boolean; desktop?: string[] } = {}): string {
  return [
    "schema: humanish.lab.v2",
    "id: clone-probe",
    "subject:",
    "  source: clone",
    "  repos:",
    "    - example/notes",
    "  serve:",
    ...(options.serve ?? ["    install: npm ci", "    start: npm start"]),
    "    url: http://127.0.0.1:3000/",
    ...(options.seed === false
      ? []
      : [
          "  state:",
          "    seed:",
          "      - name: seed-notes",
          "        command: npm run seed",
          "        timeoutMs: 120000",
        ]),
    "execution:",
    "  target: e2b-desktop",
    ...(options.desktop ?? []),
    "actors:",
    "  - type: openai-computer-use",
    "scenario:",
    "  mode: live",
  ].join("\n");
}

interface FakeProvider {
  module: E2BDesktopModule;
  created: E2BDesktopCreateOptions[];
  killed: string[];
}

function fakeProvider(behavior: {
  onFirstCommand?: () => Promise<void>;
  killThrows?: boolean;
  /** Kill throws the SDK's not-found error: the sandbox was already gone. */
  killNotFound?: boolean;
  /** Kill resolves with an answer the real SDK does not give. */
  killAnswer?: unknown;
}): FakeProvider {
  const created: E2BDesktopCreateOptions[] = [];
  const killed: string[] = [];
  let firstCommand = true;
  const sandbox = {
    sandboxId: "sb-preflight-1",
    commands: {
      run: async (command: string) => {
        if (firstCommand) {
          firstCommand = false;
          await behavior.onFirstCommand?.();
        }
        if (command.includes("curl")) return { exitCode: 0, stdout: "READY\n" };
        if (command.includes("/status")) return { exitCode: 0, stdout: "0\n" };
        if (command.includes("rev-parse")) return { exitCode: 0, stdout: "abc123\n" };
        return { exitCode: 0, stdout: "" };
      },
    },
    files: { write: async () => undefined },
  } as unknown as E2BDesktopSandbox;
  const module = {
    Sandbox: {
      create: async (options: E2BDesktopCreateOptions) => {
        created.push(options);
        return sandbox;
      },
      kill: async (sandboxId: string) => {
        if (behavior.killThrows) throw new Error("provider unreachable");
        if (behavior.killNotFound)
          throw Object.assign(new Error(`Sandbox ${sandboxId} not found`), {
            name: "SandboxNotFoundError",
          });
        killed.push(sandboxId);
        return "killAnswer" in behavior ? behavior.killAnswer : true;
      },
    },
  } as unknown as E2BDesktopModule;
  return { module, created, killed };
}

async function journals(cwd: string): Promise<string[]> {
  return readdir(path.join(cwd, ".humanish", "preflight")).catch(() => []);
}

/** A process id that has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid!;
}

/** A journal with one receipt and an owner record; the owner defaults to this host and namespace. */
async function writeJournal(
  cwd: string,
  owner: {
    pid: number;
    hostname?: string;
    pidNamespace?: string;
    startTicks?: string;
    createdAt?: string;
    leaseMs?: number;
  },
): Promise<string> {
  const id = `preflight-${owner.pid}-test-${Math.random().toString(16).slice(2, 10)}`;
  const dir = path.join(cwd, ".humanish", "preflight", id);
  await mkdir(dir, { recursive: true });
  let namespace: string | undefined;
  try {
    namespace = readlinkSync("/proc/self/ns/pid");
  } catch {
    namespace = undefined;
  }
  const createdAt = owner.createdAt ?? new Date().toISOString();
  const leaseMs = owner.leaseMs ?? 30 * 60_000;
  await writeFile(
    path.join(dir, "owner.json"),
    JSON.stringify({
      hostname: owner.hostname ?? hostname(),
      ...((owner.pidNamespace ?? namespace) === undefined
        ? {}
        : { pidNamespace: owner.pidNamespace ?? namespace }),
      pid: owner.pid,
      ...(owner.startTicks === undefined ? {} : { startTicks: owner.startTicks }),
      createdAt,
      leaseMs,
    }),
  );
  await writeFile(
    path.join(dir, SANDBOX_RECEIPTS_ARTIFACT),
    `${JSON.stringify({ at: createdAt, laneId: id, provider: "e2b", sandboxId: "sb-journaled", timeoutMs: leaseMs })}\n`,
  );
  return id;
}

describe("lab preflight receipts", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-preflight-receipt-"));
    await mkdir(path.join(cwd, "humanish", "labs"), { recursive: true });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  });

  it("journals the probe before its first command and removes the journal after the kill", async () => {
    await writeFile(path.join(cwd, "humanish/labs/preview.yaml"), previewLab());
    let journalAtFirstCommand = "";
    const provider = fakeProvider({
      onFirstCommand: async () => {
        const [id] = await journals(cwd);
        journalAtFirstCommand = await readFile(
          path.join(cwd, ".humanish", "preflight", id ?? "missing", SANDBOX_RECEIPTS_ARTIFACT),
          "utf8",
        );
      },
    });

    const result = await runLabPreflight({
      cwd,
      lab: "preview",
      reachability: "public-preview",
      env,
      hooks: { loadDesktopModule: async () => provider.module },
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(journalAtFirstCommand)).toMatchObject({
      provider: "e2b",
      sandboxId: "sb-preflight-1",
      timeoutMs: PROBE_TIMEOUT_MS + LEASE_BUFFER_MS,
    });
    expect(provider.killed).toEqual(["sb-preflight-1"]);
    expect(await journals(cwd)).toEqual([]);
  });

  it("sizes the lease to the probe, capped by a declared sandbox timeout", async () => {
    await writeFile(
      path.join(cwd, "humanish/labs/preview.yaml"),
      previewLab(["  desktop:", "    sandboxTimeoutMs: 3600000"]),
    );
    await writeFile(path.join(cwd, "humanish/labs/clone-probe.yaml"), cloneLab());
    const preview = fakeProvider({});
    const clone = fakeProvider({});

    const previewResult = await runLabPreflight({
      cwd,
      lab: "preview",
      reachability: "public-preview",
      env,
      hooks: { loadDesktopModule: async () => preview.module },
    });
    const cloneResult = await runLabPreflight({
      cwd,
      lab: "clone-probe",
      reachability: "sandbox-loopback",
      env,
      hooks: { loadDesktopModule: async () => clone.module, sleep: async () => undefined },
    });

    // The run's 60-minute sandbox timeout does not become the probe's lease.
    expect(preview.created[0]?.timeoutMs).toBe(PROBE_TIMEOUT_MS + LEASE_BUFFER_MS);
    expect(previewResult.sandbox.timeoutMs).toBe(PROBE_TIMEOUT_MS + LEASE_BUFFER_MS);
    // A clone probe gets the run's provisioning allowance plus its declared seed steps.
    expect(cloneResult.ok).toBe(true);
    // clone 5 min, Node bootstrap 2 x 5 min, install 2 x 10 min, the seed step's 2 min,
    // readiness 3 min, plus the buffer.
    expect(clone.created[0]?.timeoutMs).toBe((5 + 10 + 20 + 2 + 3) * 60_000 + LEASE_BUFFER_MS);

    await writeFile(
      path.join(cwd, "humanish/labs/preview.yaml"),
      previewLab(["  desktop:", "    sandboxTimeoutMs: 120000"]),
    );
    const capped = fakeProvider({});
    await runLabPreflight({
      cwd,
      lab: "preview",
      reachability: "public-preview",
      env,
      hooks: { loadDesktopModule: async () => capped.module },
    });
    expect(capped.created[0]?.timeoutMs).toBe(120_000);
  });

  it("gives a clone probe what the run's provisioning may use, up to the declared timeout", async () => {
    // A 50-minute build under a declared 60-minute sandbox: the run may provision for the full
    // hour, so the probe must not be cut off earlier.
    await writeFile(
      path.join(cwd, "humanish/labs/clone-probe.yaml"),
      cloneLab({
        serve: [
          "    install: npm ci",
          "    build: npm run build",
          "    buildTimeoutMs: 3000000",
          "    start: npm start",
        ],
        seed: false,
        desktop: ["  desktop:", "    sandboxTimeoutMs: 3600000"],
      }),
    );
    const slow = fakeProvider({});
    await runLabPreflight({
      cwd,
      lab: "clone-probe",
      reachability: "sandbox-loopback",
      env,
      hooks: { loadDesktopModule: async () => slow.module, sleep: async () => undefined },
    });
    expect(slow.created[0]?.timeoutMs).toBe(3_600_000);

    // A clone served as-is needs only the clone and readiness budgets.
    await writeFile(
      path.join(cwd, "humanish/labs/clone-probe.yaml"),
      cloneLab({ serve: ["    start: python3 -m http.server 3000"], seed: false }),
    );
    const quick = fakeProvider({});
    await runLabPreflight({
      cwd,
      lab: "clone-probe",
      reachability: "sandbox-loopback",
      env,
      hooks: { loadDesktopModule: async () => quick.module, sleep: async () => undefined },
    });
    expect(quick.created[0]?.timeoutMs).toBe((5 + 3) * 60_000 + LEASE_BUFFER_MS);
  });

  it("reads a not-found kill error as already gone: no teardown failure, journal removed", async () => {
    await writeFile(path.join(cwd, "humanish/labs/preview.yaml"), previewLab());
    const gone = fakeProvider({ killNotFound: true });

    const result = await runLabPreflight({
      cwd,
      lab: "preview",
      reachability: "public-preview",
      env,
      hooks: { loadDesktopModule: async () => gone.module },
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toContain("Sandbox was already absent when cleanup ran");
    expect(await journals(cwd)).toEqual([]);
  });

  it("does not count a non-boolean kill answer as proof: teardown fails, journal kept", async () => {
    await writeFile(path.join(cwd, "humanish/labs/preview.yaml"), previewLab());
    const odd = fakeProvider({ killAnswer: "ok" });

    const result = await runLabPreflight({
      cwd,
      lab: "preview",
      reachability: "public-preview",
      env,
      hooks: { loadDesktopModule: async () => odd.module },
    });

    expect(result.error?.code).toBe("HUMANISH_LAB_PREFLIGHT_TEARDOWN_FAILED");
    expect(result.warnings.join("\n")).toContain("Sandbox teardown returned an unexpected result");
    expect(await journals(cwd)).toHaveLength(1);
  });

  it("keeps the journal when the kill fails, and reclaim --preflight kills it by id", async () => {
    await writeFile(path.join(cwd, "humanish/labs/preview.yaml"), previewLab());
    const failing = fakeProvider({ killThrows: true });

    const result = await runLabPreflight({
      cwd,
      lab: "preview",
      reachability: "public-preview",
      env,
      hooks: { loadDesktopModule: async () => failing.module },
    });

    expect(result.error?.code).toBe("HUMANISH_LAB_PREFLIGHT_TEARDOWN_FAILED");
    expect(result.warnings.join("\n")).toContain("humanish reclaim --preflight");
    const [id] = await journals(cwd);
    expect(id).toMatch(/^preflight-\d+-/);

    // This process is still alive; the abandoned marker is what lets reclaim act.
    const reclaimer = fakeProvider({});
    const reclaim = await reclaimPreflightSandboxes(cwd, {
      loadModule: async () => reclaimer.module,
    });
    expect(reclaim.ok).toBe(true);
    expect(reclaim.outcomes).toEqual([
      { sandboxId: "sb-preflight-1", laneId: id, state: "killed" },
    ]);
    expect(reclaimer.killed).toEqual(["sb-preflight-1"]);
    expect(await journals(cwd)).toEqual([]);
  });

  it("leaves a journal alone while its probe may still be running", async () => {
    const id = await writeJournal(cwd, { pid: process.pid });
    const provider = fakeProvider({});

    const reclaim = await reclaimPreflightSandboxes(cwd, {
      loadModule: async () => provider.module,
    });

    expect(reclaim.outcomes).toEqual([]);
    expect(reclaim.warnings.join("\n")).toContain("still running");
    expect(provider.killed).toEqual([]);
    expect(await journals(cwd)).toEqual([id]);
  });

  it("leaves a journal from another pid namespace alone even when its pid is not running here", async () => {
    // A probe in a container writes its container pid; the host sees no such process.
    const pid = await deadPid();
    const id = await writeJournal(cwd, { pid, pidNamespace: "pid:[1]" });
    const provider = fakeProvider({});

    const reclaim = await reclaimPreflightSandboxes(cwd, {
      loadModule: async () => provider.module,
    });

    expect(provider.killed).toEqual([]);
    expect(reclaim.warnings.join("\n")).toContain("another host or pid namespace");
    expect(await journals(cwd)).toEqual([id]);
  });

  it("reclaims a journal whose lease has elapsed, whoever opened it", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await writeJournal(cwd, {
      pid: process.pid,
      hostname: "another-host",
      createdAt: twoHoursAgo,
      leaseMs: 5 * 60_000,
    });
    const provider = fakeProvider({});

    const reclaim = await reclaimPreflightSandboxes(cwd, {
      loadModule: async () => provider.module,
    });

    expect(provider.killed).toEqual(["sb-journaled"]);
    expect(reclaim.ok).toBe(true);
    expect(await journals(cwd)).toEqual([]);
  });

  it("refuses reclaim with E2B_DEBUG=true and keeps the journal", async () => {
    const id = await writeJournal(cwd, {
      pid: process.pid,
      hostname: "another-host",
      createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      leaseMs: 5 * 60_000,
    });
    const provider = fakeProvider({});
    vi.stubEnv("E2B_DEBUG", "true");

    const reclaim = await reclaimPreflightSandboxes(cwd, {
      loadModule: async () => provider.module,
    });

    expect(reclaim.ok).toBe(false);
    expect(reclaim.error?.code).toBe("HUMANISH_RECLAIM_E2B_DEBUG");
    expect(provider.killed).toEqual([]);
    expect(await journals(cwd)).toEqual([id]);
  });

  it.skipIf(!existsSync("/proc/self/stat"))(
    "reclaims a journal whose pid now belongs to another process",
    async () => {
      const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
      try {
        await writeJournal(cwd, { pid: other.pid!, startTicks: "1" });
        const provider = fakeProvider({});

        const reclaim = await reclaimPreflightSandboxes(cwd, {
          loadModule: async () => provider.module,
        });

        expect(provider.killed).toEqual(["sb-journaled"]);
        expect(reclaim.ok).toBe(true);
      } finally {
        other.kill("SIGKILL");
      }
    },
  );

  it("keeps a journal whose receipts cannot be read, without discarding or killing", async () => {
    const id = await writeJournal(cwd, {
      pid: process.pid,
      hostname: "another-host",
      createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      leaseMs: 5 * 60_000,
    });
    // A second hard link makes the contained read refuse the file, as it refuses any file it
    // cannot prove is the journal's own. The directory stays writable.
    const receipts = path.join(cwd, ".humanish", "preflight", id, SANDBOX_RECEIPTS_ARTIFACT);
    await link(receipts, path.join(cwd, "receipts-alias"));
    const provider = fakeProvider({});

    const reclaim = await reclaimPreflightSandboxes(cwd, {
      loadModule: async () => provider.module,
    });

    expect(reclaim.ok).toBe(false);
    expect(reclaim.warnings.join("\n")).toContain("could not be read safely");
    expect(provider.killed).toEqual([]);
    expect(await journals(cwd)).toEqual([id]);
    expect(await readFile(receipts, "utf8")).toContain("sb-journaled");
  });

  it("refuses --preflight together with --run", async () => {
    const program = createProgram({
      writeOut: () => undefined,
      writeErr: () => undefined,
      setExitCode: () => undefined,
    });
    // Commander's conflict check runs on the subcommand, so each command needs the override.
    for (const command of [program, ...program.commands]) command.exitOverride();
    await expect(
      program.parseAsync(["node", "humanish", "reclaim", "--run", "latest", "--preflight"], {
        from: "node",
      }),
    ).rejects.toMatchObject({ code: "commander.conflictingOption" });
  });

  it("reclaims the sandbox of a probe whose process was killed mid-preflight", async () => {
    await writeFile(path.join(cwd, "humanish/labs/preview.yaml"), previewLab());
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const script = `
      const { runLabPreflight } = await import(${JSON.stringify(path.join(root, "src/lab/preflight.ts"))});
      const sandbox = {
        sandboxId: "sb-preflight-orphan",
        // Every command hangs on an open handle, as a stuck provider socket would.
        commands: { run: () => new Promise(() => setInterval(() => {}, 60_000)) },
        files: { write: async () => undefined },
      };
      const module = { Sandbox: { create: async () => sandbox, kill: async () => true } };
      await runLabPreflight({
        cwd: process.env.PROBE_CWD,
        lab: "preview",
        reachability: "public-preview",
        env: ${JSON.stringify(env)},
        hooks: { loadDesktopModule: async () => module },
      });
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: root,
        env: { ...process.env, PROBE_CWD: cwd },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exited = new Promise<NodeJS.Signals | number | null>((resolve) => {
      child.on("exit", (code, signal) => resolve(signal ?? code));
    });
    try {
      await vi.waitFor(
        async () => {
          const [id] = await journals(cwd);
          const text = id
            ? await readFile(
                path.join(cwd, ".humanish", "preflight", id, SANDBOX_RECEIPTS_ARTIFACT),
                "utf8",
              ).catch(() => "")
            : "";
          expect(text, stderr).toContain('"sandboxId":"sb-preflight-orphan"');
        },
        { timeout: 15_000, interval: 50 },
      );
    } finally {
      child.kill("SIGKILL");
    }
    expect(await exited).toBe("SIGKILL");

    const reclaimer = fakeProvider({});
    const reclaim = await reclaimPreflightSandboxes(cwd, {
      loadModule: async () => reclaimer.module,
    });
    expect(reclaimer.killed).toEqual(["sb-preflight-orphan"]);
    expect(reclaim.ok).toBe(true);
    expect(await journals(cwd)).toEqual([]);
  }, 30_000);
});
