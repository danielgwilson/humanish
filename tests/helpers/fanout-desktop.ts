import { PNG } from "pngjs";

import type { FetchLike } from "../../src/actors/computer-use/openai-provider.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../src/substrates/e2b/sdk.js";
import { measuredChromeDesktop } from "./measured-chrome-desktop.js";

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

export interface FanoutModuleOptions {
  /** Override the geometry a given sandbox reports (participantIndex from metadata). Default: matches. */
  geometryOverride?: (laneIndex: number, requested: [number, number]) => [number, number];
  /** Every kill by id throws, as when the provider cannot be reached at teardown. */
  killFails?: boolean;
  /** Answers one participant's sandbox command; undefined falls through to the default reply. */
  commandHandler?: (laneIndex: number, command: string) => { stdout: string } | undefined;
  /** Chrome launches and reports measured geometry (measured-chrome-desktop.ts). */
  measuredChrome?: boolean;
}

export interface FanoutModuleHandle {
  module: E2BDesktopModule;
  created: E2BDesktopCreateOptions[];
  /** Parallel to `created`: the custom template each participant's create() got (undefined ==
   *  default). */
  templates: (string | undefined)[];
  opened: string[];
  killed: string[];
  createdIds: string[];
  /** Peak count of simultaneously-live (created, not yet killed) sandboxes. */
  maxLive: () => number;
}

export function makeFanoutModule(options: FanoutModuleOptions = {}): FanoutModuleHandle {
  const created: E2BDesktopCreateOptions[] = [];
  const templates: (string | undefined)[] = [];
  const opened: string[] = [];
  const createdIds: string[] = [];
  const killed: string[] = [];
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
    return {
      sandboxId: id,
      // Captured stock shape; resource-size variation tests live in desktop-resource-pricing.
      getInfo: async () => ({ cpuCount: 8, memoryMB: 8192 }),
      commands: {
        run: async (command: string) => {
          const handled = options.commandHandler?.(laneIndex, command);
          if (handled) return { exitCode: 0, ...handled };
          if (command.includes("xdpyinfo")) {
            return {
              exitCode: 0,
              stdout: `  dimensions:    ${reported[0]}x${reported[1]} pixels (300x200 millimeters)\n`,
            };
          }
          const targetUrl = command.match(/^target_url='([^']+)'$/m)?.[1];
          if (targetUrl) {
            opened.push(targetUrl);
          }
          return measured?.(command) ?? { exitCode: 0, stdout: "" };
        },
      },
      files: { write: async () => undefined },
      launch: record("launch") as (application: string, uri?: string) => Promise<void>,
      open: (async (fileOrUrl: string) => {
        opened.push(fileOrUrl);
      }) as (fileOrUrl: string) => Promise<void>,
      async screenshot() {
        frame += 1;
        return makePng(frame);
      },
      async wait() {
        /* settle is instant in the fake */
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

  return { module, created, templates, opened, killed, createdIds, maxLive: () => maxLive };
}
