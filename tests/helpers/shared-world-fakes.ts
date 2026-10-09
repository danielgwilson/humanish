// The shared-world route's fakes for the N+1 substrate (one subject sandbox and one sandbox per
// participant), shared by the route's tests.

import {
  ACTOR_TRACE_SCHEMA,
  type ActorCompletionReason,
  type ActorStatus,
  type ActorTrace,
} from "../../src/actors/contract.js";
import type { CuaActorSessionOptions } from "../../src/actors/computer-use/actor.js";
import type { CuaLoopResult } from "../../src/actors/computer-use/loop.js";
import { parseStudy } from "../../src/study/config.js";
import type { StudyDeps } from "../../src/study/study-deps.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import type { SubjectPhaseEvent } from "../../src/subject/steps.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../src/substrates/e2b/sdk.js";

// ---------------------------------------------------------------------------
// Fakes for the N+1 substrate. The module records create/kill by id and exposes
// no `list` (enumerate-and-kill is impossible by construction). Each fake sandbox
// has getHost(port) → a bare tokenless host keyed on its id (no scheme, exactly as
// the real @e2b SDK returns it: the orchestrator normalizes it to https://). The command handler drives
// the detached primitive (provisioning + checkpoints) and returns stateful
// checkpoint output (a shared worldVersion the fake runSession bumps per turn).
//
// Overlap is produced, not injected. The fake runSession blocks on a
// rendezvous latch until all N actors have entered, so N participant fns are genuinely
// in-flight while the real orchestrator clock (Date.now, not overridden) measures
// the wrapped [start,end] laneWindows. The windows therefore overlap for real.
// ---------------------------------------------------------------------------

interface FakeSandbox extends E2BDesktopSandbox {
  calls: Array<[string, ...unknown[]]>;
}

export const FAKE_DESKTOP_SCREEN = { width: 1440, height: 950 } as const;
export const FAKE_DESKTOP_VIEWPORT = { width: 1440, height: 817, deviceScaleFactor: 1 } as const;

export function browserTargetFromCalls(calls: Array<[string, ...unknown[]]>): string | undefined {
  for (const call of calls) {
    if (call[0] === "open") return String(call[1]);
    if (call[0] !== "commands.run") continue;
    const target = String(call[1]).match(/^target_url='([^']+)'$/m)?.[1];
    if (target) return target;
  }
  return undefined;
}

function makeFakeSandbox(
  id: string,
  commandHandler: (command: string) => { stdout?: string } | undefined,
): FakeSandbox {
  const calls: Array<[string, ...unknown[]]> = [];
  const sandbox = {
    calls,
    sandboxId: id,
    commands: {
      run: async (command: string) => {
        calls.push(["commands.run", command]);
        return commandHandler(command) ?? { exitCode: 0, stdout: "" };
      },
    },
    files: {
      // Raw data (never String()-coerced): existing callers write string script content
      // (String(data) === data for those, unchanged), and the local-tree upload path writes a
      // real ArrayBuffer that tests need to inspect directly (byteLength, reference equality).
      write: async (filePath: string, data: string | ArrayBuffer) => {
        calls.push(["files.write", filePath, data]);
        return undefined;
      },
    },
    launch: async (application: string, uri?: string) => {
      calls.push(["launch", application, uri]);
    },
    open: async (fileOrUrl: string) => {
      calls.push(["open", fileOrUrl]);
    },
    getHost: (port: number) => `${port}-${id}.e2b.app`, // bare host (no scheme); matches the real @e2b SDK
    async screenshot() {
      return new Uint8Array([1, 2, 3, 4]);
    },
    async wait(ms: number) {
      calls.push(["wait", ms]);
    },
    stream: {
      getAuthKey: () => "fake-auth-key",
      getUrl: () => "https://stream.invalid/fake-auth-key",
      start: async (options?: unknown) => {
        calls.push(["stream.start", options]);
      },
    },
  };
  return sandbox as unknown as FakeSandbox;
}

