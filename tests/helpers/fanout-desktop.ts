import { ReadableStream } from "node:stream/web";
import { PNG } from "pngjs";

import type { CuaActorSessionOptions } from "../../src/actors/computer-use/actor.js";
import type { FetchLike } from "../../src/actors/computer-use/openai-provider.js";
import type {
  E2BCommandRunOptions,
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../src/substrates/e2b/sdk.js";
import { measuredChromeDesktop } from "./measured-chrome-desktop.js";
import { x11vncRemote } from "./x11vnc-remote.js";

// ---------------------------------------------------------------------------
// Fan-out fakes: a desktop module that mints a distinct sandbox per create()
// (unique sandboxId), records create options (per-participant metadata) and kill calls
// (by id), tracks peak concurrent live sandboxes, and answers xdpyinfo with the
// requested geometry (so the per-participant geometry assertion passes). It has no
// `list` method: enumerate-and-kill is physically impossible.
// ---------------------------------------------------------------------------

function makePng(seed: number): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (seed * 37 + i) % 256;
    png.data[i + 1] = (seed * 89 + i) % 256;
    png.data[i + 2] = (seed * 13 + i) % 256;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

export function scriptedFetch(responses: unknown[]): FetchLike {
  let i = 0;
  return async () => {
    const value = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(value),
      json: async () => value,
    };
  };
}

/** A session's OpenAI participant whose requests get `responses` in order, and no network. */
export function scriptedParticipant(
  responses: unknown[],
  apiKey = "test-openai-key",
): NonNullable<CuaActorSessionOptions["participant"]> {
  return { vendor: "openai", options: { apiKey, fetchFn: scriptedFetch(responses) } };
}

export const TWO_TURN_SESSION = [
  {
    id: "resp_1",
    output: [{ type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] }],
  },
  {
    id: "resp_2",
    output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
  },
];

type CommandAnswer = { stdout: string; exitCode?: number; stderr?: string };

export interface FanoutModuleOptions {
  /** Override the geometry a given sandbox reports (participantIndex from metadata). Default: matches. */
  geometryOverride?: (laneIndex: number, requested: [number, number]) => [number, number];
  /** Every kill by id throws, as when the provider cannot be reached at teardown. */
  killFails?: boolean;
  /**
   * Answers one participant's sandbox command; undefined falls through to the default reply. A
   * promise holds the command until it settles.
   */
  commandHandler?: (
    laneIndex: number,
    command: string,
  ) => CommandAnswer | undefined | Promise<CommandAnswer | undefined>;
  /** Chrome launches and reports measured geometry (measured-chrome-desktop.ts). */
  measuredChrome?: boolean;
  /** The size files.getInfo reports for a written file; default its written size. */
  reportedFileSize?: (path: string, written: number) => number;
  /** Called on each files.write, in order with the rest of the run. A promise holds the write. */
  onFileWrite?: (sandboxId: string, path: string) => unknown;
  /** Called on each desktop.wait with the participant's index and the time asked, in order. */
  onWait?: (laneIndex: number, ms: number) => void;
  /**
   * The bytes files.read streams for a sandbox path, in two chunks; undefined reads as a missing
   * file. Without it the sandbox has no files.read.
   */
  readFile?: (laneIndex: number, path: string) => string | undefined;
}

export interface FanoutModuleHandle {
  module: E2BDesktopModule;
  created: E2BDesktopCreateOptions[];
  /** Parallel to `created`: the custom template each participant's create() got (undefined ==
   *  default). */
  templates: (string | undefined)[];
  opened: string[];
  /** Each browser launch command: the participant's index and the environment it ran with. */
  browserLaunches: Array<{ laneIndex: number; env?: Record<string, string> }>;
  killed: string[];
  createdIds: string[];
  /** Each sandbox's files.write calls: path to the bytes written. */
  files: Map<string, Map<string, Buffer>>;
  /** Peak count of simultaneously-live (created, not yet killed) sandboxes. */
  maxLive: () => number;
}