export function makeFakeModule(
  commandHandler: (command: string) => { stdout?: string } | undefined,
  fitToResolution = true,
): {
  module: E2BDesktopModule;
  created: E2BDesktopCreateOptions[];
  templates: (string | undefined)[];
  killed: string[];
  sandboxes: FakeSandbox[];
} {
  const created: E2BDesktopCreateOptions[] = [];
  // Parallel to `created`: the custom template each create() got; subject and every actor sandbox.
  // undefined == called with no template arg (the byte-stable default).
  const templates: (string | undefined)[] = [];
  const killed: string[] = [];
  const sandboxes: FakeSandbox[] = [];
  let n = 0;
  const module: E2BDesktopModule = {
    Sandbox: {
      // Mirror the real @e2b/desktop overload: create(opts) or create(template, opts).
      create: async (
        templateOrOptions: string | E2BDesktopCreateOptions,
        maybeOptions?: E2BDesktopCreateOptions,
      ) => {
        const template = typeof templateOrOptions === "string" ? templateOrOptions : undefined;
        const createOptions =
          typeof templateOrOptions === "string" ? maybeOptions! : templateOrOptions;
        n += 1;
        const [width, height] = createOptions.resolution ?? [1440, 950];
        const sandbox = makeFakeSandbox(`fake-sandbox-${String(n).padStart(3, "0")}`, (command) => {
          // A phone participant has its own physical display, including in the committed live
          // fixture.
          if (fitToResolution && command.includes("xdpyinfo"))
            return { stdout: `dimensions: ${width}x${height} pixels\n` };
          if (fitToResolution && command.includes("xwininfo -id"))
            return {
              stdout: `Absolute upper-left X: 0\nAbsolute upper-left Y: 0\nWidth: ${width}\nHeight: ${height}\nMap State: IsViewable\n`,
            };
          return commandHandler(command);
        });
        templates.push(template);
        created.push(createOptions);
        sandboxes.push(sandbox);
        return sandbox;
      },
      kill: async (sandboxId) => {
        killed.push(sandboxId);
        return true;
      },
      // NOTE: no `list` method.
    },
  };
  return { module, created, templates, killed, sandboxes };
}

export function makeCommandHandler(state: {
  worldVersion: number;
}): (command: string) => { stdout?: string } | undefined {
  return (command: string): { stdout?: string } | undefined => {
    if (command.includes("xdpyinfo"))
      return { stdout: "dimensions: 1440x950 pixels (381x251 millimeters)\n" };
    if (command.includes("browser_preference='default'"))
      return { stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\n" };
    if (command.includes("/status")) return { stdout: "0" };
    if (command.includes("rev-parse")) return { stdout: "abc123def4567890abc1\n" };
    if (command.includes("curl")) return { stdout: "READY" };
    if (command.includes("checkpoint-") && command.includes("tail -c"))
      return { stdout: `world=${state.worldVersion}\n` };
    if (command.includes("find_chrome_window")) return { stdout: "WINDOW_ID=424242\n" };
    if (command.includes("xwininfo -id"))
      return {
        stdout:
          "Absolute upper-left X: 0\nAbsolute upper-left Y: 0\nWidth: 1440\nHeight: 950\nMap State: IsViewable\n",
      };
    if (command.includes("browserWindow: { x: window.screenX")) {
      return {
        stdout: JSON.stringify({
          browserWindow: { x: 0, y: 0, ...FAKE_DESKTOP_SCREEN },
          viewport: FAKE_DESKTOP_VIEWPORT,
        }),
      };
    }
    if (command.includes("tail -c")) return { stdout: "" };
    return undefined;
  };
}

/** A rendezvous latch: the returned fn blocks until `count` callers have entered, then releases
 *  them all, so `count` participant fns are genuinely in-flight at once (real overlap). */
export function makeRendezvous(count: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= count) release();
    await gate;
  };
}

// A full-suite run on a loaded machine can take several seconds to reach a condition that is
// immediate when the file runs alone. The wait returns as soon as the condition holds.
export async function waitForCondition(
  label: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export function makeTrace(args: {
  persona: { id: string; traitsApplied: string[]; promptDigest: string };
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  actions: number;
  messages: number;
  reason?: string;
}): ActorTrace {
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "fake-cua",
    protocol: "cua-loop",
    lane: "computer-use",
    persona: args.persona,
    redaction: { status: "passed", screenshots: "n/a", notes: "fake trace (no frames captured)" },
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    status: args.status,
    completionReason: args.completionReason,
    reason: args.reason ?? `${args.status} (${args.completionReason})`,
    ids: {},
    counts: { actions: args.actions, messages: args.messages, screenshots: 0 },
    items: [
      ...(args.messages > 0
        ? [
            {
              id: "i-msg",
              kind: "message" as const,
              lifecycle: "completed" as const,
              title: "message",
              text: "did my task",
            },
          ]
        : []),
      ...(args.actions > 0
        ? [
            {
              id: "i-act",
              kind: "ui_action" as const,
              lifecycle: "completed" as const,
              title: "click",
            },
          ]
        : []),
    ],
    capabilities: {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: true,
      byoModel: false,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "proprietary",
    },
  };
}

/** A runSession fake: rendezvous (real overlap) → bump the shared world → engaged passed trace,
 *  unless a per-call override (harness throw / mission failure) applies. */