export function makeFanoutModule(options: FanoutModuleOptions = {}): FanoutModuleHandle {
  const created: E2BDesktopCreateOptions[] = [];
  const templates: (string | undefined)[] = [];
  const opened: string[] = [];
  const browserLaunches: FanoutModuleHandle["browserLaunches"] = [];
  const createdIds: string[] = [];
  const killed: string[] = [];
  const files = new Map<string, Map<string, Buffer>>();
  let serial = 0;
  let live = 0;
  let maxLive = 0;

  const makeSandbox = (id: string, createOptions: E2BDesktopCreateOptions): E2BDesktopSandbox => {
    const requested = createOptions.resolution ?? [1440, 950];
    const laneIndex = Number(createOptions.metadata?.participantIndex ?? "0");
    const reported = options.geometryOverride
      ? options.geometryOverride(laneIndex, requested)
      : requested;
    let frame = 0;
    const record = (name: string) => async (): Promise<void> => {
      void name;
    };
    const measured = options.measuredChrome ? measuredChromeDesktop(() => reported) : undefined;
    const x11vnc = x11vncRemote();
    return {
      sandboxId: id,
      // Captured stock shape; resource-size variation tests live in desktop-resource-pricing.
      getInfo: async () => ({ cpuCount: 8, memoryMB: 8192 }),
      commands: {
        run: async (command: string, runOptions?: E2BCommandRunOptions) => {
          const handled = await options.commandHandler?.(laneIndex, command);
          if (handled) return { exitCode: 0, ...handled };
          const vnc = x11vnc(command);
          if (vnc !== undefined) return vnc;
          if (command.includes("xdpyinfo")) {
            return {
              exitCode: 0,
              stdout: `  dimensions:    ${reported[0]}x${reported[1]} pixels (300x200 millimeters)\n`,
            };
          }
          const targetUrl = command.match(/^target_url='([^']+)'$/m)?.[1];
          if (targetUrl) {
            opened.push(targetUrl);
            browserLaunches.push({
              laneIndex,
              ...(runOptions?.envs === undefined ? {} : { env: runOptions.envs }),
            });
          }
          return measured?.(command) ?? { exitCode: 0, stdout: "" };
        },
      },
      files: {
        write: async (path: string, data: string | ArrayBuffer) => {
          await options.onFileWrite?.(id, path);
          const written = files.get(id) ?? new Map<string, Buffer>();
          files.set(id, written);
          written.set(path, Buffer.from(typeof data === "string" ? data : new Uint8Array(data)));
        },
        ...(options.readFile === undefined
          ? {}
          : {
              read: async (path: string) => {
                const text = options.readFile?.(laneIndex, path);
                if (text === undefined) throw new Error(`path '${path}' does not exist`);
                const bytes = Buffer.from(text, "utf8");
                const half = Math.floor(bytes.length / 2);
                return new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(bytes.subarray(0, half));
                    controller.enqueue(bytes.subarray(half));
                    controller.close();
                  },
                });
              },
            }),
        // EntryInfo.size is the one getInfo field humanish reads.
        getInfo: async (path: string) => {
          const bytes = files.get(id)?.get(path);
          if (bytes === undefined) throw new Error(`path '${path}' does not exist`);
          return { size: options.reportedFileSize?.(path, bytes.length) ?? bytes.length };
        },
      },
      launch: record("launch") as (application: string, uri?: string) => Promise<void>,
      open: (async (fileOrUrl: string) => {
        opened.push(fileOrUrl);
      }) as (fileOrUrl: string) => Promise<void>,
      async screenshot() {
        frame += 1;
        return makePng(frame);
      },
      async wait(ms: number) {
        // Settle is instant in the fake.
        options.onWait?.(laneIndex, ms);
      },
      stream: {
        getAuthKey: () => "fake-auth-key",
        getUrl: () => "https://stream.invalid/fake-auth-key",
        start: async () => undefined,
      },
      leftClick: record("leftClick"),
      rightClick: record("rightClick"),
      middleClick: record("middleClick"),
      doubleClick: record("doubleClick"),
      moveMouse: record("moveMouse"),
      scroll: record("scroll"),
      write: record("write"),
      press: record("press"),
      drag: record("drag"),
    } as unknown as E2BDesktopSandbox;
  };

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
        serial += 1;
        live += 1;
        maxLive = Math.max(maxLive, live);
        const id = `fake-sandbox-${String(serial).padStart(2, "0")}`;
        templates.push(template);
        created.push(createOptions);
        createdIds.push(id);
        return makeSandbox(id, createOptions);
      },
      kill: async (sandboxId) => {
        if (options.killFails) throw new Error("synthetic kill failure");
        killed.push(sandboxId);
        live -= 1;
        return true;
      },
      // No `list`: the run can only kill the exact ids it created, never enumerate.
    },
  };

  return {
    module,
    created,
    templates,
    opened,
    browserLaunches,
    killed,
    createdIds,
    files,
    maxLive: () => maxLive,
  };
}