export function makeRunSession(
  state: { worldVersion: number },
  rendezvous: () => Promise<void>,
  override?: (index: number) =>
    | {
        throwMessage?: string;
        status?: ActorStatus;
        completionReason?: ActorCompletionReason;
        reason?: string;
        actions?: number;
        messages?: number;
        /** False leaves the shared world unchanged by this participant's turn. */
        mutates?: boolean;
      }
    | undefined,
): (options: CuaActorSessionOptions) => Promise<CuaLoopResult> {
  let calls = -1;
  return async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
    calls += 1;
    // The override targets a participant (by its persona id), never "the Nth call": concurrent
    // participants interleave however the scheduler likes, so call order is an accident: asserting
    // on it made these tests flake the moment an unrelated await shifted the schedule.
    const personaMatch = /^persona-(\d+)$/.exec(options.persona.id);
    const myIndex = personaMatch ? Number(personaMatch[1]) - 1 : calls;
    await rendezvous(); // all actors are in-flight here → their windows overlap on the real clock
    // All participants were released together; hold them concurrently for a measurable interval so
    // the real orchestrator clock records overlapping [start,end] windows (Date.now is
    // ms-resolution: without this the instant fake collapses every window to a zero-width point).
    // The overlap is genuinely produced (all participants are in this delay at once), not injected.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
    const o = override?.(myIndex);
    if (o?.mutates !== false) state.worldVersion += 1; // each actor's turn mutates the shared world
    if (o?.throwMessage) {
      throw new Error(o.throwMessage);
    }
    const status = o?.status ?? "passed";
    const completionReason = o?.completionReason ?? "goal_satisfied";
    const trace = makeTrace({
      persona: options.persona,
      status,
      completionReason,
      actions: o?.actions ?? 1,
      messages: o?.messages ?? 1,
      ...(o?.reason === undefined ? {} : { reason: o.reason }),
    });
    return { status, completionReason, reason: trace.reason, trace };
  };
}

/** The concurrent shared-world study as a humanish.study.v3 object. */
export function concurrentStudy(roleCount = 3, concurrency = 3, template?: string) {
  const lanes = Array.from({ length: roleCount }, (_unused, i) => ({
    id: `persona-${String(i + 1).padStart(2, "0")}`,
    actorType: i === 0 ? "initiator" : "collaborator",
    surface: i === 0 ? "intake" : "review",
    caseGroup: "case-001",
    persona: `persona-${i + 1}`,
    entry: `/seat-${i + 1}`,
  }));
  return {
    schema: STUDY_SCHEMA,
    id: "concurrent-shared-world-proof",
    title: "Concurrent shared-world proof",
    route: "shared-world",
    mode: "live",
    subject: {
      source: "clone",
      exposure: "synthetic",
      repos: ["example-org/collab-app"],
      env: ["DATABASE_URL"],
      serve: {
        install: "pnpm install",
        start: "pnpm start -H 0.0.0.0",
        url: "http://127.0.0.1:3000/",
      },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [
          { name: "notes-count", command: "psql query notes" },
          { name: "reviews-count", command: "psql query reviews" },
        ],
      },
    },
    actor: { type: "openai-computer-use", mission: "Use the shared app." },
    participants: lanes,
    execution: {
      target: "e2b-desktop",
      timeoutMs: 60_000,
      concurrency,
      ...(template === undefined ? {} : { desktop: { template } }),
    },
  };
}

export function concurrentConfig(
  roleCount = 3,
  concurrency = 3,
  template?: string,
  caps?: { maxUsd?: number; maxTotalUsd?: number },
): StudyConfig {
  const study = concurrentStudy(roleCount, concurrency, template);
  const parsed = parseStudy(caps === undefined ? study : { ...study, caps });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

/** The seams, writable so a test can swap one. */
export type TestDeps = { -readonly [K in keyof StudyDeps]: StudyDeps[K] };

/** Keys and the subject env value every fake run gets. */
const testEnv = (): Record<string, string> => ({
  OPENAI_API_KEY: "test-openai-key",
  E2B_API_KEY: "test-e2b-key",
  DATABASE_URL: "opaque-pw-7f3a9c2e-do-not-leak",
});

export function baseSeams(
  state: { worldVersion: number },
  rendezvous: () => Promise<void>,
  override?: Parameters<typeof makeRunSession>[2],
): {
  env: Record<string, string>;
  deps: TestDeps;
  created: E2BDesktopCreateOptions[];
  templates: (string | undefined)[];
  killed: string[];
  sandboxes: FakeSandbox[];
  phaseEvents: SubjectPhaseEvent[];
} {
  const { module, created, templates, killed, sandboxes } = makeFakeModule(
    makeCommandHandler(state),
  );
  const phaseEvents: SubjectPhaseEvent[] = [];
  const deps: TestDeps = {
    desktopModule: async () => module,
    runSession: makeRunSession(state, rendezvous, override),
    detachedTimers: { now: () => 0, sleep: async () => {} },
    proberCadenceMs: 100_000, // large: no periodic snapshot fires in the fast test (baseline+final carry the gate)
    // Captures instead of writing to real stderr (the default without a sink); also lets tests
    // assert the ordered phase-boundary sequence.
    subjectPhaseSink: (event) => phaseEvents.push(event),
  };
  return { env: testEnv(), deps, created, templates, killed, sandboxes, phaseEvents };
}
